/* BandSynth · analysis.js
 * 音频 → 鼓谱 分析内核（P1 阶段）。
 *
 * 设计约束（很重要）：
 *   · 站点是「双击 index.html 即可用」的 file:// 页面 → **Worker 不可用**
 *     （file:// 下 new Worker 会被同源策略拒绝），所以全部分析跑在主线程，
 *     按帧分块 + await 让出，靠 onProgress 回报进度，界面不会整段冻住。
 *   · 不引第三方库：FFT 自己写（radix-2），节拍/起音/鼓分类也都是纯手写，
 *     这样零安装、零 CDN 依赖。
 *   · 只做「鼓」的转写（P1 范围）。和声/贝斯/人声转写在 P2，接口预留占位。
 *
 * 处理链路：
 *   AudioBuffer → 单声道 @22050 → STFT(1024/hop256) → 每帧 8 段能量 + 谱通量/质心/平坦度
 *   → **分频段**起音检测（低/中/高三路各自检测再合并，同刻的底鼓+镲不会互相吃掉）
 *   → 速度估计（起音包络自相关 × 对数先验）
 *   → 拍点跟踪（相位搜索 + 最小二乘拟合）→ 拍号/小节相位（重音投票）
 *   → 按频段分类鼓位（衰减时间 + 谱质心/平坦度细分嗵鼓与镲）
 *   → 量化到 1/16 网格 → 生成琴谱 JSON + 置信度（对齐残差 / 逐小节分数）
 */
(function (global) {
  'use strict';

  var BS = global.BS;
  var U = BS.util;

  /* 分析用采样率：22050 足够覆盖鼓的高频（镲到 11k），又比 44.1k 省一半算力 */
  var SR = 22050;
  var FFT_N = 1024;          // ≈46ms 窗
  var HOP = 256;             // ≈11.6ms 步进
  var FPS = SR / HOP;        // ≈86.13 帧/秒
  var BAND_EDGES = [20, 80, 160, 320, 700, 1500, 3000, 6000, 11000];

  /* 鼓位 → 音高（真值来自 arranger.js，别在这里另立一套） */
  var DRUM_PITCH = {
    kick: 36, snare: 38, hihatClosed: 42, hihatOpen: 46,
    crash: 49, ride: 51, tomLow: 45, tomMid: 48, tomHigh: 50
  };
  var DRUM_LABEL = {
    kick: '底鼓', snare: '军鼓', hihatClosed: '闭镲', hihatOpen: '开镲',
    crash: '碎音镲', ride: '叮镲', tomLow: '低嗵', tomMid: '中嗵', tomHigh: '高嗵'
  };

  /* 三个检测组：底鼓偏低频、军鼓/嗵鼓中频、镲片高频 */
  var GROUPS = {
    low: { bands: [0, 1], minGapSec: 0.06, winSec: 0.5 },
    mid: { bands: [2, 3, 4, 5], minGapSec: 0.06, winSec: 0.5 },
    high: { bands: [6, 7], minGapSec: 0.035, winSec: 0.4 }
  };

  /* ================= 小工具 ================= */

  function nextTick() {
    return new Promise(function (r) { setTimeout(r, 0); });
  }

  function median(arr) {
    if (!arr.length) return 0;
    var a = Array.prototype.slice.call(arr).sort(function (x, y) { return x - y; });
    var m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  function pct(arr, p) {
    if (!arr.length) return 0;
    var a = Array.prototype.slice.call(arr).sort(function (x, y) { return x - y; });
    return a[U.clamp(Math.floor(a.length * p), 0, a.length - 1)];
  }

  /* ================= FFT ================= */

  function makeFFT(n) {
    var bits = Math.round(Math.log(n) / Math.LN2);
    var rev = new Uint32Array(n);
    for (var i = 0; i < n; i++) {
      var r = 0;
      for (var b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      rev[i] = r;
    }
    var cos = new Float32Array(n / 2), sin = new Float32Array(n / 2);
    for (i = 0; i < n / 2; i++) {
      cos[i] = Math.cos(2 * Math.PI * i / n);
      sin[i] = Math.sin(2 * Math.PI * i / n);
    }
    return { n: n, rev: rev, cos: cos, sin: sin };
  }

  function fftRun(F, re, im) {
    var n = F.n, rev = F.rev, cos = F.cos, sin = F.sin, i, j, t;
    for (i = 0; i < n; i++) {
      j = rev[i];
      if (j > i) {
        t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (var size = 2; size <= n; size <<= 1) {
      var half = size >> 1, step = n / size;
      for (i = 0; i < n; i += size) {
        for (var k = 0; k < half; k++) {
          var c = cos[k * step], s = -sin[k * step];
          var a = i + k, b = a + half;
          var tr = re[b] * c - im[b] * s;
          var ti = re[b] * s + im[b] * c;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  }

  var FFT = makeFFT(FFT_N);
  var WIN = new Float32Array(FFT_N);
  for (var wi = 0; wi < FFT_N; wi++) WIN[wi] = 0.5 - 0.5 * Math.cos(2 * Math.PI * wi / (FFT_N - 1));

  /* ================= 单声道降采样 ================= */

  /**
   * AudioBuffer → 单声道 Float32 @ targetSr（分块，长文件也不卡界面）
   * 降采样用 2 点线性插值；先做一次 2 点平均当简易抗混叠。
   */
  async function toMono(buf, onProgress, targetSr) {
    var sr = targetSr || SR;
    var ch = Math.min(2, buf.numberOfChannels || 1);
    var srcSr = buf.sampleRate;
    var srcLen = buf.length;
    var ratio = srcSr / sr;
    var n = Math.max(1, Math.floor(srcLen / ratio));
    var out = new Float32Array(n);
    var data = [];
    for (var c = 0; c < ch; c++) data.push(buf.getChannelData(c));
    var CHUNK = 200000;
    for (var start = 0; start < n; start += CHUNK) {
      var end = Math.min(n, start + CHUNK);
      for (var i = start; i < end; i++) {
        var pos = i * ratio;
        var i0 = pos | 0, frac = pos - i0;
        var acc = 0;
        for (var k = 0; k < ch; k++) {
          var d = data[k];
          var a = d[i0] || 0, b = d[i0 + 1] || 0;
          // 平均两点 → 一点点低通，抑制折叠噪声
          acc += (a + b) * 0.5 + ((b - a) * 0.5) * frac;
        }
        out[i] = acc / ch;
      }
      if (onProgress) onProgress(0.05 * (end / n), '重采样');
      await nextTick();
    }
    return out;
  }

  /* ================= 频谱特征 ================= */

  /**
   * 逐帧算特征（不存完整频谱，省内存）：
   *   bands[b][f]  8 段能量（幅度）
   *   flux[f]      谱通量（只有上升沿）
   *   centroid[f]  谱质心（Hz）
   *   flat[f]      谱平坦度（噪声性 / 音调性）
   */
  async function spectralFeatures(mono, onProgress) {
    var nFrames = Math.max(1, Math.floor((mono.length - FFT_N) / HOP) + 1);
    var bands = [];
    for (var b = 0; b < BAND_EDGES.length - 1; b++) bands.push(new Float32Array(nFrames));
    var flux = new Float32Array(nFrames);
    var centroid = new Float32Array(nFrames);
    var flat = new Float32Array(nFrames);

    var binOf = function (hz) { return Math.max(1, Math.min(FFT_N / 2 - 1, Math.round(hz * FFT_N / SR))); };
    var ranges = [];
    for (var i = 0; i < BAND_EDGES.length - 1; i++) {
      ranges.push([binOf(BAND_EDGES[i]), Math.max(binOf(BAND_EDGES[i]) + 1, binOf(BAND_EDGES[i + 1]))]);
    }

    var re = new Float32Array(FFT_N), im = new Float32Array(FFT_N);
    var prevMag = new Float32Array(FFT_N / 2);
    var mag = new Float32Array(FFT_N / 2);

    for (var f = 0; f < nFrames; f++) {
      var off = f * HOP;
      for (var s = 0; s < FFT_N; s++) {
        re[s] = (mono[off + s] || 0) * WIN[s];
        im[s] = 0;
      }
      fftRun(FFT, re, im);

      var fl = 0, cenNum = 0, cenDen = 0, logSum = 0, linSum = 0, cnt = 0;
      for (var k = 1; k < FFT_N / 2; k++) {
        var m = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
        mag[k] = m;
        var dm = m - prevMag[k];
        if (dm > 0) fl += dm;
        cenNum += m * (k * SR / FFT_N);
        cenDen += m;
        if (m > 1e-4) { logSum += Math.log(m); linSum += m; cnt++; }
      }
      for (i = 0; i < ranges.length; i++) {
        var sum = 0, r = ranges[i];
        for (k = r[0]; k < r[1]; k++) sum += mag[k];
        bands[i][f] = sum;
      }
      flux[f] = fl;
      centroid[f] = cenDen > 1e-6 ? cenNum / cenDen : 0;
      flat[f] = cnt > 8 ? Math.exp(logSum / cnt) / (linSum / cnt) : 0;
      prevMag.set(mag);

      if ((f & 255) === 0) {
        if (onProgress) onProgress(0.05 + 0.55 * (f / nFrames), '频谱分析');
        await nextTick();
      }
    }
    return { nFrames: nFrames, bands: bands, flux: flux, centroid: centroid, flat: flat };
  }

  /* ================= 起音检测（分频段） =================
   * ⚠️ 为什么不是「一条总包络 + 单标签分类」：
   *   真实鼓组里底鼓和闭镲几乎总在同一拍上响。用总包络做峰值挑选，
   *   同刻的两个音会被「最短间隔」吃掉一个 —— 实测合成样例里
   *   8 个底鼓 + 8 个军鼓全被当成镲，只剩镲。
   *   所以按低频/中频/高频各自检测起音，再合并事件：
   *   同刻的「底鼓 + 闭镲」会同时保留，谱面才对得上。
   */

  /** 每组的原始能量包络（幅度和） */
  function groupEnvelopes(feat) {
    var out = {};
    Object.keys(GROUPS).forEach(function (g) {
      var idx = GROUPS[g].bands;
      var env = new Float32Array(feat.nFrames);
      for (var f = 0; f < feat.nFrames; f++) {
        var s = 0;
        for (var i = 0; i < idx.length; i++) s += feat.bands[idx[i]][f];
        env[f] = s;
      }
      out[g] = env;
    });
    return out;
  }

  /** 起音函数：能量的一阶正差分（只留上升沿）；第 0 帧按「从静音起跳」算 */
  function onsetFunction(env) {
    var out = new Float32Array(env.length);
    out[0] = env[0] > 0 ? env[0] : 0;
    for (var i = 1; i < env.length; i++) {
      var d = env[i] - env[i - 1];
      out[i] = d > 0 ? d : 0;
    }
    return out;
  }

  /**
   * 自适应阈值 + 局部极大 + 非极大抑制。
   * @returns Array<{f, t, raw, strength}>
   */
  function detectOnsets(fn, opts) {
    opts = opts || {};
    var nF = fn.length;
    var win = Math.round(FPS * (opts.winSec || 0.5));
    var minGap = Math.max(2, Math.round(FPS * (opts.minGapSec || 0.04)));
    var cands = [];
    /* 绝对下限：安静的段落里 mean/std 都接近 0，纯自适应阈值会放各种底噪进来
       （实测会多出一堆假军鼓），所以再压一条相对全曲 p99 的地板线。 */
    var floor = pct(fn, 0.99) * 0.03;

    for (var f = 0; f < nF - 2; f++) {
      // 从第 0 帧开始：曲子第一个音就落在开头时（f=0 前面补一个 0）也能命中
      var prev = f > 0 ? fn[f - 1] : 0;
      if (!(fn[f] > prev)) continue;
      if (!(fn[f] >= fn[f + 1])) continue;
      var lo = Math.max(0, f - win), hi = Math.min(nF, f + win);
      var sum = 0, sum2 = 0, cnt = 0;
      for (var i = lo; i < hi; i += 4) { sum += fn[i]; sum2 += fn[i] * fn[i]; cnt++; }
      var mean = cnt ? sum / cnt : 0;
      var std = cnt ? Math.sqrt(Math.max(0, sum2 / cnt - mean * mean)) : 0;
      var thr = Math.max(mean + Math.max(std * 1.4, mean * 0.8), floor);
      if (fn[f] <= thr) continue;
      cands.push({ f: f, raw: fn[f], strength: fn[f] / (thr + 1e-9) });
    }

    // 非极大抑制：按强度降序，抢到位置的才留（同刻只留一个）
    cands.sort(function (a, b) { return b.raw - a.raw; });
    var picked = [];
    cands.forEach(function (c) {
      for (var i = 0; i < picked.length; i++) {
        if (Math.abs(picked[i].f - c.f) < minGap) return;
      }
      picked.push(c);
    });
    picked.sort(function (a, b) { return a.f - b.f; });
    picked.forEach(function (c) { c.t = c.f * HOP / SR; });
    return picked;
  }

  /**
   * 检测「打击事件」，并对每个事件判定它由哪些乐器同时触发（可能 1~2 个）。
   *
   * 为什么这么设计：
   *   · 用一条**三组归一化后相加**的总起音函数挑峰 → 同刻的底鼓+闭镲只算「一个事件」，
   *     不会被最短间隔吃掉；
   *   · 再用该帧的低/中/高频能量占比判定这个事件由谁发响：
   *     低频占比高 → 底鼓（或嗵鼓），中频占比高 → 军鼓，高频占比高 → 镲。
   *     于是「底鼓 + 闭镲」同刻会产出两个音，谱面才和真实演奏一致。
   *   · 军鼓自带大量高频噪声，所以中频判定为军鼓时，只有高频占比足够高（>=0.55）
   *     才额外加一个镲 —— 否则会把军鼓自己的亮度误判成一下闭镲。
   */
  function detectHits(feat, genv) {
    var nF = feat.nFrames, f, g;
    var fns = {}, norm = {};
    Object.keys(GROUPS).forEach(function (gk) {
      fns[gk] = onsetFunction(genv[gk]);
      norm[gk] = pct(fns[gk], 0.9) || 1;      // 三组等权：按各自 p90 归一
    });
    var mixed = new Float32Array(nF);
    for (f = 0; f < nF; f++) {
      mixed[f] = fns.low[f] / norm.low + fns.mid[f] / norm.mid + fns.high[f] / norm.high;
    }
    var evs = detectOnsets(mixed, { minGapSec: 0.032, winSec: 0.5 });

    var out = [];
    evs.forEach(function (e) {
      var tot = 0, gl = 0, gm = 0, gh = 0, b, i;
      for (b = 0; b < 8; b++) tot += feat.bands[b][e.f];
      for (i = 0; i < GROUPS.low.bands.length; i++) gl += feat.bands[GROUPS.low.bands[i]][e.f];
      for (i = 0; i < GROUPS.mid.bands.length; i++) gm += feat.bands[GROUPS.mid.bands[i]][e.f];
      for (i = 0; i < GROUPS.high.bands.length; i++) gh += feat.bands[GROUPS.high.bands[i]][e.f];
      tot = Math.max(tot, 1e-9);
      var sh = { low: gl / tot, mid: gm / tot, high: gh / tot };

      var notes = [];
      var isSnare = sh.mid >= 0.24 && sh.low < 0.6;
      if (sh.low >= 0.25) notes.push(classifyLow(feat, e.f));
      if (isSnare) notes.push(classifyMid(feat, e.f));
      /* 镲：高频占比过线就加。军鼓自带高频亮度，但真实鼓组里「军鼓 + 闭镲」几乎总
         一起响（八分镲铺满），所以门槛压到 0.40；更低才算军鼓自己的亮度丢掉。
         代价：底鼓很响时会把同刻闭镲挤到 0.4 以下而漏掉 —— 宁可少画不多画，
         谱面上多出来的假鼓点比漏掉的更烦人，用户补一下也快。 */
      if (sh.high >= 0.28 && !(isSnare && sh.high < 0.40)) notes.push(classifyHigh(feat, e.f));
      if (!notes.length) notes.push(classifyByShare(feat, e.f, sh));

      out.push({ f: e.f, t: e.t, strength: e.strength, shares: sh, notes: notes });
    });

    // 力度：按全体事件的起音强度 p90 归一，别让某一组把别的组压平
    var p90 = pct(out.map(function (o) { return o.strength; }), 0.9) || 1;
    out.forEach(function (o) { o.vel = U.clamp(0.4 + 0.6 * (o.strength / p90), 0.35, 1); });
    return out;
  }

  /* ================= 速度估计 ================= */

  /**
   * 起音包络自相关 + 对数速度先验。
   * conf 是「主峰相对全区间中位数」的显著度，用来提示半速/倍速歧义。
   */
  function estimateTempo(feat, onsets) {
    var nF = feat.nFrames;
    var env = new Float32Array(nF);
    onsets.forEach(function (o) { env[o.f] += o.strength; });
    var mean = 0;
    for (var i = 0; i < nF; i++) mean += env[i];
    mean /= Math.max(1, nF);
    for (i = 0; i < nF; i++) env[i] -= mean;

    var minBpm = 50, maxBpm = 210;
    var lagMin = Math.max(2, Math.round(FPS * 60 / maxBpm));
    var lagMax = Math.min(nF >> 1, Math.round(FPS * 60 / minBpm));
    var best = { lag: 0, score: -Infinity };
    var scores = [];
    var scoreByLag = {};
    for (var lag = lagMin; lag <= lagMax; lag++) {
      var s = 0;
      for (i = 0; i + lag < nF; i++) s += env[i] * env[i + lag];
      s /= Math.max(1, nF - lag);
      var bpm = 60 * FPS / lag;
      // 对数正态先验：120 BPM 附近最可信
      var w = Math.exp(-0.5 * Math.pow(Math.log(bpm / 120) / 0.75, 2));
      var sc = s * w;
      scores.push({ lag: lag, bpm: bpm, s: s, score: sc });
      scoreByLag[lag] = sc;
      if (sc > best.score) best = { lag: lag, score: sc, bpm: bpm, s: s };
    }
    if (best.score === -Infinity) return { bpm: 120, conf: 0, ambiguous: false };

    /**
     * 半速/倍速歧义：自相关在 lag、2×lag、4×lag 上都会出现峰（因为都是周期的整数倍），
     * 而 2 拍 / 4 拍的峰往往还更强 —— 只取最大值会系统性地选到「半速」
     * （实测 100 BPM 的四拍鼓被估成 50 BPM、拍号跟着变成 2/4）。
     * 规则：凡是「更快的、分数仍在该峰 90% 以内」的候选，优先选它；
     * 上限 190 BPM，避免一路折到八分音符上。
     */
    var fastest = best.lag;
    for (var k = 2; k <= 4; k++) {
      var lagK = Math.round(best.lag / k);
      if (lagK < lagMin) break;
      var scK = scoreByLag[lagK];
      if (scK !== undefined && scK >= best.score * 0.9 && 60 * FPS / lagK <= 190) {
        fastest = lagK;
      }
    }
    if (fastest !== best.lag) {
      best = { lag: fastest, score: scoreByLag[fastest], bpm: 60 * FPS / fastest,
               s: (function () {
                 var ss = 0;
                 for (var j = 0; j + fastest < nF; j++) ss += env[j] * env[j + fastest];
                 return ss / Math.max(1, nF - fastest);
               })() };
    }

    function acfAt(lag2) {
      if (lag2 < 2 || lag2 >= nF) return 0;
      var ss = 0;
      for (var j = 0; j + lag2 < nF; j++) ss += env[j] * env[j + lag2];
      return ss / Math.max(1, nF - lag2);
    }
    var peakS = best.s;
    // 基线取「中位数」并夹一个下限：去均值后的自相关在很多滞后上是负的，
    // 直接用中位数做分母会算出负比值，置信度会被恒判成 0。
    var md = Math.max(median(scores.map(function (x) { return x.s; })), peakS * 0.15, 1e-9);
    var sHalf = acfAt(Math.round(best.lag * 2));      // 更慢（半速）
    var sDouble = acfAt(Math.round(best.lag / 2));    // 更快（倍速）
    var ambig = Math.max(sHalf, sDouble) / (peakS || 1e-9);

    return {
      bpm: Math.round(best.bpm * 10) / 10,
      conf: U.clamp((peakS / md - 1) / 2, 0, 1),
      ambiguous: ambig > 0.82,
      lag: best.lag
    };
  }

  /* ================= 拍点跟踪 ================= */

  /**
   * 给定 BPM：先在整段上搜最佳相位，再把每个拍点吸到附近的起音峰上，
   * 最后用最小二乘拟合一条直线（拍号 k → 帧），拿到稳定的拍点序列。
   */
  function trackBeats(feat, onsets, bpm) {
    var period = 60 * FPS / bpm;
    var nF = feat.nFrames;
    var env = new Float32Array(nF);
    onsets.forEach(function (o) { env[o.f] += o.strength; });

    var bestPhase = 0, bestScore = -Infinity;
    var step = Math.max(0.25, period / 64);
    for (var ph = 0; ph < period; ph += step) {
      var sc = 0, cnt = 0;
      for (var pos = ph; pos < nF; pos += period) {
        var c = Math.round(pos), v = 0;
        for (var d = -2; d <= 2; d++) {
          var idx = c + d;
          if (idx >= 0 && idx < nF) v = Math.max(v, env[idx]);
        }
        sc += v; cnt++;
      }
      sc /= Math.max(1, cnt);
      if (sc > bestScore) { bestScore = sc; bestPhase = ph; }
    }

    var pairs = [];
    var k = 0;
    for (var pos2 = bestPhase; pos2 < nF; pos2 += period, k++) {
      var c0 = Math.round(pos2);
      var win = Math.max(2, Math.round(period * 0.14));
      var bestI = -1, bestV = 0;
      for (var i = c0 - win; i <= c0 + win; i++) {
        if (i < 0 || i >= nF) continue;
        if (env[i] > bestV) { bestV = env[i]; bestI = i; }
      }
      if (bestI >= 0 && bestV > 0) pairs.push({ k: k, f: bestI });
    }

    var a = bestPhase, b = period;
    for (var it = 0; it < 2; it++) {
      var sx = 0, sy = 0, sxx = 0, sxy = 0, used = 0;
      var resid = pairs.map(function (p) { return Math.abs(p.f - (a + b * p.k)); });
      var medR = median(resid) || 1;
      var lim = Math.max(1.5, medR * 2.5);
      pairs.forEach(function (p, idx) {
        if (resid[idx] > lim) return;
        sx += p.k; sy += p.f; sxx += p.k * p.k; sxy += p.k * p.f; used++;
      });
      if (used > 2) {
        var den = used * sxx - sx * sx;
        if (Math.abs(den) > 1e-9) {
          b = (used * sxy - sx * sy) / den;
          a = (sy - b * sx) / used;
        }
      }
    }

    var beats = [], residual = [];
    for (k = 0; ; k++) {
      var f2 = a + b * k;
      if (f2 > nF - 1) break;
      if (f2 < 0) continue;
      beats.push(f2 * HOP / SR);
      residual.push(Math.abs(f2 - Math.round(f2)));
    }
    return {
      beats: beats,
      spb: b / FPS,
      bpm: 60 / (b / FPS),
      residualMs: median(residual) * HOP / SR * 1000
    };
  }

  /* ================= 拍号 / 小节相位 ================= */

  function detectMeter(feat, onsets, beatTimes, spb) {
    var nF = feat.nFrames;
    var accent = beatTimes.map(function (t) {
      var c = Math.round(t * SR / HOP);
      var v = 0;
      for (var i = Math.max(0, c - 3); i <= Math.min(nF - 1, c + 3); i++) {
        v += (feat.bands[0][i] + feat.bands[1][i]) * 0.6 + feat.flux[i] * 0.4;
      }
      return v;
    });
    var total = 0;
    accent.forEach(function (v) { total += v; });
    if (!accent.length || total <= 0) return { num: 4, den: 4, phase: 0, conf: 0 };

    /* 候选只留 4/4 与 3/4。
       2/4 看着「更规整」是因为底鼓在第 1、3 拍、军鼓在 2、4 拍时，
       「每 2 拍一个重音」的周期确实比 4 拍更干净 —— 实测把一首 4/4 抒情歌
       判成 2/4，小节数直接翻倍（171 小节 vs 86 小节）。流行乐里 2/4 极少，
       所以默认 4/4，只有当 3/4 明显更规整时才让步。 */
    var cands = [4, 3];
    var best = { num: 4, phase: 0, conf: 0, score: -1 };
    var bestOf = {};
    cands.forEach(function (m) {
      if (accent.length < m * 2) return;
      for (var ph = 0; ph < m; ph++) {
        var s1 = 0, c1 = 0, s0 = 0, c0 = 0;
        for (var i = 0; i < accent.length; i++) {
          if ((i - ph) % m === 0) { s1 += accent[i]; c1++; }
          else { s0 += accent[i]; c0++; }
        }
        var m1 = s1 / Math.max(1, c1), m0 = s0 / Math.max(1, c0);
        var sc = (m1 - m0) / (m1 + m0 + 1e-9);
        if (!bestOf[m] || sc > bestOf[m].score) bestOf[m] = { num: m, phase: ph, score: sc };
        if (sc > best.score) best = { num: m, phase: ph, score: sc, conf: U.clamp(sc * 2.2, 0, 1) };
      }
    });
    if (best.num === 3 && bestOf[4] && best.score < bestOf[4].score + 0.06) {
      // 3/4 优势不明显 → 按 4/4（附带把拍号相位换回 4 拍的最优值）
      best = { num: 4, phase: bestOf[4].phase, score: bestOf[4].score, conf: U.clamp(bestOf[4].score * 2.2, 0, 1) };
    }
    return { num: best.num, den: 4, phase: best.phase, conf: best.conf };
  }

  /* ================= 鼓分类 ================= */

  /** 该帧某组能量从峰值落到 30% 需要多久（秒）—— 分闭镲/开镲/碎音镲的关键特征 */
  function decayOf(feat, f, groups) {
    var dom = groups.bands[0], domV = -1, i;
    for (i = 0; i < groups.bands.length; i++) {
      var b = groups.bands[i];
      var dv = feat.bands[b][f] - feat.bands[b][Math.max(0, f - 2)];
      if (dv > domV) { domV = dv; dom = b; }
    }
    var peak = feat.bands[dom][f], decay = 0.45, nF = feat.nFrames;
    for (i = f; i < Math.min(nF, f + Math.round(FPS * 0.45)); i++) {
      if (feat.bands[dom][i] < peak * 0.3) { decay = (i - f) / FPS; break; }
    }
    return decay;
  }

  function classifyLow(feat, f) {
    var decay = decayOf(feat, f, GROUPS.low);
    // ⚠️ 不要用全谱质心判底鼓/嗵鼓：底鼓的击打瞬态含大量宽带噪声，
    // 起音那一帧的质心经常被抬到 300Hz 以上，底鼓会被误判成嗵鼓。
    // 改看低频内部的重心：能量偏 80–160Hz 才像嗵鼓，压在 20–80Hz 就是底鼓。
    var i = Math.min(feat.nFrames - 1, f + 2);
    var b0 = feat.bands[0][i], b1 = feat.bands[1][i];
    var hiBias = b1 / (b0 + b1 + 1e-9);
    if (hiBias > 0.55 && decay > 0.13) {
      return { id: hiBias > 0.75 ? 'tomMid' : 'tomLow', conf: 0.55 };
    }
    return { id: 'kick', conf: 0.85 };
  }

  function classifyMid(feat, f) {
    var decay = decayOf(feat, f, GROUPS.mid);
    var cen = feat.centroid[f];
    if (cen < 300 && decay > 0.17) return { id: cen < 200 ? 'tomLow' : 'tomMid', conf: 0.5 };
    return { id: 'snare', conf: 0.8 };
  }

  function classifyHigh(feat, f) {
    var decay = decayOf(feat, f, GROUPS.high);
    var flat = feat.flat[f];
    if (decay >= 0.24) return { id: flat > 0.18 ? 'crash' : 'ride', conf: 0.6 };
    if (decay >= 0.09) return { id: 'hihatOpen', conf: 0.7 };
    return { id: 'hihatClosed', conf: 0.82 };
  }

  /** 三个占比都没过线时兜底：按最大占比对应到最接近的乐器 */
  function classifyByShare(feat, f, sh) {
    if (sh.low >= sh.mid && sh.low >= sh.high) return classifyLow(feat, f);
    if (sh.mid >= sh.high) return classifyMid(feat, f);
    return classifyHigh(feat, f);
  }

  /* ================= 量化 ================= */

  function quantizeBeat(t, spb, gridBeats) {
    return Math.round(t / spb / gridBeats) * gridBeats;
  }

  /* ================= 贝斯音高跟踪（P2） =================
   * 贝斯是单声部，用 YIN（CMNDF）就够，不需要复音检测：
   *   1. 单独降采样到 11k（贝斯基频 30–400Hz，用不到高频）
   *   2. 每帧 FFT → 功率谱 → 再 FFT 得到自相关（比时域 O(N·L) 快一个量级）
   *   3. 用累积均值归一化差分函数（CMNDF）挑第一个可信谷点 → f0
   *   4. 逐帧 f0 → 中值滤波去毛刺 → 同音高连续帧合成音符
   */
  var BASS_SR = 11025;
  var BASS_WIN = 1024;        // 93ms
  var BASS_HOP = 512;         // 46ms
  var BASS_FFT_N = 2048;      // ≥ 2×WIN，保证是线性（非循环）自相关
  var BASS_F0_MIN = 30;
  var BASS_F0_MAX = 480;

  var BASS_FFT = makeFFT(BASS_FFT_N);
  var BASS_WIN_FN = new Float32Array(BASS_WIN);
  for (var bi2 = 0; bi2 < BASS_WIN; bi2++) {
    BASS_WIN_FN[bi2] = 0.5 - 0.5 * Math.cos(2 * Math.PI * bi2 / (BASS_WIN - 1));
  }

  /** 滞后（采样点）→ 频率，带抛物线插值压量化误差 */
  function lagToF0(lag, d, lagMin, lagMax) {
    if (!(lag > 0)) return 0;
    if (lag > lagMin && lag < lagMax) {
      var y0 = d[lag - 1], y1 = d[lag], y2 = d[lag + 1];
      var den = (y0 - 2 * y1 + y2);
      var shift = Math.abs(den) > 1e-12 ? 0.5 * (y0 - y2) / den : 0;
      return BASS_SR / (lag + U.clamp(shift, -0.5, 0.5));
    }
    return BASS_SR / lag;
  }

  /** 逐帧基频：返回 [{f0, conf, rms, alt}]（alt = 八度备选，给 Viterbi 用）。
   *  opts.f0Min / opts.f0Max 可改音域：贝斯 30–480Hz，人声要放宽到 70–1000Hz。 */
  async function pitchFrames(mono, onProgress, opts) {
    opts = opts || {};
    var f0Min = opts.f0Min || BASS_F0_MIN;
    var f0Max = opts.f0Max || BASS_F0_MAX;
    var label = opts.label || '基频';
    var nF = Math.max(1, Math.floor((mono.length - BASS_WIN) / BASS_HOP) + 1);
    var out = new Array(nF);
    var re = new Float32Array(BASS_FFT_N), im = new Float32Array(BASS_FFT_N);
    var lagMin = Math.max(2, Math.floor(BASS_SR / f0Max));
    var lagMax = Math.min(BASS_WIN - 1, Math.ceil(BASS_SR / f0Min));
    var d = new Float32Array(lagMax + 2);

    for (var f = 0; f < nF; f++) {
      var off = f * BASS_HOP, s;
      for (s = 0; s < BASS_FFT_N; s++) {
        re[s] = s < BASS_WIN ? (mono[off + s] || 0) * BASS_WIN_FN[s] : 0;
        im[s] = 0;
      }
      fftRun(BASS_FFT, re, im);
      var r0 = 0;
      for (s = 0; s < BASS_FFT_N; s++) {
        var p = re[s] * re[s] + im[s] * im[s];
        if (s === 0) r0 = p;
        re[s] = p;
        im[s] = 0;
      }
      fftRun(BASS_FFT, re, im);        // 功率谱再变换 = 自相关（实偶序列，虚部≈0）
      var acf0 = re[0] / BASS_FFT_N;

      // CMNDF
      var cum = 0, best = -1, bestV = 1e9;
      for (var lag = 1; lag <= lagMax; lag++) {
        d[lag] = 2 * (acf0 - re[lag] / BASS_FFT_N);
        if (d[lag] < 0) d[lag] = 0;
        cum += d[lag];
        d[lag] = cum > 1e-12 ? d[lag] * lag / cum : 1;
      }
      // 第一个低于阈值的局部极小（YIN 的标准做法：取第一个，避免倍频）
      var chosen = -1;
      for (lag = lagMin; lag <= lagMax; lag++) {
        if (d[lag] < 0.16 && d[lag] <= d[lag - 1] && d[lag] <= d[lag + 1]) { chosen = lag; break; }
        if (d[lag] < bestV) { bestV = d[lag]; best = lag; }
      }
      if (chosen < 0) chosen = best;

      /* ---- HPS 式八度校验 ----
         YIN 的「第一个谷点」在噪声大时会落在真周期的 2 倍上（音高低八度），
         实测人声轨 599 个音里有 3 个掉到 C2。这里再检查更短的可能周期
         （半周期 = 高八度、2/3 = 高十二度）：只要它自己也是个够低的谷，
         就说明 chosen 是次谐波，改取更短的那个。 */
      var alt = 0;
      var candLag = chosen;
      var candD = d[chosen];
      [[0.5, 0], [2 / 3, 0], [0.75, 0]].forEach(function (r) {
        var L = Math.round(chosen * r);
        if (L < lagMin || L >= chosen) return;
        var dd = d[L];
        if (dd < 0.55 && dd <= candD + 0.15) { candLag = L; candD = dd; }
      });
      var pitchLag = candLag;
      // 备选（给 Viterbi 做八度二选一）：反过来那个周期
      if (candLag !== chosen) alt = chosen;
      else {
        var half = Math.round(chosen / 2);
        if (half >= lagMin && d[half] < 0.7) alt = half;
      }

      var conf = 1 - Math.min(1, d[chosen] || 1);
      var f0 = lagToF0(pitchLag, d, lagMin, lagMax);
      var f0Alt = alt > 0 ? lagToF0(alt, d, lagMin, lagMax) : 0;

      out[f] = { f0: f0, conf: f0 > 0 ? conf : 0, rms: Math.sqrt(Math.max(0, r0) / BASS_WIN), alt: f0Alt };

      if ((f & 255) === 0) {
        if (onProgress) onProgress(f / nF, label);
        await nextTick();
      }
    }
    return out;
  }

  /* ---- pYIN 式 Viterbi 音高平滑 ----
   * 旧版用「3 帧中值投票」：单帧八度跳变能被压掉，但连续好几帧的次谐波误判
   * （低音浑浑的贝斯、混响尾巴）压不掉，实测人声 599 音里 3 个掉到 C2。
   * 现在每帧给 1~2 个候选（主 + 八度备选），用 HMM 解码：
   *   发射代价 = 1 - conf；转移代价 ∝ 音高跳幅，八度跳变额外重罚，
   *   静音↔有声也有代价 —— 连续性和八度惩罚一起把孤立误判拉回来。 */
  function viterbiPitch(frames, opts) {
    opts = opts || {};
    var f0Min = opts.f0Min || BASS_F0_MIN;
    var f0Max = opts.f0Max || BASS_F0_MAX;
    var n = frames.length;
    if (!n) return [];
    var rmsAll = frames.map(function (x) { return x.rms; });
    var loud = pct(rmsAll, 0.9) || 1;
    var floor = loud * 0.10;

    // 每帧候选：空数组 = 静音
    var cands = new Array(n);
    var i, fr;
    for (i = 0; i < n; i++) {
      fr = frames[i];
      var list = [];
      if (fr.conf >= 0.4 && fr.rms > floor) {
        if (fr.f0 >= f0Min && fr.f0 <= f0Max) {
          list.push({ midi: Math.round(69 + 12 * Math.log2(fr.f0 / 440)), cost: (1 - fr.conf) * 0.8 });
        }
        if (fr.alt && fr.alt >= f0Min && fr.alt <= f0Max) {
          list.push({ midi: Math.round(69 + 12 * Math.log2(fr.alt / 440)), cost: (1 - fr.conf) * 0.8 + 0.18 });
        }
      }
      cands[i] = list;
    }

    var SIL = -1;                      // 静音状态
    var JUMP = 0.05;                   // 每半音跳变的代价
    var OCTAVE = 0.55;                 // 八度跳变额外代价（宁可不动，也别乱翻八度）
    var VOICE = 0.30;                  // 静音 ↔ 有声

    function trans(a, b) {
      if (a === SIL) return b === SIL ? 0 : VOICE;
      if (b === SIL) return VOICE;
      var d = Math.abs(a - b);
      var c = d * JUMP;
      if (d > 0 && d % 12 === 0) c += OCTAVE;      // 八度跳变重罚
      return c;
    }

    // DP：cost[i][state]、back[i][state]
    var prev = null, prevState = null, allCost = [], allBack = [];
    for (i = 0; i < n; i++) {
      var states = cands[i].length ? cands[i].map(function (c) { return c.midi; }) : [SIL];
      var cur = {}, back = {};
      states.forEach(function (s) {
        var emit = s === SIL ? 0.35 : (cands[i].filter(function (c) { return c.midi === s; })[0].cost);
        if (!prev) { cur[s] = emit; back[s] = SIL; return; }
        var bestV = Infinity, bestS = SIL;
        Object.keys(prev).forEach(function (ps) {
          var v = prev[ps] + trans(parseInt(ps, 10), s);
          if (v < bestV) { bestV = v; bestS = parseInt(ps, 10); }
        });
        cur[s] = bestV + emit;
        back[s] = bestS;
      });
      prev = cur;
      allCost.push(cur); allBack.push(back);
    }

    // 回溯
    var path = new Array(n);
    var last = null, lastV = Infinity;
    Object.keys(allCost[n - 1]).forEach(function (s) {
      if (allCost[n - 1][s] < lastV) { lastV = allCost[n - 1][s]; last = parseInt(s, 10); }
    });
    for (i = n - 1; i >= 0; i--) {
      path[i] = last === SIL ? null : last;      // 静音帧必须是 null，别把 -1 当音高
      last = allBack[i][last];
    }
    return path;                       // 每帧一个 midi（或 null）
  }

  /** 逐帧基频 → 音符（Viterbi 平滑后按音高分段）。
   *  opts.f0Min / opts.f0Max 与 pitchFrames 保持一致，否则人声会被贝斯音域剪掉。 */
  function pitchFramesToNotes(frames, opts) {
    var path = viterbiPitch(frames, opts);
    var n = path.length;
    if (!n) return [];

    var notes = [];
    var cur = null;
    for (var i = 0; i < n; i++) {
      var m = path[i];
      if (m === null || m === undefined) {
        if (cur) { cur.gap = (cur.gap || 0) + 1; if (cur.gap > 2) { notes.push(cur); cur = null; } }
        continue;
      }
      if (cur && cur.midi === m) {
        cur.endF = i;
        cur.gap = 0;
        cur.rmsMax = Math.max(cur.rmsMax, frames[i].rms);
      } else if (cur && cur.gap <= 2 && Math.abs(cur.midi - m) <= 1) {
        // 相邻半音的短抖动：并进前一个音（滑音/音准漂移）
        cur.endF = i;
        cur.gap = 0;
      } else {
        if (cur) notes.push(cur);
        cur = { midi: m, startF: i, endF: i, gap: 0, rmsMax: frames[i].rms };
      }
    }
    if (cur) notes.push(cur);

    // 帧 → 秒：用窗中心（窗覆盖 [off, off+WIN)，中心更能代表这一帧的音高）
    var toSec = function (f) { return (f * BASS_HOP + BASS_WIN / 2) / BASS_SR; };
    var minFrames = 2;      // 46ms×2 ≈ 92ms 以下当碎片丢掉
    return notes.filter(function (nt) { return nt.endF - nt.startF + 1 >= minFrames; })
      .map(function (nt) {
        return {
          midi: nt.midi,
          t: toSec(nt.startF),
          dur: Math.max(BASS_HOP / BASS_SR, toSec(nt.endF) + BASS_HOP / BASS_SR - toSec(nt.startF)),
          rms: nt.rmsMax
        };
      });
  }

  /* 人声基频范围：男低音 ~82Hz 到女高音 ~1kHz，留点余量 */
  var VOCAL_F0 = { f0Min: 70, f0Max: 1000, label: '人声音高' };

  /**
   * 单声部音高序列（贝斯 / 人声）→ 谱面音符。
   * 统一用鼓那套网格（bias / 小节相位），多轨才会真的对得上；
   * 同拍同音合并、前后重叠截断（单声部重叠会糊）。
   */
  function monoTrackNotes(raw, biasSec, phaseBeats, spb, grid) {
    var loud = pct(raw.map(function (n) { return n.rms; }), 0.9) || 1;
    var notes = [];
    raw.forEach(function (n) {
      var beat = (n.t - biasSec) / spb - phaseBeats;
      if (beat < -grid * 0.6) return;
      beat = Math.max(0, beat);
      notes.push({
        beat: Math.round(beat / grid) * grid,
        len: Math.max(grid, Math.round((n.dur / spb) / grid) * grid),
        pitch: n.midi,
        vel: Math.round(U.clamp(0.5 + 0.5 * (n.rms / loud), 0.4, 1) * 100) / 100,
        t: n.t,
        dur: n.dur
      });
    });
    notes.sort(function (a, b) { return a.beat - b.beat; });
    var dedup = [];
    notes.forEach(function (n) {
      var last = dedup[dedup.length - 1];
      if (last && Math.abs(last.beat - n.beat) < 1e-6 && last.pitch === n.pitch) {
        last.len = Math.max(last.len, n.len);
        return;
      }
      if (last && last.beat + last.len > n.beat + 1e-6) last.len = Math.max(grid, n.beat - last.beat);
      dedup.push(n);
    });
    return dedup;
  }

  /* ================= 和声：色度 → 和弦（P2） ================= */

  /**
   * 色度图（chroma）：每帧 12 个音级能量。
   * 窗 4096 / 步进 2048 @22050 —— 和弦变化的最小单位是一拍，93ms 的步进足够。
   */
  async function chromaFrames(mono, onProgress) {
    var N = 4096, HOP2 = 2048;
    var nF = Math.max(1, Math.floor((mono.length - N) / HOP2) + 1);
    var out = new Float32Array(nF * 12);
    var energy = new Float32Array(nF);
    var F = makeFFT(N);
    var win = new Float32Array(N);
    for (var i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
    var re = new Float32Array(N), im = new Float32Array(N);
    // 只用到 55Hz–4.2kHz 的频点
    var kLo = Math.max(1, Math.round(55 * N / SR));
    var kHi = Math.min(N / 2 - 1, Math.round(4200 * N / SR));
    var centOf = new Float32Array(N);
    for (var k = 0; k < N; k++) centOf[k] = 69 + 12 * Math.log2(Math.max(1e-6, k * SR / N) / 440);

    for (var f = 0; f < nF; f++) {
      var off = f * HOP2;
      for (var s = 0; s < N; s++) { re[s] = (mono[off + s] || 0) * win[s]; im[s] = 0; }
      fftRun(F, re, im);
      var base = f * 12, e = 0;
      for (k = kLo; k <= kHi; k++) {
        var mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
        if (mag < 1e-5) continue;
        var m = centOf[k];
        var near = Math.round(m);
        var pc = ((near % 12) + 12) % 12;
        // 离音级中心越远权重越低（减少相邻半音的涂抹）
        var w = mag * Math.max(0, 1 - Math.abs(m - near) * 1.6);
        out[base + pc] += w;
        e += mag;
      }
      energy[f] = e;
      if ((f & 127) === 0) {
        if (onProgress) onProgress(f / nF, '和声色度');
        await nextTick();
      }
    }
    return { frames: out, energy: energy, nFrames: nF };
  }

  /** 音级名（12 个，与 arranger 的 root 写法一致） */
  var PC_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  /** 用 arranger 的和弦库建模板（真值只有一份，别在这另写一套音程） */
  function chordTemplates() {
    var Q = (BS.arranger && BS.arranger.CHORD_QUALITIES) || {
      maj: { iv: [0, 4, 7] }, min: { iv: [0, 3, 7] }, dom7: { iv: [0, 4, 7, 10] },
      maj7: { iv: [0, 4, 7, 11] }, min7: { iv: [0, 3, 7, 10] }, sus4: { iv: [0, 5, 7] },
      dim: { iv: [0, 3, 6] }
    };
    // 只留流行乐里真正常见的六种，越少越不容易乱认
    var use = ['maj', 'min', 'dom7', 'maj7', 'min7', 'sus4', 'dim'];
    var list = [];
    use.forEach(function (q) {
      if (!Q[q]) return;
      for (var root = 0; root < 12; root++) {
        var v = new Float32Array(12);
        Q[q].iv.forEach(function (iv) { v[(root + iv) % 12] += 1; });
        v[root] += 0.25;                 // 根音加权：听感上根音最稳
        list.push({ root: root, quality: q, vec: v, iv: Q[q].iv });
      }
    });
    return list;
  }

  function cosine(a, b, off) {
    var dot = 0, na = 0, nb = 0;
    for (var i = 0; i < 12; i++) {
      var x = a[off + i], y = b[i];
      dot += x * y; na += x * x; nb += y * y;
    }
    return dot / (Math.sqrt(na * nb) + 1e-9);
  }

  /** Krumhansl-Schmuckler 调性判定（大/小调各 12 个旋转） */
  function detectKey(chroma, nFrames) {
    var MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
    var MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
    var sum = new Float32Array(12);
    for (var f = 0; f < nFrames; f++) for (var i = 0; i < 12; i++) sum[i] += chroma[f * 12 + i];
    var best = { root: 0, mode: 'major', score: -Infinity };
    for (var root = 0; root < 12; root++) {
      ['major', 'minor'].forEach(function (mode) {
        var prof = mode === 'major' ? MAJ : MIN;
        var v = new Float32Array(12);
        for (var j = 0; j < 12; j++) v[j] = prof[(j - root + 12) % 12];
        var sc = cosine(sum, v, 0);
        if (sc > best.score) best = { root: root, mode: mode, score: sc };
      });
    }
    return { root: PC_NAMES[best.root], pc: best.root, mode: best.mode, score: best.score };
  }

  /**
   * 逐拍判和弦 → 合并成段。
   * bassPcByBeat 参与投票：贝斯根音是很强的先验（多轨互验）。
   */
  function detectChords(chroma, nFrames, beatTimes, spb, barBeats, bassPcByBeat) {
    var T = chordTemplates();
    var framesPerSec = (nFrames > 1) ? 1 : 0;
    var dur = nFrames * 2048 / SR;
    var fps2 = nFrames / Math.max(1e-6, dur);

    var best = [];
    for (var bi = 0; bi < beatTimes.length; bi++) {
      var t0 = beatTimes[bi];
      var t1 = (bi + 1 < beatTimes.length) ? beatTimes[bi + 1] : t0 + spb;
      var f0 = Math.max(0, Math.floor(t0 * fps2));
      var f1 = Math.min(nFrames, Math.max(f0 + 1, Math.ceil(t1 * fps2)));
      var v = new Float32Array(12);
      for (var f = f0; f < f1; f++) for (var i = 0; i < 12; i++) v[i] += chroma[f * 12 + i];
      var tot = 0;
      for (i = 0; i < 12; i++) tot += v[i];
      if (tot < 1e-6) { best.push(null); continue; }

      var bassPc = bassPcByBeat && bassPcByBeat[bi];
      var top = { score: -2 }, second = -2;
      T.forEach(function (tpl) {
        var sc = cosine(v, tpl.vec, 0);
        // 贝斯根音一致 → 加分（和声与低音互验）
        if (bassPc !== undefined && bassPc !== null) {
          if (tpl.root === bassPc % 12) sc += 0.10;
        }
        if (sc > top.score) { second = top.score; top = { score: sc, tpl: tpl }; }
        else if (sc > second) second = sc;
      });
      best.push({ tpl: top.tpl, score: top.score, margin: top.score - second });
    }

    // 平滑：夹在两个相同和弦中间的「孤点」按邻居改（和弦很少只响一拍）
    for (var k = 1; k < best.length - 1; k++) {
      var a = best[k - 1], b = best[k], c = best[k + 1];
      if (a && b && c && a.tpl.root === c.tpl.root && a.tpl.quality === c.tpl.quality &&
          (b.tpl.root !== a.tpl.root || b.tpl.quality !== a.tpl.quality)) {
        best[k] = { tpl: a.tpl, score: b.score, margin: b.margin };
      }
    }

    // 合并成段
    var segs = [];
    for (k = 0; k < best.length; k++) {
      var cur = best[k];
      if (!cur) continue;
      var last = segs[segs.length - 1];
      if (last && last.root === cur.tpl.root && last.quality === cur.tpl.quality &&
          Math.abs(last.endBeat - k) < 1e-6) {
        last.endBeat = k + 1;
        last.score = Math.max(last.score, cur.score);
      } else {
        segs.push({
          startBeat: k, endBeat: k + 1,
          t0: beatTimes[k], t1: (k + 1 < beatTimes.length) ? beatTimes[k + 1] : beatTimes[k] + spb,
          root: cur.tpl.root, quality: cur.tpl.quality,
          rootName: PC_NAMES[cur.tpl.root], score: cur.score, margin: cur.margin
        });
      }
    }
    // 合并后的段按最终 endBeat 重算结束时刻（合并时 t1 还是旧的）
    segs.forEach(function (s) {
      s.t0 = beatTimes[Math.min(s.startBeat, beatTimes.length - 1)];
      s.t1 = s.endBeat < beatTimes.length ? beatTimes[s.endBeat] : s.t0 + (s.endBeat - s.startBeat) * spb;
    });

    // 每小节取「占拍数最多」的和弦（arranger 的和弦轨一个小节只有一个和弦）
    var perBar = chordsPerBar(segs, barBeats, Math.ceil(beatTimes.length / barBeats));

    return { segments: segs, perBar: perBar };
  }

  /**
   * 段 → 每小节一个和弦（arranger 的和弦轨就是「一小节一个」）。
   * 取该小节内占拍数最多的那个；一小节换两次和弦时只保留主和弦，
   * 变化本身仍在 segments / pad 轨里（pad 是逐段铺的，不受这个限制）。
   */
  function chordsPerBar(segs, barBeats, maxBars) {
    var out = [];
    var lastEnd = 0;
    segs.forEach(function (s) { lastEnd = Math.max(lastEnd, s.endBeat); });
    var bars = maxBars || Math.ceil(lastEnd / barBeats);
    for (var bar = 0; bar < bars; bar++) {
      var b0 = bar * barBeats, b1 = b0 + barBeats;
      var vote = {}, win = null;
      segs.forEach(function (s) {
        var overlap = Math.min(s.endBeat, b1) - Math.max(s.startBeat, b0);
        if (overlap <= 0) return;
        var key = s.rootName + '|' + s.quality;
        if (!vote[key]) vote[key] = { len: 0, seg: s };
        vote[key].len += overlap;
      });
      Object.keys(vote).forEach(function (k) { if (!win || vote[k].len > win.len) win = vote[k]; });
      if (win) out.push({ bar: bar, root: win.seg.rootName, quality: win.seg.quality, beats: win.len });
    }
    return out;
  }

  /** 和弦段 → 铺底 pad 音符（三/四音，声部落在 C3–C5 附近，避免和贝斯撞） */
  function padNotesFromSegments(segs, grid, totalBeats) {
    var out = [];
    segs.forEach(function (s) {
      var iv = ((BS.arranger && BS.arranger.CHORD_QUALITIES[s.quality]) || { iv: [0, 4, 7] }).iv;
      var len = Math.min(s.endBeat, totalBeats) - s.startBeat;
      if (len <= 1e-6) return;
      // 根音放到 48..59（C3–B3），音程往上叠
      var rootPitch = 48 + ((s.root % 12));
      iv.forEach(function (step) {
        var p = rootPitch + step;
        while (p > 76) p -= 12;
        out.push({
          beat: Math.round(s.startBeat / grid) * grid,
          len: Math.max(grid, Math.round((len - 0.02) / grid) * grid),
          pitch: p, vel: 0.62
        });
      });
    });
    return out;
  }

  /* ================= 复音转写：谐波显著性 + 基频校验（P0） =================
   * 钢琴 / 吉他 / 其他 这类分轨是多音的， chroma→和弦 只能给「和弦块」，
   * 编曲页没法逐音编辑。这里用经典 DSP 路线（不引神经网络、不引第三方库）：
   *   1. STFT（4096/1024 @22050，93ms 窗、46ms 步进）
   *   2. 每个 MIDI 音高算「谐波显著性」：基频 + 2~5 次谐波的能量加权和
   *      （权重递减，抑制高次谐波把高音“染”出来）
   *   3. 逐帧自适应阈值 + 迟滞出音符段
   *   4. 基频校验：八度假象（只响了高八度、低八度被谐波能量带出来）靠
   *      「基频处是否真有谱峰」判掉 —— specAt(f0) 相对 2f0/3f0 太小就丢
   */
  var HARM_WIN = 4096, HARM_HOP = 1024;
  var HARM_FFT = makeFFT(HARM_WIN);
  var HARM_WINF = new Float32Array(HARM_WIN);
  for (var hi3 = 0; hi3 < HARM_WIN; hi3++) {
    HARM_WINF[hi3] = 0.5 - 0.5 * Math.cos(2 * Math.PI * hi3 / (HARM_WIN - 1));
  }

  /** 角色 → 音域（MIDI）。吉他不写低音，钢琴可以下到 A2 */
  var HARM_RANGE = {
    piano: [33, 96], guitar: [40, 84], other: [33, 88]
  };
  var HARM_W = [1, 0.6, 0.45, 0.35, 0.3];   // 谐波权重

  /**
   * 逐帧音高显著性图。
   * @returns {{sal: Float32Array, fund: Float32Array, nF: number, pitches: number[], t0: number}}
   *   sal[f*pn + i] = 归一化显著性；fund[...] = 基频谱峰相对强度（八度校验用）
   */
  async function harmonicFrames(mono, range, onProgress) {
    var nBins = HARM_WIN / 2;
    var nF = Math.max(1, Math.floor((mono.length - HARM_WIN) / HARM_HOP) + 1);
    var lo = range ? range[0] : 33, hi = range ? range[1] : 96;
    var pitches = [];
    for (var p = lo; p <= hi; p++) pitches.push(p);
    var pn = pitches.length;
    var sal = new Float32Array(nF * pn);
    var fund = new Float32Array(nF * pn);

    var re = new Float32Array(HARM_WIN), im = new Float32Array(HARM_WIN);
    var mag = new Float32Array(nBins);

    for (var f = 0; f < nF; f++) {
      var off = f * HARM_HOP, s;
      for (s = 0; s < HARM_WIN; s++) {
        re[s] = (mono[off + s] || 0) * HARM_WINF[s];
        im[s] = 0;
      }
      fftRun(HARM_FFT, re, im);
      for (s = 1; s < nBins; s++) {
        mag[s] = Math.sqrt(re[s] * re[s] + im[s] * im[s]);
      }
      mag[0] = 0;

      // 幅度谱 → 只在需要的频点取值，用多点取峰扛调音误差
      var specAt = function (freq) {
        var b = freq * HARM_WIN / SR;
        var i0 = b | 0;
        if (i0 < 1 || i0 >= nBins - 1) return 0;
        var a = mag[i0 - 1], c = mag[i0], d = mag[i0 + 1];
        // 低音区桶宽占比大，多取两格
        if (b < 220) {
          var e = mag[i0 + 2] || 0, g = i0 >= 2 ? mag[i0 - 2] : 0;
          return Math.max(a, g, c, d, e);
        }
        return Math.max(a, c, d);
      };

      var rowMax = 0;
      for (var pi = 0; pi < pn; pi++) {
        var f0 = 440 * Math.pow(2, (pitches[pi] - 69) / 12);
        var acc = 0, wsum = 0, fundPeak = 0, harm2 = 0;
        for (var k = 0; k < HARM_W.length; k++) {
          var fk = f0 * (k + 1);
          if (fk > SR * 0.45) break;
          var v = specAt(fk);
          acc += HARM_W[k] * v;
          wsum += HARM_W[k];
          if (k === 0) fundPeak = v;
          if (k === 1 || k === 2) harm2 = Math.max(harm2, v);
        }
        var v2 = wsum > 0 ? acc / wsum : 0;
        sal[f * pn + pi] = v2;
        fund[f * pn + pi] = fundPeak / (harm2 + 1e-9);
        if (v2 > rowMax) rowMax = v2;
      }
      // 逐帧归一化：安静段也能转，大动态曲子不会整体过阈值
      if (rowMax > 1e-9) {
        var inv = 1 / rowMax;
        for (pi = 0; pi < pn; pi++) sal[f * pn + pi] *= inv;
      }
      if ((f & 1023) === 0) {
        if (onProgress) onProgress(f / nF);
        await nextTick();
      }
    }

    return { sal: sal, fund: fund, nF: nF, pitches: pitches, pn: pn, t0: HARM_WIN / 2 / SR };
  }

  /** 显著性图 → 音符事件（迟滞 + 最短时长 + 八度假象剔除） */
  function salienceToNotes(hf, opts) {
    opts = opts || {};
    var onThr = opts.onThr || 0.45;      // 起音阈值（归一化显著性）
    var offThr = opts.offThr || 0.30;    // 保持阈值（迟滞，避免一音切成几段）
    var minDur = opts.minDur || 0.18;    // 最短音符（秒）
    var fundMin = opts.fundMin || 0.18;  // 基频峰占比下限，低于此判为八度假象
    var maxPoly = opts.maxPoly || 4;     // 每帧最多几个音（复音上限，混响/谐波会虚增）
    var mergeGap = opts.mergeGap || 0.25;// 同音高间隔小于此值 → 当成一个音的颤动/混响尾
    var hopSec = HARM_HOP / SR;
    var nF = hf.nF, pn = hf.pn, pitches = hf.pitches;

    // 每个音高一条迟滞状态机
    var notes = [];
    /* 逐帧「局部极大」抑制：相邻半音里只留显著更强的那个。
       强和弦的谱泄漏会把隔壁半音顶过阈值，凭空多出音来（实测合成钢琴
       8 小节 3 音和弦 → 61 个音，一半是邻音伪迹）。1.35 倍才算被压制，
       真正的相邻半音旋律（级进）不会被误伤。 */
    var sal2 = new Float32Array(hf.sal.length);
    for (var f2 = 0; f2 < nF; f2++) {
      var base = f2 * pn;
      for (var pi = 0; pi < pn; pi++) {
        var v = hf.sal[base + pi];
        var dominated = false;
        for (var q = Math.max(0, pi - 1); q <= Math.min(pn - 1, pi + 1); q++) {
          if (q !== pi && hf.sal[base + q] > v * 1.35) { dominated = true; break; }
        }
        sal2[base + pi] = dominated ? 0 : v;
      }
    }

    /* 逐帧复音上限：混响尾音 + 谐波会把十几个音同时顶过阈值
       （实测真实钢琴分轨 86 小节出 9049 个音 ≈ 每拍 26 个音，全是噪声）。
       起音必须落在「当帧最强 maxPoly 个音」里，收音仍看原始显著性。 */
    var topK = new Uint8Array(hf.sal.length);
    for (var f3 = 0; f3 < nF; f3++) {
      var base3 = f3 * pn;
      var idx = [];
      for (var pi3 = 0; pi3 < pn; pi3++) {
        if (sal2[base3 + pi3] >= onThr) idx.push([sal2[base3 + pi3], pi3]);
      }
      idx.sort(function (a, b) { return b[0] - a[0]; });
      for (var k3 = 0; k3 < Math.min(maxPoly, idx.length); k3++) topK[base3 + idx[k3][1]] = 1;
    }

    for (var pi2 = 0; pi2 < pn; pi2++) {
      var open = -1;
      for (var f = 0; f < nF; f++) {
        var v = sal2[f * pn + pi2];
        if (open < 0) {
          if (v >= onThr && topK[f * pn + pi2]) open = f;
        } else if (v < offThr) {
          pushNote(open, f - 1, pi2);
          open = -1;
        }
      }
      if (open >= 0) pushNote(open, nF - 1, pi2);
    }

    function pushNote(f0i, f1i, pi) {
      var t = f0i * hopSec, dur = (f1i - f0i + 1) * hopSec;
      if (dur < minDur) return;
      // 显著性中位数当力度，基频占比中位数当八度校验分
      var vs = [], fs = [];
      for (var f = f0i; f <= f1i; f++) {
        vs.push(sal2[f * pn + pi]);
        fs.push(hf.fund[f * pn + pi]);
      }
      vs.sort(function (a, b) { return a - b; });
      fs.sort(function (a, b) { return a - b; });
      notes.push({
        midi: pitches[pi],
        t: t,
        dur: dur,
        rms: vs[vs.length >> 1],
        fundRatio: fs[fs.length >> 1]
      });
    }

    // 八度/十二度假象：基频处没有真谱峰（能量全来自高八度音的谐波）→ 丢
    var keep = notes.filter(function (n) { return n.fundRatio >= fundMin; });
    /* 同音高、间隔很短的碎片并回去：混响尾和阈值抖动会把一个音切成几段
       （间隔 < mergeGap 才算同一个音；真重复音至少隔半拍，不会被误并） */
    keep.sort(function (a, b) { return a.midi - b.midi || a.t - b.t; });
    var merged = [];
    keep.forEach(function (n) {
      var last = merged[merged.length - 1];
      if (last && last.midi === n.midi && n.t - (last.t + last.dur) < mergeGap) {
        last.dur = Math.max(last.dur, n.t + n.dur - last.t);
        last.rms = Math.max(last.rms, n.rms);
        return;
      }
      merged.push(n);
    });
    merged.sort(function (a, b) { return a.t - b.t; });
    return merged;
  }

  /**
   * 复音音符序列 → 谱面音符（与鼓同一套网格）。
   * 和单声部的区别：**不去重、不截重叠**，同一起点的多个音（和弦）都要保留。
   */
  /** 几乎同时的 onset 并成一个和弦簇（簇内取中位时刻）。
   *  只用于 MIDI 分轨这类「本来就该同时」的音符；audio 转写出来的音各有各的时值，
   *  乱归并会把真实的装饰音吃掉。 */
  function clusterOnsets(raw, winSec) {
    var a = (raw || []).slice().sort(function (x, y) { return x.t - y.t; });
    if (!a.length) return [];
    var groups = [], cur = null;
    a.forEach(function (n) {
      if (cur && n.t - cur.lastT <= winSec) { cur.items.push(n); cur.lastT = n.t; }
      else { cur = { items: [n], lastT: n.t }; groups.push(cur); }
    });
    var out = [];
    groups.forEach(function (grp) {
      var ts = grp.items.map(function (n) { return n.t; }).sort(function (x, y) { return x - y; });
      var mid = ts[ts.length >> 1];
      grp.items.forEach(function (n) {
        out.push({ midi: n.midi, t: mid, dur: n.dur, rms: n.rms });
      });
    });
    return out;
  }

  function polyTrackNotes(raw, biasSec, phaseBeats, spb, grid) {
    return raw.map(function (n) {
      var beat = (n.t - biasSec) / spb - phaseBeats;
      if (beat < -grid * 0.6) return null;
      beat = Math.max(0, beat);
      var len = Math.max(grid, Math.round((n.dur / spb) / grid) * grid);
      return {
        beat: Math.round(beat / grid) * grid,
        len: len,
        pitch: n.midi,
        vel: Math.round(U.clamp(0.55 + 0.45 * n.rms, 0.45, 1) * 100) / 100,
        t: n.t,
        dur: n.dur
      };
    }).filter(function (n) { return n; });
  }


  /* ================= 主入口 ================= */

  /** 分轨角色 → 默认音色（一轨一个分轨文件） */
  var TONE_OF_ROLE = {
    bass: 'bass', vocals: 'vocalAh', piano: 'piano',
    guitar: 'acousticGuitar', other: 'warmPad'
  };
  var HARMONIC_ROLES = { piano: 1, guitar: 1, other: 1 };

  /**
   * 归一化分轨清单：统一成 [{ role, name, buffers[] }]。
   * 新接口走 src.stems（一个文件一条），旧接口 src.bass / src.harmonic 继续可用
   * （多个 harmonic buffer 仍按一条「和声」轨处理，保持老调用方行为不变）。
   */
  function stemsOf(src) {
    var out = [];
    if (src.stems && src.stems.length) {
      src.stems.forEach(function (s) {
        if (!s) return;
        // MIDI 分轨没有音频 buffer，带的是解析好的音符表
        if (s.role === 'midi') {
          out.push({ role: 'midi', name: s.name || '', buffers: [], midi: s.midi || {} });
          return;
        }
        if (!s.buffer) return;
        out.push({ role: s.role || 'other', name: s.name || '', buffers: [s.buffer] });
      });
      return out;
    }
    if (src.bass) out.push({ role: 'bass', name: '贝斯', buffers: [src.bass] });
    if (src.harmonic && src.harmonic.length) {
      out.push({ role: 'other', name: '和声', buffers: src.harmonic.slice() });
    }
    return out;
  }

  /** 多个 buffer → 相加后的单声道（等价于混音，省一遍 STFT） */
  async function sumMono(buffers) {
    var acc = null;
    for (var i = 0; i < buffers.length; i++) {
      var m = await toMono(buffers[i], null);
      if (!acc) { acc = m; continue; }
      var n = Math.min(acc.length, m.length);
      for (var j = 0; j < n; j++) acc[j] += m[j];
    }
    return acc;
  }

  /**
   * @param {object} src   { name, mixed, drums, stems: [{role, name, buffer}] }
   * @param {object} params { bpm, meterNum, grid, name }
   * @param {function} onProgress (ratio, label)
   */
  async function analyze(src, params, onProgress) {
    params = params || {};
    var report = function (p, label) { if (onProgress) onProgress(U.clamp(p, 0, 1), label); };
    var buf = src.drums || src.mixed;
    if (!buf) throw new Error('没有可分析的音频');
    var stems = stemsOf(src);

    report(0.02, '重采样');
    var mono = await toMono(buf, report);

    report(0.10, '频谱分析');
    var feat = await spectralFeatures(mono, report);

    report(0.62, '检测起音');
    await nextTick();
    var genv = groupEnvelopes(feat);
    var evs = detectHits(feat, genv);
    if (!evs.length) throw new Error('没有检测到打击点：这段音频可能不是鼓/节奏素材');

    report(0.70, '估计速度');
    var tempo = (params.bpm && params.bpm > 0)
      ? { bpm: params.bpm, conf: 1, ambiguous: false }
      : estimateTempo(feat, evs);

    report(0.78, '跟踪拍点');
    var track = trackBeats(feat, evs, tempo.bpm);
    var bpm = Math.round((params.bpm && params.bpm > 0 ? tempo.bpm : track.bpm) * 10) / 10;
    if (!(bpm >= 20 && bpm <= 400)) bpm = tempo.bpm;
    if (Math.abs(track.bpm - bpm) > 0.3) {
      track = trackBeats(feat, evs, bpm);
      bpm = Math.round(track.bpm * 10) / 10;
    }
    var spb = 60 / bpm;

    report(0.84, '判断拍号');
    var meter = (params.meterNum && params.meterNum > 0)
      ? { num: params.meterNum, den: 4, phase: 0, conf: 1 }
      : detectMeter(feat, evs, track.beats, spb);
    var barBeats = meter.num;
    var grid = params.grid || 0.25;

    report(0.88, '识别鼓组');
    /**
     * 先估一次「常数延迟」再量化。
     * STFT 帧栅格（窗 46ms / 步进 11.6ms）会让检测到的起音整体提前十几毫秒，
     * 这不是错误、只是系统的固定偏移；拿全体事件对最近网格点的中位数残差当偏移量扣掉，
     * 剩下的才是真正的抖动（对齐置信度就应该反映抖动，而不是这个常数）。
     */
    var rough = evs.map(function (e) { return e.t / spb; });
    var offsets = rough.map(function (b) { return (b - Math.round(b / grid) * grid) * spb; });
    var biasSec = median(offsets);
    // 小节相位：detectMeter 给出「第几拍是小节 1」，把网格整体平移过去
    var phaseBeats = meter.phase || 0;

    // 一个打击事件可能同时触发 1~2 个乐器（底鼓 + 闭镲），逐个展开成音符
    var hits = [];
    evs = evs.filter(function (e) {
      var b = (e.t - biasSec) / spb - phaseBeats;
      if (b < -1e-6) {
        // 小节 1 之前的弱起：贴得很近就归到 0，差得多就丢掉（谱面从小节 1 起）
        if (b < -grid * 0.6) return false;
        b = 0;
      }
      e.beat = b;
      e.gridBeat = Math.max(0, quantizeBeat(b * spb, spb, grid));
      return true;
    });
    evs.forEach(function (e) {
      e.notes.forEach(function (cls) {
        hits.push({
          t: e.t,
          beat: e.beat,
          gridBeat: e.gridBeat,
          id: cls.id,
          pitch: DRUM_PITCH[cls.id] || 38,
          vel: Math.round(e.vel * 100) / 100,
          conf: cls.conf
        });
      });
    });

    // 网格残差 = 「谱面 vs 音频」的对齐自检（按事件算，同一刻的多个音不重复计）
    var resid = evs.map(function (e) { return Math.abs(e.beat - e.gridBeat) * spb * 1000; });
    var residMed = median(resid);
    var gridMs = grid * spb * 1000;

    var totalBeats = evs.length ? Math.max.apply(null, evs.map(function (e) { return e.gridBeat + grid; })) : barBeats;
    var lengthBars = Math.max(1, Math.ceil(totalBeats / barBeats));

    var barScores = [];
    for (var bar = 0; bar < lengthBars; bar++) {
      var b0 = bar * barBeats, b1 = b0 + barBeats;
      var inBar = evs.filter(function (e) { return e.beat >= b0 - 1e-9 && e.beat < b1 - 1e-9; });
      if (!inBar.length) { barScores.push({ bar: bar, score: null, count: 0 }); continue; }
      var r = inBar.map(function (e) { return Math.abs(e.beat - e.gridBeat) * spb * 1000; });
      barScores.push({
        bar: bar,
        count: inBar.length,
        score: U.clamp(1 - median(r) / Math.max(1, gridMs * 0.5), 0, 1)
      });
    }

    var alignConf = U.clamp(1 - residMed / Math.max(1, gridMs * 0.5), 0, 1);
    var classConf = hits.length ? hits.reduce(function (a, h) { return a + h.conf; }, 0) / hits.length : 0;

    /* ---------- P2①：贝斯 / 人声（单声部，逐分轨转录） ---------- */
    var bassNotes = [];
    var bassInfo = null;
    var vocalTracks = [];

    var bassStem = stems.filter(function (s) { return s.role === 'bass'; })[0];
    if (bassStem) {
      report(0.58, '贝斯音高');
      var bMono = await toMono(bassStem.buffers[0], report, BASS_SR);
      var bFrames = await pitchFrames(bMono, function (p, l) { report(0.58 + 0.16 * p, l); });
      var rawBass = pitchFramesToNotes(bFrames);
      bassNotes = monoTrackNotes(rawBass, biasSec, phaseBeats, spb, grid);
      bassInfo = {
        notes: bassNotes.length,
        low: bassNotes.length ? Math.min.apply(null, bassNotes.map(function (n) { return n.pitch; })) : null,
        high: bassNotes.length ? Math.max.apply(null, bassNotes.map(function (n) { return n.pitch; })) : null
      };
    }

    /* 人声：一个分轨文件 ↔ 一条独立音轨，绝不并进和声轨。
     * 用同一套 YIN，只是把音域放宽（男低音 ~82Hz 到女高音 ~1kHz）。 */
    var vocalStems = stems.filter(function (s) { return s.role === 'vocals'; });
    for (var vi = 0; vi < vocalStems.length; vi++) {
      report(0.62, '人声旋律 ' + (vi + 1) + '/' + vocalStems.length);
      var vMono = await toMono(vocalStems[vi].buffers[0], null, BASS_SR);
      var vFrames = await pitchFrames(vMono,
        function (p, l) { report(0.62 + 0.10 * p, l); }, VOCAL_F0);
      var vNotes = monoTrackNotes(pitchFramesToNotes(vFrames, VOCAL_F0),
        biasSec, phaseBeats, spb, grid);
      if (vNotes.length) {
        vocalTracks.push({ name: vocalStems[vi].name || '人声', notes: vNotes });
      }
    }

    /* ---------- P2②：和声（全局和弦 + 每个和声分轨各自一轨） ---------- */
    var chordSegs = [], perBar = [], keyInfo = null, padNotes = [];
    var harmonicTracks = [];
    var harmonicStems = stems.filter(function (s) { return HARMONIC_ROLES[s.role]; });
    if (harmonicStems.length) {
      report(0.76, '和声色度');
      // 各和声分轨先各自降到单声道（后面每轨还要单独算色度图），再相加当「全局和声」
      var stemMonos = [];
      for (var hi = 0; hi < harmonicStems.length; hi++) {
        stemMonos.push(await sumMono(harmonicStems[hi].buffers));
        report(0.76 + 0.02 * (hi + 1) / harmonicStems.length,
          '合轨 ' + (hi + 1) + '/' + harmonicStems.length);
        await nextTick();
      }
      // 注意：要另开一块内存，别直接拿第一轨的单声道数组当累加器
      //（后面每轨还要用它单独算色度图，被加进去就脏了）
      var hMono = new Float32Array(stemMonos[0].length);
      stemMonos.forEach(function (m) {
        var n = Math.min(hMono.length, m.length);
        for (var j = 0; j < n; j++) hMono[j] += m[j];
      });

      var ch = await chromaFrames(hMono, function (p, l) { report(0.79 + 0.10 * p, l); });
      keyInfo = detectKey(ch.frames, ch.nFrames);

      // 贝斯根音 → 逐拍先验（多轨互验：低音和和声要对得上）
      var beatCount = track.beats.length;
      var bassPcByBeat = new Array(beatCount);
      bassNotes.forEach(function (n) {
        for (var bi = 0; bi < beatCount; bi++) {
          if (n.beat <= bi + 1e-6 && n.beat + n.len > bi + 1e-6) bassPcByBeat[bi] = n.pitch % 12;
        }
      });
      // 注意：track.beats 是「含 bias」的原始拍点，这里用归一化后的拍索引即可
      var beatTimesNorm = track.beats.map(function (t) { return t - biasSec - phaseBeats * spb; });
      var chordRes = detectChords(ch.frames, ch.nFrames, beatTimesNorm, spb, barBeats, bassPcByBeat);
      chordSegs = chordRes.segments;
      perBar = chordRes.perBar;
      padNotes = padNotesFromSegments(chordSegs, grid, 1e9);

      /* 每个和声分轨 → 自己的一条轨：
       *  · 单独算色度图判和弦（各轨内容来自本轨，不是合并结果）
       *  · 再做音符级转写（谐波显著性 + 基频校验）—— 编曲页要能逐音编辑，
       *    转不出来（音符太少）才退回和弦 pad。 */
      for (var hj = 0; hj < harmonicStems.length; hj++) {
        var hs = harmonicStems[hj];
        var trackSegs = chordSegs;
        if (harmonicStems.length > 1) {
          report(0.90, '分轨和弦 ' + (hj + 1) + '/' + harmonicStems.length);
          var hch = await chromaFrames(stemMonos[hj], null);
          trackSegs = detectChords(hch.frames, hch.nFrames, beatTimesNorm,
            spb, barBeats, bassPcByBeat).segments;
          await nextTick();
        }
        report(0.93, '音符转写 ' + (hj + 1) + '/' + harmonicStems.length);
        var hf = await harmonicFrames(stemMonos[hj], HARM_RANGE[hs.role],
          function (p) { report(0.93 + 0.04 * p, '音符转写 ' + (hj + 1) + '/' + harmonicStems.length); });
        var rawNotes = salienceToNotes(hf, {});
        var notes = polyTrackNotes(rawNotes, biasSec, phaseBeats, spb, grid);
        harmonicTracks.push({
          name: hs.name || '和声',
          toneId: TONE_OF_ROLE[hs.role] || 'warmPad',
          segs: trackSegs,
          padNotes: padNotesFromSegments(trackSegs, grid, 1e9),
          notes: notes,
          rawNotes: rawNotes
        });
      }
    }

    /* ---------- MIDI 分轨（P1） ----------
     * 用户在外部用 Basic Pitch / Melodyne / Transkun 转好再拖进来，
     * 这里只做「对齐本曲网格」：秒 → 拍（同一套 bias / 小节相位），
     * 不重新分析音频。一个 MIDI 轨 → 一条音轨。 */
    var midiTracks = [];
    var midiStems = stems.filter(function (s) { return s.role === 'midi'; });
    for (var mi = 0; mi < midiStems.length; mi++) {
      var mstem = midiStems[mi];
      var mspec = mstem.midi || {};
      /* 和弦簇先归并：转写出来的和弦几个音常有几毫秒到几十毫秒的先后，
         各自取整会被拆到相邻两格 —— 谱面上看是琶音，听感也不对。 */
      var mraw = clusterOnsets((mspec.notes || []).map(function (n) {
        return { midi: n.pitch, t: n.t, dur: n.dur, rms: n.vel };
      }), 0.02);
      // MIDI 的时间原点就是它自己的第 0 拍，**不跟音频的小节相位走**
      //（否则 phase=1 时前几拍的音会被当成弱起丢掉，实测 4 音掉 2 音）
      var mnotes = polyTrackNotes(mraw, biasSec, 0, spb, grid);
      if (!mnotes.length) continue;
      midiTracks.push({
        name: mstem.name || ('MIDI ' + (mi + 1)),
        role: mspec.role || 'synth',
        toneId: mspec.toneId || null,
        notes: mnotes
      });
    }

    /* ---------- 汇总长度 ---------- */
    var contentEnd = totalBeats;
    bassNotes.forEach(function (n) { contentEnd = Math.max(contentEnd, n.beat + n.len); });
    vocalTracks.forEach(function (v) {
      v.notes.forEach(function (n) { contentEnd = Math.max(contentEnd, n.beat + n.len); });
    });
    chordSegs.forEach(function (s) { contentEnd = Math.max(contentEnd, s.endBeat); });
    harmonicTracks.forEach(function (h) {
      h.notes.forEach(function (n) { contentEnd = Math.max(contentEnd, n.beat + n.len); });
    });
    midiTracks.forEach(function (m) {
      m.notes.forEach(function (n) { contentEnd = Math.max(contentEnd, n.beat + n.len); });
    });
    totalBeats = Math.max(totalBeats, contentEnd);
    lengthBars = Math.max(1, Math.ceil(totalBeats / barBeats));

    // pad 音符按最终长度裁一次（全局 + 每个和声分轨各自一份）
    var clipPad = function (list) {
      return list.filter(function (n) { return n.beat < totalBeats; })
        .map(function (n) {
          return { beat: n.beat, len: Math.max(grid, Math.min(n.len, totalBeats - n.beat)), pitch: n.pitch, vel: n.vel };
        });
    };
    padNotes = clipPad(padNotes);
    harmonicTracks.forEach(function (h) {
      h.padNotes = clipPad(h.padNotes);
      h.notes = clipPad(h.notes);
    });

    var overall = U.clamp(0.34 * tempo.conf + 0.22 * meter.conf + 0.30 * alignConf + 0.14 * classConf, 0, 1);

    report(0.95, '生成谱面');

    // 只有音符分轨（没识别到鼓点）时别塞一条空鼓轨
    var hasNotes = bassNotes.length || vocalTracks.length || harmonicTracks.length || midiTracks.length;
    var tracks = [];
    if (hits.length || !hasNotes) {
      tracks.push({
        name: '鼓组', role: 'drum', part: -1, toneId: 'drumkit',
        volume: 0.9, pan: 0,
        notes: hits.map(function (h) {
          return { beat: h.gridBeat, len: grid, pitch: h.pitch, vel: h.vel };
        })
      });
    }
    /* 分轨 → 音轨：一个分轨文件一条轨（贝斯 / 人声 / 钢琴 / 吉他 / 其他） */
    var partSeq = 0;
    if (bassNotes.length) {
      tracks.push({
        name: '贝斯', role: 'bass', part: partSeq++, toneId: 'bass', volume: 0.85, pan: 0,
        notes: bassNotes.map(function (n) {
          return { beat: n.beat, len: n.len, pitch: n.pitch, vel: n.vel };
        })
      });
    }
    vocalTracks.forEach(function (v) {
      tracks.push({
        name: v.name, role: 'synth', part: partSeq++, toneId: TONE_OF_ROLE.vocals,
        volume: 0.8, pan: 0,
        notes: v.notes.map(function (n) {
          return { beat: n.beat, len: n.len, pitch: n.pitch, vel: n.vel };
        })
      });
    });
    /* 和声分轨：优先用音符级转写结果；转不出来（太少/太散）才退回和弦 pad。
       阈值定在 12 个音：少于这个数基本是噪声，铺和弦反而更可用。 */
    harmonicTracks.forEach(function (h) {
      var list = h.notes.length >= 12 ? h.notes : h.padNotes;
      if (!list.length) return;
      tracks.push({
        name: h.name, role: 'synth', part: partSeq++, toneId: h.toneId,
        volume: 0.7, pan: 0, notes: list
      });
    });
    /* MIDI 分轨（P1）：外部转写工具（Basic Pitch / Melodyne / Transkun）的产物，
       一个 MIDI 轨一条音轨，直接沿用本曲的 BPM/拍号网格量化。 */
    midiTracks.forEach(function (m) {
      if (!m.notes.length) return;
      tracks.push({
        name: m.name, role: m.role || 'synth', part: partSeq++,
        toneId: m.toneId || null, volume: 0.8, pan: 0, notes: m.notes
      });
    });

    var song = {
      version: 1, type: 'arranger',
      name: (params.name || src.name || '导入成谱'),
      bpm: bpm,
      timeSignature: [meter.num, meter.den],
      swing: 0,
      lengthBars: lengthBars,
      key: keyInfo ? keyInfo.root : 'C',
      scale: keyInfo ? keyInfo.mode : 'major',
      chords: perBar.map(function (c) { return { bar: c.bar, root: c.root, quality: c.quality }; }),
      tracks: tracks
    };

    var counts = {};
    hits.forEach(function (h) { counts[h.id] = (counts[h.id] || 0) + 1; });

    var chordConf = chordSegs.length
      ? U.clamp(chordSegs.reduce(function (a, s) { return a + Math.max(0, s.margin); }, 0) / chordSegs.length * 4, 0, 1)
      : 0;

    report(1, '完成');
    return {
      bpm: bpm,
      spb: spb,
      meter: { num: meter.num, den: meter.den, phase: meter.phase || 0 },
      barBeats: barBeats,
      grid: grid,
      lengthBars: lengthBars,
      totalBeats: totalBeats,
      hits: hits,
      song: song,
      counts: counts,
      bass: bassInfo,
      bassNotes: bassNotes,
      /* 分轨级结果：一个分轨文件一条轨，导入页据此生成 tracks[] */
      vocalTracks: vocalTracks,
      harmonicTracks: harmonicTracks,
      midiTracks: midiTracks,
      chords: perBar,
      chordSegs: chordSegs,
      key: keyInfo,
      padNotes: padNotes,
      source: src.drums ? 'drums-stem' : 'mixed',
      onsets: evs.length,
      durationSec: buf.duration,
      confidence: {
        overall: overall,
        tempo: tempo.conf,
        meter: meter.conf,
        align: alignConf,
        classes: classConf,
        chords: chordConf,
        bass: bassNotes.length ? U.clamp(0.55 + Math.min(0.4, bassNotes.length / Math.max(1, totalBeats) * 2), 0, 1) : 0,
        residualMs: residMed,
        gridMs: gridMs,
        ambiguousTempo: !!tempo.ambiguous
      },
      barScores: barScores,
      biasSec: biasSec,
      phaseBeats: phaseBeats,
      beatTimes: track.beats.map(function (t) { return t - biasSec - phaseBeats * spb; }),
      peaks: peaksOf(mono)
    };
  }

  function peaksOf(mono) {
    var bucket = Math.max(1, Math.floor(mono.length / 1200));
    var out = new Float32Array(Math.ceil(mono.length / bucket));
    for (var i = 0; i < out.length; i++) {
      var s = i * bucket, e = Math.min(mono.length, s + bucket), p = 0;
      for (var j = s; j < e; j += 2) {
        var v = mono[j] < 0 ? -mono[j] : mono[j];
        if (v > p) p = v;
      }
      out[i] = p;
    }
    return out;
  }

  BS.analysis = {
    SR: SR,
    HOP: HOP,
    FFT_N: FFT_N,
    FPS: FPS,
    GROUPS: GROUPS,
    DRUM_PITCH: DRUM_PITCH,
    DRUM_LABEL: DRUM_LABEL,
    analyze: analyze,
    /* 拆开导出，方便单独测 */
    toMono: toMono,
    spectralFeatures: spectralFeatures,
    groupEnvelopes: groupEnvelopes,
    onsetFunction: onsetFunction,
    detectOnsets: detectOnsets,
    detectHits: detectHits,
    estimateTempo: estimateTempo,
    trackBeats: trackBeats,
    detectMeter: detectMeter,
    classifyLow: classifyLow,
    classifyMid: classifyMid,
    classifyHigh: classifyHigh,
    quantizeBeat: quantizeBeat,
    /* P2：贝斯 + 和声 */
    pitchFrames: pitchFrames,
    pitchFramesToNotes: pitchFramesToNotes,
    viterbiPitch: viterbiPitch,
    chromaFrames: chromaFrames,
    detectChords: detectChords,
    detectKey: detectKey,
    chordTemplates: chordTemplates,
    chordsPerBar: chordsPerBar,
    padNotesFromSegments: padNotesFromSegments,
    /* P0：复音转写（钢琴/吉他音符级） */
    harmonicFrames: harmonicFrames,
    salienceToNotes: salienceToNotes,
    polyTrackNotes: polyTrackNotes,
    PC_NAMES: PC_NAMES,
    BASS_SR: BASS_SR
  };
})(typeof window !== 'undefined' ? window : globalThis);

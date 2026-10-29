/* BandSynth · denoise.js
 * 采样降噪 / 信噪比（SNR）提升
 *
 * 全部是纯 JS 算法（时域 + 一次 STFT），不引第三方库，也不依赖 Web Audio 的
 * 实时节点 —— 直接处理 AudioBuffer，处理完换回声部的采样。
 *
 * 提供：
 *   analyze(buffer)                峰值 / 噪声基底 / 信噪比 读数
 *   removeDC(buffer)               去直流偏置
 *   deHum(buffer, opts)            去工频干扰（50/60Hz 及谐波，notch）
 *   highpass(buffer, opts)         去低频隆隆（高通）
 *   declick(buffer, opts)          去咔哒 / 爆音（削波尖峰）
 *   noiseGate(buffer, opts)        噪声门（时域，最省事的一档）
 *   spectralDenoise(buffer, opts)  谱减降噪（STFT，最有效）
 *   normalize(buffer, opts)        归一化（峰值 / RMS，把有效电平提上去）
 *   chain(ctx, buffer, opts)       一键链：去直流 → 去咔哒 → 去工频 → 谱减 → 归一化
 *
 * 设计取向：
 *   · 只在「素材本底干净」时提升 SNR；宁可少降一点，也不要把素材本身的
 *     泛音当噪声削掉（过减因子 + 谱地板 + 增益跨频平滑，都是为了这个）。
 *   · 所有处理都可撤销、可叠加，处理顺序固定（见 chain）。
 */
(function (global) {
  'use strict';
  var BS = global.BS;

  var EPS = 1e-12;

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function dbToLin(db) { return Math.pow(10, db / 20); }
  function linToDb(v) { return v > EPS ? 20 * Math.log10(v) : -Infinity; }
  function fmtDb(v) {
    if (!isFinite(v)) return '-∞';
    return (v >= 0 ? '+' : '') + v.toFixed(1);
  }

  /* ================= FFT（radix-2，含逆变换） ================= */
  function makeFFT(n) {
    var bits = Math.round(Math.log(n) / Math.LN2);
    var rev = new Uint32Array(n);
    for (var i = 0; i < n; i++) {
      var r = 0;
      for (var b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      rev[i] = r;
    }
    var cos = new Float32Array(n / 2), sin = new Float32Array(n / 2);
    for (var k = 0; k < n / 2; k++) {
      cos[k] = Math.cos(2 * Math.PI * k / n);
      sin[k] = Math.sin(2 * Math.PI * k / n);
    }
    return { n: n, rev: rev, cos: cos, sin: sin, inv: false };
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
          var c = cos[k * step], s = F.inv ? sin[k * step] : -sin[k * step];
          var a = i + k, b = a + half;
          var tr = re[b] * c - im[b] * s;
          var ti = re[b] * s + im[b] * c;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
    if (F.inv) {
      for (i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
    }
  }

  /* ================= 双二阶滤波器（RBJ cookbook） ================= */
  function biquad(type, f0, Q, sr) {
    var w0 = 2 * Math.PI * clamp(f0, 8, sr * 0.45) / sr;
    var c = Math.cos(w0), s = Math.sin(w0);
    var alpha = s / (2 * Math.max(0.0001, Q));
    var b0, b1, b2, a0, a1, a2;
    if (type === 'notch') {
      b0 = 1; b1 = -2 * c; b2 = 1;
    } else if (type === 'highpass') {
      b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2;
    } else {                       // lowpass
      b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2;
    }
    a0 = 1 + alpha; a1 = -2 * c; a2 = 1 - alpha;
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
  }

  function applyBiquad(buffer, c) {
    var ch = buffer.numberOfChannels;
    for (var k = 0; k < ch; k++) {
      var x = buffer.getChannelData(k);
      var x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (var i = 0; i < x.length; i++) {
        var x0 = x[i];
        var y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
        x2 = x1; x1 = x0; y2 = y1; y1 = y0;
        x[i] = y0;
      }
    }
    return buffer;
  }

  /* ================= 读数：峰值 / 噪声基底 / 信噪比 ================= */
  /**
   * 估计一段素材的信噪比。
   * · 帧 RMS（20ms）排序后取低分位当「噪声基底」，高分位当「信号电平」
   * · SNR = 20log10(信号电平 / 噪声基底)
   * 这样算出来的数值和耳朵的体感一致：底噪抬 6dB，SNR 就掉 6dB。
   */
  function analyze(buffer) {
    if (!buffer || !buffer.length) {
      return { peakDb: -Infinity, rmsDb: -Infinity, noiseDb: -Infinity,
               signalDb: -Infinity, snrDb: 0, dcOffset: 0, peak: 0 };
    }
    var ch = buffer.numberOfChannels, len = buffer.length;
    var peak = 0, sum = 0, sumSq = 0, count = 0;
    for (var c = 0; c < ch; c++) {
      var d = buffer.getChannelData(c);
      for (var i = 0; i < len; i++) {
        var v = d[i];
        var a = v < 0 ? -v : v;
        if (a > peak) peak = a;
        sum += v; sumSq += v * v; count++;
      }
    }
    var rms = count ? Math.sqrt(sumSq / count) : 0;

    // 帧 RMS → 噪声基底 / 信号电平
    var sr = buffer.sampleRate;
    var win = Math.max(32, Math.round(sr * 0.02));
    var hop = win >> 1;
    var frames = [];
    for (var off = 0; off + win <= len; off += hop) {
      var e = 0, n = 0;
      for (var c2 = 0; c2 < ch; c2++) {
        var dd = buffer.getChannelData(c2);
        for (var j = off; j < off + win; j++) { e += dd[j] * dd[j]; n++; }
      }
      frames.push(Math.sqrt(e / Math.max(1, n)));
    }
    if (!frames.length) frames.push(rms);
    frames.sort(function (a, b) { return a - b; });
    function pct(p) {
      var idx = clamp(Math.floor(frames.length * p), 0, frames.length - 1);
      return frames[idx];
    }
    var noise = pct(0.10);
    var signal = pct(0.90);
    if (signal < noise) signal = noise;
    return {
      peak: peak,
      peakDb: linToDb(peak),
      rmsDb: linToDb(rms),
      noiseDb: linToDb(noise),
      signalDb: linToDb(signal),
      snrDb: linToDb(signal) - linToDb(noise),
      dcOffset: count ? sum / count : 0
    };
  }

  /* ================= 1) 去直流 ================= */
  function removeDC(buffer) {
    var ch = buffer.numberOfChannels, offset = 0;
    for (var k = 0; k < ch; k++) {
      var d = buffer.getChannelData(k);
      var sum = 0;
      for (var i = 0; i < d.length; i++) sum += d[i];
      var mean = d.length ? sum / d.length : 0;
      if (Math.abs(mean) > Math.abs(offset)) offset = mean;
      for (var j = 0; j < d.length; j++) d[j] -= mean;
    }
    return { buffer: buffer, offset: offset };
  }

  /* ================= 2) 去工频 / 低频隆隆 ================= */
  function deHum(buffer, opts) {
    opts = opts || {};
    var freq = opts.freq || 50;
    var harmonics = opts.harmonics === undefined ? 3 : opts.harmonics;
    var q = opts.q === undefined ? 12 : opts.q;
    var sr = buffer.sampleRate;
    for (var h = 1; h <= harmonics; h++) {
      var f = freq * h;
      if (f >= sr * 0.45) break;
      applyBiquad(buffer, biquad('notch', f, q, sr));
    }
    return buffer;
  }

  function highpass(buffer, opts) {
    opts = opts || {};
    var f = opts.freq || 80;
    var q = opts.q === undefined ? 0.707 : opts.q;
    return applyBiquad(buffer, biquad('highpass', f, q, buffer.sampleRate));
  }

  /* ================= 3) 去咔哒 / 爆音 ================= */
  /** 削波或插值产生的「孤立高电平尖峰」：短促且电平极高 → 用前后样本抹平 */
  function declick(buffer, opts) {
    opts = opts || {};
    var thr = dbToLin(opts.thresholdDb === undefined ? -1 : opts.thresholdDb);
    var maxRun = Math.max(1, Math.round((opts.maxWidthMs === undefined ? 3 : opts.maxWidthMs) / 1000 * buffer.sampleRate));
    var ch = buffer.numberOfChannels, fixed = 0;
    for (var k = 0; k < ch; k++) {
      var d = buffer.getChannelData(k), n = d.length, i = 0;
      while (i < n) {
        if (Math.abs(d[i]) < thr) { i++; continue; }
        var j = i;
        while (j < n && Math.abs(d[j]) >= thr) j++;
        var runLen = j - i;
        if (runLen <= maxRun) {
          var before = i > 0 ? d[i - 1] : 0;
          var after = j < n ? d[j] : 0;
          for (var m = i; m < j; m++) {
            var t = runLen > 1 ? (m - i + 1) / (runLen + 1) : 0.5;
            d[m] = before + (after - before) * t;
          }
          fixed += runLen;
        }
        i = j;
      }
    }
    return { buffer: buffer, fixed: fixed };
  }

  /* ================= 4) 噪声门（时域） ================= */
  /**
   * 低于门限的部分直接压掉 → 音符之间的底噪消失，信噪比立竿见影。
   * 门限按「相对峰值」给（dB），比绝对 dBFS 稳：不同素材不用分别调。
   */
  function noiseGate(buffer, opts) {
    opts = opts || {};
    var sr = buffer.sampleRate;
    var ch = buffer.numberOfChannels, len = buffer.length;
    if (!len) return { buffer: buffer, threshold: 0, closed: 0 };

    var peak = 0;
    for (var c = 0; c < ch; c++) {
      var d0 = buffer.getChannelData(c);
      for (var i = 0; i < len; i++) { var a = Math.abs(d0[i]); if (a > peak) peak = a; }
    }
    if (peak < EPS) return { buffer: buffer, threshold: 0, closed: 0 };

    var thrDb = opts.thresholdDb === undefined ? -35 : opts.thresholdDb;
    var thr = peak * dbToLin(thrDb);
    var knee = dbToLin(opts.kneeDb === undefined ? 6 : opts.kneeDb);
    var thrLow = thr / knee;

    // 包络：各声道整流后单极点平滑，再取跨声道最大值（link，避免左右增益不一致）
    var env = new Float32Array(len);
    var envTau = Math.max(0.0005, (opts.envMs === undefined ? 3 : opts.envMs) / 1000);
    var envCoef = Math.exp(-1 / (sr * envTau));
    for (var c2 = 0; c2 < ch; c2++) {
      var d = buffer.getChannelData(c2), e = 0;
      for (var j = 0; j < len; j++) {
        var av = Math.abs(d[j]);
        e = av + envCoef * (e - av);
        if (e > env[j]) env[j] = e;
      }
    }

    // 目标增益 → attack / release 平滑（快开慢关，避免咔哒声）
    var atk = Math.exp(-1 / (sr * Math.max(0.0005, (opts.attackMs === undefined ? 3 : opts.attackMs) / 1000)));
    var rel = Math.exp(-1 / (sr * Math.max(0.005, (opts.releaseMs === undefined ? 120 : opts.releaseMs) / 1000)));
    var gain = new Float32Array(len);
    var prev = 0, closed = 0;
    for (var k2 = 0; k2 < len; k2++) {
      var ev = env[k2], target;
      if (ev >= thr) target = 1;
      else if (ev >= thrLow) target = (ev - thrLow) / Math.max(EPS, thr - thrLow);
      else target = 0;
      var coef = target > prev ? atk : rel;
      prev = target + coef * (prev - target);
      if (prev < 0.001) closed++;
      gain[k2] = prev;
    }

    for (var c3 = 0; c3 < ch; c3++) {
      var dd = buffer.getChannelData(c3);
      for (var m2 = 0; m2 < len; m2++) dd[m2] *= gain[m2];
    }
    return { buffer: buffer, threshold: thr, closed: closed };
  }

  /* ================= 5) 谱减降噪（STFT） ================= */
  /**
   * 谱减法：先从「最安静的若干帧」估出噪声谱，再逐帧把噪声幅度减掉。
   * 三个关键细节（少了就会出音乐噪声 / 削掉素材本身的泛音）：
   *   · 过减因子 α：减得比估计的噪声更多一点，抵消谱估计的误差
   *   · 谱地板：增益不低于 floorDb，保留一点点底噪，避免「音乐噪声」
   *   · 增益跨频率平滑：相邻频点的增益差太多就会听成断断续续的调子
   */
  function spectralDenoise(buffer, opts) {
    opts = opts || {};
    var sr = buffer.sampleRate;
    var ch = buffer.numberOfChannels, len = buffer.length;
    if (!len) return { buffer: buffer, frames: 0 };

    var N = opts.frameSize || 2048;
    if (N & (N - 1)) N = 1024;                 // 必须是 2 的幂
    while (N > 512 && N > len) N >>= 1;
    var hop = N >> 2;                          // 75% 重叠
    var strength = clamp(opts.strength === undefined ? 1 : opts.strength, 0, 4);
    var over = opts.overSubtraction === undefined ? 1.6 : opts.overSubtraction;
    var alpha = over * strength;
    var floorGain = dbToLin(opts.floorDb === undefined ? -45 : opts.floorDb);
    var pct = opts.noisePercentile === undefined ? 0.12 : opts.noisePercentile;

    var F = makeFFT(N), FInv = makeFFT(N);
    FInv.inv = true;
    var win = new Float32Array(N);
    for (var i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);

    var half = N >> 1;
    /* ⚠️ 前后各补 N 个零再分析。
       不补的话，素材最前面的样本只被 1 帧覆盖，重叠相加的归一化分母
       （Σw²）小到 1e-6 量级 —— 谱减留下的边缘残差被除以这个极小的分母，
       开头会炸出几倍于原信号的尖峰（实测 +9dB）。补零后每个真实样本
       都有完整 4 帧重叠，分母恒定，问题消失。 */
    var pad = N;
    var total = len + 2 * pad;
    var chData = [];
    for (var c = 0; c < ch; c++) {
      var src = buffer.getChannelData(c);
      var arr = new Float32Array(total);
      arr.set(src, pad);
      chData.push(arr);
    }
    // 单声道混合（只用于估计噪声谱）
    var mono = new Float32Array(total);
    for (var c2 = 0; c2 < ch; c2++) {
      var d2 = chData[c2];
      for (var j = 0; j < total; j++) mono[j] += d2[j] / ch;
    }

    var numFrames = Math.max(1, Math.ceil(total / hop) + 1);

    /* ---- 噪声谱估计：取「最安静的若干帧」的平均幅度谱 ----
       只统计落在真实素材区内的帧（补零区是纯 0，会把噪声谱估成 0）。 */
    var energies = new Float32Array(numFrames);
    var usable = [];
    for (var f = 0; f < numFrames; f++) {
      var off = f * hop;
      if (off < pad || off > len) { energies[f] = Infinity; continue; }
      var e = 0;
      for (var k = 0; k < N; k++) {
        var idx = off + k;
        if (idx >= total) break;
        e += mono[idx] * mono[idx];
      }
      energies[f] = e;
      usable.push(f);
    }
    if (!usable.length) usable = [0];
    usable.sort(function (a, b) { return energies[a] - energies[b]; });
    var take = clamp(Math.round(usable.length * pct), 1, usable.length);

    var noiseSpec = new Float32Array(half);
    var re = new Float32Array(N), im = new Float32Array(N);
    for (var t = 0; t < take; t++) {
      var fo = usable[t] * hop;
      for (var m = 0; m < N; m++) {
        var id2 = fo + m;
        re[m] = id2 < total ? mono[id2] * win[m] : 0;
        im[m] = 0;
      }
      fftRun(F, re, im);
      for (var b2 = 0; b2 < half; b2++) noiseSpec[b2] += Math.sqrt(re[b2] * re[b2] + im[b2] * im[b2]);
    }
    for (var b3 = 0; b3 < half; b3++) noiseSpec[b3] /= take;

    /* ---- 逐帧处理 + 重叠相加 ---- */
    var outCh = [];
    for (var c3b = 0; c3b < ch; c3b++) {
      var src2 = chData[c3b];
      var acc = new Float32Array(total);
      var wsm = new Float32Array(total);
      var mag = new Float32Array(half), phase = new Float32Array(half);
      var gain = new Float32Array(half), sm = new Float32Array(half);
      for (var fr = 0; fr < numFrames; fr++) {
        var start = fr * hop;
        for (var m2 = 0; m2 < N; m2++) {
          var id3 = start + m2;
          re[m2] = id3 < total ? src2[id3] * win[m2] : 0;
          im[m2] = 0;
        }
        fftRun(F, re, im);
        for (var b = 0; b < half; b++) {
          var mg = Math.sqrt(re[b] * re[b] + im[b] * im[b]);
          mag[b] = mg;
          phase[b] = Math.atan2(im[b], re[b]);
        }
        // 减噪增益
        for (var b4 = 0; b4 < half; b4++) {
          var g = 1 - alpha * noiseSpec[b4] / (mag[b4] + EPS);
          gain[b4] = g > 0 ? g : 0;
        }
        // 跨频率平滑（3 点 [0.25,0.5,0.25]）：抑制「音乐噪声」
        for (var b5 = 0; b5 < half; b5++) {
          var a1 = gain[b5 > 0 ? b5 - 1 : 0];
          var a2 = gain[b5];
          var a3 = gain[b5 < half - 1 ? b5 + 1 : half - 1];
          sm[b5] = 0.25 * a1 + 0.5 * a2 + 0.25 * a3;
        }
        for (var b6 = 0; b6 < half; b6++) {
          if (sm[b6] < floorGain) sm[b6] = floorGain;
          var mm = mag[b6] * sm[b6];
          re[b6] = mm * Math.cos(phase[b6]);
          im[b6] = mm * Math.sin(phase[b6]);
        }
        // 负频率共轭镜像（保证是实信号）
        for (var b7 = half + 1; b7 < N; b7++) {
          re[b7] = re[N - b7];
          im[b7] = -im[N - b7];
        }
        im[0] = 0;
        if (half > 0) im[half] = 0;
        fftRun(FInv, re, im);
        for (var m3 = 0; m3 < N; m3++) {
          var pos = start + m3;
          if (pos >= total) break;
          acc[pos] += re[m3] * win[m3];
          wsm[pos] += win[m3] * win[m3];
        }
      }
      for (var w = 0; w < total; w++) {
        if (wsm[w] > 1e-6) acc[w] /= wsm[w];
      }
      outCh.push(acc);
    }

    // 写回（新建缓冲，避免破坏原数据）
    var nb = bufferContextCreate(buffer, len);
    var outPeak = 0;
    for (var c4 = 0; c4 < ch; c4++) {
      var dst = nb.getChannelData(c4);
      var a3b = outCh[c4];
      for (var i2 = 0; i2 < len; i2++) {
        var v = a3b[i2 + pad];
        dst[i2] = v;
        var av = v < 0 ? -v : v;
        if (av > outPeak) outPeak = av;
      }
    }
    /* 峰值保护：谱减后的波形可能出现局部过冲，超过满刻度就整体压回来，
       免得采样一播放就削波失真。 */
    var limit = opts.limitPeak === undefined ? 0.99 : opts.limitPeak;
    var limGain = 1;
    if (limit > 0 && outPeak > limit) {
      limGain = limit / outPeak;
      for (var c5 = 0; c5 < ch; c5++) {
        var dd2 = nb.getChannelData(c5);
        for (var i3 = 0; i3 < len; i3++) dd2[i3] *= limGain;
      }
    }
    return { buffer: nb, frames: numFrames, noiseFrames: take, alpha: alpha, limitGain: limGain, outPeak: outPeak };
  }

  /** 新建同规格缓冲（不依赖 ctx：AudioBuffer 构造需要一个 ctx，这里用全局 app 的） */
  function bufferContextCreate(buffer, len) {
    var ctx = (global.BS && BS.app && BS.app.ctx) || null;
    if (ctx && typeof ctx.createBuffer === 'function') {
      return ctx.createBuffer(buffer.numberOfChannels, len, buffer.sampleRate);
    }
    // 没有 ctx 时退回 AudioBuffer 构造（现代浏览器都支持）
    return new global.AudioBuffer({ numberOfChannels: buffer.numberOfChannels, length: len, sampleRate: buffer.sampleRate });
  }

  /* ================= 6) 归一化 ================= */
  /**
   * mode 'peak'：峰值到 targetPeak（0.98）
   * mode 'rms' ：把「有效电平」（帧 RMS 的高分位，避开噪声段）提到 targetDb，
   *              再限制峰值不超过 0.99（超出就整体压回来，并报告被限了多少）
   */
  function normalize(buffer, opts) {
    opts = opts || {};
    var mode = opts.mode || 'peak';
    var ch = buffer.numberOfChannels, len = buffer.length;
    var peak = 0, sumSq = 0, count = 0;
    for (var c = 0; c < ch; c++) {
      var d = buffer.getChannelData(c);
      for (var i = 0; i < len; i++) {
        var a = Math.abs(d[i]);
        if (a > peak) peak = a;
        sumSq += d[i] * d[i]; count++;
      }
    }
    if (peak < EPS) return { buffer: buffer, gain: 1, limited: false };

    var gain = 1, limited = false;
    if (mode === 'rms') {
      var targetDb = opts.targetDb === undefined ? -20 : opts.targetDb;
      var target = dbToLin(targetDb);
      var sr = buffer.sampleRate;
      var win = Math.max(32, Math.round(sr * 0.02)), hop = win >> 1;
      var frames = [];
      for (var off = 0; off + win <= len; off += hop) {
        var e = 0, n = 0;
        for (var c2 = 0; c2 < ch; c2++) {
          var dd = buffer.getChannelData(c2);
          for (var j = off; j < off + win; j++) { e += dd[j] * dd[j]; n++; }
        }
        frames.push(Math.sqrt(e / Math.max(1, n)));
      }
      frames.sort(function (a, b) { return a - b; });
      var level = frames.length ? frames[clamp(Math.floor(frames.length * 0.75), 0, frames.length - 1)] : 0;
      if (level < EPS) return { buffer: buffer, gain: 1, limited: false };
      gain = target / level;
      if (peak * gain > 0.99) { gain = 0.99 / peak; limited = true; }
    } else {
      var targetPeak = opts.targetPeak === undefined ? 0.98 : opts.targetPeak;
      gain = targetPeak / peak;
    }
    for (var c3 = 0; c3 < ch; c3++) {
      var d3 = buffer.getChannelData(c3);
      for (var i3 = 0; i3 < len; i3++) d3[i3] *= gain;
    }
    return { buffer: buffer, gain: gain, limited: limited };
  }

  /* ================= 一键链 ================= */
  /**
   * 固定顺序（顺序很重要）：
   *   去直流 → 去咔哒 → 去工频 → 高通（去隆隆）→ 谱减降噪 → 归一化
   * 先去直流再滤低频：直流偏置会把低通/陷波的工作点推偏。
   */
  function chain(buffer, opts) {
    opts = opts || {};
    var report = { steps: [] };
    var out = buffer;

    if (opts.removeDC !== false) {
      var r1 = removeDC(out);
      out = r1.buffer;
      report.steps.push({ name: '去直流', offset: r1.offset });
    }
    if (opts.declick !== false) {
      var r2 = declick(out, opts.declickOpts);
      out = r2.buffer;
      report.steps.push({ name: '去咔哒', fixed: r2.fixed });
    }
    if (opts.hum) {
      deHum(out, opts.humOpts);
      report.steps.push({ name: '去工频 ' + (opts.humOpts && opts.humOpts.freq || 50) + 'Hz' });
    }
    if (opts.highpass) {
      highpass(out, opts.highpassOpts);
      report.steps.push({ name: '高通 ' + (opts.highpassOpts && opts.highpassOpts.freq || 80) + 'Hz' });
    }
    if (opts.spectral !== false) {
      var r3 = spectralDenoise(out, opts.spectralOpts);
      out = r3.buffer;
      report.steps.push({ name: '谱减降噪', alpha: r3.alpha });
    }
    if (opts.gate) {
      var r3b = noiseGate(out, opts.gateOpts);
      out = r3b.buffer;
      report.steps.push({ name: '噪声门', threshold: r3b.threshold });
    }
    if (opts.normalize !== false) {
      var r4 = normalize(out, opts.normalizeOpts);
      out = r4.buffer;
      report.steps.push({ name: '归一化', gain: r4.gain });
    }
    report.buffer = out;
    return report;
  }

  BS.denoise = {
    analyze: analyze,
    removeDC: removeDC,
    deHum: deHum,
    highpass: highpass,
    declick: declick,
    noiseGate: noiseGate,
    spectralDenoise: spectralDenoise,
    normalize: normalize,
    chain: chain,
    fmtDb: fmtDb,
    dbToLin: dbToLin,
    linToDb: linToDb
  };

})(typeof window !== 'undefined' ? window : globalThis);

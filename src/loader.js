/* BandSynth · loader.js
 * 采样加载：手机录音格式 / 视频格式 / 微信传输格式 → AudioBuffer
 * 策略：
 *  1) 统一走 AudioContext.decodeAudioData —— 浏览器原生解封装
 *     覆盖：mp3 / wav / m4a / aac / mp4 / mov / webm / ogg / flac / opus
 *  2) 微信传输文件：微信语音为 AMR/SILK(私有名)，聊天视频多为 mp4/H.264，
 *     mp4 直接解码；AMR/SILK 无法原生解码 → 给出明确降级方案
 *  3) 视频轨不影响 decodeAudioData（只取音频轨）
 *  4) 提供重采样到目标采样率 + 归一化 + 静音裁剪等预处理
 */
(function (global) {
  'use strict';
  var BS = global.BS;
  var U = BS.util;

  var SUPPORTED = [
    { ext: 'mp3',  label: 'MP3',       type: 'audio' },
    { ext: 'wav',  label: 'WAV',       type: 'audio' },
    { ext: 'm4a',  label: 'M4A/AAC',   type: 'audio' },
    { ext: 'aac',  label: 'AAC',       type: 'audio' },
    { ext: 'flac', label: 'FLAC',      type: 'audio' },
    { ext: 'ogg',  label: 'OGG/Opus',  type: 'audio' },
    { ext: 'opus', label: 'OPUS',      type: 'audio' },
    { ext: 'weba', label: 'WEBA',      type: 'audio' },
    { ext: 'mp4',  label: 'MP4 视频',  type: 'video' },
    { ext: 'm4v',  label: 'M4V 视频',  type: 'video' },
    { ext: 'mov',  label: 'MOV 视频',  type: 'video' },
    { ext: 'webm', label: 'WEBM 视频', type: 'video' },
    { ext: 'mkv',  label: 'MKV 视频',  type: 'video', native: false },
    { ext: 'amr',  label: 'AMR(微信语音)', type: 'audio', native: false },
    { ext: 'silk', label: 'SILK(微信语音)', type: 'audio', native: false },
    { ext: 'wma',  label: 'WMA',       type: 'audio', native: false },
    { ext: 'aiff', label: 'AIFF',      type: 'audio', native: false }
  ];

  function extOf(name) {
    var m = /\.([a-z0-9]+)$/i.exec(name || '');
    return m ? m[1].toLowerCase() : '';
  }

  /* ======================================================================
   * 原声高识别的底层工具（纯函数，供 detectRootNote 用）
   * ==================================================================== */
  var ROOT_SR = 11025;        // 与基频跟踪同一采样率：>5.5k 对基频没信息

  /** AudioBuffer → 单声道 Float32 @ targetSr（两点平均当简易抗混叠） */
  function monoAt(buffer, targetSr, maxSec) {
    var ch = buffer.numberOfChannels;
    var ratio = buffer.sampleRate / targetSr;
    var total = Math.floor(buffer.length / ratio);
    var n = Math.max(1, Math.min(total, Math.round(maxSec * targetSr)));
    var data = [];
    for (var c = 0; c < ch; c++) data.push(buffer.getChannelData(c));
    var out = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var pos = i * ratio, i0 = pos | 0, frac = pos - i0;
      var acc = 0;
      for (var k = 0; k < ch; k++) {
        var d = data[k], a = d[i0] || 0, b = d[i0 + 1] || 0;
        acc += (a + b) * 0.5 + ((b - a) * 0.5) * frac;
      }
      out[i] = acc / ch;
    }
    return out;
  }

  /** 单帧基频：CMNDF（YIN 的累积均值归一化差分）取第一个可信谷
   *  返回 {f0, conf} 或 null。conf = 1 - 谷底深度，越接近 1 越可信。 */
  function frameF0(x, from, win, sr, f0Min, f0Max) {
    var lagMin = Math.max(2, Math.floor(sr / f0Max));
    var lagMax = Math.min(Math.floor(win * 0.8), Math.ceil(sr / f0Min));
    var span = win - lagMax;                 // 所有 lag 用同一比较长度，避免长度偏置
    if (span < 32 || lagMax <= lagMin) return null;

    var d = new Float32Array(lagMax + 2);
    var cum = 0;
    for (var lag = 1; lag <= lagMax; lag++) {
      var diff = 0;
      for (var j = 0; j < span; j++) {
        var t = x[from + j] - x[from + j + lag];
        diff += t * t;
      }
      cum += diff;
      // d'(τ) = d(τ) / ((1/τ)·Σ_{k≤τ} d(k))；cum 已含本次 d(τ)
      d[lag] = cum > 1e-12 ? diff * lag / cum : 1;
    }

    // 第一遍算完再找：找「第一个低于阈值的局部极小」，这样不会被次谐波抢走
    var best = -1, bestV = 1e9;
    for (var l = lagMin; l <= lagMax; l++) {
      var right = (l === lagMax) ? 1 : d[l + 1];   // 右边界没有邻居，按「是极小」算
      if (d[l] < 0.15 && d[l] <= d[l - 1] && d[l] <= right) { best = l; bestV = d[l]; break; }
      if (d[l] < bestV) { bestV = d[l]; best = l; }
    }
    if (best < 1) return null;

    // 抛物线插值：lag 是整数采样点，不插值会有几十音分的量化误差
    var shift = 0;
    if (best > lagMin && best < lagMax) {
      var y0 = d[best - 1], y1 = d[best], y2 = d[best + 1];
      var den = y0 - 2 * y1 + y2;
      shift = Math.abs(den) > 1e-12 ? 0.5 * (y0 - y2) / den : 0;
    }
    var lagF = best + U.clamp(shift, -0.5, 0.5);
    return { f0: sr / lagF, conf: U.clamp(1 - bestV, 0, 1) };
  }

  /** 按权重求中位数（samples[i] = {midi, w}） */
  function weightedMedian(samples) {
    var a = samples.slice().sort(function (x, y) { return x.midi - y.midi; });
    var total = 0;
    for (var i = 0; i < a.length; i++) total += a[i].w;
    var half = total * 0.5, acc = 0;
    for (var k = 0; k < a.length; k++) {
      acc += a[k].w;
      if (acc >= half) return a[k].midi;
    }
    return a[a.length - 1].midi;
  }

  var Loader = BS.loader = {
    SUPPORTED: SUPPORTED,

    describeFormat: function (name) {
      var e = extOf(name);
      for (var i = 0; i < SUPPORTED.length; i++) {
        if (SUPPORTED[i].ext === e) {
          var s = SUPPORTED[i];
          return s.label + (s.native === false ? '（需转码）' : '');
        }
      }
      return e ? e.toUpperCase() + '（自动识别）' : '未知格式';
    },

    isNative: function (name) {
      var e = extOf(name);
      for (var i = 0; i < SUPPORTED.length; i++) {
        if (SUPPORTED[i].ext === e) return SUPPORTED[i].native !== false;
      }
      return true;
    },

    acceptAttr: 'audio/*,video/*,.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus,.webm,.mp4,.m4v,.mov,.mkv,.amr,.silk,.wma,.aiff,.aif',

    /* File -> AudioBuffer */
    decodeFile: function (ctx, file) {
      var ext = extOf(file.name);
      return new Promise(function (resolve, reject) {
        var fr = new FileReader();
        fr.onerror = function () { reject(new Error('文件读取失败：' + file.name)); };
        fr.onload = function () {
          var ab = fr.result;

          var fail = function (err) {
            reject(new Error(Loader.explain(err, file.name)));
          };

          /* WAV 走自研解析器（兼容 decodeAudioData 不认的 WAV 变体）。
           * ⚠️ 解析器在 core.js 里，命名空间是 **BS.wav**，不是 Loader.wav。
           *    之前误写成 Loader.wav → undefined.decode → 所有 WAV 导入全挂。 */
          var viaRawWav = function () {
            var parser = BS.wav;
            if (!parser || typeof parser.decode !== 'function') {
              // 解析器不可用 → 退回浏览器原生
              return viaDecode();
            }
            try {
              Loader.parseRaw(ctx, parser.decode(ab)).then(resolve, fail);
            } catch (e) {
              // 自研解析失败（罕见格式）→ 也退回原生，避免整条路都断掉
              viaDecode();
            }
          };

          var viaDecode = function () {
            try {
              var p = ctx.decodeAudioData(ab, undefined, fail);
              if (p && typeof p.then === 'function') p.then(resolve, fail);
            } catch (e) { fail(e); }
          };

          // WAV 走自研解析器兜底（兼容 decodeAudioData 不认的 WAV 变体）
          if (ext === 'wav' || ext === 'wave') viaRawWav();
          else viaDecode();
        };
        fr.readAsArrayBuffer(file);
      });
    },

    /* decodeAudioData 报错翻译成可执行建议 */
    explain: function (err, fileName) {
      var ext = extOf(fileName);
      var base = '无法解码「' + (fileName || '文件') + '」：' +
        ((err && (err.message || err)) || '未知错误') + '。';
      if (['amr', 'silk'].indexOf(ext) >= 0) {
        return base + ' 微信语音为 AMR/SILK 私有格式，浏览器无法原生解码。' +
          '请用手机系统录音重录，或用 ffmpeg 转码：ffmpeg -i in.' + ext + ' -ar 44100 out.wav';
      }
      if (['mkv', 'wma', 'aiff', 'aif'].indexOf(ext) >= 0) {
        return base + ' 该容器/编码浏览器不支持。转码命令：' +
          'ffmpeg -i "' + fileName + '" -vn -ar 44100 -ac 2 out.wav';
      }
      if (['mp4', 'mov', 'm4v'].indexOf(ext) >= 0) {
        return base + ' 视频内可能无音轨，或使用了浏览器未内置的解码器。转码命令：' +
          'ffmpeg -i "' + fileName + '" -vn -c:a aac -ar 44100 out.m4a';
      }
      return base + ' 建议转成 WAV/MP3 后重试：ffmpeg -i "' + (fileName || 'in') + '" -vn -ar 44100 out.wav';
    },

    /* {channels, sampleRate} -> AudioBuffer */
    parseRaw: function (ctx, raw) {
      return new Promise(function (resolve) {
        var len = raw.frames;
        var buf = ctx.createBuffer(raw.channels.length, len, raw.sampleRate);
        for (var c = 0; c < raw.channels.length; c++) buf.copyToChannel(raw.channels[c], c);
        resolve(buf);
      });
    },

    /* ---------------- 预处理 ---------------- */

    /**
     * 裁掉首尾静音，返回 {buffer, startSec, endSec, peak, noiseFloor}。
     *
     * ⚠️ 为什么不能用固定阈值（这是老实现的 bug）：
     *   固定 -48dB 对「数字静音」有效，但真实素材常常带底噪或渐入：
     *     · 带底噪的录音：开头就有 -43dB 的噪声 → 阈值形同虚设，一帧都没裁
     *     · 渐入的乐器/人声：开头就是 -45dB 缓慢爬升 → 同上
     *   改用**自适应阈值**：先估噪声基底（首尾静音区的中位峰值），
     *   再取 噪声基底 + margin 作为裁剪线。
     *
     * 边界精确到样本：先用窗口快速定位，再在窗口内**逐样本回退/前进**，
     *   避免把渐弱尾巴整段切掉（老实现会多裁几十毫秒）。
     */
    trimSilence: function (ctx, buffer, thresholdDb, opts) {
      opts = opts || {};
      var ch = buffer.numberOfChannels, len = buffer.length;
      var data = [];
      for (var c = 0; c < ch; c++) data.push(buffer.getChannelData(c));

      /** 任意帧的绝对峰值（多声道取最大） */
      function peakAt(i) {
        var p = 0;
        for (var c2 = 0; c2 < ch; c2++) {
          var a = Math.abs(data[c2][i]);
          if (a > p) p = a;
        }
        return p;
      }
      /** 帧区间峰值 */
      function peakRange(from, to) {
        var p = 0;
        var e = Math.min(to, len);
        for (var i = Math.max(0, from); i < e; i++) {
          var v = peakAt(i);
          if (v > p) p = v;
        }
        return p;
      }

      var globalPeak = peakRange(0, len);
      var WIN = 256;

      /* ---- 1) 估噪声基底 ----
       * 用**窗口峰值的低分位数**，不能用「首尾区的峰值」。
       *
       * 原因：真实素材常常没有纯静音区 ——
       *   · 渐入的猫叫/人声：开头第一帧就已在爬升
       *   · 带底噪的录音：首尾永远有噪声
       * 取低分位数（本实现取 10%）能拿到「本底的安静程度」，
       * 对上面两种素材都成立。
       * 例：某渐入猫叫素材的窗口峰值分布 —— 5%=0.00003 / 25%=0.029 / 中位=0.14，
       * 10% 分位正好落在真正的安静区，而首区峰值已经是 0.021（信号本身）。 */
      var winPeaks = [];
      for (var w = 0; w < len; w += WIN) {
        winPeaks.push(peakRange(w, w + WIN));
      }
      winPeaks.sort(function (a, b) { return a - b; });
      var qIdx = Math.floor(winPeaks.length * (opts.noisePercentile === undefined ? 0.10 : opts.noisePercentile));
      if (qIdx >= winPeaks.length) qIdx = winPeaks.length - 1;
      var noiseFloor = winPeaks[qIdx] || 0;
      // 全片都很响时不要把噪声基底抬到接近信号
      if (noiseFloor > globalPeak * 0.5) noiseFloor = globalPeak * 0.5;

      /* ---- 2) 自适应阈值 ----
       * 主判据是**峰值相对值**（floorDb，默认 -35dB），
       * 而不是绝对 dB 或噪声基底。原因：
       *   真实素材常常完全没有静音区（渐入的猫叫/渐弱的人声），
       *   此时「噪声基底」测出来的其实是信号本身，阈值会被抬得过高，
       *   把大半个素材裁掉（实测会从 796ms 裁到 489ms）。
       * 峰值相对阈值对这类素材稳定：峰值 -35dB 正好落在真实边界。
       *
       * 噪声基底只作**下限**：保证带底噪录音不会被裁进噪声里
       * （阈值至少要比噪声高 marginDb）。
       */
      var floorDb = opts.floorDb === undefined ? -35 : opts.floorDb;
      var marginDb = opts.marginDb === undefined ? 12 : opts.marginDb;
      var thresh = globalPeak * Math.pow(10, floorDb / 20);

      /* 噪声下限只在「素材真的有静音区」时才生效。
       *
       * 判据是「噪声基底是否接近数字静音」，而不是「比峰值低多少 dB」。
       * 原因：真实录音的底噪常在 -50…-40dB，相对峰值并不算低，
       * 但它**确实是噪声**；而渐入/渐弱素材的「噪声基底」其实是
       * 信号的一部分（本例 0.011 ≈ 峰值的 1/30），此时用噪声下限
       * 会把大半个素材裁掉。
       *
       * 绝对门槛：噪声基底低于 -60dBFS 才认为是真静音区。 */
      var absSilence = Math.pow(10, (opts.silenceFloorDb === undefined ? -60 : opts.silenceFloorDb) / 20);
      var hasRealSilence = noiseFloor <= absSilence;
      if (hasRealSilence) {
        var noiseLimit = noiseFloor * Math.pow(10, marginDb / 20);
        if (thresh < noiseLimit) thresh = noiseLimit;
      }

      // 用户显式给了 thresholdDb（绝对 dB）时取较大值，
      // 但不超过峰值 -12dB（否则弱素材会被整段当静音）
      if (thresholdDb !== undefined && thresholdDb !== null) {
        var fixed = Math.pow(10, thresholdDb / 20);
        if (fixed > thresh) thresh = fixed;
        var cap = globalPeak * Math.pow(10, -12 / 20);
        if (thresh > cap) thresh = cap;
      }
      if (thresh <= 0) thresh = globalPeak * 0.01;

      /* ---- 3) 窗口粗定位 ---- */
      var start = -1, end = -1;
      for (var i = 0; i < len; i += WIN) {
        if (peakRange(i, i + WIN) > thresh) { start = i; break; }
      }
      if (start < 0) {
        // 全片都低于阈值：保留原样，别返回空 buffer
        return { buffer: buffer, startSec: 0, endSec: buffer.duration,
                 peak: globalPeak, noiseFloor: noiseFloor, thresh: thresh,
                 hasRealSilence: hasRealSilence };
      }
      for (var k = len - WIN; k >= start; k -= WIN) {
        if (peakRange(k, k + WIN) > thresh) { end = Math.min(len, k + WIN); break; }
      }
      if (end <= start) end = len;

      /* ---- 4) 边界精确到样本 ----
       * 窗口会把边界撑到整个窗口（最多 WIN 帧 ≈ 5.8ms），
       * 对渐弱尾巴来说就是「多裁一段」。这里回退到真实越界点。 */
      var guard = opts.guardMs === undefined ? 2 : opts.guardMs;
      var sr = buffer.sampleRate;
      var guardN = Math.max(0, Math.round(guard / 1000 * sr));

      // 起点：从 start 往回退，直到低于阈值；再留 guard 帧余量保住起音
      var s = start;
      while (s > 0 && peakAt(s - 1) > thresh) s--;
      s = Math.max(0, s - guardN);

      // 终点：从 end 往前找真实结束点；再留 guard 帧余量保住渐弱尾巴
      var e = Math.min(len, end);
      while (e > s && peakAt(e - 1) <= thresh) e--;
      e = Math.min(len, e + guardN);

      if (e <= s) {
        return { buffer: buffer, startSec: 0, endSec: buffer.duration,
                 peak: globalPeak, noiseFloor: noiseFloor, thresh: thresh,
                 hasRealSilence: hasRealSilence };
      }

      /* ---- 5) 切出并加淡入淡出（防硬切爆音）---- */
      var fadeMs = opts.fadeMs === undefined ? 3 : opts.fadeMs;
      var fadeN = Math.min(Math.round(fadeMs / 1000 * sr), Math.floor((e - s) / 2));
      var outLen = e - s;
      var nb = ctx.createBuffer(ch, outLen, sr);
      for (var c4 = 0; c4 < ch; c4++) {
        var src = data[c4];
        var dst = nb.getChannelData(c4);
        for (var m = 0; m < outLen; m++) dst[m] = src[s + m];
        if (fadeN > 0) {
          for (var f = 0; f < fadeN; f++) {
            var g = f / fadeN;
            dst[f] *= g;
            dst[outLen - 1 - f] *= g;
          }
        }
      }
      return { buffer: nb, startSec: 0, endSec: nb.duration,
               peak: globalPeak, noiseFloor: noiseFloor, thresh: thresh,
               hasRealSilence: hasRealSilence };
    },

    /* ---------------- 采样原声高识别 ----------------
     * 「原声高」决定键盘按哪个键时原速播放（playbackRate = 1）。
     * 以前装载采样后一律给 C4（60）—— 那只是默认值，不是分析结果：
     * 录一个 A2 的贝斯，按 C4 会加速（音高也一起偏），必须手动改回来才对。
     * 这里补上真正的检测，让初始音高不是瞎填的。
     *
     * 算法（纯时域、无第三方库，几十毫秒量级）：
     *   降采样到 11k 单声道 → 按能量挑若干帧 → 每帧算 CMNDF（YIN 的
     *   累积均值归一化差分函数）→ 取第一个可信谷得基频 → 加权中位数 →
     *   落到最近的平均律音高。
     * 和弦 / 鼓 / 噪声 / 混响很重的素材会给出很低的 conf，调用方据此决定
     * 是否采用（不采用就保持原值并如实告知，绝不静默瞎猜）。
     */
    detectRootNote: function (buffer, opts) {
      opts = opts || {};
      if (!buffer || !buffer.length || !buffer.sampleRate) return null;
      var sr = ROOT_SR;

      // 1) 只分析前 4 秒（长素材也够判断；避免整首降采样）
      var mono = monoAt(buffer, sr, opts.maxSec || 4);
      if (mono.length < 512) return null;

      // 2) 分帧，按 RMS 挑能量高的帧（起音瞬态里噪声多，取整体响的部分更稳）
      var win = Math.min(2048, mono.length - 1);
      var hop = Math.max(128, win >> 2);
      var frames = [];
      for (var off = 0; off + win <= mono.length; off += hop) {
        var e = 0;
        for (var j = 0; j < win; j++) { var v = mono[off + j]; e += v * v; }
        frames.push({ off: off, rms: Math.sqrt(e / win) });
      }
      if (!frames.length) return null;
      frames.sort(function (a, b) { return b.rms - a.rms; });
      var maxRms = frames[0].rms;
      if (!(maxRms > 1e-5)) return null;      // 整段近乎静音
      var picked = frames.filter(function (f) { return f.rms >= maxRms * 0.25; })
        .slice(0, opts.maxFrames || 12);

      // 3) 逐帧求基频，只保留清晰度够的帧
      var f0Min = opts.f0Min || 40;
      var f0Max = opts.f0Max || 2000;
      var samples = [];
      for (var i = 0; i < picked.length; i++) {
        var r = frameF0(mono, picked[i].off, win, sr, f0Min, f0Max);
        if (!r || r.conf < 0.5) continue;
        samples.push({
          midi: 69 + 12 * Math.log2(r.f0 / 440),
          f0: r.f0,
          w: Math.max(1e-6, picked[i].rms * r.conf),
          conf: r.conf
        });
      }
      if (!samples.length) return null;

      // 4) 音高（半音域）加权中位数：比直接平均更抗八度抖动
      var medMidi = weightedMedian(samples);
      var midi = Math.round(medMidi);

      // 5) 可信度 = 与中位数一致的权重占比 × 平均清晰度
      var totalW = 0, agreeW = 0, clarW = 0;
      for (var k = 0; k < samples.length; k++) {
        var s = samples[k];
        totalW += s.w;
        clarW += s.w * s.conf;
        if (Math.abs(s.midi - medMidi) <= 0.5) agreeW += s.w;
      }
      var conf = (totalW > 0 ? agreeW / totalW : 0) * (totalW > 0 ? clarW / totalW : 0);

      return {
        midi: midi,
        freq: BS.pitch.midiToFreq(midi),
        refFreq: Math.pow(2, (medMidi - 69) / 12) * 440,   // 实测基频（可能不在平均律上）
        cents: Math.round((medMidi - midi) * 100),
        conf: U.clamp(conf, 0, 1),
        frames: samples.length
      };
    },

    /* 反向 */
    reverse: function (ctx, buffer) {
      var out = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
      for (var c = 0; c < buffer.numberOfChannels; c++) {
        var src = buffer.getChannelData(c);
        var dst = new Float32Array(src.length);
        for (var i = 0; i < src.length; i++) dst[i] = src[src.length - 1 - i];
        out.copyToChannel(dst, c);
      }
      return out;
    },

    /* 归一化到 targetPeak(0..1)，返回增益倍数 */
    normalize: function (buffer, targetPeak) {
      var peak = 0, ch = buffer.numberOfChannels;
      for (var c = 0; c < ch; c++) {
        var d = buffer.getChannelData(c);
        for (var i = 0; i < d.length; i++) {
          var a = Math.abs(d[i]);
          if (a > peak) peak = a;
        }
      }
      if (peak < 1e-6) return 1;
      var target = targetPeak === undefined ? 0.98 : targetPeak;
      return target / peak;
    },

    /* 单声道化 */
    toMono: function (ctx, buffer) {
      if (buffer.numberOfChannels === 1) return buffer;
      var out = ctx.createBuffer(1, buffer.length, buffer.sampleRate);
      var dst = out.getChannelData(0);
      for (var c = 0; c < buffer.numberOfChannels; c++) {
        var src = buffer.getChannelData(c);
        for (var i = 0; i < src.length; i++) dst[i] += src[i];
      }
      var inv = 1 / buffer.numberOfChannels;
      for (var j = 0; j < dst.length; j++) dst[j] *= inv;
      return out;
    },

    /* 重采样到目标采样率（离线渲染时统一用） */
    resample: function (ctx, buffer, targetRate) {
      if (!targetRate || Math.abs(buffer.sampleRate - targetRate) < 1) return buffer;
      var ratio = buffer.sampleRate / targetRate;
      var outLen = Math.max(1, Math.floor(buffer.length / ratio));
      var ch = buffer.numberOfChannels;
      var out = ctx.createBuffer(ch, outLen, targetRate);
      for (var c = 0; c < ch; c++) {
        var src = buffer.getChannelData(c);
        var dst = out.getChannelData(c);
        for (var i = 0; i < outLen; i++) {
          var pos = i * ratio;
          var i0 = Math.floor(pos);
          var frac = pos - i0;
          var s0 = src[i0] || 0;
          var s1 = src[i0 + 1] || 0;
          dst[i] = s0 + (s1 - s0) * frac;
        }
      }
      return out;
    },

    /* 波形峰值包络（用于切片显示） */
    peaks: function (buffer, buckets) {
      var n = buckets || 256;
      var d = buffer.getChannelData(0);
      var out = new Float32Array(n);
      var per = Math.max(1, Math.floor(d.length / n));
      for (var i = 0; i < n; i++) {
        var p = 0;
        var s = i * per, e = Math.min(d.length, s + per);
        for (var j = s; j < e; j++) {
          var v = d[j] < 0 ? -d[j] : d[j];
          if (v > p) p = v;
        }
        out[i] = p;
      }
      return out;
    }
  };

})(window);

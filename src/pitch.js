/* BandSynth · pitch.js
 * 变调算法：
 *  1) varispeed —— 直接改 playbackRate。零延迟、零 CPU，采样机的传统做法，
 *     代价是时长随音高变化（升高变短）。
 *  2) stretch（锁时长）—— WSOLA 波形相似度重叠相加做时间伸缩，再用 playbackRate 复采样。
 *     输出时长 = 原时长，音高任意变化。用于 pad / loop / 需要卡时值的场合。
 *
 * WSOLA 原理：
 *   以固定合成步长 Hs_out 逐帧输出，每帧在输入中以步长 Ha=Hs_out/s 前进；
 *   对每帧在 ±search 范围内搜索一个偏移 δ，使输入片段与"上一帧的自然延续"最相似，
 *   从而在拉伸时间的同时保持局部波形与基频连续（听起来音高清晰、无明显相位断裂）。
 *   之后再以 playbackRate = r 复采样，得到 音高×r、时长不变。
 */
(function (global) {
  'use strict';
  var BS = global.BS;

  /* 质量档位
   * frame: 帧长。决定 OLA 的相位重建精度 —— 帧内含整数个信号周期时无误差，
   *        非整数周期会产生系统性音高偏移（实测：440Hz 下 N=1024 偏 +17%，
   *        N=4096 偏 -2%，N=8192 偏 ±0.4%）。故高质量档需要长帧。
   * hopDiv: 合成步长 = frame / hopDiv，重叠率 = 1 - 1/hopDiv
   * search/corr: 相似性搜索半径与相关窗长度 */
  var QUALITY = {
    low:    { frame: 2048, hopDiv: 4, search: 128, corr: 256 },
    medium: { frame: 4096, hopDiv: 4, search: 256, corr: 512 },
    high:   { frame: 8192, hopDiv: 4, search: 512, corr: 1024 }
  };

  /* sqrt-Hann 窗：对含非整数个周期的信号比 Hann 更对称，音高偏差更小 */
  function sqrtHann(N) {
    var w = new Float32Array(N);
    for (var i = 0; i < N; i++) w[i] = Math.sin(Math.PI * i / N);
    return w;
  }

  /* ---------- 归一化互相关（子采样加速） ---------- */
  function bestOffset(x, ref, from, len, radius, stride) {
    var best = 0, bestScore = -Infinity;
    var step = stride || 4;
    for (var d = -radius; d <= radius; d += 1) {
      var p = from + d;
      if (p < 0 || p + len >= x.length) continue;
      var num = 0, den = 1e-9;
      for (var i = 0; i < len; i += step) {
        var a = x[p + i], b = ref[i];
        num += a * b;
        den += a * a;
      }
      var score = num / Math.sqrt(den);
      if (score > bestScore) { bestScore = score; best = d; }
    }
    return best;
  }

  /* ---------- 缓存（分片计算，避免长任务卡顿） ---------- */
  function clampInt(v, lo, hi) { v = Math.round(v); return v < lo ? lo : (v > hi ? hi : v); }
  function StretchCache() {
    this.map = new Map();
    this.jobs = [];
    this.running = false;
    this.CHUNK_MS = 6; // 每片计算预算
  }

  StretchCache.prototype.key = function (bufferId, ratio, quality) {
    return bufferId + '|' + ratio.toFixed(4) + '|' + quality;
  };

  /* 命中则返回 buffer；未命中则排队计算并返回 null（调用方回退 varispeed） */
  StretchCache.prototype.get = function (ctx, buffer, bufferId, ratio, quality) {
    var k = this.key(bufferId, ratio, quality);
    var hit = this.map.get(k);
    if (hit !== undefined) return hit;
    this.enqueue(ctx, buffer, k, ratio, quality);
    return null;
  };

  StretchCache.prototype.enqueue = function (ctx, buffer, key, ratio, quality) {
    for (var i = 0; i < this.jobs.length; i++) if (this.jobs[i].key === key) return;
    var self = this;
    this.jobs.push({
      key: key, ctx: ctx, buffer: buffer, ratio: ratio, quality: quality,
      done: function (b) {
        self.map.set(key, b);
        BS.emit('stretch:ready', { key: key, ratio: ratio });
      }
    });
    this.pump();
  };

  StretchCache.prototype.pump = function () {
    if (this.running) return;
    var job = this.jobs.shift();
    if (!job) return;
    var self = this;
    var ctx = job.ctx;
    var src = job.buffer.getChannelData(0);

    var cfg = QUALITY[job.quality] || QUALITY.medium;
    var N = cfg.frame;
    var Hs = Math.max(16, Math.floor(N / cfg.hopDiv));  // 合成步长（输出侧，等距）
    var len = src.length;
    var ratio = job.ratio;                              // 时间伸缩因子
    var Ha = Hs / ratio;                                // 分析步长（输入侧，等距）

    this.running = true;

    // 采样太短：退化为线性重采样
    if (len < N * 2) {
      this.finish(ctx, job, null, null);
      this.running = false;
      this.pump();
      return;
    }

    // 输出帧数：铺满整段输入 → 输出长度 ≈ len * ratio
    var totalFrames = Math.ceil(len / Ha) + 3;
    var outLen = totalFrames * Hs + N;
    var out = new Float32Array(outLen);
    var win = sqrtHann(N);
    var norm = 2 / cfg.hopDiv;   // sqrt-Hann 在 hopDiv 重叠下求和 ≈ hopDiv/2

    var usePrev = -1;

    function chunk(startK) {
      var t = performance.now();
      var k0 = startK || 0;
      for (var k = k0; k < totalFrames; k++) {
        // 时间片预算到就 yield，保持 UI 与音频线程响应
        if (performance.now() - t >= self.CHUNK_MS) {
          setTimeout(function () { chunk(k); }, 0);
          return;
        }

        var synth = k * Hs;      // 合成位置：严格等距
        var an = k * Ha;         // 分析位置：等距
        if (an >= len - N) break;

        var use = clampInt(an, 0, len - N);

        // WSOLA 相似性搜索：
        // 以「上一帧实际使用的输入片段」为参考，在其按 Ha 自然延伸的位置附近
        // 搜索最相似的候选，使相邻帧波形连续，避免 OLA 叠加产生梳状滤波与音高偏移。
        if (k > 0 && cfg.search > 0 && usePrev >= 0) {
          var center = clampInt(usePrev + Ha, 0, len - N);
          if (usePrev + cfg.corr <= len && center + cfg.corr <= len) {
            var ref = src.subarray(usePrev, usePrev + cfg.corr);
            var d = bestOffset(src, ref, center, cfg.corr, cfg.search, 4);
            use = clampInt(center + d, 0, len - N);
          } else {
            use = center;
          }
        }
        usePrev = use;

        for (var j = 0; j < N; j++) {
          var o = synth + j;
          if (o < 0 || o >= outLen) continue;
          out[o] += src[use + j] * win[j] * norm;
        }
      }
      self.finish(ctx, job, out, src, ratio);
      self.running = false;
      self.pump();
    }
    setTimeout(chunk, 0);
  };

  /* 复采样到目标音高比：
     伸缩后输出长 ≈ len*ratio，再以 ratio 复采样 → 时长回到 len（锁定），音高 ×ratio */
  StretchCache.prototype.finish = function (ctx, job, out, srcFallback, ratioOverride) {
    if (!out) {
      // 退化路径：线性重采样到目标音高比
      var r0 = job.ratio;
      var s0 = srcFallback || job.buffer.getChannelData(0);
      var n0 = Math.max(1, Math.round(s0.length));
      var lin = new Float32Array(n0);
      for (var a = 0; a < n0; a++) {
        var p = a * r0, i0 = Math.floor(p), f = p - i0;
        lin[a] = (s0[i0] || 0) + ((s0[i0 + 1] || 0) - (s0[i0] || 0)) * f;
      }
      var b0 = ctx.createBuffer(1, n0, job.buffer.sampleRate);
      b0.copyToChannel(lin, 0);
      job.done(b0);
      return;
    }

    var ratio = ratioOverride || job.ratio;
    var srcLen = (srcFallback || job.buffer.getChannelData(0)).length;
    // 目标：复采样后长度 == 原采样长度（时长锁定）
    var targetLen = srcLen;
    var resampled = new Float32Array(targetLen);
    for (var i = 0; i < targetLen; i++) {
      var p = i * ratio;
      var i0 = Math.floor(p), f = p - i0;
      var a2 = out[i0] || 0, b2 = out[i0 + 1] || 0;
      resampled[i] = a2 + (b2 - a2) * f;
    }

    // 峰值归一，避免 OLA 叠加过载
    var peak = 0;
    for (var j = 0; j < resampled.length; j++) {
      var v = resampled[j] < 0 ? -resampled[j] : resampled[j];
      if (v > peak) peak = v;
    }
    if (peak > 1e-6 && peak > 0.98) {
      var g = 0.98 / peak;
      for (var k = 0; k < resampled.length; k++) resampled[k] *= g;
    }

    var buf = ctx.createBuffer(1, resampled.length, job.buffer.sampleRate);
    buf.copyToChannel(resampled, 0);
    job.done(buf);
  };

  StretchCache.prototype.has = function (bufferId, ratio, quality) {
    return this.map.has(this.key(bufferId, ratio, quality));
  };

  /* 等一批缓存键全部算完（或超时）。
     编曲试听用：锁时长变调的缓存没算好时 noteOn 会退回变速变调 ——
     音高对但时值跟着变，整段听感是错的。播放前等它就绪，才谈得上「一直锁时长」。 */
  StretchCache.prototype.whenAll = function (keys, timeoutMs) {
    var self = this;
    var limit = timeoutMs === undefined ? 15000 : timeoutMs;
    var t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    return new Promise(function (resolve) {
      (function poll() {
        var missing = 0;
        for (var i = 0; i < keys.length; i++) if (!self.map.has(keys[i])) missing++;
        var spent = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
        if (!missing || spent >= limit) { resolve({ ready: keys.length - missing, pending: missing }); return; }
        setTimeout(poll, 40);
      })();
    });
  };

  StretchCache.prototype.clear = function () { this.map.clear(); this.jobs.length = 0; };

  var cache = new StretchCache();

  /* 音高比量化：48 步/八度（≈25 音分）。
     不量化的话每个新音高都要一份完整缓存，长曲子里几百个音高会把内存吃光；
     量化后听感无差别，缓存量降到可控。 */
  function quantRatio(ratio) {
    if (!isFinite(ratio) || ratio <= 0) return 1;
    return Math.pow(2, Math.round(Math.log2(ratio) * 48) / 48);
  }

  /* 某音高需要的音高比；不需要/不能做 WSOLA 时返回 0 */
  function ratioForNote(note, rootNote, transpose, fine) {
    var semis = (note - rootNote) + (transpose || 0) + (fine || 0) / 100;
    var r = quantRatio(Math.pow(2, semis / 12));
    if (Math.abs(r - 1) < 1e-4 || r > 7.9 || r < 0.127) return 0;   // ±3 个八度外不做
    return r;
  }

  BS.pitchAlgo = {
    QUALITY: QUALITY,
    cache: cache,
    quantRatio: quantRatio,
    ratioForNote: ratioForNote,

    /* 为某个采样在给定音高比下取得「锁时长」的可播放 buffer；
       未命中返回 null，调用方立即回退 varispeed（零延迟），后台算好后自动升级 */
    prepare: function (ctx, buffer, bufferId, ratio, quality) {
      if (!buffer) return null;
      if (Math.abs(ratio - 1) < 1e-4) return buffer;
      if (ratio > 7.9 || ratio < 0.127) return null;   // 超出 ±3 个八度
      var r = quantRatio(ratio);
      if (Math.abs(r - 1) < 1e-4) return buffer;
      return cache.get(ctx, buffer, bufferId, r, quality || 'medium');
    },

    /* 预热一批音高（分片后台执行，不阻塞 UI 与音频线程） */
    prewarm: function (ctx, buffer, bufferId, notes, rootNote, transpose, fine, quality) {
      if (!buffer || !notes) return;
      var q = quality || 'medium';
      var seen = {};
      notes.forEach(function (n) {
        var r = ratioForNote(n, rootNote, transpose, fine);
        if (!r) return;
        var k = cache.key(bufferId, r, q);
        if (seen[k]) return;
        seen[k] = 1;
        cache.get(ctx, buffer, bufferId, r, q);
      });
    },

    /* 预热 + 等待：返回 Promise<{total, ready, pending}>。
       与 prewarm 的差别是「可等」——编曲试听必须在播放前确认缓存就绪，
       否则 noteOn 会退回变速变调（音高对、时值错），整段就白听了。 */
    warmNotes: function (ctx, buffer, bufferId, notes, rootNote, transpose, fine, quality, opts) {
      opts = opts || {};
      var keys = [], seen = {};
      if (buffer && notes && notes.length) {
        var q = quality || 'medium';
        for (var i = 0; i < notes.length; i++) {
          var r = ratioForNote(notes[i], rootNote, transpose, fine);
          if (!r) continue;
          var k = cache.key(bufferId, r, q);
          if (seen[k]) continue;
          seen[k] = 1;
          keys.push(k);
          if (!cache.map.has(k)) cache.get(ctx, buffer, bufferId, r, q);
        }
      }
      if (!keys.length) return Promise.resolve({ total: 0, ready: 0, pending: 0 });
      return cache.whenAll(keys, opts.timeoutMs).then(function (res) {
        return { total: keys.length, ready: res.ready, pending: res.pending };
      });
    },

    /* 采样换缓存后（换采样/改根音/裁剪）需要清空：缓存按 bufferId + ratio 存 */
    invalidate: function () { cache.clear(); },

    status: function () {
      return { cached: cache.map.size, pending: cache.jobs.length, running: cache.running };
    }
  };

})(window);

/* BandSynth · core.js
 * 基础设施：命名空间、音高/时间换算、工具函数、WAV 编解码、事件总线
 * 全局命名空间 BS，兼容 file:// 直接打开（不使用 ES Module / fetch）
 */
(function (global) {
  'use strict';

  var BS = global.BS || (global.BS = {});

  /* ---------------- 事件总线 ---------------- */
  var handlers = {};
  BS.on = function (evt, fn) {
    (handlers[evt] || (handlers[evt] = [])).push(fn);
    return function () { BS.off(evt, fn); };
  };
  BS.off = function (evt, fn) {
    var arr = handlers[evt];
    if (!arr) return;
    var i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  };
  BS.emit = function (evt, payload) {
    var arr = handlers[evt];
    if (!arr) return;
    for (var i = 0; i < arr.length; i++) {
      try { arr[i](payload); } catch (e) { console.error('[BS.on:' + evt + ']', e); }
    }
  };

  /* ---------------- 工具 ---------------- */
  var U = BS.util = {
    /* 对非有限值（NaN/Infinity）免疫：NaN 传入时返回 lo。
       AudioParam 赋值 NaN 会抛异常，必须在源头拦住。 */
    clamp: function (v, lo, hi) {
      if (typeof v !== 'number' || v !== v) return lo;
      if (v === Infinity) return hi;
      if (v === -Infinity) return lo;
      return v < lo ? lo : (v > hi ? hi : v);
    },
    lerp: function (a, b, t) { return a + (b - a) * t; },
    dbToGain: function (db) { return Math.pow(10, db / 20); },
    gainToDb: function (g) { return 20 * Math.log10(Math.max(1e-6, g)); },
    // x -> 0..1 归一化（可指定曲线）
    norm: function (v, min, max) { return max === min ? 0 : U.clamp((v - min) / (max - min), 0, 1); },
    rand: function (a, b) { return a + Math.random() * (b - a); },
    uid: (function () { var n = 0; return function (p) { n++; return (p || 'id') + '_' + n; }; })(),
    // 数组深拷贝（结构化克隆降级）
    clone: function (o) {
      if (typeof structuredClone === 'function') {
        try { return structuredClone(o); } catch (e) { /* 含函数等不可克隆对象时降级 */ }
      }
      return JSON.parse(JSON.stringify(o));
    },
    fmtTime: function (sec) {
      sec = Math.max(0, sec || 0);
      var m = Math.floor(sec / 60), s = sec - m * 60;
      return m + ':' + (s < 10 ? '0' : '') + s.toFixed(2);
    },
    fmtDb: function (g) {
      var db = U.gainToDb(g);
      return (db <= -60 ? '-∞' : db.toFixed(1)) + ' dB';
    },
    download: function (blob, filename) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click();
      setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 2000);
    },
    escapeHtml: function (s) {
      return String(s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }
  };

  /* ---------------- 音高换算 ---------------- */
  var NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  var NOTE_BASE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

  var P = BS.pitch = {
    names: NOTE_NAMES,
    A4: 440,
    midiToFreq: function (m) { return 440 * Math.pow(2, (m - 69) / 12); },
    freqToMidi: function (f) { return 69 + 12 * Math.log2(f / 440); },
    midiToName: function (m) {
      m = Math.round(m);
      return NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
    },
    nameToMidi: function (name) {
      if (typeof name === 'number') return name;
      var m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(String(name).trim());
      if (!m) return null;
      var base = NOTE_BASE[m[1].toUpperCase()];
      if (m[2] === '#') base++;
      if (m[2] === 'b') base--;
      return base + (parseInt(m[3], 10) + 1) * 12;
    },
    centsToRatio: function (cents) { return Math.pow(2, cents / 1200); },
    ratioToCents: function (r) { return 1200 * Math.log2(r); }
  };

  /* ---------------- 时间 / 拍号 ---------------- */
  var T = BS.timing = {
    secPerBeat: function (bpm) { return 60 / bpm; },
    secPerBar: function (bpm, sig) { return (60 / bpm) * (sig ? sig[0] : 4); },
    barBeatToBeats: function (bar, beat, sig) {
      var len = sig ? sig[0] : 4;
      return bar * len + beat;
    },
    // 带 swing 的时间偏移（swing 0..1，正拍后移）
    swingOffset: function (beats, swing, sig) {
      if (!swing) return 0;
      var len = sig ? sig[0] : 4;
      var b = ((beats % len) + len) % len;
      var beat = Math.floor(b);
      var isOff = Math.abs(b - beat - 0.5) < 1e-6;
      if (!isOff) return 0;
      var unit = (60 / 0 /*bpm 由调用方换算为秒*/);
      return swing * 0.5; // 归一化位移（拍）
    },
    secondsOf: function (beats, bpm, swing, sig) {
      var sec = beats * 60 / bpm;
      if (swing) sec += T.swingOffset(beats, swing, sig) * 60 / bpm;
      return sec;
    }
  };

  /* ---------------- WAV 编解码 ---------------- */
  var W = BS.wav = {
    /* AudioBuffer -> ArrayBuffer（16/24/32bit，整数 PCM） */
    encode: function (audioBuffer, opts) {
      opts = opts || {};
      var numCh = opts.channels === 1 ? 1 : Math.min(2, audioBuffer.numberOfChannels);
      var chans = [];
      for (var c = 0; c < numCh; c++) chans.push(audioBuffer.getChannelData(c));
      return W.encodeChannels(chans, audioBuffer.sampleRate, opts);
    },

    /* 浮点通道数组 -> WAV ArrayBuffer
       chans: [Float32Array, ...]  opts: {bitDepth, sampleRate}
       独立于 AudioBuffer，便于导出裁剪/处理后的裸数据。 */
    encodeChannels: function (chans, sampleRate, opts) {
      opts = opts || {};
      var bitDepth = opts.bitDepth || 16;
      var numCh = chans.length;
      var len = numCh > 0 ? chans[0].length : 0;
      var sr = sampleRate || 44100;
      var bytesPerSample = bitDepth / 8;
      var dataSize = len * numCh * bytesPerSample;
      var ab = new ArrayBuffer(44 + dataSize);
      var dv = new DataView(ab);

      function str(off, s) { for (var i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); }
      str(0, 'RIFF');
      dv.setUint32(4, 36 + dataSize, true);
      str(8, 'WAVE');
      str(12, 'fmt ');
      dv.setUint32(16, 16, true);
      dv.setUint16(20, bitDepth === 32 ? 3 : 1, true); // 1=PCM 3=IEEE float
      dv.setUint16(22, numCh, true);
      dv.setUint32(24, sr, true);
      dv.setUint32(28, sr * numCh * bytesPerSample, true);
      dv.setUint16(32, numCh * bytesPerSample, true);
      dv.setUint16(34, bitDepth, true);
      str(36, 'data');
      dv.setUint32(40, dataSize, true);

      var off = 44;
      var isFloat = bitDepth === 32;
      // 16/24bit 统一按 2^(bits-1)-1 缩放，保证正负半边量化对称
      var fullScale = Math.pow(2, bitDepth - 1) - 1;
      for (var i = 0; i < len; i++) {
        for (var c2 = 0; c2 < numCh; c2++) {
          var s = U.clamp(chans[c2][i], -1, 1);
          if (isFloat) { dv.setFloat32(off, s, true); off += 4; }
          else if (bitDepth === 16) { dv.setInt16(off, Math.round(s * fullScale), true); off += 2; }
          else {
            var v = Math.round(s * fullScale);
            dv.setUint8(off, v & 0xFF);
            dv.setUint8(off + 1, (v >> 8) & 0xFF);
            dv.setUint8(off + 2, (v >> 16) & 0xFF);
            off += 3;
          }
        }
      }
      return ab;
    },

    /* ArrayBuffer -> {channels:Float32Array[], sampleRate}（仅支持 PCM WAV） */
    decode: function (ab) {
      var dv = new DataView(ab);
      function str(off, n) {
        var s = '';
        for (var i = 0; i < n; i++) s += String.fromCharCode(dv.getUint8(off + i));
        return s;
      }
      if (str(0, 4) !== 'RIFF' || str(8, 4) !== 'WAVE') throw new Error('不是有效的 WAV 文件');
      var pos = 12, fmt = null, dataOff = -1, dataLen = 0;
      while (pos + 8 <= dv.byteLength) {
        var id = str(pos, 4), size = dv.getUint32(pos + 4, true);
        if (id === 'fmt ') {
          fmt = {
            format: dv.getUint16(pos + 8, true),
            channels: dv.getUint16(pos + 10, true),
            sampleRate: dv.getUint32(pos + 12, true),
            bits: dv.getUint16(pos + 22, true)
          };
        } else if (id === 'data') {
          dataOff = pos + 8; dataLen = Math.min(size, dv.byteLength - dataOff);
        }
        pos += 8 + size + (size & 1);
      }
      if (!fmt || dataOff < 0) throw new Error('WAV 结构损坏');
      var bps = fmt.bits / 8;
      var frames = Math.floor(dataLen / (bps * fmt.channels));
      var chans = [];
      for (var c = 0; c < fmt.channels; c++) chans.push(new Float32Array(frames));
      var o = dataOff;
      for (var i = 0; i < frames; i++) {
        for (var c2 = 0; c2 < fmt.channels; c2++) {
          var v = 0;
          if (fmt.format === 3 && fmt.bits === 32) v = dv.getFloat32(o, true);
          else if (fmt.bits === 8) v = (dv.getUint8(o) - 128) / 128;
          else if (fmt.bits === 16) v = dv.getInt16(o, true) / 32767;
          else if (fmt.bits === 24) v = ((dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getUint8(o + 2) << 16 << 8)) << 8 >> 8) / 8388607;
          else if (fmt.bits === 32) v = dv.getInt32(o, true) / 2147483647;
          chans[c2][i] = v;
          o += bps;
        }
      }
      return { channels: chans, sampleRate: fmt.sampleRate, frames: frames };
    }
  };

  /* ---------------- 混音曲线（ Waveshaper 驱动） ---------------- */
  BS.makeDriveCurve = function (amount, samples) {
    var n = samples || 2048;
    var curve = new Float32Array(n);
    var k = amount * 100 + 0.001;
    for (var i = 0; i < n; i++) {
      var x = (i / (n - 1)) * 2 - 1;
      curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
    }
    return curve;
  };

  /* ---------------- 混响脉冲响应 ---------------- */
  BS.makeImpulse = function (ctx, seconds, decay, reverse) {
    var sr = ctx.sampleRate;
    var len = Math.max(1, Math.floor(sr * seconds));
    var buf = ctx.createBuffer(2, len, sr);
    for (var ch = 0; ch < 2; ch++) {
      var d = buf.getChannelData(ch);
      for (var i = 0; i < len; i++) {
        var t = i / len;
        var env = Math.pow(1 - t, decay);
        d[i] = (Math.random() * 2 - 1) * env;
      }
      // 早期反射：稀疏脉冲，塑造空间感
      var taps = [0.011, 0.019, 0.031, 0.047, 0.063, 0.089];
      for (var k = 0; k < taps.length; k++) {
        var idx = Math.floor(taps[k] * sr * (1 + ch * 0.07));
        if (idx < len) d[idx] += (k % 2 ? -1 : 1) * 0.55 * Math.pow(1 - taps[k] * 6, 2);
      }
      if (reverse) d.reverse();
    }
    return buf;
  };

  /* ---------------- 简易噪声 ---------------- */
  BS.noiseBuffer = function (ctx, seconds, color) {
    var sr = ctx.sampleRate, len = Math.max(1, Math.floor(sr * seconds));
    var buf = ctx.createBuffer(1, len, sr);
    var d = buf.getChannelData(0);
    var last = 0;
    for (var i = 0; i < len; i++) {
      var w = Math.random() * 2 - 1;
      if (color === 'pink') {
        last = 0.98 * last + 0.02 * w;
        d[i] = last * 3.2;
      } else if (color === 'brown') {
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.5;
      } else {
        d[i] = w;
      }
    }
    return buf;
  };

})(window);

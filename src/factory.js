/* BandSynth · factory.js
 * 内置合成音源工厂：用代码生成鼓组 / 贝斯 / 键盘 / 人声垫
 * 目的：零采样文件也能立刻演奏与渲染伴奏；也可作为编写谱面的占位音色。
 * 所有音色均为 AudioBuffer，与外部采样走完全相同的 Part 通路。
 */
(function (global) {
  'use strict';
  var BS = global.BS;
  var U = BS.util, P = BS.pitch;

  function buf(ctx, seconds, channels) {
    return ctx.createBuffer(channels || 1, Math.max(1, Math.ceil(ctx.sampleRate * seconds)), ctx.sampleRate);
  }

  /* ---------------- 基础波形 ---------------- */
  var WAVES = {
    sine: function (ph) { return Math.sin(ph * 2 * Math.PI); },
    saw: function (ph) { return (ph % 1) * 2 - 1; },
    square: function (ph) { return (ph % 1) < 0.5 ? 1 : -1; },
    tri: function (ph) { var t = ph % 1; return t < 0.5 ? t * 4 - 1 : 3 - t * 4; },
    noise: function (ph, st) { st.s = (st.s * 1103515245 + 12345) & 0x7fffffff; return (st.s / 0x3fffffff) - 1; },
    pulse: function (ph) { return ((ph % 1) < 0.25) ? 1 : -1; }
  };

  function lcg(seed) {
    var s = seed || 12345;
    return function () { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  }

  /* ---------------- 鼓组 ---------------- */
  var DRUMS = {

    kick: function (ctx) {
      var sr = ctx.sampleRate, dur = 0.62;
      var b = buf(ctx, dur);
      var d = b.getChannelData(0);
      var rnd = lcg(7777);
      var ph = 0;
      for (var i = 0; i < d.length; i++) {
        var t = i / sr;
        // 音高包络：120Hz → 45Hz
        var f = 45 + (120 - 45) * Math.exp(-t / 0.028);
        ph += f / sr;
        var env = Math.exp(-t / 0.16);
        var click = (t < 0.006) ? (rnd() * 2 - 1) * Math.exp(-t / 0.0018) * 0.5 : 0;
        var body = Math.sin(ph * 2 * Math.PI) * env;
        var sub = Math.sin(ph * 2 * Math.PI * 0.5) * Math.exp(-t / 0.1) * 0.25;
        d[i] = U.clamp(body + sub + click, -1, 1) * 0.95;
      }
      return b;
    },

    snare: function (ctx) {
      var sr = ctx.sampleRate, dur = 0.34;
      var b = buf(ctx, dur);
      var d = b.getChannelData(0);
      var rnd = lcg(4242);
      var ph1 = 0, ph2 = 0, hp = 0, prev = 0;
      for (var i = 0; i < d.length; i++) {
        var t = i / sr;
        var n = rnd() * 2 - 1;
        hp = 0.82 * (hp + n - prev); prev = n;         // 高通
        var tone = (Math.sin(ph1 * 2 * Math.PI) * 0.5 + Math.sin(ph2 * 2 * Math.PI) * 0.3);
        ph1 += 182 / sr; ph2 += 331 / sr;
        var tEnv = Math.exp(-t / 0.075);
        var nEnv = Math.exp(-t / 0.115);
        d[i] = U.clamp(tone * tEnv * 0.55 + hp * nEnv * 0.8, -1, 1);
      }
      return b;
    },

    clap: function (ctx) {
      var sr = ctx.sampleRate, dur = 0.42;
      var b = buf(ctx, dur);
      var d = b.getChannelData(0);
      var rnd = lcg(9090);
      var bp = 0, bp2 = 0;
      // 三次快速起振 + 尾部
      var bursts = [0, 0.011, 0.023, 0.036];
      for (var i = 0; i < d.length; i++) {
        var t = i / sr;
        var n = rnd() * 2 - 1;
        bp = bp * 0.72 + n * 0.28;
        bp2 = bp2 * 0.35 + n * 0.65;
        var band = bp2 - bp * 0.5;
        var env = 0;
        for (var k = 0; k < bursts.length; k++) {
        var dt = t - bursts[k];
        if (dt >= 0) env += Math.exp(-dt / (k === 3 ? 0.14 : 0.008)) * (k === 3 ? 0.8 : 0.55);
        }
        d[i] = U.clamp(band * env * 1.6, -1, 1);
      }
      return b;
    },

    hihatClosed: function (ctx) { return hihat(ctx, 0.085, 0.7); },
    hihatOpen: function (ctx) { return hihat(ctx, 0.42, 0.55); },

    tomLow: function (ctx) { return tom(ctx, 0.44, 105); },
    tomMid: function (ctx) { return tom(ctx, 0.36, 155); },
    tomHigh: function (ctx) { return tom(ctx, 0.3, 230); },

    ride: function (ctx) {
      var sr = ctx.sampleRate, dur = 1.5;
      var b = buf(ctx, dur);
      var d = b.getChannelData(0);
      var rnd = lcg(31415);
      var hp = 0, prev = 0;
      var parts = [523, 787, 1093, 1471, 2013].map(function (f) { return f / sr; });
      var phs = [0, 0, 0, 0, 0];
      for (var i = 0; i < d.length; i++) {
        var t = i / sr;
        var n = rnd() * 2 - 1;
        hp = 0.9 * (hp + n - prev); prev = n;
        var s = 0;
        for (var k = 0; k < parts.length; k++) {
          phs[k] += parts[k];
          s += Math.sign(Math.sin(phs[k] * 2 * Math.PI)) * (1 / (k + 1));
        }
        var env = Math.exp(-t / 0.55);
        d[i] = U.clamp((hp * 0.35 + s * 0.16) * env, -1, 1);
      }
      return b;
    },

    crash: function (ctx) {
      var sr = ctx.sampleRate, dur = 2.2;
      var b = buf(ctx, dur);
      var d = b.getChannelData(0);
      var rnd = lcg(60606);
      var hp = 0, prev = 0;
      for (var i = 0; i < d.length; i++) {
        var t = i / sr;
        var n = rnd() * 2 - 1;
        hp = 0.93 * (hp + n - prev); prev = n;
        var env = Math.exp(-t / 0.85);
        d[i] = U.clamp(hp * env * 0.55, -1, 1);
      }
      return b;
    },

    rim: function (ctx) {
      var sr = ctx.sampleRate, dur = 0.12;
      var b = buf(ctx, dur);
      var d = b.getChannelData(0);
      var rnd = lcg(8888);
      for (var i = 0; i < d.length; i++) {
        var t = i / sr;
        var n = rnd() * 2 - 1;
        var env = Math.exp(-t / 0.012);
        var tone = Math.sin(2 * Math.PI * 1700 * t) * 0.4 + Math.sin(2 * Math.PI * 2450 * t) * 0.3;
        d[i] = U.clamp((n * 0.5 + tone) * env, -1, 1);
      }
      return b;
    },

    shaker: function (ctx) {
      var sr = ctx.sampleRate, dur = 0.14;
      var b = buf(ctx, dur);
      var d = b.getChannelData(0);
      var rnd = lcg(2323);
      var hp = 0, prev = 0;
      for (var i = 0; i < d.length; i++) {
        var t = i / sr;
        var n = rnd() * 2 - 1;
        hp = 0.7 * (hp + n - prev); prev = n;
        var env = Math.sin(Math.min(1, t / dur) * Math.PI);
        d[i] = U.clamp(hp * env * 0.5, -1, 1);
      }
      return b;
    }
  };

  function hihat(ctx, dur, bright) {
    var sr = ctx.sampleRate;
    var b = buf(ctx, dur);
    var d = b.getChannelData(0);
    var rnd = lcg(dur > 0.2 ? 5150 : 5151);
    var hp = 0, prev = 0;
    var ratios = [1, 1.342, 1.2312, 1.6532, 1.9523, 2.1523];
    var phs = ratios.map(function () { return rnd(); });
    for (var i = 0; i < d.length; i++) {
      var t = i / sr;
      var n = rnd() * 2 - 1;
      hp = 0.72 * (hp + n - prev); prev = n;
      var metal = 0;
      for (var k = 0; k < ratios.length; k++) {
        phs[k] += ratios[k] * (1 + bright * 0.15);
        metal += (phs[k] % 1 < 0.5 ? 1 : -1);
      }
      var env = Math.exp(-t / (dur * 0.32));
      d[i] = U.clamp((hp * 0.7 + metal * 0.09) * env * 0.6, -1, 1);
    }
    return b;
  }

  function tom(ctx, dur, freq) {
    var sr = ctx.sampleRate;
    var b = buf(ctx, dur);
    var d = b.getChannelData(0);
    var ph = 0;
    for (var i = 0; i < d.length; i++) {
      var t = i / sr;
      var f = freq * (1 + 0.35 * Math.exp(-t / 0.05));
      ph += f / sr;
      var env = Math.exp(-t / (dur * 0.36));
      var n = (Math.random() * 2 - 1) * Math.exp(-t / 0.006) * 0.12;
      d[i] = U.clamp(Math.sin(ph * 2 * Math.PI) * env + n, -1, 1) * 0.9;
    }
    return b;
  }

  /* ---------------- 乐音音色（对接 src/tone.js） ----------------
   * 注意：这里不再自己合成波形，只做「rootNote → 真实频率」的换算后转调内核。
   * 旧实现在此处用 `ph += 1/dur` 导致基频仅 0.5Hz（详见 tone.js 顶部说明）。 */

  /* 把每个乐音的合成器绑定到 rootNote 真实频率 */
  var TONE_IDS = ['bass', 'warmPad', 'ePiano', 'piano', 'strings', 'organ', 'lead',
                  'bell', 'vocalAh', 'pluck',
                  'acousticGuitar', 'electricGuitar'];

  function f0Of(rootNote) {
    return BS.pitch.midiToFreq(rootNote);
  }

  /* ---------------- 预设（声部参数组） ---------------- */
  var PRESETS = {
    kick:      { name: '底鼓',   root: 36, mode: 'oneshot', amp: { attack: 0.001, decay: 0.25, sustain: 0.0, release: 0.05, gain: 0.95 }, filter: { type: 'lowpass', cutoff: 18000, resonance: 0.5, envAmount: 0, keyTrack: 0 } },
    snare:     { name: '军鼓',   root: 38, mode: 'oneshot', amp: { attack: 0.001, decay: 0.22, sustain: 0.0, release: 0.08, gain: 0.85 }, filter: { type: 'highpass', cutoff: 200, resonance: 0.7, envAmount: 0, keyTrack: 0 } },
    clap:      { name: '拍手',   root: 39, mode: 'oneshot', amp: { attack: 0.001, decay: 0.3, sustain: 0.0, release: 0.1, gain: 0.8 }, filter: { type: 'bandpass', cutoff: 1400, resonance: 1.2, envAmount: 0, keyTrack: 0 } },
    hihatClosed: { name: '闭镲', root: 42, mode: 'oneshot', amp: { attack: 0.001, decay: 0.09, sustain: 0.0, release: 0.03, gain: 0.55 }, filter: { type: 'highpass', cutoff: 7000, resonance: 0.6, envAmount: 0, keyTrack: 0 } },
    hihatOpen: { name: '开镲',  root: 46, mode: 'oneshot', amp: { attack: 0.001, decay: 0.4, sustain: 0.0, release: 0.15, gain: 0.45 }, filter: { type: 'highpass', cutoff: 6000, resonance: 0.6, envAmount: 0, keyTrack: 0 } },
    tomLow:    { name: '低嗵',   root: 45, mode: 'oneshot', amp: { attack: 0.001, decay: 0.3, sustain: 0.0, release: 0.1, gain: 0.8 }, filter: { type: 'lowpass', cutoff: 4000, resonance: 0.5, envAmount: 0, keyTrack: 0 } },
    tomMid:    { name: '中嗵',   root: 48, mode: 'oneshot', amp: { attack: 0.001, decay: 0.26, sustain: 0.0, release: 0.1, gain: 0.8 }, filter: { type: 'lowpass', cutoff: 5000, resonance: 0.5, envAmount: 0, keyTrack: 0 } },
    tomHigh:   { name: '高嗵',   root: 50, mode: 'oneshot', amp: { attack: 0.001, decay: 0.22, sustain: 0.0, release: 0.1, gain: 0.8 }, filter: { type: 'lowpass', cutoff: 6000, resonance: 0.5, envAmount: 0, keyTrack: 0 } },
    ride:      { name: '叮镲',   root: 51, mode: 'oneshot', amp: { attack: 0.001, decay: 0.9, sustain: 0.0, release: 0.3, gain: 0.4 }, filter: { type: 'highpass', cutoff: 4000, resonance: 0.6, envAmount: 0, keyTrack: 0 } },
    crash:     { name: '碎音镲', root: 49, mode: 'oneshot', amp: { attack: 0.002, decay: 1.5, sustain: 0.0, release: 0.5, gain: 0.42 }, filter: { type: 'highpass', cutoff: 3000, resonance: 0.5, envAmount: 0, keyTrack: 0 } },
    rim:       { name: '边击',   root: 37, mode: 'oneshot', amp: { attack: 0.001, decay: 0.06, sustain: 0.0, release: 0.02, gain: 0.7 }, filter: { type: 'bandpass', cutoff: 2000, resonance: 2, envAmount: 0, keyTrack: 0 } },
    shaker:    { name: '沙锤',   root: 70, mode: 'oneshot', amp: { attack: 0.004, decay: 0.12, sustain: 0.0, release: 0.04, gain: 0.45 }, filter: { type: 'highpass', cutoff: 5000, resonance: 0.6, envAmount: 0, keyTrack: 0 } },

    bass:      { name: '贝斯',   root: 41, mode: 'gate', pitchMode: 'varispeed', amp: { attack: 0.006, decay: 0.25, sustain: 0.7, release: 0.08, gain: 0.9 }, filter: { type: 'lowpass', cutoff: 900, resonance: 1.4, envAmount: 0.45, keyTrack: 0.2, envAttack: 0.005, envDecay: 0.18, envSustain: 0.25 } },
    warmPad:   { name: '暖垫',   root: 60, mode: 'loop', pitchMode: 'varispeed', amp: { attack: 0.35, decay: 0.4, sustain: 0.85, release: 0.7, gain: 0.55 }, filter: { type: 'lowpass', cutoff: 2200, resonance: 0.7, envAmount: 0, keyTrack: 0.3 } },
    ePiano:    { name: '电钢',   root: 60, mode: 'gate', pitchMode: 'varispeed', amp: { attack: 0.004, decay: 0.5, sustain: 0.25, release: 0.35, gain: 0.7 }, filter: { type: 'lowpass', cutoff: 3200, resonance: 0.8, envAmount: 0.2, keyTrack: 0.3, envAttack: 0.005, envDecay: 0.4, envSustain: 0.3 } },
    piano:     { name: '钢琴',   root: 60, mode: 'oneshot', pitchMode: 'varispeed', amp: { attack: 0.002, decay: 1.4, sustain: 0.12, release: 0.35, gain: 0.8 }, filter: { type: 'lowpass', cutoff: 6500, resonance: 0.5, envAmount: 0.15, keyTrack: 0.3, envAttack: 0.002, envDecay: 1.2, envSustain: 0.3 } },
    strings:   { name: '弦乐',   root: 60, mode: 'loop', pitchMode: 'varispeed', amp: { attack: 0.25, decay: 0.5, sustain: 0.8, release: 0.6, gain: 0.55 }, filter: { type: 'lowpass', cutoff: 3000, resonance: 0.6, envAmount: 0, keyTrack: 0.3 } },
    vocalAh:   { name: '人声垫', root: 57, mode: 'loop', pitchMode: 'varispeed', amp: { attack: 0.4, decay: 0.5, sustain: 0.8, release: 0.8, gain: 0.5 }, filter: { type: 'bandpass', cutoff: 1100, resonance: 0.9, envAmount: 0, keyTrack: 0.2 } },
    pluck:     { name: '拨弦',   root: 60, mode: 'oneshot', pitchMode: 'varispeed', amp: { attack: 0.002, decay: 0.35, sustain: 0.15, release: 0.2, gain: 0.75 }, filter: { type: 'lowpass', cutoff: 4000, resonance: 1.1, envAmount: 0.35, keyTrack: 0.3, envAttack: 0.002, envDecay: 0.25, envSustain: 0.2 } },
    acousticGuitar: { name: '原声吉他', root: 60, mode: 'oneshot', pitchMode: 'varispeed', amp: { attack: 0.002, decay: 1.0, sustain: 0.1, release: 0.3, gain: 0.8 }, filter: { type: 'lowpass', cutoff: 5000, resonance: 0.9, envAmount: 0.2, keyTrack: 0.35, envAttack: 0.002, envDecay: 0.8, envSustain: 0.25 } },
    electricGuitar: { name: '电吉他', root: 60, mode: 'oneshot', pitchMode: 'varispeed', amp: { attack: 0.003, decay: 1.2, sustain: 0.2, release: 0.3, gain: 0.72 }, filter: { type: 'lowpass', cutoff: 6500, resonance: 1.2, envAmount: 0.2, keyTrack: 0.35, envAttack: 0.003, envDecay: 1.0, envSustain: 0.3 } },
    bell:      { name: '钟琴',   root: 72, mode: 'oneshot', amp: { attack: 0.001, decay: 1.2, sustain: 0.0, release: 0.4, gain: 0.5 }, filter: { type: 'highpass', cutoff: 200, resonance: 0.7, envAmount: 0, keyTrack: 0 } },
    organ:     { name: '风琴',   root: 60, mode: 'loop', amp: { attack: 0.02, decay: 0.1, sustain: 1.0, release: 0.1, gain: 0.6 }, filter: { type: 'lowpass', cutoff: 4000, resonance: 0.5, envAmount: 0, keyTrack: 0 } },
    lead:      { name: '主音',   root: 60, mode: 'gate', amp: { attack: 0.01, decay: 0.3, sustain: 0.65, release: 0.15, gain: 0.7 }, filter: { type: 'lowpass', cutoff: 4500, resonance: 1.2, envAmount: 0.25, keyTrack: 0.3, envAttack: 0.01, envDecay: 0.3, envSustain: 0.4 } }
  };

  /* 拨弦（Karplus-Strong 近似）与钟琴 */
  /* ---------------- 工厂 API ---------------- */
  var cache = {};

  var Factory = BS.factory = {
    /* 全部可用音色 id */
    list: function () {
      var ids = [];
      Object.keys(DRUMS).forEach(function (k) { ids.push(k); });
      TONE_IDS.forEach(function (k) { ids.push(k); });
      return ids;
    },

    /* 乐音音色 id（不含鼓组） */
    toneIds: function () { return TONE_IDS.slice(); },

    isDrum: function (id) { return !!DRUMS[id]; },

    has: function (id) {
      return this.list().indexOf(id) >= 0;
    },

    preset: function (id) { return PRESETS[id] || null; },

    /* 生成音色 buffer（带缓存）
       乐音走 BS.tone：按 PRESETS[id].root 的真实频率合成，
       而非旧实现的「1/dur 低频单周期」。 */
    buffer: function (ctx, id) {
      var key = id;
      if (cache[key] && cache[key].sampleRate === ctx.sampleRate) return cache[key];
      var b = null;
      if (DRUMS[id]) {
        b = DRUMS[id](ctx);
      } else if (BS.tone && BS.tone[id]) {
        var preset = PRESETS[id] || {};
        var root = preset.root === undefined ? 60 : preset.root;
        b = BS.tone[id](ctx, f0Of(root));
      }
      if (b) cache[key] = b;
      return b;
    },

    /* 创建一个装好内置音色的声部 */
    makePart: function (engine, id, overrides) {
      var preset = PRESETS[id] || {};
      var buf = Factory.buffer(engine.ctx, id);
      var opts = Object.assign({
        name: preset.name || id,
        rootNote: preset.root === undefined ? 60 : preset.root,
        mode: preset.mode || 'oneshot',
        pitchMode: preset.pitchMode || 'varispeed',
        amp: Object.assign({}, preset.amp),      // 复制，避免与 PRESETS 共享引用
        filter: Object.assign({}, preset.filter),
        filter2: { enabled: false, type: 'highpass', cutoff: 80, resonance: 0.5 },
        drive: 0, unison: 1, detune: 0,
        volume: 0.85, pan: 0,
        sendReverb: preset.sendReverb || 0.1,
        sendDelay: preset.sendDelay || 0
      }, overrides || {});
      var p = engine.addPart(opts);
      if (buf) p.setBuffer(buf, '内置:' + id);
      return p;
    },

    /* 导出内置音色为 WAV（用于外部 DAW） */
    exportWav: function (ctx, id) {
      var b = Factory.buffer(ctx, id);
      if (!b) return Promise.reject(new Error('未知音色：' + id));
      var ab = BS.wav.encode(b, { bitDepth: 16, channels: 1 });
      return new Blob([ab], { type: 'audio/wav' });
    },

    /* 当前上下文预生成全部音色（避免首次演奏时卡顿） */
    warmup: function (ctx, onDone) {
      var ids = Factory.list();
      var i = 0;
      function step() {
        if (i >= ids.length) { if (onDone) onDone(); return; }
        try { Factory.buffer(ctx, ids[i++]); } catch (e) { i++; }
        setTimeout(step, 0);
      }
      step();
    }
  };

  /* 暴露波形与预设表 */
  Factory.WAVES = WAVES;
  Factory.PRESETS = PRESETS;
  BS.PRESETS = PRESETS;
  void P;

})(window);

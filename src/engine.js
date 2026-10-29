/* BandSynth · engine.js
 * 合成器引擎：多声部采样 + ADSR + 双滤波器 + LFO + FX 总线 + 复音管理
 *
 * 信号流（单声部）：
 *   BufferSource(s) → filter1 → [filter2] → [drive] → VCA → part.pan → part.vol
 *        → partBus(干声) + revSend → reverbBus + dlySend → delayBus
 *   主链：partBus → masterDrive → compressor → master → analyser → destination
 */
(function (global) {
  'use strict';
  var BS = global.BS;
  var U = BS.util, P = BS.pitch;

  /* ---------------- 工具：防御性数值处理 ---------------- */
  /* AudioParam 赋值 NaN/Infinity 会抛异常（浏览器严格校验），
     所有写入 AudioParam 的数值都必须先过这道闸。 */
  var FILTER_TYPES = {
    lowpass: 1, highpass: 1, bandpass: 1, lowshelf: 1,
    highshelf: 1, notch: 1, peaking: 1, allpass: 1
  };
  function clampNum(v, lo, hi, dflt) {
    if (typeof v !== 'number' || !isFinite(v)) return dflt;
    return v < lo ? lo : (v > hi ? hi : v);
  }
  function clampIntNum(v, lo, hi, dflt) {
    return Math.round(clampNum(v, lo, hi, dflt));
  }

  /* ---------------- 默认声部参数 ---------------- */
  /* 注意：每次调用必须返回全新的嵌套对象。
     若返回共享引用，Object.assign 会把多个声部的参数互相污染。 */
  function defaultPart(name) {
    return {
      id: U.uid('part'),
      name: name || '新声部',
      buffer: null, bufferName: '', bufferDuration: 0,
      mode: 'oneshot',           // oneshot | loop | gate
      startSec: 0, endSec: 0,
      reverse: false,
      rootNote: 60,              // 采样原声高
      transpose: 0,              // 半音
      fine: 0,                   // 音分
      keyTrack: true,
      pitchMode: 'varispeed',    // varispeed | stretch（锁时长）
      stretchQuality: 'medium',
      amp: { attack: 0.005, decay: 0.12, sustain: 0.8, release: 0.18, gain: 0.9 },
      filter: {
        type: 'lowpass', cutoff: 18000, resonance: 0.8,
        /* lowCut 只对 bandpass 生效：低切（高通边）频率。
           不能用单个 Biquad 的 bandpass —— 它只有一个中心频率 + Q（带宽），
           用户没法分别选「保留下限」和「保留上限」。 */
        lowCut: 200,
        envAmount: 0, keyTrack: 0.3,
        envAttack: 0.01, envDecay: 0.2, envSustain: 0.4
      },
      filter2: { enabled: false, type: 'highpass', cutoff: 80, resonance: 0.5 },
      drive: 0,
      unison: 1, detune: 0,
      sampleGain: 1,               // 采样音量（写入 buffer 前的增益，dB 可调）
      volume: 0.8, pan: 0,
      sendReverb: 0.15, sendDelay: 0,
      muted: false, solo: false,
      maxVoices: 16,
      velocityToGain: 0.7,
      portamento: 0,
      lfo: { rate: 5, depth: 0, toPitch: 0, toFilter: 0, wave: 'sine' }
    };
  }

  /* ---------------- 声部 ---------------- */
  function Part(engine, opts) {
    this.engine = engine;
    this.ctx = engine.ctx;
    var d = defaultPart(opts && opts.name);
    // 顶层浅合并（opts 的标量字段覆盖默认值）
    Object.assign(this, d, opts || {});
    // 嵌套对象逐个替换为新对象，避免与 defaultPart 的返回值共享引用
    this.amp = Object.assign({}, d.amp, (opts && opts.amp) || {});
    this.filter = Object.assign({}, d.filter, (opts && opts.filter) || {});
    this.filter2 = Object.assign({}, d.filter2, (opts && opts.filter2) || {});
    this.lfo = Object.assign({}, d.lfo, (opts && opts.lfo) || {});
    // 关键数值再兜一层，防止外部传入非法值
    this.rootNote = clampNum(this.rootNote, 0, 127, 60);
    this.transpose = clampNum(this.transpose, -48, 48, 0);
    this.fine = clampNum(this.fine, -200, 200, 0);
    this.volume = clampNum(this.volume, 0, 1.5, 0.8);
    this.pan = clampNum(this.pan, -1, 1, 0);
    this.sendReverb = clampNum(this.sendReverb, 0, 1, 0.15);
    this.sendDelay = clampNum(this.sendDelay, 0, 1, 0);
    this.drive = clampNum(this.drive, 0, 1, 0);
    this.unison = clampIntNum(this.unison, 1, 7, 1);
    this.detune = clampNum(this.detune, 0, 200, 0);
    this.maxVoices = clampIntNum(this.maxVoices, 1, 32, 16);
    this.portamento = clampNum(this.portamento, 0, 5, 0);
    this.velocityToGain = clampNum(this.velocityToGain, 0, 1, 0.7);
    this.startSec = clampNum(this.startSec, 0, 1e6, 0);
    this.endSec = clampNum(this.endSec, 0, 1e6, 0);
    this.amp.gain = clampNum(this.amp.gain, 0, 2, 0.9);
    this.sampleGain = clampNum(this.sampleGain, 0, 4, 1);
    this.amp.attack = clampNum(this.amp.attack, 0.0005, 10, 0.005);
    this.amp.decay = clampNum(this.amp.decay, 0.001, 20, 0.12);
    this.amp.sustain = clampNum(this.amp.sustain, 0, 1, 0.8);
    this.amp.release = clampNum(this.amp.release, 0.005, 20, 0.18);
    this.filter.cutoff = clampNum(this.filter.cutoff, 10, 22000, 18000);
    this.filter.lowCut = clampNum(this.filter.lowCut, 10, 22000, 200);
    this.filter.resonance = clampNum(this.filter.resonance, 0.0001, 1000, 0.8);
    this.filter.envAmount = clampNum(this.filter.envAmount, -1, 1, 0);
    this.filter.keyTrack = clampNum(this.filter.keyTrack, -1, 1, 0.3);
    this.filter.envAttack = clampNum(this.filter.envAttack, 0.001, 10, 0.01);
    this.filter.envDecay = clampNum(this.filter.envDecay, 0.001, 20, 0.2);
    this.filter.envSustain = clampNum(this.filter.envSustain, 0, 1, 0.4);
    this.filter2.cutoff = clampNum(this.filter2.cutoff, 10, 22000, 80);
    this.filter2.resonance = clampNum(this.filter2.resonance, 0.0001, 1000, 0.5);
    if (!FILTER_TYPES[this.filter.type]) this.filter.type = 'lowpass';
    if (!FILTER_TYPES[this.filter2.type]) this.filter2.type = 'highpass';
    if (['oneshot', 'loop', 'gate'].indexOf(this.mode) < 0) this.mode = 'oneshot';
    if (['varispeed', 'stretch'].indexOf(this.pitchMode) < 0) this.pitchMode = 'varispeed';

    this.voices = [];
    this._portaFrom = null;
    this._buildRouting();
  }

  Part.prototype._buildRouting = function () {
    var ctx = this.ctx, engine = this.engine;
    this.out = ctx.createGain();          // 声部音量
    this.panNode = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    this.revSend = ctx.createGain();
    this.dlySend = ctx.createGain();

    if (this.panNode) {
      this.panNode.pan.value = clampNum(this.pan, -1, 1, 0);
      this.out.connect(this.panNode);
      this.panNode.connect(engine.partBus);
      this.panNode.connect(this.revSend);
      this.panNode.connect(this.dlySend);
    } else {
      this.out.connect(engine.partBus);
      this.out.connect(this.revSend);
      this.out.connect(this.dlySend);
    }
    this.revSend.connect(engine.reverbBus);
    this.dlySend.connect(engine.delayBus);

    this.out.gain.value = clampNum(this.volume, 0, 1.5, 0.8);
    this.revSend.gain.value = clampNum(this.sendReverb, 0, 1, 0.15);
    this.dlySend.gain.value = clampNum(this.sendDelay, 0, 1, 0);
    if (this.panNode) this.panNode.pan.value = clampNum(this.pan, -1, 1, 0);
    this.applyAudible();
  };

  Part.prototype.applyAudible = function () {
    var anySolo = this.engine.parts.some(function (p) { return p.solo; });
    var audible = anySolo ? this.solo : !this.muted;
    this._audible = audible;
    var target = audible ? clampNum(this.volume, 0, 1.5, 0.8) : 0;
    var t = this.ctx.currentTime;
    try {
      this.out.gain.cancelScheduledValues(t);
      this.out.gain.setTargetAtTime(target, t, 0.01);
    } catch (e) { this.out.gain.value = target; }
  };

  Part.prototype.setBuffer = function (buffer, name) {
    this.buffer = buffer;
    this.bufferName = name || '';
    this.bufferDuration = buffer ? buffer.duration : 0;
    this.startSec = 0;
    this.endSec = buffer ? buffer.duration : 0;
    // 变体缓存（反向）
    this._revBuffer = null;
    BS.pitchAlgo.cache.clear();
    BS.emit('part:buffer', this);
  };

  Part.prototype.sourceBuffer = function () {
    if (!this.buffer) return null;
    if (!this.reverse) return this.buffer;
    if (!this._revBuffer) this._revBuffer = BS.loader.reverse(this.ctx, this.buffer);
    return this._revBuffer;
  };
  /* 鼓组已完全独立到 BS.DrumRack（src/drum-rack.js），
   * 不再占用 Part —— Part 只负责合成器声部，两者逻辑互不干扰。 */

  Part.prototype.playRange = function () {
    var b = this.sourceBuffer();
    if (!b) return null;
    var s = U.clamp(this.startSec, 0, b.duration);
    var e = this.endSec > 0 ? U.clamp(this.endSec, 0, b.duration) : b.duration;
    if (e <= s) e = Math.min(b.duration, s + 0.02);
    return { start: s, end: e, duration: e - s, buffer: b };
  };

  Part.prototype.effectiveRatio = function (note) {
    var semis = (this.keyTrack ? (note - this.rootNote) : 0) + this.transpose + this.fine / 100;
    var r = P.centsToRatio(semis * 100);
    // 兜底：AudioParam 不接受非有限值或 0
    if (!isFinite(r) || r <= 0) return 1;
    return Math.min(Math.max(r, 1 / 128), 128);
  };

  /* ---------------- 发声 ---------------- */
  /* opts（可选，音符级修饰，不影响声部自身的参数）：
      glide     滑音时长（秒），配合 glideFrom 从上一个音滑入
      glideFrom 上一个音的 MIDI 音高
      vib       颤音深度 0..1（映射 ±60 音分）
      vibRate   颤音速率 Hz（缺省 5.5） */
  Part.prototype.noteOn = function (note, vel, when, opts) {
    if (!this.buffer || this.muted) return null;
    var ctx = this.ctx, engine = this.engine;
    when = when === undefined ? ctx.currentTime : when;
    vel = vel === undefined ? 1 : vel;
    opts = opts || {};
    var glideFrom = (typeof opts.glideFrom === 'number' && isFinite(opts.glideFrom)) ? opts.glideFrom : null;
    var glide = clampNum(opts.glide, 0, 2, 0);
    if (glideFrom === null) glide = 0;
    var vib = clampNum(opts.vib, 0, 1, 0);
    var vibRate = clampNum(opts.vibRate, 0.5, 14, 5.5);

    var range = this.playRange();
    if (!range) return null;

    // 复音上限 → 抢占最老的音
    if (this.voices.length >= this.maxVoices) this._killVoice(this.voices[0], when);

    var ratio = this.effectiveRatio(note);

    // 滑音：从上一个音高滑入（loop/gate 模式才有意义）
    var porta = false;
    if (this.portamento > 0 && this._portaFrom !== null &&
        (this.mode === 'loop' || this.mode === 'gate') && when - (this._portaTime || 0) < 1) {
      var semis = (this._portaFrom - note) * (this.keyTrack ? 1 : 0);
      var fromRatio = ratio * Math.pow(2, semis / 12);
      this._portaFrom = note; this._portaTime = when;
      ratio = fromRatio;
      porta = true;
    } else {
      this._portaFrom = note; this._portaTime = when;
    }

    /* --- 音高算法选择 --- */
    var playBuffer = range.buffer;
    var playbackRate = ratio;
    var startOffset = range.start;
    var lockedDuration = 0;

    if (this.pitchMode === 'stretch' && Math.abs(ratio - 1) > 1e-4) {
      var prepared = BS.pitchAlgo.prepare(
        this.ctx, range.buffer, this.id, ratio, this.stretchQuality);
      if (prepared) {
        // 命中缓存：已复采样到目标音高、时长锁定 → playbackRate = 1
        playBuffer = prepared;
        playbackRate = 1;
        startOffset = 0;
        lockedDuration = prepared.duration;
      }
      // 未命中：立即用 varispeed 出声，后台算好缓存后自动升级
    }

    var srcDuration = playBuffer.duration;
    // 自然时长：变调后播放长度。ratio 极小时可能溢出，兜底上限 60s
    var naturalDur = lockedDuration || (range.duration / ratio);
    if (!isFinite(naturalDur) || naturalDur <= 0) naturalDur = srcDuration;
    naturalDur = Math.min(naturalDur, 60);

    /* 音符比采样长时**不自动循环**：发声到哪由声部「播放模式」决定 ——
       单次 = 采样自己播完；门控 = 到音符末尾收尾（采样先完就停）；循环 = 一直循环。 */

    /* --- 节点链 --- */
    var vca = ctx.createGain();
    vca.gain.value = 0.0001;

    /* --- 滤波器链 ---
       bandpass 用「高通(低切) → 低通(高切)」两级级联，而不是单个 Biquad 的
       bandpass：后者的 frequency 只是中心频率、Q 是带宽，用户无法分别指定
       「保留到多低」和「保留到多高」。级联后两个频率各自独立，斜率固定
       12dB/oct 每级，听感与硬件合成器的低切+高切一致。 */
    var filterType = FILTER_TYPES[this.filter.type] ? this.filter.type : 'lowpass';
    var isBand = filterType === 'bandpass';
    var reso = clampNum(this.filter.resonance, 0.0001, 1000, 0.7);
    var kt = clampNum(this.filter.keyTrack, -1, 1, 0.3);

    // 键盘跟随：截止频率随音高上移（两个边一起跟，频带宽度按比例保持）
    var trackHz = function (hz, dflt) {
      var v = clampNum(hz, 10, 22000, dflt);
      if (kt) v = clampNum(v * Math.pow(2, ((note - 60) / 12) * kt), 10, 22000, v);
      if (!isFinite(v) || v <= 0) v = dflt;
      return v;
    };

    var cutHi = trackHz(this.filter.cutoff, 18000);
    var cutLo = trackHz(this.filter.lowCut, 200);
    // 低切必须严格低于高切，否则带通会变成「全掐掉」
    if (isBand && cutLo > cutHi * 0.9) cutLo = Math.max(10, cutHi * 0.5);

    var f1 = ctx.createBiquadFilter();
    f1.type = isBand ? 'highpass' : filterType;
    f1.Q.value = reso;
    f1.frequency.value = isBand ? cutLo : cutHi;

    // bandpass 的第二级：高切（低通边）
    var fHi = null;
    if (isBand) {
      fHi = ctx.createBiquadFilter();
      fHi.type = 'lowpass';
      fHi.Q.value = reso;
      fHi.frequency.value = cutHi;
    }
    var cut = cutHi;   // 滤波包络的基准频率（跟高切走，最符合听感）

    var f2 = null;
    if (this.filter2.enabled) {
      f2 = ctx.createBiquadFilter();
      f2.type = FILTER_TYPES[this.filter2.type] ? this.filter2.type : 'highpass';
      f2.frequency.value = clampNum(this.filter2.cutoff, 10, 22000, 80);
      f2.Q.value = clampNum(this.filter2.resonance, 0.0001, 1000, 0.5);
    }

    var shaper = null;
    if (this.drive > 0) {
      shaper = ctx.createWaveShaper();
      shaper.curve = BS.makeDriveCurve(this.drive);
      shaper.oversample = '2x';
    }

    // source(s) → f1(高切前的低切) → [fHi 高切] → [f2] → [shaper] → vca → this.out
    var tail = f1;
    if (fHi) { f1.connect(fHi); tail = fHi; }
    if (f2) { tail.connect(f2); tail = f2; }
    if (shaper) { tail.connect(shaper); tail = shaper; }
    tail.connect(vca);
    vca.connect(this.out);

    /* --- 采样源 --- */
    var sources = [];
    var uni = Math.max(1, this.unison | 0);
    for (var u = 0; u < uni; u++) {
      var node = ctx.createBufferSource();
      node.buffer = playBuffer;
      var r = playbackRate;
      if (uni > 1) {
        var spread = uni === 1 ? 0 : (u / (uni - 1) - 0.5) * 2; // -1..1
        r = playbackRate * Math.pow(2, (spread * this.detune) / 1200);
      }
      // playbackRate 必须为有限正数
      if (!isFinite(r) || r <= 0) r = 1;
      node.playbackRate.value = Math.min(Math.max(r, 1/128), 128);

      if (this.mode === 'loop') {
        node.loop = true;
        node.loopStart = startOffset;
        node.loopEnd = playBuffer.duration;
      }

      node.connect(f1);
      sources.push(node);
    }

    var voice = {
      part: this, note: note, vel: vel, when: when,
      sources: sources, vca: vca,
      nodes: [vca, f1].concat(fHi ? [fHi] : []).concat(f2 ? [f2] : [])
        .concat(shaper ? [shaper] : []),
      ratio: ratio, released: false, porta: porta, portaFrom: this._portaFrom,
      naturalDur: naturalDur, filterBase: cut,
      filterLowBase: isBand ? cutLo : 0
    };
    var self = this;
    voice.release = function (t) { self._releaseVoice(voice, t); };
    voice.kill = function (t) { self._killVoice(voice, t); };

    /* --- 起音（含滤波包络与滑音） --- */
    var startAt = Math.max(when, ctx.currentTime + 0.001);
    for (var k = 0; k < sources.length; k++) {
      try { sources[k].start(startAt, startOffset); } catch (e) { /* 已启动 */ }
    }

    this._applyAmpEnv(vca, when, vel, naturalDur, voice);
    /* 包络作用于每个滤波边的**自身基准频率**：
       bandpass 时低切与高切按同一比例扫动，频带整体上移，听感是「哇」而不是变窄。 */
    this._applyFilterEnv(f1, when, isBand ? voice.filterLowBase : voice.filterBase, voice);
    if (fHi) this._applyFilterEnv(fHi, when, voice.filterBase, voice);

    if (porta && this.portamento > 0) {
      // 从 fromRatio 滑到目标 ratio
      for (var m = 0; m < sources.length; m++) {
        var s = sources[m];
        try {
          s.playbackRate.cancelScheduledValues(when);
          s.playbackRate.setValueAtTime(ratio * Math.pow(2, (this._portaFrom - note) / 12), when);
          s.playbackRate.exponentialRampToValueAtTime(Math.max(0.01, ratio), when + this.portamento);
        } catch (e) { /* noop */ }
      }
    }

    /* --- 音符滑音（glide） ---
       从同轨上一个音滑到本音。走 detune（音分）而不是 playbackRate：
       与音高算法（varispeed / stretch）以及声部级 portamento 互不打架，
       音程到音分是纯线性关系，换算法也不用重新推公式。 */
    if (glide > 0 && glideFrom !== null) {
      var gCents = (glideFrom - note) * 100;
      var gDur = Math.min(glide, Math.max(0.02, naturalDur));
      for (var gi = 0; gi < sources.length; gi++) {
        try {
          var gs = sources[gi];
          gs.detune.cancelScheduledValues(startAt);
          gs.detune.setValueAtTime(gCents, startAt);
          gs.detune.linearRampToValueAtTime(0, startAt + gDur);
        } catch (e) { /* noop */ }
      }
      voice.glide = gDur;
    }

    /* --- 音符颤音（vib） ---
       正弦 LFO 抖动 detune，深度 0..1 → ±60 音分。
       LFO 从 0 相位起振，起音处不会有音分跳变（听不到咔哒）。 */
    if (vib > 0) {
      try {
        var lfo = ctx.createOscillator();
        lfo.type = 'sine';
        lfo.frequency.value = vibRate;
        var vibGain = ctx.createGain();
        vibGain.gain.value = vib * 60;
        lfo.connect(vibGain);
        for (var vi = 0; vi < sources.length; vi++) vibGain.connect(sources[vi].detune);
        lfo.start(startAt);
        voice.lfo = lfo;
        voice.nodes.push(lfo, vibGain);
      } catch (e) { /* LFO 建不起来就别颤了，出音优先 */ }
    }

    /* --- oneshot 自动收尾 ---
       单次模式：采样自己播完就结束（音符时值不管，音符比采样长也不循环）。
       停之前先做 30ms 淡出 —— 直接 stop 是硬切，采样结尾还有电平时会
       「戛然而止」，听起来像被掐断（还会爆音）。 */
    if (this.mode === 'oneshot') {
      var stopAt = when + naturalDur;
      try { vca.gain.setTargetAtTime(0.0001, Math.max(when + 0.005, stopAt - 0.03), 0.008); }
      catch (e) { /* noop */ }
      for (var j = 0; j < sources.length; j++) {
        try { sources[j].stop(stopAt + 0.02); } catch (e) { /* noop */ }
      }
      this._stopLfo(voice, stopAt + 0.02);
      var self2 = this;
      setTimeout(function () { self2._cleanupVoice(voice); },
        Math.max(0, (stopAt - ctx.currentTime + this.amp.release)) * 1000 + 60);
    }

    this.voices.push(voice);
    engine.activeVoices++;
    BS.emit('voice:start', { part: this, note: note, vel: vel, voice: voice });
    return voice;
  };

  Part.prototype._applyAmpEnv = function (vca, when, vel, naturalDur, voice) {
    var a = this.amp, ctx = this.ctx;
    // 峰值 = 包络增益 × 采样音量 × 力度映射
    var peak = a.gain * this.sampleGain * (1 - this.velocityToGain + this.velocityToGain * vel);
    peak = clampNum(peak, 0, 4, 0.9);
    var g = vca.gain;
    var atk = Math.max(0.001, a.attack);
    var decTC = Math.max(0.004, a.decay) / 3;   // setTargetAtTime 时间常数，必须 > 0
    if (!isFinite(when)) when = ctx.currentTime;
    try {
      g.cancelScheduledValues(when);
      g.setValueAtTime(0.0001, when);
      g.linearRampToValueAtTime(peak, when + atk);
      g.setTargetAtTime(peak * a.sustain, when + atk, decTC);
    } catch (e) { g.value = peak; }
    voice.peak = peak;

    // gate 模式：超过自然长度后按 sustain 继续，松键才 release
    if (this.mode === 'gate') {
      var sustainAt = when + naturalDur;
      try {
        g.setTargetAtTime(peak * a.sustain, sustainAt, 0.01);
      } catch (e) { /* noop */ }
    }
  };

  /* node：要扫的滤波器；base：它自己的基准频率（高切 / 低切各一份） */
  Part.prototype._applyFilterEnv = function (node, when, base, voice) {
    var f = this.filter;
    if (!f.envAmount || !node || !(base > 0)) return;
    var peak = clampNum(base * Math.pow(2, f.envAmount * 3), 10, 22000, base);
    var atk = Math.max(0.001, f.envAttack);
    var decTC = Math.max(0.004, f.envDecay) / 3;
    if (!isFinite(when)) return;
    try {
      node.frequency.cancelScheduledValues(when);
      node.frequency.setValueAtTime(peak, when);
      node.frequency.setTargetAtTime(clampNum(peak * f.envSustain, 10, 22000, peak), when + atk, decTC);
    } catch (e) { /* noop */ }
    if (voice) voice.filterEnv = true;
  };

  /* 颤音 LFO 不是「放完自己停」的节点，必须显式 stop ——
     只 disconnect 的话振荡器会在后台一直跑。多次调用由 _lfoStopped 兜住。 */
  Part.prototype._stopLfo = function (voice, at) {
    if (!voice || !voice.lfo || voice._lfoStopped) return;
    voice._lfoStopped = true;
    try { voice.lfo.stop(at === undefined ? this.ctx.currentTime : at); } catch (e) { /* 已停止 */ }
  };

  /* 把参数「此刻的实际值」冻结住，作为下一段自动化的起点。
     ⚠️ 不能读 param.value：那拿到的是参数的**基础值**（自动化之外的设定值），
     起音/衰减是调度在未来的自动化，所以这里读到的常常还是初始化时的 0.0001。
     以前释音就是栽在这上面 —— 松键后增益从 0.0001 开始淡出，
     听感是「一下子就没了」，A.释音 旋钮怎么调都没用。
     cancelAndHoldAtTime 会保留 when 时刻的自动化值并取消其后的自动化，正是为此设计的。 */
  function holdParamAt(param, when) {
    if (!param) return false;
    if (typeof param.cancelAndHoldAtTime === 'function') {
      try { param.cancelAndHoldAtTime(when); return true; } catch (e) { /* 退回基础值写法 */ }
    }
    return false;
  }

  Part.prototype._releaseVoice = function (voice, when) {
    if (voice.released) return;
    voice.released = true;
    when = when === undefined ? this.ctx.currentTime : when;
    if (!isFinite(when)) when = this.ctx.currentTime;
    var rel = Math.max(0.01, this.amp.release);
    var g = voice.vca.gain;
    try {
      if (!holdParamAt(g, when)) {
        g.cancelScheduledValues(when);
        var cur = g.value;
        g.setValueAtTime(isFinite(cur) && cur > 0.0001 ? cur : 0.0001, when);
      }
      g.setTargetAtTime(0.0001, when, rel / 3);
    } catch (e) { /* noop */ }

    var stopAt = when + rel + 0.02;
    for (var i = 0; i < voice.sources.length; i++) {
      try { voice.sources[i].stop(stopAt); } catch (e) { /* noop */ }
    }
    this._stopLfo(voice, stopAt);
    if (voice.timer) clearTimeout(voice.timer);
    var self = this;
    /* ⚠️ 清理定时器必须按**音频时钟**算，不能直接用 rel：
       序列器有前瞻窗口（120ms），release 往往是「将来」的时刻 —— 提前排好了，
       但发声还在几百毫秒之后。固定用 rel*1000 计时的话，音符还没到点就被
       disconnect，声音在开头就被掐断（长音符尤其明显：只响半个音符就没了）。
       演奏页键盘不受影响：那里的 release 就是「当下」，两边时间相同。
       离线渲染也看不出来：渲染期间 setTimeout 根本不会跑。
       正确做法：等「release 时刻 - 现在」再算释音时长。 */
    var wait = Math.max(0, when - this.ctx.currentTime) + rel;
    voice.timer = setTimeout(function () { self._cleanupVoice(voice); }, wait * 1000 + 60);
  };

  Part.prototype._killVoice = function (voice, when) {
    if (!voice || voice._cleaned) return;
    when = when === undefined ? this.ctx.currentTime : when;
    if (!isFinite(when)) when = this.ctx.currentTime;
    voice.released = true;
    if (voice.timer) clearTimeout(voice.timer);
    var g = voice.vca.gain;
    try {
      // 同理：从「此刻的实际增益」开始 6ms 淡出，避免硬切爆音
      if (!holdParamAt(g, when)) {
        g.cancelScheduledValues(when);
        var cur = g.value;
        g.setValueAtTime(isFinite(cur) && cur > 0.0001 ? cur : 0.0001, when);
      }
      g.linearRampToValueAtTime(0.0001, when + 0.006);
    } catch (e) { /* noop */ }
    for (var i = 0; i < voice.sources.length; i++) {
      try { voice.sources[i].stop(when + 0.008); } catch (e) { /* noop */ }
    }
    this._stopLfo(voice, when + 0.02);
    this._cleanupVoice(voice, true);
  };

  Part.prototype._cleanupVoice = function (voice, immediate) {
    var idx = this.voices.indexOf(voice);
    if (idx >= 0) this.voices.splice(idx, 1);
    if (voice._cleaned) return;
    voice._cleaned = true;
    this._stopLfo(voice);   // 兜底：任何路径漏停，回收时补上
    this.engine.activeVoices = Math.max(0, this.engine.activeVoices - 1);
    BS.emit('voice:stop', { part: this, note: voice.note, voice: voice });

    var delay = immediate ? 40 : 60;
    setTimeout(function () {
      for (var i = 0; i < voice.nodes.length; i++) {
        try { voice.nodes[i].disconnect(); } catch (e) { /* noop */ }
      }
      for (var j = 0; j < voice.sources.length; j++) {
        try { voice.sources[j].disconnect(); } catch (e) { /* noop */ }
      }
    }, delay);
  };

  Part.prototype.allNotesOff = function (when) { this._releaseAll(when, false); };
  Part.prototype.panic = function () { this._releaseAll(this.ctx.currentTime, true); };

  Part.prototype._releaseAll = function (when, hard) {
    var list = this.voices.slice();
    for (var i = 0; i < list.length; i++) {
      if (hard) this._killVoice(list[i], when);
      else this._releaseVoice(list[i], when);
    }
  };

  /* 参数更新（供 UI 调用） */
  Part.prototype.update = function (path, value) {
    var parts = path.split('.');
    var o = this;
    for (var i = 0; i < parts.length - 1; i++) {
      if (!o[parts[i]] || typeof o[parts[i]] !== 'object') return;
      o = o[parts[i]];
    }
    var key = parts[parts.length - 1];
    // 数值参数必须有限，否则 AudioParam 会抛异常
    if (typeof o[key] === 'number' && !isFinite(value)) return;
    o[key] = value;

    // 即时生效的映射
    if (path === 'volume') this.applyAudible();
    else if (path === 'muted' || path === 'solo') { this.engine.refreshAudible(); }
    else if (path === 'pan' && this.panNode) this.panNode.pan.value = clampNum(value, -1, 1, 0);
    else if (path === 'sendReverb') this.revSend.gain.value = clampNum(value, 0, 1, 0);
    else if (path === 'sendDelay') this.dlySend.gain.value = clampNum(value, 0, 1, 0);
    else if (path === 'reverse') this._revBuffer = null;
  };

  /* ---------------- 引擎 ---------------- */
  function Engine(ctx) {
    this.ctx = ctx;
    this.parts = [];
    this.activeVoices = 0;
    this.bpm = 120;
    this.timeSignature = [4, 4];
    this.swing = 0;

    this.partBus = ctx.createGain();
    this.masterDrive = ctx.createWaveShaper();
    this.masterDrive.curve = BS.makeDriveCurve(0);
    this.masterDrive.oversample = '2x';

    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14;
    this.comp.knee.value = 12;
    this.comp.ratio.value = 3;
    this.comp.attack.value = 0.004;
    this.comp.release.value = 0.18;

    this.master = ctx.createGain();
    this.masterValue = 0.85;   // 主音量设定值（工程保存读它）
    this.master.gain.value = 0.85;

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.6;

    /* 混响总线 */
    this.reverbBus = ctx.createGain();
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = BS.makeImpulse(ctx, 2.4, 2.2);
    this.reverbReturn = ctx.createGain();
    this.reverbReturn.gain.value = 0.9;
    this.reverbBus.connect(this.reverb);
    this.reverb.connect(this.reverbReturn);
    this.reverbReturn.connect(this.master);

    /* 延迟总线 */
    this.delayBus = ctx.createGain();
    this.delay = ctx.createDelay(2.0);
    this.delay.delayTime.value = 0.375;
    this.delayFb = ctx.createGain();
    this.delayFb.gain.value = 0.36;
    this.delayTone = ctx.createBiquadFilter();
    this.delayTone.type = 'lowpass';
    this.delayTone.frequency.value = 3200;
    this.delayReturn = ctx.createGain();
    this.delayReturn.gain.value = 0.8;
    this.delayBus.connect(this.delay);
    this.delay.connect(this.delayTone);
    this.delayTone.connect(this.delayFb);
    this.delayFb.connect(this.delay);
    this.delayTone.connect(this.delayReturn);
    this.delayReturn.connect(this.master);

    /* 主链 */
    this.partBus.connect(this.masterDrive);
    this.masterDrive.connect(this.comp);
    this.comp.connect(this.master);
    this.master.connect(this.analyser);
    this.analyser.connect(ctx.destination);

    this.meterData = new Float32Array(this.analyser.fftSize);
    this.setTempo(120);
  }

  Engine.prototype.addPart = function (opts) {
    var p = new Part(this, opts);
    this.parts.push(p);
    BS.emit('parts:changed', this.parts);
    return p;
  };

  Engine.prototype.removePart = function (id) {
    var i = this.parts.findIndex(function (p) { return p.id === id; });
    if (i < 0) return null;
    var p = this.parts[i];
    p.panic();
    try { p.out.disconnect(); p.revSend.disconnect(); p.dlySend.disconnect(); } catch (e) { /* noop */ }
    this.parts.splice(i, 1);
    BS.emit('parts:changed', this.parts);
    return p;
  };

  Engine.prototype.getPart = function (id) {
    for (var i = 0; i < this.parts.length; i++) if (this.parts[i].id === id) return this.parts[i];
    return null;
  };

  Engine.prototype.refreshAudible = function () {
    for (var i = 0; i < this.parts.length; i++) this.parts[i].applyAudible();
  };

  Engine.prototype.panic = function () {
    for (var i = 0; i < this.parts.length; i++) this.parts[i].panic();
  };

  Engine.prototype.allNotesOff = function () {
    for (var i = 0; i < this.parts.length; i++) this.parts[i].allNotesOff();
  };

  Engine.prototype.setTempo = function (bpm) {
    this.bpm = bpm;
    this.syncDelay();
  };

  Engine.prototype.setTimeSignature = function (sig) { this.timeSignature = sig; };

  Engine.prototype.syncDelay = function (div) {
    var d = (60 / this.bpm) * (div || 0.75);   // 默认 8分附点
    var v = clampNum(d, 0.01, 1.9, 0.375);
    try {
      this.delay.delayTime.setTargetAtTime(v, this.ctx.currentTime, 0.05);
    } catch (e) { this.delay.delayTime.value = v; }
  };

  Engine.prototype.setDelayFeedback = function (v) {
    this.delayFb.gain.value = clampNum(v, 0, 0.92, 0.36);
  };

  Engine.prototype.setReverbType = function (type) {
    var presets = {
      room:   { t: 0.7, decay: 3.2, ret: 0.7 },
      hall:   { t: 2.4, decay: 2.2, ret: 1.0 },
      plate:  { t: 1.6, decay: 3.6, ret: 0.85 },
      spring: { t: 1.2, decay: 2.0, ret: 0.9 },
      church: { t: 4.5, decay: 1.6, ret: 1.1 }
    };
    var p = presets[type] || presets.hall;
    this.reverb.buffer = BS.makeImpulse(this.ctx, p.t, p.decay);
    this.reverbReturn.gain.value = clampNum(p.ret, 0, 2, 1);
  };

  Engine.prototype.getLevel = function () {
    this.analyser.getFloatTimeDomainData(this.meterData);
    var peak = 0, sum = 0;
    for (var i = 0; i < this.meterData.length; i++) {
      var v = this.meterData[i];
      var a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      sum += v * v;
    }
    return { peak: peak, rms: Math.sqrt(sum / this.meterData.length) };
  };

  Engine.prototype.setMaster = function (v) {
    var val = clampNum(v, 0, 1.5, 0.85);
    // 记住目标值：setTargetAtTime 是渐变的，立即读 gain.value 拿到的是旧值，
    // 工程保存需要拿到「设定值」而不是「当前插值」。
    this.masterValue = val;
    try { this.master.gain.setTargetAtTime(val, this.ctx.currentTime, 0.015); }
    catch (e) { this.master.gain.value = val; }
  };

  Engine.prototype.setMasterDrive = function (amount) {
    this.masterDrive.curve = BS.makeDriveCurve(clampNum(amount, 0, 1, 0));
  };

  BS.Engine = Engine;
  BS.Part = Part;
  BS.defaultPart = defaultPart;

})(window);

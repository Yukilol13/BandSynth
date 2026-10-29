/* BandSynth · drum-rack.js
 * 鼓组通道：与合成器声部**完全独立**的一套音频通路。
 *
 * ── 为什么必须完全独立 ──
 * 之前的实现把鼓组塞进 engine.parts（哪怕合并成 1 个 Part），带来一堆问题：
 *   · 声部列表里鼓和合成器混在一起，选错就出怪声
 *   · 演奏台按键盘时如果当前选中的是鼓组，会用合成器音高去触发鼓 → 声音完全不对
 *   · 鼓轨与合成器轨共用 part 索引，编辑/删除/静音时互相牵连
 *   · 鼓的「音高」其实是「哪个鼓」的编号，和 MIDI 音高是两回事，混用必然出错
 *
 * 现在 DrumRack 是**独立通道**：
 *   · 不在 engine.parts 里，声部面板看不到它
 *   · 自己的 master 输出、自己的混响/延迟发送、自己的音量/声像
 *   · 触发接口 hit(drumId, vel, when) —— 用 drumId 而不是音高
 *   · 每面鼓有自己的 buffer 与参数（音量、滤波、混响送出）
 *   · 琴谱里鼓轨由 role:'drum' 标记，走 drum 字段，不占用 part 索引
 *
 * 触发链路：
 *   鼓轨音符 pitch(固定音高) ──反查──> drumId ──> 该鼓的 buffer ──> 独立节点链
 */
(function (global) {
  'use strict';
  var BS = global.BS;
  var U = BS.util;

  /* 鼓位 → 固定音高（与琴谱里鼓轨的 pitch 约定一致） */
  var DRUM_PITCH = {
    kick: 36, snare: 38, clap: 39, hihatClosed: 42, hihatOpen: 46,
    tomLow: 45, tomMid: 48, tomHigh: 50, ride: 51, crash: 49,
    rim: 37, shaker: 70
  };
  var PITCH_DRUM = {};
  for (var dk in DRUM_PITCH) {
    if (DRUM_PITCH.hasOwnProperty(dk)) PITCH_DRUM[DRUM_PITCH[dk]] = dk;
  }

  var FILTER_TYPES = {
    lowpass: 'lowpass', highpass: 'highpass', bandpass: 'bandpass',
    lowshelf: 'lowshelf', highshelf: 'highshelf', notch: 'notch', allpass: 'allpass'
  };

  /**
   * 鼓组通道。
   * @param {object} opts
   *   ctx       AudioContext（与引擎同一个）
   *   dest      输出目标（通常是 engine.master）
   *   factory   音色工厂（用于生成内置鼓 buffer）
   */
  function DrumRack(opts) {
    opts = opts || {};
    this.ctx = opts.ctx;
    this.dest = opts.dest || null;
    this.factory = opts.factory || BS.factory;

    /* ---- 通道级参数（整组一起调） ---- */
    this.volume = 0.85;
    this.pan = 0;
    this.sendReverb = 0.08;
    this.sendDelay = 0;
    this.muted = false;
    this.solo = false;
    this.maxVoices = 24;

    /* ---- 每面鼓的设置 ---- */
    this.drums = {};          // drumId -> { id, name, toneId, buffer, params }
    this.voices = [];         // 活跃声部

    this._buildRouting();
  }

  DrumRack.DRUM_PITCH = DRUM_PITCH;
  DrumRack.PITCH_DRUM = PITCH_DRUM;

  /** 音高 → drumId（未登记则返回 null） */
  DrumRack.prototype.drumIdOf = function (pitch) {
    var id = PITCH_DRUM[pitch];
    return (id && this.drums[id]) ? id : null;
  };

  /* ================= 路由 ================= */

  DrumRack.prototype._buildRouting = function () {
    var ctx = this.ctx;
    this.out = ctx.createGain();
    this.out.gain.value = this.volume;

    this.panNode = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (this.panNode) {
      this.panNode.pan.value = this.pan;
      this.out.connect(this.panNode);
    } else {
      this.out.connect(this.dest);
    }

    // 效果发送（与声部同样的接法：连到引擎的总线）
    this.revSend = ctx.createGain();
    this.revSend.gain.value = this.sendReverb;
    this.dlySend = ctx.createGain();
    this.dlySend.gain.value = this.sendDelay;

    if (this.panNode) this.panNode.connect(this.dest);
    this.out.connect(this.revSend);
    this.out.connect(this.dlySend);
  };

  /** 重新连接到新的目标（离线渲染时用） */
  DrumRack.prototype.connectTo = function (dest) {
    this.dest = dest;
    if (this.panNode) {
      try { this.panNode.disconnect(); } catch (e) { /* noop */ }
      this.panNode.connect(dest);
    } else {
      try { this.out.disconnect(); } catch (e) { /* noop */ }
      this.out.connect(dest);
    }
  };

  /* ================= 鼓的装载 ================= */

  /**
   * 装载整套鼓。
   * @param {string[]} drumIds  鼓位 id 列表
   * @param {object}   opts     { volume, pan, sendReverb }
   */
  DrumRack.prototype.loadKit = function (drumIds, opts) {
    opts = opts || {};
    var self = this;
    this.drums = {};

    (drumIds || []).forEach(function (drumId) {
      var toneId = (BS.drumKit && BS.drumKit.TONE_OF[drumId]) || drumId;
      var buf = self.factory.buffer(self.ctx, toneId);
      if (!buf) return;
      var preset = self.factory.preset(toneId) || {};
      self.drums[drumId] = {
        id: drumId,
        name: (BS.drumKit && BS.drumKit.labelOf(drumId)) || drumId,
        toneId: toneId,
        buffer: buf,
        // 每面鼓独立参数（来自该鼓的 preset，之后可单独调）
        volume: preset.volume === undefined ? 0.9 : preset.volume,
        sampleGain: preset.sampleGain === undefined ? 1 : preset.sampleGain,
        velocityToGain: preset.velocityToGain === undefined ? 0 : preset.velocityToGain,
        pan: 0,
        sendReverb: 0,
        filter: Object.assign({ type: 'lowpass', cutoff: 18000, resonance: 0.5 }, preset.filter || {}),
        amp: Object.assign({ attack: 0.001, decay: 0.2, sustain: 0, release: 0.05, gain: 0.9 }, preset.amp || {})
      };
    });

    if (opts.volume !== undefined) this.volume = opts.volume;
    if (opts.pan !== undefined) this.pan = opts.pan;
    if (opts.sendReverb !== undefined) this.sendReverb = opts.sendReverb;
    this.applyParams();
    return this;
  };

  /** 从鼓位 id 列表取默认（内置 12 面鼓） */
  DrumRack.prototype.loadDefaultKit = function (opts) {
    var ids = BS.drumKit ? BS.drumKit.DRUM_IDS : Object.keys(DRUM_PITCH);
    return this.loadKit(ids, opts);
  };

  DrumRack.prototype.drumIds = function () {
    return Object.keys(this.drums);
  };

  DrumRack.prototype.has = function (drumId) {
    return !!this.drums[drumId];
  };

  /* ================= 参数应用 ================= */

  DrumRack.prototype.applyParams = function () {
    var g = U.clamp(this.volume, 0, 1.5);
    try { this.out.gain.setTargetAtTime(g, this.ctx.currentTime, 0.01); }
    catch (e) { this.out.gain.value = g; }
    if (this.panNode) {
      var p = U.clamp(this.pan, -1, 1);
      try { this.panNode.pan.setTargetAtTime(p, this.ctx.currentTime, 0.01); }
      catch (e) { this.panNode.pan.value = p; }
    }
    try { this.revSend.gain.value = U.clamp(this.sendReverb, 0, 1); } catch (e) { /* noop */ }
    try { this.dlySend.gain.value = U.clamp(this.sendDelay, 0, 1); } catch (e) { /* noop */ }
  };

  DrumRack.prototype.setVolume = function (v) { this.volume = U.clamp(v, 0, 1.5); this.applyParams(); };
  DrumRack.prototype.setPan = function (v) { this.pan = U.clamp(v, -1, 1); this.applyParams(); };
  DrumRack.prototype.setSendReverb = function (v) { this.sendReverb = U.clamp(v, 0, 1); this.applyParams(); };
  DrumRack.prototype.setSendDelay = function (v) { this.sendDelay = U.clamp(v, 0, 1); this.applyParams(); };
  DrumRack.prototype.setMuted = function (m) { this.muted = !!m; };

  /* ================= 触发 ================= */

  /**
   * 敲击某面鼓。
   * @param drumId  鼓位 id（如 'kick'）
   * @param vel     力度 0~1
   * @param when    绝对时间（AudioContext 时间轴）
   * @param opts    { gain, pan } 单次触发的额外增益/声像（按轨混音用）
   */
  DrumRack.prototype.hit = function (drumId, vel, when, opts) {
    if (this.muted) return null;
    var d = this.drums[drumId];
    if (!d) return null;
    opts = opts || {};

    var ctx = this.ctx;
    when = when === undefined ? ctx.currentTime : when;
    vel = vel === undefined ? 1 : U.clamp(vel, 0, 1);

    // 复音上限：抢占最老的
    if (this.voices.length >= this.maxVoices) {
      this._killVoice(this.voices[0], when);
    }

    /* --- 节点链：source → filter → vca → out --- */
    var src = ctx.createBufferSource();
    src.buffer = d.buffer;

    var filt = ctx.createBiquadFilter();
    filt.type = FILTER_TYPES[d.filter.type] ? d.filter.type : 'lowpass';
    filt.frequency.value = U.clamp(d.filter.cutoff, 20, 20000);
    filt.Q.value = U.clamp(d.filter.resonance, 0.0001, 1000);

    var vca = ctx.createGain();
    vca.gain.value = 0.0001;

    src.connect(filt);
    filt.connect(vca);
    /* 每轨声像：只在需要时插一个 panner（pan=0 时省掉一个节点） */
    var pan = U.clamp(opts.pan || 0, -1, 1);
    var panner = null;
    if (Math.abs(pan) > 0.001 && ctx.createStereoPanner) {
      panner = ctx.createStereoPanner();
      panner.pan.value = pan;
      vca.connect(panner);
      panner.connect(this.out);
    } else {
      vca.connect(this.out);
    }

    /* --- 包络 --- */
    var a = d.amp;
    /* 增益公式与 Part.noteOn 对齐：
     *   peak = amp.gain × sampleGain × (1 - velocityToGain + velocityToGain × vel)
     * 少乘 sampleGain 会让内置鼓比采样声部轻两个数量级（听起来"没声音"）。 */
    var aGain = (a.gain === undefined ? 0.9 : a.gain);
    var sGain = (d.sampleGain === undefined ? 1 : d.sampleGain);
    var velToGain = U.clamp(d.velocityToGain === undefined ? 0 : d.velocityToGain, 0, 1);
    /* 轨增益直接乘进峰值：内置鼓的 velocityToGain 默认为 0，
       只改 vel 不会改变响度 —— 之前靠改通道总音量来调轨，才导致两轨互相覆盖。 */
    var trGain = U.clamp(opts.gain === undefined ? 1 : opts.gain, 0, 2);
    var peak = U.clamp(d.volume * aGain * sGain * (1 - velToGain + velToGain * vel) * trGain, 0, 2);
    var atk = Math.max(0.0005, a.attack === undefined ? 0.001 : a.attack);
    var dec = Math.max(0.01, a.decay === undefined ? 0.2 : a.decay);
    var sus = U.clamp(a.sustain === undefined ? 0 : a.sustain, 0, 1);
    var rel = Math.max(0.01, a.release === undefined ? 0.05 : a.release);

    var g = vca.gain;
    try {
      g.cancelScheduledValues(when);
      g.setValueAtTime(0.0001, when);
      g.linearRampToValueAtTime(peak, when + atk);
      if (sus > 0.001) {
        g.setTargetAtTime(peak * sus, when + atk, Math.max(0.004, dec) / 3);
        // loop/gate 型：等释放
        var stopAt = when + Math.max(0.05, dec * 4);
        g.setTargetAtTime(0.0001, stopAt, Math.max(0.004, rel) / 3);
        try { src.stop(stopAt + rel + 0.05); } catch (e) { /* noop */ }
      } else {
        // oneshot：自然衰减到 0
        g.setTargetAtTime(0.0001, when + atk, Math.max(0.004, dec) / 3);
        try { src.stop(when + atk + dec * 4 + 0.05); } catch (e) { /* noop */ }
      }
    } catch (e) { g.value = peak; }

    try { src.start(when); } catch (e) { /* noop */ }

    var voice = {
      drumId: drumId, src: src, vca: vca, filt: filt,
      released: false, startedAt: when, peak: peak
    };
    this.voices.push(voice);
    var self = this;
    src.onended = function () { self._cleanup(voice); };
    return voice;
  };

  /** 按音高触发（琴谱用：pitch 是鼓的固定音高） */
  DrumRack.prototype.hitPitch = function (pitch, vel, when, opts) {
    var id = this.drumIdOf(pitch);
    if (!id) return null;
    return this.hit(id, vel, when, opts);
  };

  DrumRack.prototype._killVoice = function (voice, when) {
    if (!voice || voice.released) return;
    voice.released = true;
    try {
      voice.vca.gain.cancelScheduledValues(when);
      voice.vca.gain.setValueAtTime(Math.max(0.0001, voice.vca.gain.value), when);
      voice.vca.gain.linearRampToValueAtTime(0.0001, when + 0.008);
      voice.src.stop(when + 0.01);
    } catch (e) { /* noop */ }
    this._cleanup(voice);
  };

  DrumRack.prototype._cleanup = function (voice) {
    var i = this.voices.indexOf(voice);
    if (i >= 0) this.voices.splice(i, 1);
  };

  DrumRack.prototype.allNotesOff = function () {
    var now = this.ctx.currentTime;
    this.voices.slice().forEach(function (v) { this._killVoice(v, now); }, this);
    this.voices.length = 0;
  };

  /* ================= 序列化（工程存档用） ================= */

  DrumRack.prototype.toSpec = function () {
    return {
      volume: this.volume,
      pan: this.pan,
      sendReverb: this.sendReverb,
      sendDelay: this.sendDelay,
      muted: this.muted,
      drums: this.drumIds().map(function (id) {
        var d = this.drums[id];
        return {
          id: id, name: d.name, toneId: d.toneId,
          volume: d.volume, pan: d.pan,
          filter: Object.assign({}, d.filter),
          amp: Object.assign({}, d.amp)
        };
      }, this)
    };
  };

  DrumRack.prototype.fromSpec = function (spec) {
    if (!spec) return this;
    this.loadKit((spec.drums || []).map(function (d) { return d.id; }), {
      volume: spec.volume, pan: spec.pan,
      sendReverb: spec.sendReverb, sendDelay: spec.sendDelay
    });
    (spec.drums || []).forEach(function (sd) {
      var d = this.drums[sd.id];
      if (!d) return;
      if (sd.volume !== undefined) d.volume = sd.volume;
      if (sd.pan !== undefined) d.pan = sd.pan;
      if (sd.filter) d.filter = Object.assign({}, d.filter);
      if (sd.amp) d.amp = Object.assign({}, d.amp);
    }, this);
    this.muted = !!spec.muted;
    this.applyParams();
    return this;
  };

  BS.DrumRack = DrumRack;
})(typeof window !== 'undefined' ? window : globalThis);

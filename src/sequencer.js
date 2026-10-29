/* BandSynth · sequencer.js
 * 序列器 + 离线渲染
 *  · Sequencer：把谱面事件实时排程到 AudioContext（支持循环、节拍器、暂停、变速）
 *  · Renderer：用 OfflineAudioContext 一次性渲染成 AudioBuffer → WAV
 *
 * 关键点：离线渲染复用同一套 Part 逻辑，只是 ctx 换成 OfflineAudioContext，
 * 所有 noteOn 的 when 传绝对时间，因此结果与实时播放一致（除采样精度外）。
 */
(function (global) {
  'use strict';
  var BS = global.BS;
  var U = BS.util;

  /* ---------------- 序列器 ---------------- */
  function Sequencer(engine, opts) {
    opts = opts || {};
    this.engine = engine;
    this.ctx = engine.ctx;
    this.song = opts.song || null;
    this.metronome = opts.metronome || null;   // 可选节拍器对象
    this.loop = opts.loop !== false;
    this.playing = false;
    this.startTime = 0;        // ctx 时间轴上"曲首"的位置
    this.pausedAt = 0;         // 暂停时的小节拍位置
    this.timer = null;
    this.lookahead = 0.12;     // 预排程窗口（秒）
    this.interval = 25;        // 调度器轮询间隔（ms）
    this.onEvent = opts.onEvent || null;
    this.onStateChange = opts.onStateChange || null;
    this._timer = null;
    this._endTimer = null;
    this.followPlayable = !!opts.followPlayable;
    /* 实时轨查询：(trackIndex) => 当前轨对象。
       编曲页播放时传的是 arr.toSong() 的快照，轨的声部（part）之后会被用户改，
       排程时要按实时轨取，改完下一轮 tick（≤120ms）就生效，不用停播。 */
    this.trackOf = opts.trackOf || null;
    this.playableParts = [];   // 跟随演奏时可被用户声部顶替的 part 索引
    // 鼓组通道（独立于 engine.parts）。鼓轨事件走这里，不占 part 索引。
    this.drumRack = opts.drumRack || null;
  }

  /** 绑定鼓组通道（通道就绪后调用） */
  Sequencer.prototype.setDrumRack = function (rack) {
    this.drumRack = rack || null;
  };

  Sequencer.prototype.setSong = function (song) {
    this.stop();
    this.song = song;
    this.pausedAt = 0;
  };

  Sequencer.prototype.events = function () {
    if (!this.song) return [];
    return BS.score.buildEvents(this.song);
  };

  Sequencer.prototype.totalBeats = function () {
    return this.song ? BS.score.totalBeats(this.song) : 0;
  };

  Sequencer.prototype.totalSec = function () {
    return this.song ? BS.score.totalSec(this.song) : 0;
  };

  /* 当前位置（秒，相对曲首） */
  Sequencer.prototype.position = function () {
    if (!this.playing) return this.pausedAt;
    return this.ctx.currentTime - this.startTime;
  };

  /** 事件表里第一条不早于 songTime 的下标 */
  Sequencer.prototype._firstIndexAt = function (songTime) {
    var evs = this._evs || [];
    var i = 0;
    while (i < evs.length && evs[i].time < songTime - 1e-6) i++;
    return i;
  };

  /** 循环区间（曲内秒）：{ start, end, len }；不循环时 len=0 */
  Sequencer.prototype.loopRange = function () {
    var s = this.song;
    if (!s || !(s.loopBars > 0)) return { start: 0, end: 0, len: 0 };
    var barSec = s.timeSignature[0] * 60 / s.bpm;
    var start = Math.max(0, (s.loopStartBars || 0) * barSec);
    return { start: start, end: start + s.loopBars * barSec, len: s.loopBars * barSec };
  };

  /* 当前拍位置 */
  Sequencer.prototype.beatPosition = function () {
    if (!this.song) return 0;
    return this.position() * this.song.bpm / 60;
  };

  Sequencer.prototype.play = function (fromSec) {
    if (!this.song) return;
    if (this.playing) this.stop();
    var offset = fromSec !== undefined ? fromSec : this.pausedAt;
    if (!(offset > 0)) offset = 0;
    this.startTime = this.ctx.currentTime + 0.08 - offset;
    this.playing = true;
    this._evs = this.events();
    this._i = 0;
    this._nextEvTime = 0;              // 曲内时间（秒），下次要排的事件时间
    /* 从 offset 处起播：排程指针也放在 offset，
       并把事件游标推到第一条不早于 offset 的事件 ——
       否则「从第 5 小节起播」会把前面所有音符当成迟到事件一次性砸出来。 */
    this._scheduledTo = offset;
    var evs = this._evs;
    while (this._i < evs.length && evs[this._i].time < offset - 1e-6) this._i++;
    this._cycleBase = 0;                // 当前循环轮的曲内偏移（秒）
    this._lastSched = this.ctx.currentTime;
    this._schedule();
    this._timer = setInterval(() => this._schedule(), this.interval);
    this._emitState();
  };

  Sequencer.prototype.pause = function () {
    if (!this.playing) return;
    this.pausedAt = this.position();
    this._teardown();
    this.playing = false;
    this._emitState();
  };

  Sequencer.prototype.stop = function () {
    if (!this.playing) { this.pausedAt = 0; this._emitState(); return; }
    this._teardown();
    this.playing = false;
    this.pausedAt = 0;
    this._emitState();
  };

  Sequencer.prototype.toggle = function () { this.playing ? this.pause() : this.play(); };

  Sequencer.prototype.seek = function (sec) {
    var wasPlaying = this.playing;
    if (wasPlaying) { this._teardown(); this.playing = false; }
    this.pausedAt = Math.max(0, sec);
    if (wasPlaying) this.play(this.pausedAt);
    else this._emitState();
  };

  Sequencer.prototype.setTempo = function (bpm) {
    if (!this.song) return;
    var pos = this.position();
    var beats = pos * this.song.bpm / 60;
    this.song.bpm = U.clamp(bpm, 20, 400);
    this.engine.setTempo(this.song.bpm);
    if (this.playing) {
      // 保持播放位置连续
      this._teardown();
      this.playing = false;
      this.play(beats * 60 / this.song.bpm);
    }
  };

  Sequencer.prototype._teardown = function () {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this.engine.allNotesOff();
  };

  Sequencer.prototype._emitState = function () {
    if (this.onStateChange) {
      this.onStateChange({ playing: this.playing, position: this.position(), song: this.song });
    }
  };

  /* 前瞻排程：把 [scheduledTo, now+lookahead) 区间内的事件挂到音频时钟上 */
  Sequencer.prototype._schedule = function () {
    if (!this.playing || !this.song) return;
    var ctx = this.ctx;
    var song = this.song;
    var evs = this._evs || (this._evs = this.events());
    var total = this.totalSec();
    var loop = this.loopRange();
    var useLoop = this.loop && loop.len > 0.001;
    /* 区域的结束点：循环时是区间末端（区间之前的部分照常播一遍） */
    var segLen = useLoop ? loop.end : total;

    var horizon = ctx.currentTime + this.lookahead;
    var guard = 0;

    while (guard++ < 400) {
      // 当前排程指针所在的时间窗口（曲内时间）
      var t = this._scheduledTo;
      if (t >= segLen - 1e-6) {
        if (!useLoop) { this._finish(); return; }
        /* 回绕到循环区间起点：
           让 songTime=loop.start 落在「区间结束的那一刻」的下一拍，
           即 startTime 前移一个区间长度，而不是固定回 0。 */
        var cycle = loop.len;
        if (cycle <= 1e-6) { this._finish(); return; }
        this.startTime += cycle;
        this._scheduledTo = loop.start;
        this._i = this._firstIndexAt(loop.start);
        t = loop.start;
      }

      // 本轮的目标窗口末端
      var winEnd = Math.min(horizon - this.startTime, segLen);
      if (winEnd <= t + 1e-9) break;   // 到前瞻边界，等下一次 tick

      // 排程窗口内的事件
      for (var i = this._i; i < evs.length; i++) {
        var ev = evs[i];
        if (ev.time >= winEnd) break;
        this._fire(ev, this.startTime + ev.time);
        this._i = i + 1;
      }

      this._scheduledTo = winEnd;
    }
  };

  Sequencer.prototype._finish = function () {
    this.playing = false;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this.pausedAt = 0;
    var self = this;
    setTimeout(function () { self._emitState(); }, 60);
  };

  /* 触发单个事件 */
  Sequencer.prototype._fire = function (ev, when) {
    if (ev.track && ev.track.muted) return;

    // 鼓轨：走独立的鼓组通道，不碰 engine.parts
    if (ev.isDrum) {
      var rack = this.drumRack;
      if (!rack) return;
      /* 每条鼓轨的增益/声像按**轨**传入，而不是去改共享鼓组通道的总音量 ——
         否则两条鼓轨会互相覆盖（后一轨把前一轨的音量顶掉）。
         注意 buildEvents 已把轨音量乘进 vel，这里要还原出音符自身力度，
         否则「音量」会被算两次。 */
      var tr = ev.track || {};
      var trVol = tr.volume === undefined ? 1 : tr.volume;
      var noteVel = trVol > 1e-4 ? U.clamp(ev.vel / trVol, 0, 1) : ev.vel;
      var dv = rack.hitPitch(ev.pitch, noteVel, when, {
        gain: trVol,
        pan: tr.pan || 0
      });
      if (!dv) return;
      if (this.onEvent) this.onEvent({ ev: ev, voice: dv, when: when });
      return;
    }

    /* 声部索引按**实时**轨取，不要用排程时快照的 partIndex：
       播放中改轨的声部（changeTrackPart）要立刻生效，
       而不是等下次播放才换（前瞻窗口只有 120ms，下一轮 tick 就用上新声部）。 */
    var live = this.trackOf ? this.trackOf(ev.trackIndex) : null;
    var partIdx = (live && live.part !== undefined && live.part !== null) ? live.part
      : ((ev.track && ev.track.part !== undefined && ev.track.part !== null) ? ev.track.part : ev.partIndex);
    var part = this.engine.parts[partIdx];
    if (!part || !part.buffer) return;      // 空声部（没有采样）直接跳过，不出声

    /* buildEvents 把轨音量折进了 vel；这里还原出音符自身力度，
       让轨音量由 part.volume（混音条）单独负责 —— 否则会被算两次。 */
    var tv = ev.track && ev.track.volume !== undefined ? ev.track.volume : 1;
    var vel = tv > 1e-4 ? U.clamp(ev.vel / tv, 0, 1) : ev.vel;
    if (ev.track && ev.track.pan !== undefined) part.pan = ev.track.pan;
    var voice = part.noteOn(ev.pitch, vel, when, {
      glide: ev.glide, glideFrom: ev.glideFrom, vib: ev.vib, vibRate: ev.vibRate
    });
    if (!voice) return;

    /* 发声长度由声部「播放模式」决定（见声部设置）：
         单次 = 采样自己播完，音符时值不干预（音符比采样长也**不循环**）
         门控 = 到音符末尾收尾（采样先放完就停，不循环）
         循环 = 采样循环，一直响到音符结束
       连奏（tie）的音符不截断。 */
    if (part.mode !== 'oneshot' && !ev.tie) {
      voice.release(when + Math.max(0.01, ev.duration) + 0.001);
    }

    if (this.onEvent) this.onEvent({ ev: ev, voice: voice, when: when });
  };

  Sequencer.prototype.getProgress = function () {
    if (!this.song) return { beat: 0, total: 0, ratio: 0, bar: 0, beatInBar: 0 };
    var total = this.totalBeats();
    var beat = this.beatPosition();
    var barLen = this.song.timeSignature[0];
    var loopBars = this.song.loopBars > 0 ? this.song.loopBars : 0;
    var loopStart = loopBars > 0 ? Math.max(0, this.song.loopStartBars || 0) * barLen : 0;
    var effTotal = loopBars > 0 ? loopBars * barLen : total;
    var effBeat = beat;
    if (loopBars > 0 && beat >= loopStart - 1e-6) {
      // 循环区间从 loopStart 起：进度条只在区间内滚动
      effBeat = loopStart + (((beat - loopStart) % effTotal) + effTotal) % effTotal;
    }
    return {
      beat: beat,
      total: total,
      effBeat: effBeat,
      effTotal: effTotal,
      ratio: effTotal > 0 ? effBeat / effTotal : 0,
      bar: Math.floor(effBeat / barLen) + 1,
      beatInBar: (effBeat % barLen) + 1
    };
  };

  /* ---------------- 节拍器 ---------------- */
  function Metronome(ctx, dest) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 0.5;
    this.out.connect(dest || ctx.destination);
    this.accentFreq = 1600;
    this.normalFreq = 1000;
    this.enabled = false;
  }

  Metronome.prototype.click = function (when, accent) {
    var ctx = this.ctx;
    var osc = ctx.createOscillator();
    var g = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = accent ? this.accentFreq : this.normalFreq;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(accent ? 0.5 : 0.28, when + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    osc.connect(g);
    g.connect(this.out);
    osc.start(when);
    osc.stop(when + 0.06);
  };

  Metronome.prototype.scheduleFor = function (song, fromBeat, toBeat, timeOfBeat) {
    var len = song.timeSignature[0];
    var start = Math.ceil(fromBeat - 1e-6);
    var end = Math.floor(toBeat + 1e-6);
    for (var b = start; b <= end; b++) {
      var t = timeOfBeat(b);
      this.click(t, b % len === 0);
    }
  };

  /* ---------------- 离线渲染 ---------------- */
  var Renderer = BS.renderer = {

    /* parts: [{buffer, rootNote, ...params}] 纯数据描述（不依赖 Engine 实例）
     * 返回 Promise<AudioBuffer> */
    render: function (opts) {
      var song = opts.song;
      var partSpecs = opts.parts;
      var sampleRate = opts.sampleRate || 44100;
      var tailSec = opts.tail === undefined ? 2.0 : opts.tail;
      var onProgress = opts.onProgress || null;

      var events = BS.score.buildEvents(song);
      var songSec = BS.score.totalSec(song);
      var lastEventEnd = 0;
      events.forEach(function (e) { lastEventEnd = Math.max(lastEventEnd, e.time + e.duration); });
      var totalSec = Math.max(songSec, lastEventEnd) + tailSec;
      var frames = Math.ceil(totalSec * sampleRate);

      var OAC = global.OfflineAudioContext || global.webkitOfflineAudioContext;
      var octx = new OAC(2, frames, sampleRate);

      var engine = new BS.Engine(octx);
      engine.setTempo(song.bpm);

      // 建立离线声部：partMap[谱面 part 序号] = 离线声部
      var partMap = {};
      partSpecs.forEach(function (spec, i) {
        if (!spec.buffer) { partMap[i] = null; return; }
        var buf = spec.buffer;
        if (buf.sampleRate !== sampleRate) buf = BS.loader.resample(octx, buf, sampleRate);

        var p = engine.addPart({
          name: spec.name || ('轨 ' + (i + 1)),
          rootNote: spec.rootNote === undefined ? 60 : spec.rootNote,
          transpose: spec.transpose || 0,
          fine: spec.fine || 0,
          mode: spec.mode || 'oneshot',
          pitchMode: 'varispeed',        // 离线渲染不做实时 WSOLA（需同步算完整曲）
          startSec: spec.startSec || 0,
          endSec: spec.endSec || 0,
          volume: spec.volume === undefined ? 0.85 : spec.volume,
          sampleGain: spec.sampleGain === undefined ? 1 : spec.sampleGain,
          pan: spec.pan || 0,
          sendReverb: spec.sendReverb || 0,
          sendDelay: spec.sendDelay || 0,
          filter: spec.filter,
          amp: spec.amp,
          reverse: !!spec.reverse
        });
        p.setBuffer(buf, spec.bufferName || '');
        partMap[i] = p;
      });

      // 离线鼓组通道（独立于 engine.parts）
      var offRack = null;
      if (partSpecs.drumRack) {
        offRack = new BS.DrumRack({
          ctx: octx, dest: engine.master, factory: BS.factory
        });
        offRack.connectTo(engine.master);
        offRack.loadKit(partSpecs.drumRack.drumIds || [], {
          volume: partSpecs.drumRack.volume,
          pan: partSpecs.drumRack.pan,
          sendReverb: partSpecs.drumRack.sendReverb
        });
        // 采样率对齐
        (partSpecs.drumRack.drumIds || []).forEach(function (did) {
          var d = offRack.drums[did];
          if (d && d.buffer && d.buffer.sampleRate !== sampleRate) {
            d.buffer = BS.loader.resample(octx, d.buffer, sampleRate);
          }
        });
      }

      // 排程所有事件
      events.forEach(function (ev) {
        if (ev.track && ev.track.muted) return;
        var when = ev.time;
        if (ev.isDrum) {
          if (offRack) {
            var trv = ev.track && ev.track.volume !== undefined ? ev.track.volume : 1;
            offRack.hitPitch(ev.pitch, trv > 1e-4 ? U.clamp(ev.vel / trv, 0, 1) : ev.vel, when, {
              gain: trv,
              pan: (ev.track && ev.track.pan) || 0
            });
          }
          return;
        }
        var p = partMap[ev.partIndex];
        if (!p) return;
        var tvol = ev.track && ev.track.volume !== undefined ? ev.track.volume : 1;
        var nvel = tvol > 1e-4 ? U.clamp(ev.vel / tvol, 0, 1) : ev.vel;
        // 离线声部按轨音量/声像走，与实时播放保持一致的混音结果
        p.volume = tvol;
        if (ev.track && ev.track.pan !== undefined) p.pan = ev.track.pan;
        var v = p.noteOn(ev.pitch, nvel, when, {
          glide: ev.glide, glideFrom: ev.glideFrom, vib: ev.vib, vibRate: ev.vibRate
        });
        /* 与实时播放同一规则：由声部播放模式决定（单次播完 / 门控按时值 / 循环到音符末） */
        if (v && p.mode !== 'oneshot' && !ev.tie) {
          v.release(when + Math.max(0.01, ev.duration) + 0.001);
        }
      });

      // 渲染
      var t0 = (global.performance || Date).now();
      return octx.startRendering().then(function (buffer) {
        if (onProgress) {
          onProgress({ seconds: (global.performance || Date).now() - t0, duration: buffer.duration });
        }
        return buffer;
      });
    },

    /* 渲染并导出 WAV（Blob） */
    renderToWav: function (opts) {
      var bitDepth = opts.bitDepth || 16;
      return Renderer.render(opts).then(function (buffer) {
        var ab = BS.wav.encode(buffer, { bitDepth: bitDepth, channels: opts.channels || 2 });
        return new Blob([ab], { type: 'audio/wav' });
      });
    },

    /* 导出单轨（分轨） */
    renderTrackToWav: function (opts) {
      var onlyPart = opts.onlyPart;
      var song = U.clone(opts.song);
      song.tracks = song.tracks.filter(function (t) { return t.part === onlyPart; });
      if (!song.tracks.length) return Promise.reject(new Error('该声部没有音符'));
      song.tracks.forEach(function (t) { t.part = 0; });
      return Renderer.renderToWav(Object.assign({}, opts, { song: song }));
    }
  };

  BS.Sequencer = Sequencer;
  BS.Metronome = Metronome;

})(window);

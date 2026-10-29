/* BandSynth · drums.js
 * 虚拟鼓组：按真实鼓组的摆放方式布局，点击哪里敲哪面鼓。
 *
 * ── 为什么鼓要走独立逻辑 ──
 * 合成器声部靠「音高」触发：noteOn(midiNote) 经 effectiveRatio 算出
 * playbackRate，采样器才变调。鼓没有音高概念 —— 底鼓永远是底鼓，
 * 你弹C2 还是 C5 它都是同一个声音。所以鼓组不能塞进Part 的音高体系，
 * 必须是「鼓ID（drumId）→ 对应音色」的直连映射：
 *
 *   合成器声部： note(音高) → ratio → 变调播放
 *   鼓组声部：  drumId     → part 索引 → 原速播放（keyTrack=false, transpose=0）
 *
 * 因此每个鼓位是一个 DrumKit 里的 { id, partIndex, label, x, y, ... }。
 * 鼓组的「轨」概念也随之独立：song 的鼓轨用 drum 字段标识是哪个鼓，
 * 而不是把鼓的 id 塞进 pitch。
 */
(function (global) {
  'use strict';
  var BS = global.BS;
  var U = BS.util;

  /* ================= 鼓位定义 =================
   * 坐标是「套组布局」的百分比，参照真实鼓手视角（从鼓手身后俯视）：
   * 底鼓在正中间最下方，军鼓左上/右上，嗵鼓右上排开，镲片在上方。
   * size 单位也是百分比，按鼓的实际视觉大小给。
   */

  var LAYOUT = [
    // ---- 镲片（上排）----
    { id: 'crash',       label: '碎音镲', x: 50, y: 11, size: 132, round: true, color: '#e8c46a' },
    { id: 'hihatOpen',   label: '开镲',   x: 21, y: 14, size: 96, round: true, color: '#d4a94f' },
    { id: 'hihatClosed', label: '闭镲',   x: 21, y: 31, size: 80, round: true, color: '#c99b45' },
    { id: 'ride',        label: '叮镲',   x: 79, y: 16, size: 104, round: true, color: '#e0b85e' },

    // ---- 鼓身（中排）----
    { id: 'tomHigh',     label: '高嗵',   x: 60, y: 34, size: 84, round: true, color: '#c96a5a' },
    { id: 'tomMid',      label: '中嗵',   x: 73, y: 44, size: 94, round: true, color: '#c2604f' },
    { id: 'tomLow',      label: '低嗵',   x: 86, y: 57, size: 104, round: true, color: '#b85546' },
    { id: 'snare',       label: '军鼓',   x: 36, y: 46, size: 100, round: true, color: '#d8dde3' },

    // ---- 打击件与底鼓（下排）----
    { id: 'shaker',      label: '沙锤',   x: 11, y: 63, size: 58, round: false, color: '#8fb8d8' },
    { id: 'rim',         label: '边击',   x: 50, y: 52, size: 52, round: true, color: '#9aa5b1' },
    { id: 'clap',        label: '拍手',   x: 28, y: 71, size: 66, round: true, color: '#b9c0c9' },
    { id: 'kick',        label: '底鼓',   x: 50, y: 80, size: 158, round: true, color: '#8a5a44' }
  ];

  /* 各鼓在 band-synth 里的音色 id（用于新建声部时选音色） */
  var TONE_OF = {
    kick: 'kick', snare: 'snare', clap: 'clap', rim: 'rim', shaker: 'shaker',
    hihatClosed: 'hihatClosed', hihatOpen: 'hihatOpen',
    tomLow: 'tomLow', tomMid: 'tomMid', tomHigh: 'tomHigh',
    ride: 'ride', crash: 'crash'
  };

  /* 电脑键盘映射（两排，模拟真实鼓手手位） */
  /* 鼓组键位（全字母区 + 空格）。
   * 注意：鼓组页与演奏页互斥，这些键在演奏页是音高键、在鼓组页才是鼓。 */
  var KEYMAP = {
    kick: ' ',      // 底鼓
    snare: 's',     // 军鼓
    clap: 'd',      // 拍手
    rim: 'f',       // 边击
    hihatClosed: 'j',  // 闭镲
    hihatOpen: 'k',   // 开镲
    tomLow: 'q',    // 低嗵
    tomMid: 'w',    // 中嗵
    tomHigh: 'e',   // 高嗵
    ride: 'r',      // 叮镲
    crash: 't',     // 碎音镲
    shaker: 'g'     // 沙锤
  };

  /* 鼓位 → 固定音高（与琴谱里鼓轨的 pitch 一致） */
  var DRUM_PITCH_FALLBACK = {
    kick: 36, snare: 38, clap: 39, hihatClosed: 42, hihatOpen: 46,
    tomLow: 45, tomMid: 48, tomHigh: 50, ride: 51, crash: 49,
    rim: 37, shaker: 70
  };

  /* ================= 鼓组乐器 ================= */

  /**
   * @param {object} opts
   *   engine     必填，BS.Engine 实例
   *   getPart    (drumId) => Part|null，供取样与触发
   *   onHit      (drumId, velocity) => void，命中回调（用于谱面高亮）
   *   getVelocity () => 0..1，当前力度
   */
  function DrumKit(opts) {
    opts = opts || {};
    this.engine = opts.engine;
    // 鼓组通道（独立于 engine.parts）。若未提供则自行创建。
    this.rack = opts.rack || null;
    if (!this.rack && this.engine) {
      this.rack = new BS.DrumRack({
        ctx: this.engine.ctx,
        dest: this.engine.master,
        factory: BS.factory
      });
      this.rack.loadDefaultKit({ volume: 0.9 });
    }
    this.getRack = opts.getRack || function () { return this.rack; }.bind(this);
    this.onHit = opts.onHit || function () {};
    this.getVelocity = opts.getVelocity || function () { return 0.85; };
    this.volume = 0.9;

    this.root = document.createElement('div');
    this.root.className = 'drumkit';
    // host 用于按容器尺寸缩放鼓垫。构造时 root 尚未入 DOM，
    // 所以优先取显式传入的 opts.host，否则后续由 attach() 补。
    this.host = opts.host || null;

    this.pads = new Map();       // drumId -> element
    this._flashTimers = new Map();

    this.build();
    this.bindPointer();
    this.bindComputerKeys();
    this.bindResize();
  }

  /* 挂载到容器后调用：确定 host 并按容器尺寸重排鼓垫 */
  DrumKit.prototype.attach = function (host) {
    this.host = host || this.root.parentElement;
    this.rescale();
    return this;
  };

  /* 窗口尺寸变化时重算鼓垫像素大小（小窗口也要放得下） */
  DrumKit.prototype.bindResize = function () {
    var self = this;
    var timer = null;
    this._onResize = function () {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () { self.rescale(); }, 150);
    };
    window.addEventListener('resize', this._onResize);
  };

  DrumKit.prototype.rescale = function () {
    var host = this.host;
    var scale = Math.min(1, (host && host.clientWidth || 1080) / 1080,
                               (host && host.clientHeight || 620) / 620);
    var self = this;
    LAYOUT.forEach(function (d) {
      var pad = self.pads.get(d.id);
      if (!pad) return;
      var px = Math.max(38, Math.round(d.size * (scale || 1)));
      pad.style.width = px + 'px';
      pad.style.height = px + 'px';
    });
  };

  DrumKit.LAYOUT = LAYOUT;
  DrumKit.TONE_OF = TONE_OF;
  DrumKit.KEYMAP = KEYMAP;
  DrumKit.DRUM_IDS = LAYOUT.map(function (d) { return d.id; });

  /** 供琴谱/落谱使用：鼓的显示名 */
  DrumKit.labelOf = function (id) {
    for (var i = 0; i < LAYOUT.length; i++) if (LAYOUT[i].id === id) return LAYOUT[i].label;
    return id;
  };

  DrumKit.prototype.build = function () {
    var self = this;
    this.root.innerHTML = '';

    // 鼓垫背景（像真实鼓群的鼓皮）
    var floor = document.createElement('div');
    floor.className = 'dk-floor';
    this.root.appendChild(floor);

    // 提示层
    var hint = document.createElement('div');
    hint.className = 'dk-hint';
    hint.textContent = '点击鼓面敲击 · 空格=底鼓 S=军鼓 J=闭镲 K=开镲 Q/W/E=嗵鼓 R=叮镲 T=碎音镲';
    this.root.appendChild(hint);

    var self = this;
    var scale = Math.min(1, (self.host && self.host.clientWidth || 1080) / 1080,
                               (self.host && self.host.clientHeight || 620) / 620);
    LAYOUT.forEach(function (d) {
      var pad = document.createElement('button');
      pad.className = 'dk-pad' + (d.round ? ' round' : '');
      pad.type = 'button';
      pad.dataset.drum = d.id;
      pad.style.left = d.x + '%';
      pad.style.top = d.y + '%';
      // 尺寸用像素：百分比宽高在无确定高度的祖先里会解析成 0，鼓垫会整体消失。
      // 同时按容器缩放，保证小窗口也放得下。
      var px = Math.max(38, Math.round(d.size * (scale || 1)));
      pad.style.width = px + 'px';
      pad.style.height = px + 'px';
      pad.style.setProperty('--pad-color', d.color);

      // 鼓面高光
      var face = document.createElement('span');
      face.className = 'dk-face';
      pad.appendChild(face);

      // 鼓名
      var name = document.createElement('span');
      name.className = 'dk-name';
      name.textContent = d.label;
      pad.appendChild(name);

      // 键盘提示
      var key = KEYMAP[d.id];
      if (key) {
        var kb = document.createElement('span');
        kb.className = 'dk-key';
        kb.textContent = key === ' ' ? '空格' : key.toUpperCase();
        pad.appendChild(kb);
      }

      self.root.appendChild(pad);
      self.pads.set(d.id, pad);
    });
  };

  DrumKit.prototype.bindPointer = function () {
    var self = this;
    var active = null;

    function padFrom(target) {
      var el = target;
      while (el && el !== self.root) {
        if (el.classList && el.classList.contains('dk-pad')) return el;
        el = el.parentElement;
      }
      return null;
    }

    // 按下位置决定力度：鼓心重、鼓边轻（真实鼓槌的 feel）
    function velocityFromEvent(e, pad) {
      var r = pad.getBoundingClientRect();
      var dx = (e.clientX - r.left) / r.width - 0.5;
      var dy = (e.clientY - r.top) / r.height - 0.5;
      var dist = Math.sqrt(dx * dx + dy * dy) * 2;      // 0=鼓心 1=鼓边
      var base = self.getVelocity();
      // 鼓心 100%，鼓边约 62%
      return U.clamp(base * (1 - dist * 0.38), 0.05, 1);
    }

    this.root.addEventListener('pointerdown', function (e) {
      var pad = padFrom(e.target);
      if (!pad) return;
      e.preventDefault();
      active = pad.dataset.drum;
      self.hit(active, velocityFromEvent(e, pad));
    });

    function onUp() {
      active = null;
      self.releaseAll();
    }
    this.root.addEventListener('pointerup', onUp);
    this.root.addEventListener('pointercancel', onUp);
    window.addEventListener('pointerup', onUp);
  };

  /* 鼓组键盘也走仲裁器：只有「鼓组页」上下文才会被分发到，
     演奏页按 S 不会同时触发军鼓与键盘。 */
  DrumKit.prototype.bindComputerKeys = function () {
    var self = this;
    var down = new Set();

    this._onKeyDown = function (e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // e.target 可能为 null（仲裁器转发时构造的是简化事件对象）
      var el = e.target || null;
      var tag = (el && el.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || (el && el.isContentEditable)) return;

      var code = e.key.toLowerCase();
      var drumId = null;
      for (var id in KEYMAP) {
        if (KEYMAP[id] === code) { drumId = id; break; }
      }
      if (!drumId || down.has(code)) return;
      e.preventDefault();
      down.add(code);
      self.hit(drumId, self.getVelocity());
    };

    this._onKeyUp = function (e) {
      var code = e.key.toLowerCase();
      down.delete(code);
      // 松开时释放所有由该键触发的音（oneshot 鼓会自然结束，无需处理）
      self.releaseAll();
    };

    // 交给仲裁器统一分发（必须 bind 保住 this）
    if (BS.keyArb) {
      BS.keyArb.setDrumsHandler(this._handleKey, this);
    }
  };

  /** 仲裁器调用的按键处理 */
  DrumKit.prototype._handleKey = function (key, e, isKeyUp) {
    var fake = {
      key: key, target: null, repeat: false,
      ctrlKey: false, metaKey: false, altKey: false,
      preventDefault: function () {}, stopPropagation: function () {}
    };
    if (isKeyUp) { this._onKeyUp(fake); return; }
    this._onKeyDown(fake);
  };

  DrumKit.prototype.destroy = function () {
    if (BS.keyArb) BS.keyArb.setDrumsHandler(null);
    if (this._onResize) window.removeEventListener('resize', this._onResize);
  };

  /* ================= 触发 ================= */

  /**
   * 敲击某个鼓。
   *
   * 鼓组是「一个完整声部」：内部按 note（鼓的固定音高）选对应的鼓 buffer。
   * 传 note 而不是音高名，是因为鼓本来就没有音高概念，
   * 固定音高只是「哪个鼓」的标识（36=底鼓、38=军鼓、42=闭镲…）。
   */
  DrumKit.prototype.hit = function (drumId, vel) {
    var rack = this.getRack();
    if (!rack || !rack.has(drumId)) {
      BS.emit('drums:missing', { drumId: drumId, label: DrumKit.labelOf(drumId) });
      return null;
    }
    if (rack.muted) return null;

    // 独立通道直接按 drumId 触发 —— 不经过任何音高换算
    var v = rack.hit(drumId, vel, this.engine.ctx.currentTime);

    // 记录最近一次触发的力度（供 UI 显示 / 调试与自动化测试观察）
    this.lastVel = vel;
    this.lastDrum = drumId;

    this.flash(drumId, vel);
    this.onHit(drumId, vel, rack);
    return v;
  };

  /** 鼓位 → 固定音高（与琴谱里鼓轨的 pitch 一致） */
  DrumKit.prototype.pitchOf = function (drumId) {
    if (this._pitchMap && this._pitchMap[drumId] !== undefined) return this._pitchMap[drumId];
    if (BS.arrangerEditor && BS.arrangerEditor.ID_TO_DRUM_PITCH) {
      return BS.arrangerEditor.ID_TO_DRUM_PITCH[drumId] || 36;
    }
    return (DRUM_PITCH_FALLBACK[drumId] || 36);
  };

  DrumKit.prototype.releaseAll = function () {
    // 鼓都是 oneshot，自然结束；这里清掉可能残留的门限音
    var rack = this.getRack();
    if (rack) rack.allNotesOff();
  };

  DrumKit.prototype.allNotesOff = function () {
    var rack = this.getRack();
    if (rack) rack.allNotesOff();
  };

  /** 视觉反馈：鼓面高亮 */
  DrumKit.prototype.flash = function (drumId, vel) {
    var pad = this.pads.get(drumId);
    if (!pad) return;
    pad.classList.add('hit');
    // 打击强度决定高亮的视觉强度
    pad.style.setProperty('--hit-strength', String(U.clamp(vel, 0, 1)));
    var old = this._flashTimers.get(drumId);
    if (old) clearTimeout(old);
    var self = this;
    this._flashTimers.set(drumId, setTimeout(function () {
      pad.classList.remove('hit');
      self._flashTimers.delete(drumId);
    }, 160));
  };

  /** 谱面播放时外部调用（响哪个亮哪个） */
  DrumKit.prototype.lightUp = function (drumId, vel) {
    this.flash(drumId, vel === undefined ? 0.85 : vel);
  };

  DrumKit.prototype.setVolume = function (v) {
    this.volume = U.clamp(v, 0, 1.5);
  };

  BS.drumKit = DrumKit;
})(typeof window !== 'undefined' ? window : globalThis);

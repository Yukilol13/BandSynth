/* BandSynth · piano-roll.js
 * 下落式谱面（音游 / 动感钢琴）：音符随时间下落，落到琴键上时发声并高亮。
 *
 * ── 设计要点 ──
 * 1. 时间基准：不用 AudioContext.currentTime 做每帧读取（会有抖动），
 *    而是用 performance.now() 计算播放头，音频事件由 Sequencer 用
 *    AudioContext 精确调度（音频层本来就准）。视觉层只要「看起来同步」。
 *
 * 2. 轨道分色：不同轨道给不同颜色，鼓轨单独一套色板。
 *
 * 3. 音符落点判定：note 的y 坐标随时间线性下移，当它到达判定线（琴键顶）
 *    时触发。需要跳过已经「过期」的音符（用户中途才打开谱面）。
 *
 * 4. 性能：音符用绝对定位 + transform，只改 style.transform，
 *    不触发重排。超出视野的音符 display:none（用 class 切换）。
 */
(function (global) {
  'use strict';
  var BS = global.BS;
  var U = BS.util;

  /* 轨道配色：给不同声部/鼓组不同色相，循环取用 */
  var PALETTE = [
    '#4fd1c5', '#f6ad55', '#f56565', '#9f7aea', '#68d391',
    '#63b3ed', '#fc8181', '#f6e05e', '#b794f4', '#4fc3f7',
    '#f687b3', '#68d391'
  ];
  var DRUM_COLORS = {
    kick: '#e0533d', snare: '#4fa3f7', clap: '#f6ad55',
    hihatClosed: '#68d391', hihatOpen: '#9ae6b4', ride: '#f6e05e',
    crash: '#fc8181', tomLow: '#b794f4', tomMid: '#9f7aea',
    tomHigh: '#d6bcfa', rim: '#a0aec0', shaker: '#ed8936'
  };

  /* 判定线到音符顶部距离 / 判定线的像素高度比 —— 控制下落区间的视觉 */
  var HIT_LINE_RATIO = 0.82;     // 判定线在下落区高度的 82% 处（靠下）

  /**
   * @param {object} opts
   *   host        谱面容器（相对定位）
   *   lowNote     谱面最低音（MIDI）
   *   highNote    谱面最高音
   *   getColor    (trackIndex) => cssColor
   *   onNoteHit   (note, track) => void  音符落到线时回调
   */
  function FallingChart(opts) {
    opts = opts || {};
    this.host = opts.host;
    this.lowNote = opts.lowNote === undefined ? 48 : opts.lowNote;
    this.highNote = opts.highNote === undefined ? 84 : opts.highNote;
    this.onNoteHit = opts.onNoteHit || function () {};
    this.getColor = opts.getColor || function (i) { return PALETTE[i % PALETTE.length]; };
    this.isDrumTrack = opts.isDrumTrack || function () { return false; };

    this.notes = [];            // 展平后的音符列表（渲染元素）
    this.active = false;
    this.startWallTime = 0;
    this.startBeat = 0;
    this.lookaheadSec = 2.2;    // 提前多少秒进入视野
    this.scrollSpeed = 1;       // 下落速度倍率
    this.previewSpanSec = 0;    // 静态预览的时间跨度（load 时按曲长设定）
    this._raf = null;
    this._lastBeat = 0;

    this.build();
  }

  FallingChart.PALETTE = PALETTE;
  FallingChart.DRUM_COLORS = DRUM_COLORS;

  FallingChart.prototype.build = function () {
    this.host.innerHTML = '';
    // 注意：不要给 host 本身加 piano-roll class ——
    // .piano-roll 是 position:absolute; inset:0 的内部层样式，
    // 加到宿主上会让整个容器脱离文档流（飞到页面顶部 top:0）。
    // 内部层单独建一个 .piano-roll 元素来承载定位。

    // 下落区（音符在这里下落）
    this.lane = document.createElement('div');
    this.lane.className = 'pr-lane';
    this.host.appendChild(this.lane);

    // 判定线（音符落到这里触发）
    this.hitLine = document.createElement('div');
    this.hitLine.className = 'pr-hitline';
    this.host.appendChild(this.hitLine);

    // 图例
    this.legend = document.createElement('div');
    this.legend.className = 'pr-legend';
    this.host.appendChild(this.legend);
  };

  /** 音高 → 垂直位置比例（0=顶部=最高音，1=底部=最低音） */
  FallingChart.prototype.yRatio = function (pitch) {
    var span = this.highNote - this.lowNote;
    if (span <= 0) return 1;
    var r = (this.highNote - pitch) / span;
    return U.clamp(r, 0, 1);
  };

  /** 静态预览：把所有音符按时间轴横向铺开（未播放时展示全貌）。
   *  播放时改用 _tick 的竖直下落，两种模式互斥。 */
  FallingChart.prototype.preview = function () {
    var laneW = this.lane.clientWidth || 1;
    var span = Math.max(0.001, this.previewSpanSec);
    this.lane.classList.add('preview');
    var self = this;
    this.notes.forEach(function (n) {
      var x = (n.time / span) * laneW;
      var w = Math.max(3, (n.dur / span) * laneW);
      n.el.classList.add('pv');
      n.el.style.display = '';
      // 纵向按音高分行（鼓轨已在上方按鼓道定位，无需再算音高）
      var row = n.isDrum
        ? (parseFloat(n.el.dataset.lane) || n.el.dataset.lane || 0.5)
        : self.yRatio(n.note.pitch);
      n.el.style.left = '0%';
      n.el.style.top = (row * 100) + '%';
      n.el.style.width = w + 'px';
      n.el.style.marginTop = '-2px';
      n.el.style.transform = 'translateX(' + x + 'px)';
    });
  };

  FallingChart.prototype.endPreview = function () {
    this.lane.classList.remove('preview');
    this.notes.forEach(function (n) {
      n.el.classList.remove('pv');
      n.el.style.width = '100%';
      n.el.style.top = '0';
      n.el.style.marginTop = '';
      n.el.style.transform = '';
    });
  };

  /** 从歌曲构建谱面音符元素 */
  FallingChart.prototype.load = function (song) {
    this.song = song;
    this.notes = [];
    this.lane.innerHTML = '';
    this.legend.innerHTML = '';

    if (!song) return;

    var self = this;
    // beatToSec(song, beat) 是两参函数，不能提前求值
    var toSec = function (beat) { return BS.score.beatToSec(song, beat); };
    var legendItems = [];

    song.tracks.forEach(function (track, ti) {
      var isDrum = self.isDrumTrack(track, ti);
      var color = isDrum
        ? (DRUM_COLORS[track.drum] || DRUM_COLORS.snare)
        : self.getColor(ti);

      // 图例
      legendItems.push({ name: track.name, color: color, isDrum: isDrum });

      track.notes.forEach(function (n) {
        if (n.mute) return;
        var el = document.createElement('div');
        el.className = 'pr-note' + (isDrum ? ' drum' : '');
        // 音符条长度按时值（相对整首歌的缩放，让长短可见）
        var lenSec = n.len * 60 / song.bpm;
        el.style.height = '4px';     // 基本厚度，后续按需

        // 鼓：按鼓ID 定位到鼓道，而不是音高
        var laneRatio = self.yRatio(n.pitch);
        if (isDrum) {
          // 鼓轨：纵向按鼓位排布（横向仍是时间轴）
          var drumId = track.drum || inferDrumFromPitch(n.pitch);
          el.dataset.drum = drumId;
          laneRatio = drumLaneRatio(drumId);
          el.classList.add('drum-' + drumId);
        }
        // 记下纵向位置：静态预览要按它分行
        el.dataset.lane = String(laneRatio);
        el.style.left = (laneRatio * 100) + '%';

        el.style.background = color;
        el.style.setProperty('--note-color', color);
        el.dataset.ti = ti;
        self.lane.appendChild(el);

        self.notes.push({
          el: el,
          note: n,
          track: track,
          trackIndex: ti,
          isDrum: isDrum,
          time: toSec(n.beat) + (n.micro || 0),
          dur: lenSec,
          fired: false,
          // 每个音符在时间轴上的位置（秒）
          y: 0
        });
      });
    });

    // 构建图例
    legendItems.forEach(function (it) {
      var chip = document.createElement('span');
      chip.className = 'pr-chip' + (it.isDrum ? ' drum' : '');
      var dot = document.createElement('i');
      dot.style.background = it.color;
      chip.appendChild(dot);
      chip.appendChild(document.createTextNode(it.name));
      self.legend.appendChild(chip);
    });

    this.sortNotes();

    // 静态预览：未播放时横向铺开全曲，播放时再切回下落模式
    var total = song ? (BS.score.totalSec(song) || 1) : 1;
    this.previewSpanSec = Math.max(4, total);
    this.preview();
  };

  /** 鼓 ID → 鼓道垂直位置（把鼓铺在谱面左侧，按鼓组布局） */
  function drumLaneRatio(drumId) {
    var order = [
      'crash', 'hihatOpen', 'ride', 'hihatClosed',
      'tomHigh', 'snare', 'tomMid', 'rim', 'tomLow', 'shaker', 'clap', 'kick'
    ];
    var idx = order.indexOf(drumId);
    if (idx < 0) idx = order.indexOf('snare');
    return (idx + 0.5) / order.length;
  }
  FallingChart.drumLaneRatio = drumLaneRatio;

  /** 从旧谱的 pitch 反推鼓ID（兼容已有鼓谱 JSON：鼓用固定 MIDI 音高） */
  function inferDrumFromPitch(pitch) {
    var map = {
      36: 'kick', 37: 'rim', 38: 'snare', 39: 'clap',
      42: 'hihatClosed', 45: 'tomLow', 46: 'hihatOpen',
      48: 'tomMid', 49: 'crash', 50: 'tomHigh', 51: 'ride', 70: 'shaker'
    };
    return map[pitch] || 'snare';
  }
  FallingChart.inferDrumFromPitch = inferDrumFromPitch;

  FallingChart.prototype.sortNotes = function () {
    this.notes.sort(function (a, b) { return a.time - b.time; });
  };

  /** 计算某音符在「提前 X 秒」内的下落位置（返回 0~1，1=到判定线） */
  FallingChart.prototype.progress = function (n, nowSec) {
    var remain = n.time - nowSec;          // >0 表示还没到
    // remain 从 lookaheadSec → 0，对应 y 从 0% → 100%（判定线）
    var p = 1 - remain / this.lookaheadSec;
    return U.clamp(p, -0.2, 1.2);
  };

  /**
   * 开始播放谱面。
   * @param fromSec 从歌曲的第几秒开始（接续播放用）
   */
  FallingChart.prototype.start = function (fromSec) {
    this.stop();
    this.startWallTime = performance.now();
    this.fromSec = fromSec || 0;
    this._lastBeat = this.fromSec;
    this.active = true;
    this.endPreview();

    // 重置 fired 状态：把早于 fromSec 的音符标为已触发（跳过）
    var self = this;
    this.notes.forEach(function (n) {
      n.fired = n.time < this.fromSec;
      n.el.classList.remove('fired');
    }, this);

    this._tick();
  };

  FallingChart.prototype.stop = function () {
    this.active = false;
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
    // 清除所有高亮
    this.notes.forEach(function (n) { n.el.classList.remove('fired', 'now'); });
    // 回到静态预览，让用户看清全曲
    this.preview();
  };

  /** 当前播放头（秒，从歌曲起点算） */
  FallingChart.prototype.headSec = function () {
    if (!this.active) return this._lastBeat;
    return this.fromSec + (performance.now() - this.startWallTime) / 1000 * this.scrollSpeed;
  };

  FallingChart.prototype._tick = function () {
    if (!this.active) return;
    var self = this;
    var now = this.headSec();
    var laneH = this.lane.clientHeight || 1;
    var hitY = laneH * HIT_LINE_RATIO;

    // 遍历音符：超出视野的隐藏，进入视野的显示并定位，判定线触发的触发
    for (var i = 0; i < this.notes.length; i++) {
      var n = this.notes[i];
      var p = this.progress(n, now);
      // p ∈ [0,1] 在视野内；<0 还没进来（上方）；>1 已过线
      if (p < -0.05) {
        if (n.el.style.display !== 'none') n.el.style.display = 'none';
        continue;
      }
      if (n.el.style.display === 'none') n.el.style.display = '';

      // y：从 lane 顶部 0% 线性到判定线 hitY
      var y = p * hitY;
      n.el.style.transform = 'translateY(' + y + 'px)';

      // 判定：刚越过线且未触发
      if (!n.fired && p >= 1) {
        n.fired = true;
        n.el.classList.add('fired');
        this.onNoteHit(n.note, n.track, n.isDrum);
      }
      // 刚过的音符高亮一小会（现在）
      if (n.fired && Math.abs(p - 1) < 0.03) {
        n.el.classList.add('now');
      } else if (p - 1 > 0.06) {
        n.el.classList.remove('now');
      }
      // 远过去的音符淡出移除
      if (p > 1.35) {
        if (n.el.style.display !== 'none') n.el.style.display = 'none';
      }
    }

    this._lastBeat = now;
    this._raf = requestAnimationFrame(function () { self._tick(); });
  };

  /** 跳转到某个时间（不触发音符，仅移动谱面） */
  FallingChart.prototype.seek = function (sec) {
    this.stop();
    this._lastBeat = sec;
  };

  FallingChart.prototype.destroy = function () {
    this.stop();
    this.host.innerHTML = '';
  };

  BS.pianoRoll = FallingChart;
})(typeof window !== 'undefined' ? window : globalThis);

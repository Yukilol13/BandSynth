/* BandSynth · arranger.js
 * 编曲引擎：可视化编曲的数据模型与编辑能力。
 *
 * ── 与 piano-roll.js 的区别 ──
 * piano-roll 是「演奏视角」：音符从上方落下砸到琴键上，看的是效果。
 * arranger 是「编辑视角」：横轴=时间、纵轴=音高，像 DAW 的钢琴卷帘，
 *   音符块可以拖动、拉伸、框选，是写歌的地方。
 *
 * ── 数据模型 ──
 * Song（与 score.js 兼容）之外，编曲额外维护：
 *   · arranger.lengthBars  —— 编曲长度（小节数），可任意扩展
 *   · arranger.key / scale  —— 调性，用于和弦库筛选
 *   · track.role            —— 'drum' | 'synth'，决定纵轴是鼓位还是音高
 *   · track.toneId          —— 该轨使用的音色（内置 id 或库中预设 id）
 *   · track.partIndex       —— 绑定的声部
 *
 * 音符精度：最小 1/32 拍。beat 单位仍是「拍」，1/32 拍 = 0.03125。
 * 存的是 beat 浮点数，量化在编辑操作时做。
 */
(function (global) {
  'use strict';
  var BS = global.BS;
  var U = BS.util;

  /* ================= 精度与常量 ================= */

  var TICK = 1 / 32;              // 最小编辑单位：1/32 拍
  var GRID_OPTIONS = [
    { v: 1 / 4, label: '1/4' }, { v: 1 / 2, label: '1/8' },
    { v: 3 / 8, label: '3/16' }, { v: 1 / 4 * 3, label: '3/4' },
    { v: 1, label: '1/4 拍' }, { v: 2, label: '1/2 拍' }
  ];
  // 修正：明确的分数
  GRID_OPTIONS = [
    { v: 1, label: '1 拍' },
    { v: 1 / 2, label: '1/2' },
    { v: 1 / 4, label: '1/4' },
    { v: 1 / 8, label: '1/8' },
    { v: 1 / 16, label: '1/16' },
    { v: 1 / 32, label: '1/32' }
  ];

  var TRACK_COLORS = [
    '#4fd1c5', '#f6ad55', '#f56565', '#9f7aea', '#68d391',
    '#63b3ed', '#fc8181', '#f6e05e', '#b794f4', '#4fc3f7',
    '#f687b3', '#a3e635', '#fda4af', '#7dd3fc', '#d9f99d'
  ];

  /* ================= 和弦库 ================= */
  /* 品质 → 音程（半音） */
  var CHORD_QUALITIES = {
    'maj':   { name: '大三', iv: [0, 4, 7], symbol: '' },
    'min':   { name: '小三', iv: [0, 3, 7], symbol: 'm' },
    'dim':   { name: '减三', iv: [0, 3, 6], symbol: 'dim' },
    'aug':   { name: '增三', iv: [0, 4, 8], symbol: 'aug' },
    'maj7':  { name: '大七', iv: [0, 4, 7, 11], symbol: 'maj7' },
    'min7':  { name: '小七', iv: [0, 3, 7, 10], symbol: 'm7' },
    'dom7':  { name: '属七', iv: [0, 4, 7, 10], symbol: '7' },
    'sus2':  { name: '挂二', iv: [0, 2, 7], symbol: 'sus2' },
    'sus4':  { name: '挂四', iv: [0, 5, 7], symbol: 'sus4' },
    'maj9':  { name: '大九', iv: [0, 4, 7, 11, 14], symbol: 'maj9' },
    'min9':  { name: '小九', iv: [0, 3, 7, 10, 14], symbol: 'm9' },
    'add9':  { name: '加九', iv: [0, 4, 7, 14], symbol: 'add9' },
    '6':     { name: '大六', iv: [0, 4, 7, 9], symbol: '6' },
    'min6':  { name: '小六', iv: [0, 3, 7, 9], symbol: 'm6' }
  };

  /* 各调的音阶（半音偏移） */
  var SCALES = {
    major:     { name: '大调', iv: [0, 2, 4, 5, 7, 9, 11] },
    minor:     { name: '自然小调', iv: [0, 2, 3, 5, 7, 8, 10] },
    harmonic:  { name: '和声小调', iv: [0, 2, 3, 5, 7, 8, 11] },
    dorian:    { name: '多利亚', iv: [0, 2, 3, 5, 7, 9, 10] },
    mixolydian:{ name: '混合利底亚', iv: [0, 2, 4, 5, 7, 9, 10] },
    phrygian:  { name: '弗里几亚', iv: [0, 1, 3, 5, 7, 8, 10] },
    lydian:    { name: '利底亚', iv: [0, 2, 4, 6, 7, 9, 11] },
    pentatonic:{ name: '五声', iv: [0, 2, 4, 7, 9] },
    minorPent: { name: '小五声', iv: [0, 3, 5, 7, 10] },
    blues:     { name: '布鲁斯', iv: [0, 3, 5, 6, 7, 10] }
  };

  var NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  /* ================= 节奏型库 =================
   * 位置/时值都用「小节内的比例」rb / rl（0~1），不是固定拍数 ——
   * 这样 3/4、6/8、5/4 也能正确铺满；旧写法把「全拍」写死成 1 拍，
   * 在 4/4 里只得到一个四分音符。
   *   arp  : 琶音时每个音取和弦的第几个音（循环）。没有 arp 就是柱式和弦。
   *   hits : 鼓型（可多个鼓位），只有鼓轨使用。
   */
  function grid16(n, len) {
    var a = [];
    for (var i = 0; i < n; i++) a.push({ rb: i / n, rl: len === undefined ? 1 / n : len });
    return a;
  }

  var PATTERNS = [
    { id: 'full',      name: '整小节',     notes: [{ rb: 0, rl: 1 }] },
    { id: 'half',      name: '半小节',     notes: [{ rb: 0, rl: 0.5 }] },
    { id: 'quarter2',  name: '两个长音',   notes: [{ rb: 0, rl: 0.5 }, { rb: 0.5, rl: 0.5 }] },
    { id: 'quarter4',  name: '四分柱式',   notes: grid16(4, 0.25) },
    { id: 'eighth',    name: '八分柱式',   notes: grid16(8, 0.125) },
    { id: 'eighthOff', name: '八分反拍',   notes: [{ rb: 0.125, rl: 0.125 }, { rb: 0.375, rl: 0.125 },
                                                   { rb: 0.625, rl: 0.125 }, { rb: 0.875, rl: 0.125 }] },
    { id: 'pulse16',   name: '十六分柱式', notes: grid16(16, 0.0625) },
    { id: 'arp8',      name: '八分琶音',   notes: grid16(8, 0.125), arp: [0, 1, 2, 1] },
    { id: 'arpUp',     name: '上行琶音',   notes: grid16(4, 0.25), arp: [0, 1, 2, 3] },
    { id: 'syncop',    name: '切分',       notes: [{ rb: 0, rl: 0.1875 }, { rb: 0.25, rl: 0.125 }, { rb: 0.625, rl: 0.125 }] },
    { id: 'triplet',   name: '三连音',     notes: [{ rb: 0, rl: 1 / 3 }, { rb: 1 / 3, rl: 1 / 3 }, { rb: 2 / 3, rl: 1 / 3 }] },
    { id: 'swing',     name: '摇摆八分',   notes: [{ rb: 0, rl: 1 / 6 + 1 / 12 }, { rb: 2 / 3, rl: 1 / 3 }] },
    { id: 'dot8',      name: '附点八分',   notes: [{ rb: 0, rl: 0.1875 }, { rb: 0.1875, rl: 0.125 },
                                                   { rb: 0.375, rl: 0.125 }, { rb: 0.5, rl: 0.1875 },
                                                   { rb: 0.6875, rl: 0.125 }, { rb: 0.875, rl: 0.125 }] },
    { id: 'rest',      name: '休止（清空）', notes: [] }
  ];

  /* ================= 低音声部（role: 'bass'）模板 =================
   * 和和弦柱式最大的区别：**每个音节只发一个低音**，从和弦音里挑一个，
   * 再落到低音区（C2 附近）——不是把整个和弦砸下去。
   *   tone: 取和弦的第几个音（0 根音 / 1 三音 / 2 五音 / 3 七音…）
   *   oct : 相对低音区的八度偏移（八度跳进用）
   * 时值同样用 rb / rl 比例，所以 3/4、6/8 也能正确铺满。
   */
  function bassHits(n, len, tones) {
    var a = [];
    for (var i = 0; i < n; i++) {
      a.push({ rb: i / n, rl: len === undefined ? 1 / n : len, tone: tones ? tones[i % tones.length] : 0 });
    }
    return a;
  }

  var BASS_PATTERNS = [
    { id: 'b_hold',    name: '整小节根音',   notes: [{ rb: 0, rl: 1, tone: 0 }] },
    { id: 'b_half',    name: '两拍根音',     notes: [{ rb: 0, rl: 0.5, tone: 0 }, { rb: 0.5, rl: 0.5, tone: 0 }] },
    { id: 'b_quarter', name: '四分根音',     notes: bassHits(4, 0.25) },
    { id: 'b_eighth',  name: '八分根音',     notes: bassHits(8, 0.125) },
    { id: 'b_5th',     name: '根音 + 五度',  notes: [{ rb: 0, rl: 0.5, tone: 0 }, { rb: 0.5, rl: 0.5, tone: 2 }] },
    { id: 'b_oct',     name: '根音八度交替', notes: [
        { rb: 0,    rl: 0.25, tone: 0, oct: 0 }, { rb: 0.25, rl: 0.25, tone: 0, oct: 1 },
        { rb: 0.5,  rl: 0.25, tone: 0, oct: 0 }, { rb: 0.75, rl: 0.25, tone: 0, oct: 1 }] },
    { id: 'b_walk',    name: '走动低音',     notes: [
        { rb: 0,   rl: 0.25, tone: 0 }, { rb: 0.25, rl: 0.25, tone: 1 },
        { rb: 0.5, rl: 0.25, tone: 2 }, { rb: 0.75, rl: 0.25, tone: 0, oct: 1 }] },
    { id: 'b_sync',    name: '切分低音',     notes: [
        { rb: 0, rl: 0.375, tone: 0 }, { rb: 0.5, rl: 0.25, tone: 0 }, { rb: 0.75, rl: 0.25, tone: 2 }] },
    { id: 'b_pump',    name: '八分推动',     notes: bassHits(8, 0.125, [0, 0, 2, 0]) },
    { id: 'b_rest',    name: '休止（清空）', notes: [] }
  ];

  /**
   * 和弦 → 低音区音高。
   * 取和弦第 tone 个音的音名，落到 36(B1)~47(B2) 这一档；oct 用于八度跳进。
   */
  function bassPitch(chord, tone, oct) {
    var idx = ((tone || 0) % chord.length + chord.length) % chord.length;
    var pc = ((chord[idx] % 12) + 12) % 12;
    var p = 36 + pc;
    if (p > 47) p -= 12;
    p += (oct || 0) * 12;
    return Math.max(0, Math.min(127, p));
  }

  /* 鼓型库：hits 里每一项都是 { rb, rl, drum }。
   * 鼓轨以前复用和弦节奏型、音高取 chordPitches[0]（C3=48 正好是中嗵），
   * 敲出来永远是中嗵 —— 所以鼓型必须独立定义到具体鼓位。 */
  var DRUM_PATTERNS = [
    { id: 'd_four',    name: '四踩',       hits: [
        { rb: 0,    rl: 0.125, drum: 'kick' }, { rb: 0.25, rl: 0.0625, drum: 'hihatClosed' },
        { rb: 0.5,  rl: 0.125, drum: 'kick' }, { rb: 0.5,  rl: 0.125, drum: 'snare' },
        { rb: 0.75, rl: 0.0625, drum: 'hihatClosed' },
        { rb: 1,    rl: 0.125, drum: 'kick' }] },
    { id: 'd_backbeat', name: '反拍军鼓',   hits: [
        { rb: 0,    rl: 0.125, drum: 'kick' },
        { rb: 0.25, rl: 0.0625, drum: 'hihatClosed' },
        { rb: 0.5,  rl: 0.125, drum: 'snare' },
        { rb: 0.75, rl: 0.0625, drum: 'hihatClosed' },
        { rb: 1,    rl: 0.125, drum: 'kick' }] },
    { id: 'd_hat16',   name: '十六分踩镲', hits: (function () {
        var a = [];
        for (var i = 0; i < 16; i++) a.push({ rb: i / 16, rl: 1 / 32, drum: i % 4 === 2 ? 'hihatOpen' : 'hihatClosed' });
        return a;
      })() },
    { id: 'd_rock',    name: '摇滚基本',   hits: [
        { rb: 0, rl: 0.125, drum: 'kick' }, { rb: 0, rl: 0.125, drum: 'hihatClosed' },
        { rb: 0.25, rl: 0.0625, drum: 'hihatClosed' },
        { rb: 0.5, rl: 0.125, drum: 'snare' }, { rb: 0.5, rl: 0.125, drum: 'hihatClosed' },
        { rb: 0.75, rl: 0.0625, drum: 'hihatClosed' },
        { rb: 0.75, rl: 0.0625, drum: 'kick' },
        { rb: 1, rl: 0.125, drum: 'snare' }] },
    { id: 'd_break',   name: '断奏收尾',   hits: [
        { rb: 0, rl: 0.125, drum: 'kick' }, { rb: 0.25, rl: 0.0625, drum: 'snare' },
        { rb: 0.5, rl: 0.125, drum: 'kick' }, { rb: 0.75, rl: 0.125, drum: 'tomHigh' },
        { rb: 0.875, rl: 0.0625, drum: 'tomMid' }, { rb: 1, rl: 0.125, drum: 'crash' }] },
    { id: 'd_rest',    name: '清空',       hits: [] }
  ];

  /* 常用和弦进行（级数，1 起）。用当前调性的音阶实时算出和弦。 */
  var PROGRESSIONS = [
    { id: 'p1564', name: '1-5-6-4 流行',  degrees: [1, 5, 6, 4] },
    { id: 'p4536', name: '4-5-3-6 王道',  degrees: [4, 5, 3, 6] },
    { id: 'p1645', name: '1-6-4-5 经典',  degrees: [1, 6, 4, 5] },
    { id: 'p251',  name: '2-5-1 终止式',  degrees: [2, 5, 1, 1] },
    { id: 'p1345', name: '1-3-4-5 上行',  degrees: [1, 3, 4, 5] }
  ];

  /* 鼓位纵轴顺序（从上到下）。界面与「鼓轨纵向移动」共用这一份。 */
  var DRUM_ORDER = [
    'crash', 'hihatOpen', 'ride', 'hihatClosed',
    'tomHigh', 'snare', 'tomMid', 'rim', 'tomLow', 'shaker', 'clap', 'kick'
  ];
  var DRUM_LABEL = {
    crash: '碎音镲', hihatOpen: '开镲', ride: '叮镲', hihatClosed: '闭镲',
    tomHigh: '高嗵', snare: '军鼓', tomMid: '中嗵', rim: '边击',
    tomLow: '低嗵', shaker: '沙锤', clap: '拍手', kick: '底鼓'
  };

  /* 鼓位 id ↔ 音高（与 arranger-ui 共用一份真值） */
  var DRUM_PITCH = {
    kick: 36, rim: 37, snare: 38, clap: 39, hihatClosed: 42,
    tomLow: 45, hihatOpen: 46, tomMid: 48, crash: 49,
    tomHigh: 50, ride: 51, shaker: 70
  };

  /* ================= 编曲对象 ================= */

  /**
   * @param {object} opts
   *   song        底层 song（与 score.js 兼容）
   *   onChange    数据变化回调（驱动界面重绘）
   */
  function Arranger(opts) {
    opts = opts || {};
    this.song = opts.song || null;
    this.onChange = opts.onChange || function () {};

    // 编曲专有状态
    this.lengthBars = opts.lengthBars || 16;    // 编曲长度（小节）
    this.key = opts.key || 'C';                 // 主音
    this.scale = opts.scale || 'major';          // 调式
    this.grid = opts.grid || 1 / 16;             // 吸附精度
    this.snap = opts.snap !== false;             // 是否吸附

    /* 目标小节（0 起）：填充和弦/录制落点的定位基准。
       之前用的是「播放头」，但播放头只在播放中存在，一停止就被清空，
       导致「填充当前小节」永远填第 1 小节。现在由界面上的小节标尺直接设定。 */
    this.targetBar = 0;

    this.selection = new Set();                 // 选中的音符 id
    this.activeTrackIndex = 0;                  // 当前编辑的轨

    /* 和弦轨：每小节一格 { bar, root, quality }。
       这是「按小节铺和弦」的数据形态，模板填充与和弦条显示都以它为准。 */
    this.chords = [];

    /* 循环区间（小节）：{ start, end }，end 不含；null 表示不循环。
       循环练习/录制的落点都在区间内。 */
    this.loop = null;

    /* 段落标记：{ bar, name }，如「主歌」「副歌」。
       编排时用来对齐段落，也方便按段落选小节。 */
    this.sections = [];

    this.listeners = {};

    /* 撤销栈：整份快照。编曲规模（几十轨 × 几百音）下快照足够便宜，
       而且天然支持「填充小节」「删除小节」这种跨轨批量操作。 */
    this._undo = [];
    this._redo = [];
    this._undoLimit = 80;
  }

  Arranger.TICK = TICK;
  Arranger.PATTERNS = PATTERNS;
  Arranger.DRUM_PATTERNS = DRUM_PATTERNS;
  Arranger.PROGRESSIONS = PROGRESSIONS;
  Arranger.DRUM_PITCH = DRUM_PITCH;
  Arranger.CHORD_QUALITIES = CHORD_QUALITIES;
  Arranger.SCALES = SCALES;
  Arranger.TRACK_COLORS = TRACK_COLORS;
  Arranger.GRID_OPTIONS = GRID_OPTIONS;

  /* ---------------- 事件 ---------------- */
  Arranger.prototype.on = function (evt, fn) {
    (this.listeners[evt] = this.listeners[evt] || []).push(fn);
  };
  Arranger.prototype.emit = function (evt, data) {
    (this.listeners[evt] || []).forEach(function (fn) { fn(data); });
    if (evt !== 'change') this.onChange(evt, data);
  };
  Arranger.prototype.changed = function (reason) {
    this.emit('change', reason || 'edit');
  };

  /* ---------------- 基础存取 ---------------- */

  Arranger.prototype.getSong = function () { return this.song; };

  Arranger.prototype.setSong = function (song) {
    this.song = song;
    this.selection.clear();
    this.targetBar = 0;
    this.changed('song');
  };

  Arranger.prototype.getTracks = function () {
    return this.song && this.song.tracks ? this.song.tracks : [];
  };

  Arranger.prototype.trackCount = function () { return this.getTracks().length; };

  Arranger.prototype.getTrack = function (i) { return this.getTracks()[i] || null; };

  Arranger.prototype.getActiveTrack = function () {
    return this.getTrack(this.activeTrackIndex);
  };

  Arranger.prototype.setActiveTrack = function (i) {
    if (i < 0 || i >= this.trackCount()) return;
    var same = this.activeTrackIndex === i;
    this.activeTrackIndex = i;
    this.emit('track:select', i);
    /* 换激活轨要立刻带动「铺满」相关控件（模板下拉、和弦、填充按钮文案），
       所以除了事件还要走一次 changed → 上层重新渲染。 */
    if (!same) this.changed('track:active');
  };

  /** 轨名像不像低音声部（导入旧曲谱时用来判断 role） */
  Arranger.prototype.isBassName = function (track) {
    var n = String((track && track.name) || '').toLowerCase();
    return /bass|贝斯|贝司|低音|sub\s*bass/.test(n);
  };

  /** 小节长度（拍） */
  Arranger.prototype.barBeats = function () {
    return this.song ? this.song.timeSignature[0] : 4;
  };

  /** 编曲总拍数 */
  Arranger.prototype.totalBeats = function () {
    return this.lengthBars * this.barBeats();
  };

  /** 编曲总小节数（含轨道实际内容的最大小节） */
  Arranger.prototype.contentBars = function () {
    var max = 0;
    var self = this;
    this.getTracks().forEach(function (t) {
      t.notes.forEach(function (n) {
        var end = n.beat + (n.len || 0);
        if (end > max) max = end;
      });
    });
    void self;
    return Math.ceil(max / self.barBeats());
  };

  /**
   * 设定目标小节（0 起）。填充和弦模版、录制落点都以它为准。
   * 越界自动夹到 [0, lengthBars-1]。
   */
  Arranger.prototype.setTargetBar = function (bar) {
    var b = U.clamp(Math.round(bar || 0), 0, Math.max(0, this.lengthBars - 1));
    if (b === this.targetBar) return b;
    this.targetBar = b;
    this.changed('barsel');
    return b;
  };

  /** 目标小节起点（拍） */
  Arranger.prototype.targetBeat = function () {
    return this.targetBar * this.barBeats();
  };

  /* ---------------- 量化 ---------------- */

  Arranger.prototype.quantize = function (beat) {
    if (!this.snap) return beat;
    var g = this.grid || TICK;
    return Math.round(beat / g) * g;
  };

  /** 吸附到 1/32 整数倍（最小单位硬约束） */
  Arranger.prototype.snapTick = function (beat) {
    return Math.round(beat / TICK) * TICK;
  };

  /* ---------------- 音轨管理 ---------------- */

  /**
   * 新增音轨。
   * @param {object} opts
   *   name     轨名
   *   role     'drum' | 'synth'
   *   toneId   内置音色 id 或库预设 id
   *   partIndex 绑定的声部索引
   */
  Arranger.prototype.addTrack = function (opts) {
    opts = opts || {};
    if (!this.song) return null;
    var tracks = this.song.tracks;
    var role = opts.role || 'synth';
    var color = TRACK_COLORS[tracks.length % TRACK_COLORS.length];
    var track = {
      name: opts.name || ('音轨 ' + (tracks.length + 1)),
      part: opts.partIndex === undefined ? tracks.length : opts.partIndex,
      notes: [],
      volume: opts.volume === undefined ? 0.85 : opts.volume,
      pan: opts.pan || 0,
      muted: false,
      solo: false,
      // 编曲专有
      role: role,
      toneId: opts.toneId || null,
      color: opts.color || color
    };
    tracks.push(track);
    this.activeTrackIndex = tracks.length - 1;
    this.emit('track:add', { index: tracks.length - 1, track: track });
    this.changed('track:add');
    return track;
  };

  Arranger.prototype.removeTrack = function (index) {
    var tracks = this.getTracks();
    if (index < 0 || index >= tracks.length) return false;
    var removed = tracks.splice(index, 1)[0];
    // 清掉指向它的选择
    this.selection.forEach(function (id) {
      if (removed.notes.some(function (n) { return n.id === id; })) this.selection.delete(id);
    }, this);
    if (this.activeTrackIndex >= tracks.length) this.activeTrackIndex = Math.max(0, tracks.length - 1);
    this.emit('track:remove', { index: index, track: removed });
    this.changed('track:remove');
    return true;
  };

  Arranger.prototype.updateTrack = function (index, patch) {
    var t = this.getTrack(index);
    if (!t) return null;
    Object.assign(t, patch);
    this.changed('track:update');
    return t;
  };

  Arranger.prototype.moveTrack = function (from, to) {
    var tracks = this.getTracks();
    if (from < 0 || from >= tracks.length) return false;
    to = U.clamp(to, 0, tracks.length - 1);
    var t = tracks.splice(from, 1)[0];
    tracks.splice(to, 0, t);
    this.activeTrackIndex = to;
    this.changed('track:move');
    return true;
  };

  /* ---------------- 撤销 / 重做 ---------------- */

  Arranger.prototype.canUndo = function () { return this._undo.length > 0; };
  Arranger.prototype.canRedo = function () { return this._redo.length > 0; };
  Arranger.prototype.undoLabel = function () {
    var e = this._undo[this._undo.length - 1];
    return e ? e.label : '';
  };
  Arranger.prototype.redoLabel = function () {
    var e = this._redo[this._redo.length - 1];
    return e ? e.label : '';
  };

  /**
   * 压一份快照（在**修改之前**调用）。
   * 拖动这类连续操作由界面在 pointerdown 时压一次，pointerup 后不再压。
   */
  Arranger.prototype.pushUndo = function (label) {
    this._undo.push({ label: label || '编辑', snap: this.snapshot() });
    if (this._undo.length > this._undoLimit) this._undo.shift();
    this._redo.length = 0;
    this.emit('history');
  };

  Arranger.prototype.undo = function () {
    if (!this._undo.length) return false;
    var e = this._undo.pop();
    this._redo.push({ label: e.label, snap: this.snapshot() });
    this.restore(e.snap);
    this.emit('history');
    this.emit('undo', e.label);
    return true;
  };

  Arranger.prototype.redo = function () {
    if (!this._redo.length) return false;
    var e = this._redo.pop();
    this._undo.push({ label: e.label, snap: this.snapshot() });
    this.restore(e.snap);
    this.emit('history');
    this.emit('redo', e.label);
    return true;
  };

  Arranger.prototype.clearHistory = function () {
    this._undo.length = 0;
    this._redo.length = 0;
    this.emit('history');
  };

  /* ---------------- 音符块操作 ---------------- */

  function noteId() { return U.uid('n'); }

  /**
   * 添加音符。
   * @param trackIndex
   * @param beat     起始拍
   * @param len      时长（拍）
   * @param pitch    音高（合成器）或鼓位 id（鼓轨）
   * @param vel
   */
  Arranger.prototype.addNote = function (trackIndex, beat, len, pitch, vel) {
    var t = this.getTrack(trackIndex);
    if (!t) return null;
    var b = this.snapTick(Math.max(0, beat));
    var l = this.snapTick(Math.max(TICK, len));
    var n = {
      id: noteId(),
      beat: b,
      len: l,
      pitch: pitch,
      vel: vel === undefined ? 0.85 : vel
    };
    t.notes.push(n);
    t.notes.sort(function (x, y) { return x.beat - y.beat; });
    this.emit('note:add', { track: trackIndex, note: n });
    this.changed('note:add');
    return n;
  };

  Arranger.prototype.removeNote = function (trackIndex, id) {
    var t = this.getTrack(trackIndex);
    if (!t) return false;
    var i = t.notes.findIndex(function (n) { return n.id === id; });
    if (i < 0) return false;
    t.notes.splice(i, 1);
    this.selection.delete(id);
    this.changed('note:remove');
    return true;
  };

  Arranger.prototype.updateNote = function (trackIndex, id, patch) {
    var t = this.getTrack(trackIndex);
    if (!t) return null;
    var n = t.notes.find(function (x) { return x.id === id; });
    if (!n) return null;
    Object.assign(n, patch);
    n.beat = this.snapTick(Math.max(0, n.beat));
    n.len = this.snapTick(Math.max(TICK, n.len));
    t.notes.sort(function (x, y) { return x.beat - y.beat; });
    this.changed('note:update');
    return n;
  };

  /** 移动音符（可跨轨，跨轨时改 pitch 语义） */
  Arranger.prototype.moveNote = function (fromTrack, id, toTrack, beat, pitch) {
    var tf = this.getTrack(fromTrack);
    var tt = this.getTrack(toTrack);
    if (!tf || !tt) return null;
    var i = tf.notes.findIndex(function (n) { return n.id === id; });
    if (i < 0) return null;
    var n = tf.notes.splice(i, 1)[0];
    n.beat = this.snapTick(Math.max(0, beat));
    if (pitch !== undefined && pitch !== null) n.pitch = pitch;
    tt.notes.push(n);
    tt.notes.sort(function (x, y) { return x.beat - y.beat; });
    this.changed('note:move');
    return n;
  };

  /** 删除选中的音符 */
  Arranger.prototype.deleteSelection = function () {
    var count = 0;
    var self = this;
    this.getTracks().forEach(function (t, ti) {
      var before = t.notes.length;
      t.notes = t.notes.filter(function (n) { return !self.selection.has(n.id); });
      count += before - t.notes.length;
    });
    this.selection.clear();
    if (count) this.changed('note:delete');
    return count;
  };

  Arranger.prototype.select = function (id, add) {
    if (!add) this.selection.clear();
    this.selection.add(id);
    this.emit('selection:change', this.selection);
  };

  Arranger.prototype.clearSelection = function () {
    this.selection.clear();
    this.emit('selection:change', this.selection);
  };

  Arranger.prototype.isSelected = function (id) { return this.selection.has(id); };

  /** 全选当前轨 */
  Arranger.prototype.selectAllInTrack = function (trackIndex) {
    var t = this.getTrack(trackIndex);
    if (!t) return;
    t.notes.forEach(function (n) { this.selection.add(n.id); }, this);
    this.emit('selection:change', this.selection);
  };

  /* ---------------- 选区批量操作 ---------------- */

  /** 所有选中音符的位置：[{ ti, track, note }] */
  Arranger.prototype.selectedLocations = function () {
    var out = [];
    var sel = this.selection;
    this.getTracks().forEach(function (t, ti) {
      t.notes.forEach(function (n) { if (sel.has(n.id)) out.push({ ti: ti, track: t, note: n }); });
    });
    return out;
  };

  Arranger.prototype.hasSelection = function () { return this.selection.size > 0; };

  function idOfDrumPitch(p) {
    for (var id in DRUM_PITCH) {
      if (DRUM_PITCH[id] === p) return id;
    }
    return null;
  }

  /**
   * 整组平移。这是「框选一个和弦后整体拖动」的实现。
   * @param {object} opts { dBeat, dPitch(半音), dRow(鼓位行) }
   */
  Arranger.prototype.moveSelection = function (opts) {
    opts = opts || {};
    var locs = this.selectedLocations();
    if (!locs.length) return 0;
    var dBeat = opts.dBeat || 0;
    var dPitch = Math.round(opts.dPitch || 0);
    var dRow = Math.round(opts.dRow || 0);

    // 不允许把整组推到负拍：整体后移量取「最早音的可用空间」
    var minBeat = Infinity;
    locs.forEach(function (l) { minBeat = Math.min(minBeat, l.note.beat); });
    if (minBeat + dBeat < 0) dBeat = -minBeat;

    var touched = {};
    locs.forEach(function (l) {
      l.note.beat = this.snapTick(Math.max(0, l.note.beat + dBeat));
      if (l.track.role === 'drum') {
        if (dRow) {
          var id = idOfDrumPitch(l.note.pitch);
          var idx = DRUM_ORDER.indexOf(id);
          if (idx < 0) idx = DRUM_ORDER.length - 1;
          var ni = U.clamp(idx + dRow, 0, DRUM_ORDER.length - 1);
          l.note.pitch = DRUM_PITCH[DRUM_ORDER[ni]];
        }
      } else if (dPitch) {
        l.note.pitch = U.clamp(Math.round(l.note.pitch + dPitch), 0, 127);
      }
      touched[l.ti] = true;
    }, this);

    Object.keys(touched).forEach(function (k) {
      this.getTracks()[k].notes.sort(function (x, y) { return x.beat - y.beat; });
    }, this);
    this.changed('note:move');
    return locs.length;
  };

  /** 复制选区（可指定拍偏移），返回新音符 id 数组 */
  Arranger.prototype.duplicateSelection = function (dBeat) {
    var locs = this.selectedLocations();
    if (!locs.length) return [];
    var byTrack = {};
    locs.forEach(function (l) { (byTrack[l.ti] = byTrack[l.ti] || []).push(l.note); });

    var ids = [];
    Object.keys(byTrack).forEach(function (k) {
      var t = this.getTrack(+k);
      if (!t) return;
      byTrack[k].forEach(function (n) {
        var c = {
          id: noteId(),
          beat: this.snapTick(Math.max(0, n.beat + (dBeat || 0))),
          len: n.len,
          pitch: n.pitch,
          vel: n.vel
        };
        if (n.glide > 0) c.glide = n.glide;      // 复制要带上音符修饰
        if (n.glideFrom !== undefined && n.glideFrom !== null) c.glideFrom = n.glideFrom;
        if (n.vib > 0) { c.vib = n.vib; if (n.vibRate > 0) c.vibRate = n.vibRate; }
        t.notes.push(c);
        ids.push(c.id);
      }, this);
      t.notes.sort(function (x, y) { return x.beat - y.beat; });
    }, this);

    this.selection = new Set(ids);
    this.changed('note:duplicate');
    this.emit('selection:change', this.selection);
    return ids;
  };

  /** 把选区复制到下一小节（保留节拍位置） */
  Arranger.prototype.duplicateToNextBar = function () {
    return this.duplicateSelection(this.barBeats());
  };

  /** 量化选区（不改数据时返回 0） */
  Arranger.prototype.quantizeSelection = function (grid) {
    var g = grid || this.grid || TICK;
    var locs = this.selectedLocations();
    var n = 0;
    locs.forEach(function (l) {
      var b = Math.round(l.note.beat / g) * g;
      if (Math.abs(b - l.note.beat) > 1e-9) n++;
      l.note.beat = this.snapTick(Math.max(0, b));
    }, this);
    if (n) {
      this.getTracks().forEach(function (t) {
        t.notes.sort(function (x, y) { return x.beat - y.beat; });
      });
      this.changed('note:quantize');
    }
    return n;
  };

  /** 移调选区（半音，鼓轨不动） */
  Arranger.prototype.transposeSelection = function (semitones) {
    var locs = this.selectedLocations();
    var n = 0;
    locs.forEach(function (l) {
      if (l.track.role === 'drum') return;
      l.note.pitch = U.clamp(Math.round(l.note.pitch + semitones), 0, 127);
      n++;
    });
    if (n) this.changed('note:transpose');
    return n;
  };

  /** 力度：整体乘系数或加偏移 */
  Arranger.prototype.scaleVelocity = function (factor, offset) {
    var locs = this.selectedLocations();
    locs.forEach(function (l) {
      l.note.vel = U.clamp((l.note.vel === undefined ? 0.85 : l.note.vel) * (factor || 1) + (offset || 0), 0.02, 1);
    });
    if (locs.length) this.changed('note:vel');
    return locs.length;
  };

  /** 设定选区统一力度 */
  Arranger.prototype.setSelectionVelocity = function (v) {
    var locs = this.selectedLocations();
    locs.forEach(function (l) { l.note.vel = U.clamp(v, 0.02, 1); });
    if (locs.length) this.changed('note:vel');
    return locs.length;
  };

  /**
   * 设置选区音符的修饰字段。
   * patch 里出现的键才生效，值为 0 表示**清除该字段**（不写进 JSON，省体积）：
   *   glide      滑音时长（秒，0–2）—— 音块内从这个位置开始往后一块滑
   *   glideFrom  滑音的**起始音高**（MIDI 0–127）。与 pitch 不同时，
   *              音块会被切成两块：前一块用 glideFrom、后一块用 pitch。
   *              值为 null 表示清除（同时清掉 glide）
   *   vib     颤音深度（0–1，映射 ±60 音分）
   *   vibRate 颤音速率（Hz，0.5–14）
   * 鼓轨没有持续音高，直接跳过。
   */
  Arranger.prototype.setNoteModifiers = function (patch) {
    patch = patch || {};
    var hasGlide = patch.glide !== undefined && patch.glide !== null;
    var hasFrom = patch.glideFrom !== undefined;
    var hasVib = patch.vib !== undefined && patch.vib !== null;
    var hasRate = patch.vibRate !== undefined && patch.vibRate !== null;
    if (!hasGlide && !hasFrom && !hasVib && !hasRate) return 0;

    var glide = hasGlide ? U.clamp(parseFloat(patch.glide) || 0, 0, 2) : null;
    var from = null;
    if (hasFrom) {
      var f = parseFloat(patch.glideFrom);
      from = (isFinite(f) && f > 0) ? Math.round(U.clamp(f, 0, 127)) : null;
    }
    var vib = hasVib ? U.clamp(parseFloat(patch.vib) || 0, 0, 1) : null;
    var rate = null;
    if (hasRate) {
      var r = parseFloat(patch.vibRate);
      rate = (isFinite(r) && r > 0) ? U.clamp(r, 0.5, 14) : 0;
    }

    var n = 0;
    this.selectedLocations().forEach(function (l) {
      if (l.track.role === 'drum') return;
      var note = l.note;
      if (hasGlide) {
        if (glide > 0) note.glide = Math.round(glide * 1000) / 1000;
        else { delete note.glide; delete note.glideFrom; }   // 滑音没了，起始音高也没意义
      }
      if (hasFrom) {
        if (from !== null) note.glideFrom = from;
        else delete note.glideFrom;
      }
      if (hasVib) {
        if (vib > 0) note.vib = Math.round(vib * 100) / 100;
        else { delete note.vib; delete note.vibRate; }   // 深度没了，速率也就没意义
      }
      if (hasRate && note.vib > 0) {
        if (rate > 0) note.vibRate = Math.round(rate * 10) / 10;
        else delete note.vibRate;
      }
      n++;
    });
    if (n) this.changed('note:mod');
    return n;
  };

  /** 选区起点的最小拍（用于整组拖动） */
  Arranger.prototype.selectionStartBeat = function () {
    var locs = this.selectedLocations();
    if (!locs.length) return null;
    var m = Infinity;
    locs.forEach(function (l) { m = Math.min(m, l.note.beat); });
    return m;
  };

  /* ---------------- 小节操作 ---------------- */

  /** 删除指定小节范围内的音符（可多选小节） */
  /**
   * 删除小节。
   *
   * ⚠️ 跨小节长音的处理（支持「长短音重叠」的谱）：
   *   · 完全落在删除区间内 → 整条删除
   *   · 与删除区间**部分**重叠 → **裁剪**（保住所剩的那一段）
   *   · 完全不重叠 → 保留
   *
   *   例如 C4 从第 2 小节唱到第 3 小节（beat 5…9，4/4 拍）：
   *   删掉第 3 小节（beat 8…12）→ 它被裁成 beat 5…8（长度 3 拍），
   *   而不是整条消失、也不是原样保留却少唱了。
   *
   * 裁剪规则：音符是「一个音」，不能拆成多段，
   * 所以取**第一段未被删除的区间**作为保留部分；
   * 若音符起点本身被删，则整体后移到删除区间之后、时长不变。
   *
   * @returns {number} 受影响的音符数（删除 + 裁剪）
   */
  Arranger.prototype.deleteBars = function (barList) {
    if (!barList || !barList.length) return 0;
    var bb = this.barBeats();
    var set = new Set(barList);
    var count = 0;
    var self = this;

    // 删除区间的拍范围（可能不连续 → 合并成若干连续段）
    var spans = [];
    Array.from(set).sort(function (a, b) { return a - b; }).forEach(function (bar) {
      var s = bar * bb, e = s + bb;
      var last = spans[spans.length - 1];
      if (last && s <= last[1]) { if (e > last[1]) last[1] = e; }
      else spans.push([s, e]);
    });

    /** 把音符切成「被删段」与「保留段」 */
    function segmentsOf(note) {
      var s = note.beat, e = note.beat + (note.len || 0);
      var keep = [], pos = s;
      spans.forEach(function (sp) {
        // 完全在音符之前/之后 → 跳过（用 < 而非 <=，贴边的段也要算进重叠）
        if (sp[1] <= pos || sp[0] >= e) return;
        var a = Math.max(pos, sp[0]), b = Math.min(e, sp[1]);
        if (b <= a) return;
        if (a > pos) keep.push([pos, a]);      // 保留段（被删段之前的部分）
        pos = b;                              // 跳过被删段
      });
      if (e > pos) keep.push([pos, e]);        // 最后一段
      return keep;
    }

    this.getTracks().forEach(function (t) {
      var kept = [];
      t.notes.forEach(function (n) {
        var dur = n.len || 0;
        var keep = segmentsOf(n);
        if (keep.length && keep[0][1] - keep[0][0] >= dur - 1e-9) {
          kept.push(n);                       // 完全没被删
          return;
        }
        if (!keep.length) { count++; return; } // 整条被删
        // 部分被删 → 裁剪
        count++;
        var sg = keep[0];
        var newBeat = sg[0];
        var newLen = sg[1] - sg[0];
        if (n.beat < newBeat - 1e-9) {
          // 起点落在删除区间内 → 整体后移到删除区间之后填补空缺，时长不变
          newLen = dur;
        } else if (n.beat > newBeat + 1e-9) {
          // 起点在保留段之前（不可能，但防御性处理）
          newLen = dur;
        }
        n.beat = self.snapTick(Math.max(0, newBeat));
        n.len = self.snapTick(Math.max(TICK, newLen));
        kept.push(n);
      });
      t.notes = kept;
      t.notes.sort(function (x, y) { return x.beat - y.beat; });
    });
    this.selection.clear();
    if (count) this.changed('bar:delete');
    return count;
  };

  Arranger.prototype.setLength = function (bars) {
    bars = Math.max(1, Math.round(bars));
    if (bars === this.lengthBars) return;
    this.lengthBars = bars;
    // 目标小节可能已越界（缩减小节数时）
    if (this.targetBar > bars - 1) this.targetBar = bars - 1;
    // 循环区间也要夹回有效范围
    if (this.loop) {
      if (this.loop.start >= bars) this.loop = null;
      else if (this.loop.end > bars) this.loop = { start: this.loop.start, end: bars };
    }
    this.changed('length');
  };

  Arranger.prototype.extendBars = function (delta) {
    this.setLength(this.lengthBars + delta);
  };

  /* ---------------- 和弦轨（每小节一格） ---------------- */

  Arranger.prototype.getChord = function (bar) {
    for (var i = 0; i < this.chords.length; i++) {
      if (this.chords[i].bar === bar) return this.chords[i];
    }
    return null;
  };

  /** 写某小节的和弦（root 形如 'C'/'F#'，quality 见 CHORD_QUALITIES） */
  Arranger.prototype.setChord = function (bar, root, quality) {
    bar = U.clamp(Math.round(bar), 0, Math.max(0, this.lengthBars - 1));
    var exists = this.getChord(bar);
    if (exists) {
      exists.root = root || exists.root;
      exists.quality = quality || exists.quality;
    } else {
      this.chords.push({ bar: bar, root: root || 'C', quality: quality || 'maj' });
      this.chords.sort(function (a, b) { return a.bar - b.bar; });
    }
    this.changed('chord');
    return this.getChord(bar);
  };

  Arranger.prototype.clearChord = function (bar) {
    var before = this.chords.length;
    this.chords = this.chords.filter(function (c) { return c.bar !== bar; });
    if (this.chords.length !== before) this.changed('chord');
  };

  /** 和弦显示名（C / Am / Fmaj7） */
  Arranger.prototype.chordLabel = function (bar) {
    var c = this.getChord(bar);
    if (!c) return '';
    var q = CHORD_QUALITIES[c.quality] || CHORD_QUALITIES.maj;
    return c.root + q.symbol;
  };

  /** 和弦音高（按小节取和弦轨，缺省用给定兜底音高） */
  Arranger.prototype.pitchesOfBar = function (bar, octave, fallback) {
    var c = this.getChord(bar);
    if (!c) return fallback;
    return this.chordPitches(c.root, c.quality, octave);
  };

  /**
   * 铺一段和弦进行（起始小节 + 级数列表，1 起）。
   * 级数按当前调性换算成和弦，可顺带用节奏型铺满。
   */
  Arranger.prototype.applyProgression = function (startBar, degrees, opts) {
    opts = opts || {};
    var inKey = this.chordsInKey(this.key, this.scale);
    var list = degrees || [];
    var applied = 0;
    for (var i = 0; i < list.length; i++) {
      var bar = startBar + i;
      if (bar >= this.lengthBars) break;
      var deg = ((list[i] - 1) % inKey.length + inKey.length) % inKey.length;
      var ch = inKey[deg];
      if (!ch) continue;
      this.setChord(bar, ch.root, ch.quality);
      applied++;
    }
    if (opts.trackIndex !== undefined && opts.patternId) {
      for (var j = 0; j < applied; j++) {
        var b = startBar + j;
        var c = this.getChord(b);
        if (!c) continue;
        var ps = this.chordPitches(c.root, c.quality, opts.octave === undefined ? 3 : opts.octave);
        this.fillBar(opts.trackIndex, b, ps, opts.patternId, { drumPitch: opts.drumPitch });
      }
    }
    this.changed('progression');
    return applied;
  };

  /* ---------------- 循环区间 ---------------- */

  /**
   * 设定循环区间（小节，end 不含）。start===end 视为清除。
   * 循环区间同时是「循环练习」和「按区间导出」的依据。
   */
  Arranger.prototype.setLoop = function (startBar, endBar) {
    var s = U.clamp(Math.round(startBar), 0, Math.max(0, this.lengthBars - 1));
    var e = U.clamp(Math.round(endBar), s + 1, this.lengthBars);
    if (e <= s) { this.clearLoop(); return null; }
    this.loop = { start: s, end: e };
    this.changed('loop');
    return this.loop;
  };

  Arranger.prototype.clearLoop = function () {
    if (!this.loop) return;
    this.loop = null;
    this.changed('loop');
  };

  /** 循环小节数（0 = 不循环） */
  Arranger.prototype.loopBars = function () {
    return this.loop ? this.loop.end - this.loop.start : 0;
  };

  Arranger.prototype.inLoop = function (bar) {
    return !!this.loop && bar >= this.loop.start && bar < this.loop.end;
  };

  /* ---------------- 段落标记 ---------------- */

  Arranger.prototype.sectionAt = function (bar) {
    for (var i = 0; i < this.sections.length; i++) {
      if (this.sections[i].bar === bar) return this.sections[i];
    }
    return null;
  };

  /** 在 bar 处设/改段落名；name 为空则删除 */
  Arranger.prototype.setSection = function (bar, name) {
    bar = U.clamp(Math.round(bar), 0, Math.max(0, this.lengthBars - 1));
    var s = this.sectionAt(bar);
    if (!name) {
      if (s) {
        this.sections = this.sections.filter(function (x) { return x.bar !== bar; });
        this.changed('section');
      }
      return null;
    }
    if (s) s.name = name;
    else {
      this.sections.push({ bar: bar, name: name });
      this.sections.sort(function (a, b) { return a.bar - b.bar; });
    }
    this.changed('section');
    return this.sectionAt(bar);
  };

  /** 当前小节所属段落（向前找最近的一个标记） */
  Arranger.prototype.sectionOf = function (bar) {
    var best = null;
    this.sections.forEach(function (s) {
      if (s.bar <= bar && (!best || s.bar > best.bar)) best = s;
    });
    return best;
  };

  /* ---------------- 调性工具 ---------------- */

  /**
   * 把选区吸附到当前调性音阶（就近取音）。
   * 编曲里「唱得跑调」或从别处导入的音符，一下就对齐到调内。
   */
  Arranger.prototype.snapSelectionToScale = function () {
    var sc = SCALES[this.scale] || SCALES.major;
    var root = nameToPc(this.key);
    var set = {};
    sc.iv.forEach(function (iv) { set[(root + iv) % 12] = true; });
    var locs = this.selectedLocations();
    var moved = 0;
    locs.forEach(function (l) {
      if (l.track.role === 'drum') return;
      var p = l.note.pitch;
      var pc = ((p % 12) + 12) % 12;
      if (set[pc]) return;
      // 就近：向上找与向下找哪个更近
      var up = 0, down = 0;
      while (!set[((p + up) % 12 + 12) % 12] && up < 6) up++;
      while (!set[((p - down) % 12 + 12) % 12] && down < 6) down++;
      l.note.pitch = U.clamp(up <= down ? p + up : p - down, 0, 127);
      moved++;
    });
    if (moved) this.changed('note:scale');
    return moved;
  };

  /** 整条轨移调（半音），鼓轨不动 */
  Arranger.prototype.transposeTrack = function (trackIndex, semitones) {
    var t = this.getTrack(trackIndex);
    if (!t || t.role === 'drum') return 0;
    t.notes.forEach(function (n) { n.pitch = U.clamp(Math.round(n.pitch + semitones), 0, 127); });
    this.changed('track:transpose');
    return t.notes.length;
  };

  /* ---------------- 和弦库 ---------------- */

  /** 音名 → 音级（C=0 … B=11），支持 #/b 后缀 */
  function nameToPc(name) {
    var m = /^([A-G])([#b]?)$/.exec(name || 'C');
    if (!m) return 0;
    var base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]];
    var acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
    return ((base + acc) % 12 + 12) % 12;
  }

  /** 调内音阶 */
  Arranger.prototype.scaleNotes = function (key, scaleName, octave) {
    var sc = SCALES[scaleName] || SCALES.major;
    /* ⚠️ 不能用 charCodeAt - 65：那会把 C 当成 2（D），整条音阶高一个大二度。
       音名到音级的换算必须走 nameToPc。 */
    var pc = nameToPc(key || 'C');
    var base = pc + 12 * ((octave === undefined ? 4 : octave) + 1);   // C4 = 60
    return sc.iv.map(function (iv) { return base + iv; });
  };

  /** 生成某和弦的音高数组（octave 是该八度的音名八度号，C4 = 60） */
  Arranger.prototype.chordPitches = function (rootName, quality, octave) {
    var q = CHORD_QUALITIES[quality] || CHORD_QUALITIES.maj;
    var pc = nameToPc(rootName || 'C');
    var base = pc + 12 * ((octave === undefined ? 4 : octave) + 1);
    return q.iv.map(function (iv) { return base + iv; });
  };

  /** 和弦在当前调里的所有级数（如 C 大调：C Dm Em F G Am Bdim） */
  Arranger.prototype.chordsInKey = function (key, scaleName) {
    var sc = SCALES[scaleName] || SCALES.major;
    var root = nameToPc(key || 'C');
    var out = [];
    for (var i = 0; i < sc.iv.length; i++) {
      var pc = (root + sc.iv[i]) % 12;
      var name = NOTE_NAMES[pc];
      // 大调：I IV V vi ii iii vii；小调：i VI iv v ii III VII
      var isMinorish = scaleName === 'minor' || scaleName === 'harmonic' ||
                       scaleName === 'minorPent' || scaleName === 'dorian' ||
                       scaleName === 'phrygian' || scaleName === 'blues';
      var quality = 'maj';
      if (isMinorish) {
        // 小调里第 3、6、7 级用大三/减三
        quality = (i === 2 || i === 5) ? 'maj' : (i === 6 ? 'dim' : 'min');
      } else {
        quality = (i === 5) ? 'min' : (i === 6) ? 'dim' : 'maj';
      }
      out.push({ root: name, quality: quality, degree: i });
    }
    return out;
  };

  /**
   * 用和弦 + 节奏型填充当前小节。
   * @param trackIndex
   * @param bar         小节序号
   * @param chordPitches 音高数组
   * @param patternId  节奏型 id
   * @param opts { replace: 是否先清空该小节, vel, drumPitch }
   */
  /** 按 id 找节奏型/鼓型 */
  Arranger.prototype.getPattern = function (patternId) {
    var i;
    for (i = 0; i < PATTERNS.length; i++) if (PATTERNS[i].id === patternId) return PATTERNS[i];
    for (i = 0; i < BASS_PATTERNS.length; i++) if (BASS_PATTERNS[i].id === patternId) return BASS_PATTERNS[i];
    for (i = 0; i < DRUM_PATTERNS.length; i++) if (DRUM_PATTERNS[i].id === patternId) return DRUM_PATTERNS[i];
    return null;
  };

  /** 某轨可用的模板列表：鼓轨给鼓型、低音轨给低音线，其余给和弦节奏型 */
  Arranger.prototype.patternsFor = function (trackIndex) {
    var t = this.getTrack(trackIndex);
    if (t && t.role === 'drum') return DRUM_PATTERNS;
    if (t && t.role === 'bass') return BASS_PATTERNS;
    return PATTERNS;
  };

  /**
   * 只计算「某小节 + 某模板」会铺出哪些音符（不修改数据）。
   * 试听预览与 fillBar 共用同一份计算，保证「听到的就是填进去的」。
   * @returns {Array<{beat, len, pitch}>}
   */
  Arranger.prototype.patternNotes = function (bar, chordPitches, patternId, opts) {
    opts = opts || {};
    var role = opts.role || 'synth';
    var isDrum = role === 'drum';
    var isBass = role === 'bass';
    var pat = this.getPattern(patternId) ||
      (isDrum ? DRUM_PATTERNS[0] : (isBass ? BASS_PATTERNS[0] : PATTERNS[0]));
    if (!pat) return [];
    var bb = this.barBeats();
    var barStart = bar * bb;
    var barEnd = barStart + bb;
    var drumPitch = opts.drumPitch === undefined ? DRUM_PITCH.kick : opts.drumPitch;
    var chord = (chordPitches && chordPitches.length) ? chordPitches : [60, 64, 67];
    var out = [];

    function push(beat, len, pitch) {
      if (!(len > 0) || beat >= barEnd - 1e-9) return;
      out.push({
        beat: Math.max(barStart, beat),
        len: Math.min(len, barEnd - beat),
        pitch: pitch
      });
    }

    if (pat.hits) {
      pat.hits.forEach(function (h) {
        var pitch = DRUM_PITCH[h.drum];
        if (pitch === undefined) pitch = drumPitch;
        push(barStart + h.rb * bb, (h.rl || 0.125) * bb, pitch);
      });
    } else if (isBass) {
      // 低音声部：每个音节只发一个音，落到低音区（不是柱式和弦）
      pat.notes.forEach(function (pn) {
        var beat = barStart + pn.rb * bb;
        var len = (pn.rl === undefined ? 0.25 : pn.rl) * bb;
        push(beat, len, bassPitch(chord, pn.tone, pn.oct));
      });
    } else {
      var arp = pat.arp;
      pat.notes.forEach(function (pn, i) {
        var beat = barStart + pn.rb * bb;
        var len = (pn.rl === undefined ? 0.25 : pn.rl) * bb;
        if (isDrum) {
          push(beat, len, drumPitch);
        } else if (arp && arp.length) {
          push(beat, len, chord[arp[i % arp.length] % chord.length]);
        } else {
          chord.forEach(function (p) { push(beat, len, p); });
        }
      });
    }
    return out;
  };

  Arranger.prototype.fillBar = function (trackIndex, bar, chordPitches, patternId, opts) {
    opts = opts || {};
    var t = this.getTrack(trackIndex);
    if (!t) return 0;
    var bb = this.barBeats();
    var barStart = bar * bb;
    var barEnd = barStart + bb;

    // 先清掉该小节内已有音符
    t.notes = t.notes.filter(function (n) {
      var s = n.beat, e = n.beat + n.len;
      return !(s < barEnd && e > barStart);
    });

    var vel = opts.vel === undefined ? 0.8 : opts.vel;
    var list = this.patternNotes(bar, chordPitches, patternId, {
      role: t.role, drumPitch: opts.drumPitch
    });
    var self = this;
    list.forEach(function (x) {
      t.notes.push({
        id: noteId(),
        beat: self.snapTick(Math.max(0, x.beat)),
        len: self.snapTick(Math.max(TICK, x.len)),
        pitch: x.pitch,
        vel: vel
      });
    });

    t.notes.sort(function (x, y) { return x.beat - y.beat; });
    this.changed('fill');
    return list.length;
  };

  /* ---------------- 播放视图（纯函数） ---------------- */

  /**
   * 生成一份**给序列器用**的 song（全新对象，不改动编曲数据）。
   *
   * ⚠️ 不要再用「把编曲轨塞进 App.song」的老做法：
   *   · 会污染琴谱页的数据（不可逆）
   *   · 旧对象上残留的 loopBars 会让编曲莫名 4 小节循环
   *   · lengthBars / key / scale 根本没地方表达
   *
   * @param {object} opts { loopBars, solo }
   * @returns {object|null}
   */
  Arranger.prototype.toSong = function (opts) {
    opts = opts || {};
    if (!this.song) return null;
    var tracks = this.getTracks();
    var anySolo = tracks.some(function (t) { return t.solo; });
    /* 单轨编辑试听：只让这一轨发声。静音只写进**返回值**（播放用的拷贝），
       不动 this.song.tracks —— 否则会把「临时静音」写进工程/导出。 */
    var only = opts.onlyTrackIndex;
    var hasOnly = (typeof only === 'number' && only >= 0);

    // 循环区间：opts.loopBars 显式指定（如按区间导出）优先，否则用编曲页设定的区间
    var loopBars = opts.loopBars;
    var loopStartBars = opts.loopStartBars;
    if (loopBars === undefined) {
      loopBars = this.loop ? (this.loop.end - this.loop.start) : 0;
      loopStartBars = this.loop ? this.loop.start : 0;
    }
    if (!loopStartBars) loopStartBars = 0;

    return {
      version: 1,
      name: this.song.name,
      bpm: this.song.bpm,
      timeSignature: this.song.timeSignature.slice(),
      swing: this.song.swing || 0,
      // 显式给 0，避免继承上一首歌的循环设定
      loopBars: loopBars || 0,
      loopStartBars: loopStartBars,
      // 编曲长度：即使内容只有 2 小节，也要能播到第 16 小节
      lengthBars: this.lengthBars,
      tracks: tracks.map(function (t, i) {
        var isDrum = t.role === 'drum';
        return {
          name: t.name,
          part: isDrum ? -1 : (t.part === undefined ? 0 : t.part),
          role: t.role || 'synth',
          drum: isDrum ? (t.drum || 'kit') : undefined,
          toneId: t.toneId || null,
          color: t.color || null,
          volume: t.volume === undefined ? 1 : t.volume,
          pan: t.pan || 0,
          // 独奏解析：有任何轨 solo 时，其余轨一律静音；单轨试听时同理只留一轨
          muted: !!t.muted || (anySolo && !t.solo) || (hasOnly && i !== only),
          solo: !!t.solo,
          notes: t.notes.map(function (n) {
            var x = { beat: n.beat, len: n.len, pitch: n.pitch, vel: n.vel };
            /* 音符修饰（可选字段，缺省即 0，不要写成 0 增加体积）：
               glide   滑音时长（秒）：从音块内第 glide 秒处开始往本音高滑
               glideFrom 滑音的**起始音高**（MIDI）：与 pitch 不同时音块切成两块，
                        前一块用 glideFrom、后一块用 pitch，中间弧线连接
               vib     颤音深度 0..1（映射 ±60 音分）
               vibRate 颤音速率 Hz（缺省 5.5） */
            if (n.glide > 0) x.glide = n.glide;
            if (n.glideFrom !== undefined && n.glideFrom !== null) x.glideFrom = n.glideFrom;
            if (n.vib > 0) { x.vib = n.vib; if (n.vibRate > 0) x.vibRate = n.vibRate; }
            return x;
          })
        };
      })
    };
  };

  /**
   * 声部被删除后重映射轨的 part 索引。
   *
   * engine.removePart 用 splice，后面的声部索引整体前移；
   * 轨里存的却是数字索引 → 不重映射就会整体串音。
   *
   * @param {number} removedIndex 被删声部的原索引
   * @param {number} remaining    剩余声部数
   * @returns {number[]} 绑定失效的轨索引列表
   */
  Arranger.prototype.remapAfterPartRemoved = function (removedIndex, remaining) {
    var lost = [];
    this.getTracks().forEach(function (t, i) {
      if (t.role === 'drum') return;
      if (t.part > removedIndex) t.part -= 1;
      else if (t.part === removedIndex) {
        // 原音色没了：夹到最近的有效声部并标记，让界面提示重新指音色
        t.part = remaining > 0 ? Math.min(removedIndex, remaining - 1) : -1;
        t._partLost = true;
        lost.push(i);
      }
    });
    this.changed('part:remove');
    return lost;
  };

  /* ---------------- 调性 / 总设定 ---------------- */

  Arranger.prototype.setKey = function (key, scale) {
    this.key = key || this.key;
    if (scale) this.scale = scale;
    this.changed('key');
  };

  Arranger.prototype.setBpm = function (bpm) {
    if (!this.song) return;
    this.song.bpm = U.clamp(Math.round(bpm), 20, 400);
    this.changed('bpm');
  };

  Arranger.prototype.setTimeSignature = function (num, den) {
    if (!this.song) return;
    this.song.timeSignature = [Math.max(1, num | 0), Math.max(1, den | 0)];
    this.changed('sig');
  };

  /* ---------------- 快照（单轨编辑的取消/保存） ---------------- */

  /** 采集当前编曲状态快照（深拷贝，用于撤销/取消编辑） */
  Arranger.prototype.snapshot = function () {
    return {
      tracks: this.getTracks().map(function (t) {
        return {
          name: t.name, part: t.part, role: t.role, toneId: t.toneId,
          color: t.color, volume: t.volume, pan: t.pan,
          muted: t.muted, solo: t.solo, drum: t.drum,
          notes: t.notes.map(function (n) {
            // 快照要带上音符修饰，否则撤销一次滑音/颤音就没了
            var x = { id: n.id, beat: n.beat, len: n.len, pitch: n.pitch, vel: n.vel };
            if (n.glide > 0) x.glide = n.glide;
            if (n.glideFrom !== undefined && n.glideFrom !== null) x.glideFrom = n.glideFrom;
            if (n.vib > 0) { x.vib = n.vib; if (n.vibRate > 0) x.vibRate = n.vibRate; }
            return x;
          })
        };
      }),
      chords: this.chords.map(function (c) { return { bar: c.bar, root: c.root, quality: c.quality }; }),
      loop: this.loop ? { start: this.loop.start, end: this.loop.end } : null,
      sections: this.sections.map(function (x) { return { bar: x.bar, name: x.name }; }),
      lengthBars: this.lengthBars,
      key: this.key,
      scale: this.scale,
      grid: this.grid,
      targetBar: this.targetBar,
      activeTrackIndex: this.activeTrackIndex,
      selection: Array.from(this.selection)
    };
  };

  /** 恢复到快照（撤销/取消编辑时调用） */
  Arranger.prototype.restore = function (snap) {
    if (!snap) return;
    var song = this.song;
    if (!song) return;
    song.tracks = snap.tracks.map(function (t) {
      return {
        name: t.name, part: t.part, role: t.role, toneId: t.toneId,
        color: t.color, volume: t.volume, pan: t.pan,
        muted: t.muted, solo: t.solo, drum: t.drum,
        notes: t.notes.map(function (n) {
          // 修饰字段按原样恢复（快照里没有就不补 0）
          var x = { id: n.id, beat: n.beat, len: n.len, pitch: n.pitch, vel: n.vel };
          if (n.glide > 0) x.glide = n.glide;
          if (n.glideFrom !== undefined && n.glideFrom !== null) x.glideFrom = n.glideFrom;
          if (n.vib > 0) { x.vib = n.vib; if (n.vibRate > 0) x.vibRate = n.vibRate; }
          return x;
        })
      };
    });
    this.chords = (snap.chords || []).map(function (c) {
      return { bar: c.bar, root: c.root, quality: c.quality };
    });
    this.loop = snap.loop ? { start: snap.loop.start, end: snap.loop.end } : null;
    this.sections = (snap.sections || []).map(function (x) { return { bar: x.bar, name: x.name }; });
    this.lengthBars = snap.lengthBars;
    this.key = snap.key;
    this.scale = snap.scale;
    this.grid = snap.grid;
    if (snap.targetBar !== undefined) {
      this.targetBar = U.clamp(snap.targetBar, 0, Math.max(0, this.lengthBars - 1));
    }
    if (snap.activeTrackIndex !== undefined && snap.activeTrackIndex < this.getTracks().length) {
      this.activeTrackIndex = snap.activeTrackIndex;
    }
    // 选区按 id 恢复：只保留仍然存在的音
    this.selection.clear();
    var alive = {};
    this.getTracks().forEach(function (t) { t.notes.forEach(function (n) { alive[n.id] = true; }); });
    (snap.selection || []).forEach(function (id) {
      if (alive[id]) this.selection.add(id);
    }, this);
    this.changed('restore');
    this.emit('selection:change', this.selection);
  };

  /* ---------------- 序列化 ---------------- */

  Arranger.prototype.toJSON = function () {
    if (!this.song) return null;
    var out = {
      version: 1,
      type: 'arranger',
      name: this.song.name,
      bpm: this.song.bpm,
      timeSignature: this.song.timeSignature.slice(),
      swing: this.song.swing || 0,
      lengthBars: this.lengthBars,
      key: this.key,
      scale: this.scale,
      grid: this.grid,
      targetBar: this.targetBar,
      // 和弦轨与循环区间：都是编曲结构的一部分，必须一起存
      chords: this.chords.map(function (c) { return { bar: c.bar, root: c.root, quality: c.quality }; }),
      loop: this.loop ? { start: this.loop.start, end: this.loop.end } : null,
      sections: this.sections.map(function (x) { return { bar: x.bar, name: x.name }; }),
      /* 结构说明（供外部工具理解）：
       *   notes 是**扁平列表**（每轨一个数组），每个音符自带 beat/len。
       *   这样天然支持：
       *     · 和弦     —— 同一轨内多个音高共享同一 beat
       *     · 长短重叠 —— 不同起点的音，时长区间可以交叠
       *   不要改成「按小节分片」—— 跨小节的长音会被劈成两半。 */
      structure: 'track-flat',
      tracks: this.getTracks().map(function (t) {
        return {
          name: t.name,
          part: t.part,
          role: t.role || 'synth',
          toneId: t.toneId || null,
          color: t.color || null,
          volume: t.volume === undefined ? 1 : t.volume,
          pan: t.pan || 0,
          muted: !!t.muted,
          solo: !!t.solo,
          notes: t.notes.map(function (n) {
            var x = { beat: Math.round(n.beat * 10000) / 10000, len: Math.round(n.len * 10000) / 10000, pitch: n.pitch };
            if (n.vel !== undefined && n.vel !== 1) x.vel = n.vel;
            if (n.glide > 0) x.glide = n.glide;
            if (n.glideFrom !== undefined && n.glideFrom !== null) x.glideFrom = n.glideFrom;
            if (n.vib > 0) { x.vib = n.vib; if (n.vibRate > 0) x.vibRate = n.vibRate; }
            return x;
          })
        };
      })
    };
    return out;
  };

  /** 从 JSON 恢复（兼容普通 song JSON：缺 role/toneId 时按音高猜） */
  Arranger.prototype.fromJSON = function (data) {
    if (!data) return null;
    var song = {
      version: 1,
      name: data.name || '未命名',
      bpm: data.bpm || 120,
      timeSignature: Array.isArray(data.timeSignature) ? data.timeSignature.slice() : [4, 4],
      swing: data.swing || 0,
      tracks: []
    };
    this.lengthBars = data.lengthBars || 16;
    this.key = data.key || 'C';
    this.scale = data.scale || 'major';
    this.grid = data.grid || 1 / 16;
    // structure 目前只有 'track-flat'；未来的分片格式在此转换
    this.structure = data.structure || 'track-flat';

    var self = this;
    (data.tracks || []).forEach(function (t) {
      var role = t.role || (self.guessRole(t) ? 'drum' : 'synth');
      song.tracks.push({
        name: t.name || ('音轨 ' + (song.tracks.length + 1)),
        part: t.part === undefined ? song.tracks.length : t.part,
        notes: (t.notes || []).map(function (n) {
          var note = {
            id: noteId(),
            beat: Math.max(0, parseFloat(n.beat) || 0),
            len: Math.max(TICK, parseFloat(n.len) || 0.25),
            pitch: n.pitch,
            vel: n.vel === undefined ? 0.85 : n.vel
          };
          // 音符修饰：滑音（秒）/ 颤音（深度、速率），缺失即 0
          var g = parseFloat(n.glide);
          if (isFinite(g) && g > 0) note.glide = U.clamp(g, 0, 2);
          // 滑音起始音高（新模型：音块切成两块，前一块用这个音高）
          var gf = parseFloat(n.glideFrom);
          if (isFinite(gf)) note.glideFrom = Math.round(U.clamp(gf, 0, 127));
          var v = parseFloat(n.vib);
          if (isFinite(v) && v > 0) {
            note.vib = U.clamp(v, 0, 1);
            var vr = parseFloat(n.vibRate);
            if (isFinite(vr) && vr > 0) note.vibRate = U.clamp(vr, 0.5, 14);
          }
          return note;
        }),
        volume: t.volume === undefined ? 0.85 : t.volume,
        pan: t.pan || 0,
        muted: !!t.muted,
        solo: !!t.solo,
        role: role,
        toneId: t.toneId || null,
        color: t.color || TRACK_COLORS[song.tracks.length % TRACK_COLORS.length]
      });
    });
    this.song = song;
    this.selection.clear();
    this.chords = (data.chords || []).filter(function (c) {
      return c && c.bar !== undefined;
    }).map(function (c) {
      return {
        bar: U.clamp(parseInt(c.bar, 10) || 0, 0, Math.max(0, this.lengthBars - 1)),
        root: c.root || 'C',
        quality: CHORD_QUALITIES[c.quality] ? c.quality : 'maj'
      };
    }, this);
    this.chords.sort(function (a, b) { return a.bar - b.bar; });
    if (data.loop && data.loop.end > data.loop.start) {
      this.loop = {
        start: U.clamp(parseInt(data.loop.start, 10) || 0, 0, Math.max(0, this.lengthBars - 1)),
        end: U.clamp(parseInt(data.loop.end, 10) || 0, 1, this.lengthBars)
      };
    } else {
      this.loop = null;
    }
    this.sections = (data.sections || []).filter(function (x) {
      return x && x.name;
    }).map(function (x) {
      return { bar: U.clamp(parseInt(x.bar, 10) || 0, 0, Math.max(0, this.lengthBars - 1)), name: String(x.name) };
    }, this).sort(function (a, b) { return a.bar - b.bar; });
    this.targetBar = U.clamp(parseInt(data.targetBar, 10) || 0, 0, Math.max(0, this.lengthBars - 1));
    this.activeTrackIndex = 0;
    this._undo.length = 0;
    this._redo.length = 0;
    this.changed('load');
    return song;
  };

  /** 猜测轨道是鼓还是合成器：全部音高都在鼓音高集合内 */
  var DRUM_PITCHES = { 36: 1, 37: 1, 38: 1, 39: 1, 42: 1, 45: 1, 46: 1, 48: 1, 49: 1, 50: 1, 51: 1, 70: 1 };
  Arranger.prototype.guessRole = function (track) {
    // 防御：notes 里可能有 null / 非法元素（外部导入的脏数据）
    var ns = (track.notes || []).filter(function (n) {
      return n && !n.mute && n.pitch !== undefined && n.pitch !== null;
    });
    if (!ns.length) return false;
    return ns.every(function (n) { return !!DRUM_PITCHES[n.pitch]; });
  };

  BS.arranger = Arranger;
  BS.arrangerLib = {
    CHORD_QUALITIES: CHORD_QUALITIES,
    SCALES: SCALES,
    PATTERNS: PATTERNS,
    BASS_PATTERNS: BASS_PATTERNS,
    DRUM_PATTERNS: DRUM_PATTERNS,
    PROGRESSIONS: PROGRESSIONS,
    NOTE_NAMES: NOTE_NAMES,
    DRUM_PITCHES: DRUM_PITCHES,
    DRUM_ORDER: DRUM_ORDER,
    DRUM_LABEL: DRUM_LABEL,
    DRUM_PITCH: DRUM_PITCH
  };
})(typeof window !== 'undefined' ? window : globalThis);

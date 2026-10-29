/* BandSynth · arranger-ui.js
 * 横向谱面编辑器：DAW 式钢琴卷帘。
 *
 * 布局（自上而下 / 自左而右）：
 *   ┌──────────────────────────────────────────────┐
 *   │ 小节标尺（点=选目标小节，Shift+拖=设循环区间） │ 22px
 *   │ 和弦轨（每小节一格，点格改和弦）               │ 26px
 *   ├──────┬───────────────────────────────────────┤
 *   │ 琴键 │ 音高网格 + 音块                        │
 *   │ /鼓名│                                        │
 *   ├──────┴───────────────────────────────────────┤
 *   │ 横向滚动条                                    │ 10px
 *   └──────────────────────────────────────────────┘
 *
 * 交互：
 *   · 单击空白：添加音符块（并立即试听）
 *   · 拖动音块：移动；选中多个时整组移动（和弦一起走）
 *   · Alt+拖动：拖动副本
 *   · 拖动两端：拉伸时值
 *   · 框选：空白处拖出选框；Delete 删除（总览也能删，可撤销）
 *   · 右键音块：菜单（复制/删除/量化/移调/力度/复制到下一小节）
 *   · 右键空白：平移视图（音高 + 节拍）
 *   · Ctrl+滚轮：缩放；Shift+滚轮：横向滚动
 *   · Ctrl+Z / Ctrl+Shift+Z：撤销 / 重做
 */
(function (global) {
  'use strict';
  var BS = global.BS;
  var U = BS.util;
  var LIB = BS.arrangerLib || {};

  /* 鼓的纵轴顺序/名称/音高：以 arranger.js 的库为唯一真值，
     界面不再自己维护一份（否则改一处另一处会漂）。 */
  var DRUM_ORDER = LIB.DRUM_ORDER || [];
  var DRUM_LABEL = LIB.DRUM_LABEL || {};
  var DRUM_PITCH = LIB.DRUM_PITCH || {};
  var DRUM_PITCH_TO_ID = {};
  var ID_TO_DRUM_PITCH = {};
  Object.keys(DRUM_PITCH).forEach(function (id) {
    DRUM_PITCH_TO_ID[DRUM_PITCH[id]] = id;
    ID_TO_DRUM_PITCH[id] = DRUM_PITCH[id];
  });

  var SCROLLBAR_H = 10;

  /**
   * @param {object} opts
   *   host        容器
   *   arranger    BS.arranger 实例
   *   getPart     (trackIndex) => Part
   *   getDrumRack () => DrumRack
   *   onChange    (reason) => void
   *   onOpenTrack (index) => void
   *   onRequestChord (bar, clientX, clientY) => void  和弦格被点击
   *   onRulerContext (bar, clientX, clientY) => void  右键标尺（段落标记）
   *   onTrackMix  (index) => void      音量/声像改变后同步到引擎
   *   toast       (msg) => void
   */
  function ArrangerEditor(opts) {
    opts = opts || {};
    this.host = opts.host;
    this.arr = opts.arranger;
    this.getPart = opts.getPart || function () { return null; };
    this.getDrumRack = opts.getDrumRack || function () { return null; };
    this.onChange = opts.onChange || function () {};
    this.toast = opts.toast || function () {};
    this.onRequestChord = opts.onRequestChord || null;
    this.onRulerContext = opts.onRulerContext || null;
    this.onTrackMix = opts.onTrackMix || function () {};
    // 声部选择：getPartOptions() => [{index,name,drum}]；onPartChange(ti, partIndex)
    this.getPartOptions = opts.getPartOptions || null;
    this.onPartChange = opts.onPartChange || null;
    this.onRoleChange = opts.onRoleChange || null;   // 声部轨 / 低音声部 切换
    this.onTonePick = opts.onTonePick || null;       // 轨头音色
    this.onSeek = opts.onSeek || null;               // 播放中单击谱面 → 跳转播放位置
    this._bands = null;          // 纵向布局缓存（见 layoutBands）

    this.pxPerBeat = 46;         // 每拍像素（横向缩放）
    this.rowH = 13;              // 每半音行高（兼容旧调用）
    this.scrollBeat = 0;         // 横向滚动（拍）
    this.scrollY = 0;            // 纵向滚动（像素）：多轨时不压缩，改为上下滚动
    this.vScrollW = 10;          // 右侧纵向滚动条宽度
    this._contentTotalH = 0;     // 所有轨带总高（含滚出视野的部分）
    this._maxScrollY = 0;
    this.pitchTop = 84;          // 纵轴顶端音高
    this.pitchBottom = 36;       // 纵轴底端音高
    /* 纵向缩放：zoomY 是倍率状态，跨度由 _zoomYBase / zoomY 算出来。
       直接对跨度乘除会有取整误差（52→33→53），连续 +/- 会一点点漂；
       用倍率做状态，放大再缩小就能精确回到原位。 */
    this.zoomY = 1;
    this._zoomYBase = 0;

    /* 演奏高亮行：holdKey → pitch（同一个音高可能被多个键按住，
       所以按 key 记录、松开时精确移除，而不是用「当前音高」单值）。 */
    this._hotKeys = {};

    this.rulerH = 22;            // 小节标尺
    this.chordH = 26;            // 和弦轨
    this.gutterW = 46;           // 左侧琴键/鼓名栏

    this.drag = null;            // 当前拖动状态
    this.selBox = null;          // 框选矩形
    this._dragAud = {};          // 拖动中「已试听音高」记录（防机关枪）
    this.menu = null;            // 右键菜单
    // 视图模式：'overview' = 总览（看全部轨）；'track' = 单轨编辑（可深编辑）
    this.viewMode = 'overview';
    this.editTrackIndex = -1;
    /* 单轨编辑的鼠标模式（原来那个「允许修改」勾选框换成了它）：
       'select' = 框选：空白处拖动 = 框选音块，选区可整组横/纵移动、可框选后删除
       'add'    = 添加：空白处左键点击 = 直接加音（等价于原来勾上「允许修改」） */
    this.editTool = 'select';
    this.onEditModeChange = opts.onEditModeChange || function () {};   // 视图模式（总览/单轨）变化
    this.onToolChange = opts.onToolChange || function () {};            // 鼠标模式（框选/添加）变化
    this.onOpenTrack = opts.onOpenTrack || function () {};

    this.build();
    this.bindEvents();
  }

  ArrangerEditor.DRUM_ORDER = DRUM_ORDER;
  ArrangerEditor.DRUM_LABEL = DRUM_LABEL;
  ArrangerEditor.DRUM_PITCH_TO_ID = DRUM_PITCH_TO_ID;
  ArrangerEditor.ID_TO_DRUM_PITCH = ID_TO_DRUM_PITCH;

  /* ================= 布局 ================= */

  ArrangerEditor.prototype.build = function () {
    this.host.innerHTML = '';
    this.host.classList.add('ag-root');

    // 左侧音轨列
    this.trackCol = document.createElement('div');
    this.trackCol.className = 'ag-trackcol';
    this.host.appendChild(this.trackCol);

    // 右侧谱面区
    this.pane = document.createElement('div');
    this.pane.className = 'ag-pane';
    this.host.appendChild(this.pane);

    // 谱面画布
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'ag-canvas';
    this.pane.appendChild(this.canvas);

    /* 交互层（DOM）：铺满整个 pane，标尺 / 和弦轨 / 横向滚动条都靠它收事件。
       ⚠️ 这一层绝不能加 clip-path —— clip-path 连命中测试一起裁，
       裁掉顶部 48px 之后标尺与小节号就点不动了（点上去命中的是底下 canvas）。 */
    this.overlay = document.createElement('div');
    this.overlay.className = 'ag-overlay';
    this.pane.appendChild(this.overlay);

    /* 演奏高亮行层：按住键盘/鼓垫时点亮谱面上对应音高那一整行。
       必须在 blockLayer 之前（音块压在高亮上），也不能放进 blockLayer ——
       renderBlocks 每次都把那层清空重建。裁剪规则与音块层一致。 */
    this.hotLayer = document.createElement('div');
    this.hotLayer.className = 'ag-hotlayer';
    this.hotLayer.style.clipPath = 'inset(' + this.headerH() + 'px ' + this.vScrollW + 'px ' +
      SCROLLBAR_H + 'px 0)';
    this.overlay.appendChild(this.hotLayer);

    /* 音块单独一层，只裁这一层：纵向滚动时音块不会画到表头/滚动条上，
       而交互层仍然覆盖全高，标尺照常可选。 */
    this.blockLayer = document.createElement('div');
    this.blockLayer.className = 'ag-blocklayer';
    this.blockLayer.style.clipPath = 'inset(' + this.headerH() + 'px ' + this.vScrollW + 'px ' +
      SCROLLBAR_H + 'px 0)';
    this.overlay.appendChild(this.blockLayer);

    /* 标注层（SVG）：滑音弧线 + 颤音波浪线。
       放在音块层**之后**：线要压在音块上面才看得清（弧线横跨两块之间）。
       pointer-events:none —— 只画不交互，命中等逻辑全在音块/手柄上。 */
    this.arcLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.arcLayer.setAttribute('class', 'ag-arcs');
    this.arcLayer.style.clipPath = 'inset(' + this.headerH() + 'px ' + this.vScrollW + 'px ' +
      SCROLLBAR_H + 'px 0)';
    this.overlay.appendChild(this.arcLayer);

    // 播放头（避开顶部标尺/和弦轨与底部横向滚动条）
    this.playhead = document.createElement('div');
    this.playhead.className = 'ag-playhead';
    this.playhead.style.top = this.headerH() + 'px';
    this.playhead.style.bottom = SCROLLBAR_H + 'px';
    this.pane.appendChild(this.playhead);

    // 纵向滚动条（DOM，叠在谱面右侧）：多轨时出现，可拖动
    this.vbar = document.createElement('div');
    this.vbar.className = 'ag-vscroll';
    this.vscrollThumb = document.createElement('i');
    this.vscrollThumb.className = 'ag-vthumb';
    this.vbar.appendChild(this.vscrollThumb);
    this.pane.appendChild(this.vbar);
    this.vbar.style.display = 'none';

    var self = this;
    this.vbar.addEventListener('pointerdown', function (e) {
      if (self.drag) return;
      e.preventDefault();
      e.stopPropagation();
      var vt = self.vThumbRect();
      var rect = self.pane.getBoundingClientRect();
      var y = e.clientY - rect.top;
      if (y < vt.y || y > vt.y + vt.h) {
        // 点滑块以外的轨道 → 翻一屏
        self.scrollYBy(y < vt.y ? -self.contentH() : self.contentH());
        return;
      }
      self.drag = { kind: 'vscroll', startY: y, startScroll: self.scrollY };
      self.vbar.classList.add('drag');
      self.onPointerMove(e);
    });

    // 面板尺寸变化（窗口缩放 / 折叠工具栏）→ 重新算布局与滚动条
    if (global.ResizeObserver) {
      this._ro = new ResizeObserver(function () { self.requestRender(); });
      this._ro.observe(this.pane);
    }

    // 提示条
    this.hint = document.createElement('div');
    this.hint.className = 'ag-hint';
    this.hint.textContent = '标尺选小节 · Shift+拖标尺设循环 · 右键音块出菜单 · 滚轮上下滚音轨';
    this.pane.appendChild(this.hint);
    this.pane.classList.add('readonly');

    this.render();
  };

  /* ================= 视图模式 ================= */

  /**
   * 是否只读：**只有总览是只读**。
   * 单轨编辑有两种鼠标模式（框选 / 添加），两种都允许改谱 ——
   * 区别只在「空白处点一下」是加音还是清选区。
   */
  ArrangerEditor.prototype.isReadOnly = function () {
    return this.viewMode !== 'track';
  };

  /** 当前鼠标模式是不是「点击添加」 */
  ArrangerEditor.prototype.isAddTool = function () {
    return this.editTool === 'add';
  };

  /**
   * 切换单轨编辑的鼠标模式。
   * 'select' 框选：空白处拖动 = 框选音块，选区可整组横/纵移动，Delete 删选区；
   * 'add'   添加：空白处左键点击 = 直接加音（等价于原来勾上「允许修改」）。
   */
  ArrangerEditor.prototype.setEditTool = function (tool) {
    this.editTool = tool === 'add' ? 'add' : 'select';
    this.pane.classList.toggle('readonly', this.isReadOnly());
    this.render();
    if (this.onToolChange) this.onToolChange(this.editTool);
  };

  /** 当前编辑的轨（单轨模式下） */
  ArrangerEditor.prototype.editTrack = function () {
    if (this.viewMode !== 'track') return null;
    return this.arr.getTrack(this.editTrackIndex);
  };

  /** 进入单轨编辑 */
  ArrangerEditor.prototype.enterTrackEdit = function (trackIndex) {
    if (trackIndex < 0 || trackIndex >= this.arr.trackCount()) return false;
    this.viewMode = 'track';
    this.editTrackIndex = trackIndex;
    // 单轨编辑可改谱（框选 / 添加 两种鼠标模式），不再有「上锁」这一步
    this.pane.classList.remove('readonly');
    this.arr.setActiveTrack(trackIndex);
    // 单轨编辑时音域按该轨实际音高铺满整屏
    var t = this.arr.getTrack(trackIndex);
    if (t && t.role !== 'drum') {
      var rng = this.trackRange(t);
      /* 滑音的起始音高也要算进视野：否则前块会被压在视图边缘，
         看起来像「滑音没生效」。 */
      t.notes.forEach(function (nn) {
        var f = parseFloat(nn.glideFrom);
        if (isFinite(f)) {
          rng.top = Math.max(rng.top, f);
          rng.bottom = Math.min(rng.bottom, f);
        }
      });
      var span = rng.top - rng.bottom;
      /* 音域很窄的轨（就两三个音）别把一屏全让给那几个半音：
         至少铺一个八度，否则行高巨大、音块糊满整屏，反而不好看也不好拖。 */
      if (span < MIN_PITCH_SPAN * 2) {
        var mid = (rng.top + rng.bottom) / 2;
        span = MIN_PITCH_SPAN * 2;
        rng = { top: mid + span / 2, bottom: mid - span / 2 };
      }
      var top = Math.round(rng.top), bot = Math.round(rng.bottom);
      // 贴到 0/127 边界时整体挪回来（跨度不变）
      if (top > 127) { bot -= top - 127; top = 127; }
      if (bot < 0) { top -= bot; bot = 0; }
      this.pitchTop = U.clamp(top, 1, 127);
      this.pitchBottom = U.clamp(bot, 0, 126);
    } else {
      this.pitchTop = 84;
      this.pitchBottom = 36;
    }
    // 纵向缩放的基准跨度（进编辑时看到的这一屏），之后的 +/- 都以它为基准
    this._zoomYBase = Math.max(1, this.pitchTop - this.pitchBottom);
    this.zoomY = 1;
    this.scrollToBar(this.arr.targetBar, true);
    this.arr.clearSelection();
    this.clearHotRows();          // 换轨后旧的高亮行不能留在新轨上
    this.render();
    this.onEditModeChange('track', trackIndex);
    return true;
  };

  /** 退出单轨编辑，回到总览 */
  ArrangerEditor.prototype.exitTrackEdit = function () {
    this.stopAudition();
    this.viewMode = 'overview';
    this.editTrackIndex = -1;
    this.pane.classList.add('readonly');
    this.arr.clearSelection();
    this.pitchTop = 84;
    this.pitchBottom = 36;
    this.zoomY = 1;
    this._zoomYBase = 0;
    this._hotKeys = {};
    this.scrollToBar(this.arr.targetBar, true);
    this.render();
    this.onEditModeChange('overview', -1);
  };

  /* ================= 坐标换算 ================= */

  /** 某轨的音高范围（合成器轨按实际音高，鼓轨按鼓位） */
  ArrangerEditor.prototype.trackRange = function (track) {
    if (track.role === 'drum') return { top: 12, bottom: 0 };
    var mn = 999, mx = 0;
    track.notes.forEach(function (n) {
      if (typeof n.pitch === 'number') {
        if (n.pitch < mn) mn = n.pitch;
        if (n.pitch > mx) mx = n.pitch;
      }
    });
    if (mn > mx) { mn = this.pitchBottom; mx = this.pitchTop; }
    // 上下各留 2 个半音，避免音块贴边
    return { top: Math.min(127, mx + 2), bottom: Math.max(0, mn - 2) };
  };

  /** 顶部表头总高（标尺 + 和弦轨） */
  ArrangerEditor.prototype.headerH = function () {
    return this.rulerH + this.chordH;
  };

  /** 拍 → 像素 x（含左侧琴键栏） */
  ArrangerEditor.prototype.xOf = function (beat) {
    return this.gutterW + (beat - this.scrollBeat) * this.pxPerBeat;
  };

  /** 像素 x → 拍 */
  ArrangerEditor.prototype.beatOf = function (x) {
    return (x - this.gutterW) / this.pxPerBeat + this.scrollBeat;
  };

  /** 可见拍数 */
  ArrangerEditor.prototype.visibleBeats = function () {
    var w = Math.max(1, this.pane.clientWidth - this.gutterW);
    return w / this.pxPerBeat;
  };

  /* ---------- 纵向几何（唯一映射） ----------
   * ⚠️ 必须只有这一套换算：
   *   音块渲染用 bandH（面板高度均分），而点击换算以前用 laneHeight()
   *   = 半音数 × rowH —— 两者毫无关系，于是「点哪不加哪」：
   *   48 半音、rowH=13 时 laneHeight≈637px，面板只有 400px 就会偏 1/3 屏。
   *   现在渲染与命中都走 yInBand / pitchAt，bandH 由调用方传入同一值。 */

  /** 谱面内容区（去掉表头与滚动条）的高度 */
  ArrangerEditor.prototype.contentH = function () {
    return Math.max(1, this.pane.clientHeight - this.headerH() - SCROLLBAR_H);
  };

  /** 内容区底部 y */
  ArrangerEditor.prototype.contentBottom = function () {
    return this.headerH() + this.contentH();
  };

  var DRUM_ROW_H = 15;      // 鼓组内每面鼓的最小行高
  var SYNTH_MIN_H = 76;     // 声部轨最小带高（名称行 + 混音行）
  /* 纵向缩放的边界（跨度 = pitchTop - pitchBottom，单位半音）：
     太小 → 一个音块占满半屏；太大 → 又回到「音块几像素高」的老问题。 */
  var MIN_PITCH_SPAN = 6;   // 最多放大到 6 个半音（7 行）铺满一屏
  var MAX_PITCH_SPAN = 96;  // 最多缩小到 96 个半音（8 个八度）铺满一屏

  /**
   * 纵向布局（唯一真值）：每个可见轨一条带，鼓组带更高（12 面鼓各一行）。
   * 左侧音轨列与右侧音块区都读这份布局 → 名称与音块必然对齐。
   *
   * 多轨时**不再等比压缩**（压缩后音块挤成一条线、点哪都点不准）：
   * 每条轨保持最小高度，装不下就走纵向滚动（scrollY + 右侧滚动条）。
   * @returns {Array<{ti:number, vi:number, top:number, h:number}>}
   */
  ArrangerEditor.prototype.layoutBands = function () {
    var tracks = this.visibleTracks();
    var n = tracks.length;
    var H = this.contentH();
    var top0 = this.headerH();
    var roles = tracks.map(function (t) { return t.role === 'drum' ? 'd' : 's'; }).join('');
    var key = this.viewMode + ':' + this.editTrackIndex + ':' + n + ':' + H + ':' + roles + ':' + this.scrollY;
    if (this._bands && this._bandKey === key) return this._bands;

    var out = [];
    var total = H;
    if (n) {
      var mins = tracks.map(function (t) {
        return t.role === 'drum' ? Math.max(DRUM_ORDER.length * DRUM_ROW_H, 120) : SYNTH_MIN_H;
      });
      var sum = 0, i;
      mins.forEach(function (m) { sum += m; });
      // 放得下：均分剩余空间；放不下：保持最小高度，用纵向滚动
      var heights = sum > H
        ? mins.slice()
        : mins.map(function (m) { return m + (H - sum) / n; });
      total = Math.max(H, sum);
      this._contentTotalH = total;
      this._maxScrollY = Math.max(0, total - H);
      this.scrollY = U.clamp(this.scrollY, 0, this._maxScrollY);

      var y = top0 - this.scrollY;
      for (i = 0; i < n; i++) {
        var h = Math.max(1, Math.round(heights[i]));
        if (i === n - 1) h = Math.max(1, top0 + total - this.scrollY - y);
        out.push({ ti: this.origIndexOf(i), vi: i, top: y, h: h });
        y += h;
      }
    } else {
      this._contentTotalH = H;
      this._maxScrollY = 0;
    }
    this._bands = out;
    this._bandKey = key;
    return out;
  };

  /** 是否需要纵向滚动条 */
  ArrangerEditor.prototype.hasVScroll = function () {
    this.layoutBands();          // 顺便刷新 _maxScrollY
    return this._maxScrollY > 0.5;
  };

  /** 纵向滚动（像素）；不传就只做边界收敛 */
  ArrangerEditor.prototype.scrollYBy = function (dy) {
    this.layoutBands();
    var next = U.clamp(this.scrollY + (dy || 0), 0, this._maxScrollY);
    if (next === this.scrollY) return false;
    this.scrollY = next;
    this._bands = null;
    this.render();
    return true;
  };

  /** 右侧纵向滚动条的轨道矩形 */
  ArrangerEditor.prototype.vScrollbarRect = function () {
    var w = this.pane.clientWidth;
    return {
      x: w - this.vScrollW, y: this.headerH(),
      w: this.vScrollW, h: Math.max(1, this.contentH())
    };
  };

  /** 纵向滚动条滑块 */
  ArrangerEditor.prototype.vThumbRect = function () {
    var r = this.vScrollbarRect();
    if (!this.hasVScroll()) return { x: r.x, y: r.y, w: r.w, h: 0 };
    var ratio = Math.min(1, r.h / Math.max(1, this._contentTotalH));
    var h = Math.max(24, r.h * ratio);
    var track = r.h - h;
    var y = r.y + track * U.clamp(this.scrollY / Math.max(1, this._maxScrollY), 0, 1);
    return { x: r.x, y: y, w: r.w, h: h };
  };

  /** 第 vi 个可见轨的纵向带：{ top(overlay 像素), h }（count 仅为兼容旧调用） */
  ArrangerEditor.prototype.bandRect = function (vi, count) {
    var bands = this.layoutBands();
    if (!bands.length) {
      var h = this.contentH() / Math.max(1, count || 1);
      return { top: this.headerH() + vi * h, h: h };
    }
    return bands[U.clamp(vi, 0, bands.length - 1)];
  };

  /**
   * 这条轨的纵向音高窗口（渲染与命中必须同源）：
   *   · 单轨编辑：用视图缩放后的 pitchTop/pitchBottom（纵向缩放改的就是它）
   *   · 总览：用该轨自己的音域（每条带各画各的音高，音块才不会被压扁）
   */
  ArrangerEditor.prototype.pitchRng = function (track) {
    if (this.viewMode === 'track' || !track) {
      return { top: this.pitchTop, bottom: this.pitchBottom };
    }
    return this.trackRange(track);
  };

  /** 波浪线 path：在 [x, x+w] 之间以 amp 为振幅折返（颤音标注） */
  function wavePath(x, y, w, amp, step) {
    step = step || 5;
    var n = Math.max(2, Math.round(w / step));
    var d = '';
    for (var i = 0; i <= n; i++) {
      var px = x + w * i / n;
      var py = y + (i % 2 === 0 ? -amp : amp);
      d += (i === 0 ? 'M ' : ' L ') + px.toFixed(1) + ' ' + py.toFixed(1);
    }
    return d;
  }

  /** 音高/鼓位 → 带内 y（相对该带顶部） */
  ArrangerEditor.prototype.yInBand = function (track, pitch, bandH) {
    bandH = Math.max(1, bandH || this.contentH());
    if (track && track.role === 'drum') {
      var id = typeof pitch === 'string' ? pitch : DRUM_PITCH_TO_ID[pitch];
      var idx = DRUM_ORDER.indexOf(id);
      if (idx < 0) idx = DRUM_ORDER.length - 1;
      return (idx / DRUM_ORDER.length) * bandH;
    }
    /* 行数 = 半音跨度 + 1：顶音占第 0 行、底音占最后一行，
       这样「音块高度 = 一行」与「网格行高」是同一个数，缩放后不会错位。 */
    var rng = this.pitchRng(track);
    var rows = Math.max(1, rng.top - rng.bottom + 1);
    var ratio = (rng.top - pitch) / rows;
    return U.clamp(ratio, 0, 1) * bandH;
  };

  /** 带内 y → 音高/鼓位 */
  ArrangerEditor.prototype.pitchAt = function (track, yInBand, bandH) {
    bandH = Math.max(1, bandH || this.contentH());
    var r = U.clamp(yInBand / bandH, 0, 0.9999);
    if (track && track.role === 'drum') {
      var idx = Math.floor(r * DRUM_ORDER.length);
      return ID_TO_DRUM_PITCH[DRUM_ORDER[U.clamp(idx, 0, DRUM_ORDER.length - 1)]];
    }
    var rng = this.pitchRng(track);
    var rows = Math.max(1, rng.top - rng.bottom + 1);
    var row = Math.floor(r * rows);
    return Math.round(U.clamp(rng.top - row, 0, 127));
  };

  /** 兼容旧调用：整个内容区的纵向像素总数 */
  ArrangerEditor.prototype.laneHeight = function () {
    return this.contentH();
  };

  /* ================= 渲染 ================= */

  /** 当前应显示的轨：总览显示全部，单轨模式只显示编辑中的那一轨 */
  ArrangerEditor.prototype.visibleTracks = function () {
    var all = this.arr.getTracks();
    if (this.viewMode === 'track') {
      var t = all[this.editTrackIndex];
      return t ? [t] : [];
    }
    return all;
  };

  /** 可见轨在数组里的原始索引（用于事件回传） */
  ArrangerEditor.prototype.origIndexOf = function (visibleIndex) {
    if (this.viewMode === 'track') return this.editTrackIndex;
    return visibleIndex;
  };

  ArrangerEditor.prototype.render = function () {
    // 布局随面板尺寸/轨数变化，每次重绘都重新校验一次（内部有 key 缓存）
    this._bands = null;
    this.renderCanvas();
    this.renderBlocks();
    this.renderHotRows();     // 缩放/滚动/切轨后高亮行要跟着重新对位
    this.renderTrackCol();
    this.updateVScrollbar();
  };

  /** 纵向滚动条：位置/显隐跟着布局与滚动走 */
  ArrangerEditor.prototype.updateVScrollbar = function () {
    if (!this.vbar) return;
    var need = this.hasVScroll();
    this.vbar.style.display = need ? 'block' : 'none';
    if (!need) return;
    var vr = this.vScrollbarRect();
    var vt = this.vThumbRect();
    this.vbar.style.top = vr.y + 'px';
    this.vbar.style.height = vr.h + 'px';
    this.vscrollThumb.style.top = Math.round(vt.y - vr.y) + 'px';
    this.vscrollThumb.style.height = Math.round(vt.h) + 'px';
  };

  /**
   * 智能重绘：拖动中合并到下一帧（每个 pointermove 都重建 DOM 会掉帧），
   * 非拖动状态立即同步绘制（外部调用方/测试可以立刻读到 DOM）。
   */
  ArrangerEditor.prototype.requestRender = function () {
    if (!this.drag) { this.render(); return; }
    if (this._rafPending) return;
    var self = this;
    this._rafPending = requestAnimationFrame(function () {
      self._rafPending = 0;
      self.render();
    });
  };

  ArrangerEditor.prototype.isDragging = function () { return !!this.drag; };

  ArrangerEditor.prototype.renderCanvas = function () {
    var cv = this.canvas;
    var w = this.pane.clientWidth, h = this.pane.clientHeight;
    if (!w || !h) return;
    var dpr = global.devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    cv.style.width = w + 'px';
    cv.style.height = h + 'px';
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    var arr = this.arr;
    var bb = arr.barBeats();
    var totalBeats = arr.totalBeats();
    var ruler = this.rulerH;
    var headH = this.headerH();
    var bottom = this.contentBottom();
    var gx = this.gutterW;
    var tracks = this.visibleTracks();
    var bandCount = Math.max(1, tracks.length);

    /* 横向缩放够大时，「拍」（1/4 音符）刻度才画得开：
       每拍不足 ~24px 时虚线会糊成一片，这时退回原来的极淡实线当纹理。 */
    var showBeatGrid = this.pxPerBeat >= 24;

    // --- 循环区间底色 ---
    if (arr.loop) {
      var lx0 = this.xOf(arr.loop.start * bb);
      var lx1 = this.xOf(arr.loop.end * bb);
      ctx.fillStyle = 'rgba(99,179,237,.07)';
      ctx.fillRect(Math.max(gx, lx0), headH, Math.max(0, Math.min(w, lx1) - Math.max(gx, lx0)), bottom - headH);
    }

    // --- 目标小节整列高亮（一眼可见「会填哪一小节」） ---
    var tx0 = this.xOf(arr.targetBar * bb);
    var tx1 = this.xOf((arr.targetBar + 1) * bb);
    ctx.fillStyle = 'rgba(79,209,197,.12)';
    ctx.fillRect(Math.max(gx, tx0), headH, Math.max(0, Math.min(w, tx1) - Math.max(gx, tx0)), bottom - headH);

    // --- 纵向音高网格 ---
    ctx.lineWidth = 1;
    for (var ti = 0; ti < tracks.length; ti++) {
      var tr = tracks[ti];
      var band = this.bandRect(ti, bandCount);
      var rng = tr.role === 'drum' ? null : this.trackRange(tr);
      if (!rng) continue;
      for (var p = Math.ceil(rng.bottom / 3) * 3; p <= rng.top; p += 3) {
        var ratio = (rng.top - p) / Math.max(1, rng.top - rng.bottom);
        var yy = Math.round(band.top + ratio * band.h) + 0.5;
        if (yy < band.top || yy > band.top + band.h) continue;
        if (yy < headH || yy > bottom) continue;     // 纵向滚动后别画到表头/滚动条上
        var isC = (p % 12 === 0);
        ctx.strokeStyle = isC ? 'rgba(255,255,255,.15)' : 'rgba(255,255,255,.045)';
        ctx.beginPath();
        ctx.moveTo(gx, yy);
        ctx.lineTo(w, yy);
        ctx.stroke();
      }
    }
    // 鼓轨行分隔
    for (var di = 0; di < tracks.length; di++) {
      if (tracks[di].role !== 'drum') continue;
      var bd = this.bandRect(di, bandCount);
      if (bd.top + bd.h < headH || bd.top > bottom) continue;
      ctx.strokeStyle = 'rgba(255,255,255,.055)';
      for (var k = 1; k < DRUM_ORDER.length; k++) {
        var dy = Math.round(bd.top + (k / DRUM_ORDER.length) * bd.h) + 0.5;
        if (dy < headH || dy > bottom) continue;
        ctx.beginPath(); ctx.moveTo(gx, dy); ctx.lineTo(w, dy); ctx.stroke();
      }
    }

    // --- 小节线 ---
    var startBeat = Math.max(0, Math.floor(this.scrollBeat / bb) * bb);
    for (var b = startBeat; b <= totalBeats + bb; b += bb) {
      var x = Math.round(this.xOf(b)) + 0.5;
      if (x < gx - 2 || x > w + 2) continue;
      ctx.strokeStyle = 'rgba(255,255,255,.18)';
      ctx.beginPath(); ctx.moveTo(x, headH); ctx.lineTo(x, bottom); ctx.stroke();
    }
    /* --- 1/4 音符（每拍）刻度线 ---
       横向放大后画成虚线：一眼能分清「小节线（实） / 拍线（虚）」，
       数时值、对齐音符都更有参照。缩得小时拍线会挤在一起，保持淡实线即可。 */
    if (showBeatGrid) {
      ctx.save();
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = 'rgba(255,255,255,.15)';
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,.05)';
    }
    for (var t = startBeat; t <= totalBeats + bb; t += 1) {
      var txx = Math.round(this.xOf(t)) + 0.5;
      if (txx < gx || txx > w) continue;
      // 小节起点跳过：那里已有实线小节线，再叠一条虚线会把小节线切碎
      if (showBeatGrid && Math.abs(t - Math.round(t / bb) * bb) < 1e-6) continue;
      ctx.beginPath(); ctx.moveTo(txx, headH); ctx.lineTo(txx, bottom); ctx.stroke();
    }
    if (showBeatGrid) ctx.restore();

    // --- 表头底色 + 分隔线 ---
    ctx.fillStyle = '#0a0f14';
    ctx.fillRect(0, 0, w, ruler);
    ctx.fillStyle = '#0b1117';
    ctx.fillRect(gx, ruler, w - gx, this.chordH);
    ctx.strokeStyle = 'rgba(255,255,255,.16)';
    ctx.beginPath(); ctx.moveTo(0, ruler + 0.5); ctx.lineTo(w, ruler + 0.5); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, headH + 0.5); ctx.lineTo(w, headH + 0.5); ctx.stroke();

    // 循环区间在标尺上的条
    if (arr.loop) {
      var ax0 = Math.max(gx, this.xOf(arr.loop.start * bb));
      var ax1 = Math.min(w, this.xOf(arr.loop.end * bb));
      ctx.fillStyle = 'rgba(99,179,237,.55)';
      ctx.fillRect(ax0, 0, Math.max(0, ax1 - ax0), 3);
    }

    // --- 标尺刻线 ---
    for (var bb2 = startBeat; bb2 <= totalBeats + bb; bb2 += bb) {
      var sx = Math.round(this.xOf(bb2)) + 0.5;
      if (sx < gx || sx > w) continue;
      ctx.strokeStyle = 'rgba(255,255,255,.26)';
      ctx.beginPath(); ctx.moveTo(sx, ruler - 5); ctx.lineTo(sx, ruler); ctx.stroke();
    }
    /* 拍刻度：横向放大后才出现，比小节刻线短一截，与谱面上的虚线拍线配套。
       小节起点已经有刻线，跳过。 */
    if (showBeatGrid) {
      ctx.strokeStyle = 'rgba(255,255,255,.20)';
      for (var bt = startBeat; bt <= totalBeats + bb; bt += 1) {
        if (Math.abs(bt - Math.round(bt / bb) * bb) < 1e-6) continue;
        var btx = Math.round(this.xOf(bt)) + 0.5;
        if (btx < gx || btx > w) continue;
        ctx.beginPath(); ctx.moveTo(btx, ruler - 3); ctx.lineTo(btx, ruler); ctx.stroke();
      }
    }

    /* --- 标尺文字：段落名（上）+ 小节号（下） ---
       ⚠️ 必须画在表头底色之后：底色 fillRect(0,0,w,ruler) 会把先画的文字整片盖掉。 */

    // 段落色带：从本段段首铺到下一段段首（末段铺到曲末），结构块一眼可见
    var secs = arr.sections || [];
    for (var si = 0; si < secs.length; si++) {
      var bandFrom = this.xOf(secs[si].bar * bb);
      var bandTo = this.xOf((si + 1 < secs.length ? secs[si + 1].bar : arr.lengthBars) * bb);
      var bx0 = Math.max(gx, bandFrom), bx1 = Math.min(w, bandTo);
      if (bx1 <= gx || bx0 >= w) continue;
      ctx.fillStyle = si % 2 ? 'rgba(79,209,197,.05)' : 'rgba(79,209,197,.09)';
      ctx.fillRect(bx0, 0, bx1 - bx0, ruler);
    }

    var labelFrom = Math.max(0, Math.floor(this.scrollBeat / bb));
    var labelTo = Math.min(arr.lengthBars, labelFrom + Math.ceil(this.visibleBeats() / bb) + 1);
    for (var lb = labelFrom; lb <= labelTo; lb++) {
      var lx = Math.round(this.xOf(lb * bb));
      if (lx > w || lx < gx - 2) continue;
      var sec = arr.sectionAt(lb);
      if (sec && sec.name) {
        // 段落起点：左侧竖条 + 名称（截断 6 字，避免压到下一小节号）
        ctx.fillStyle = 'rgba(79,209,197,.9)';
        ctx.fillRect(lx + 1, 3, 2, ruler - 4);
        ctx.fillStyle = '#9ff0e6';
        ctx.font = '9px ui-monospace, monospace';
        ctx.fillText(sec.name.slice(0, 6), lx + 5, 10);
      }
      ctx.fillStyle = 'rgba(255,255,255,.62)';
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillText(String(lb + 1), lx + 4, ruler - 3);
    }

    // --- 和弦轨：每小节一格 ---
    var cellStart = Math.max(0, Math.floor(this.scrollBeat / bb));
    var cellEnd = Math.min(arr.lengthBars, Math.ceil((this.scrollBeat + this.visibleBeats()) / bb) + 1);
    for (var cb = cellStart; cb < cellEnd; cb++) {
      var cx0 = Math.max(gx, this.xOf(cb * bb));
      var cx1 = Math.min(w, this.xOf((cb + 1) * bb));
      if (cx1 <= gx || cx0 >= w) continue;
      var chord = arr.getChord(cb);
      ctx.fillStyle = chord ? 'rgba(79,209,197,.14)' : 'rgba(255,255,255,.025)';
      ctx.fillRect(cx0 + 1, ruler + 3, Math.max(0, cx1 - cx0 - 2), this.chordH - 6);
      ctx.strokeStyle = 'rgba(255,255,255,.08)';
      ctx.strokeRect(cx0 + 1.5, ruler + 3.5, Math.max(0, cx1 - cx0 - 3), this.chordH - 7);
      if (chord && cx1 - cx0 > 26) {
        ctx.fillStyle = '#9ff0e6';
        ctx.font = '11px ui-monospace, monospace';
        ctx.fillText(arr.chordLabel(cb), cx0 + 4, ruler + this.chordH - 8);
      }
      if (cb === arr.targetBar) {
        ctx.strokeStyle = 'rgba(79,209,197,.9)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(cx0 + 1.5, ruler + 3.5, Math.max(0, cx1 - cx0 - 3), this.chordH - 7);
        ctx.lineWidth = 1;
      }
    }

    // --- 左侧栏：每条轨在自己的带内画自己的刻度（鼓组 = 12 面鼓名，声部轨 = 琴键） ---
    ctx.fillStyle = '#0c1218';
    ctx.fillRect(0, headH, gx, bottom - headH);
    ctx.strokeStyle = 'rgba(255,255,255,.14)';
    ctx.beginPath(); ctx.moveTo(gx + 0.5, 0); ctx.lineTo(gx + 0.5, bottom); ctx.stroke();

    var bands = this.layoutBands();
    // 轨带分隔线（贯穿整行，先画，不受左侧裁切影响）
    for (var bj = 1; bj < bands.length; bj++) {
      var sepY = Math.round(bands[bj].top) + 0.5;
      if (sepY < headH || sepY > bottom) continue;
      ctx.strokeStyle = 'rgba(255,255,255,.12)';
      ctx.beginPath(); ctx.moveTo(0, sepY); ctx.lineTo(w, sepY); ctx.stroke();
    }
    // 左侧刻度（鼓名 / 琴键）：裁到内容区，纵向滚动时不会画到表头与滚动条上
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, headH, gx, Math.max(1, bottom - headH));
    ctx.clip();
    for (var bi = 0; bi < bands.length; bi++) {
      var bnd = bands[bi];
      var trI = tracks[bi];
      if (!trI) continue;
      if (bnd.top + bnd.h <= headH || bnd.top >= bottom) continue;   // 完全滚出去的轨不画
      if (trI.role === 'drum') {
        var rowH = bnd.h / DRUM_ORDER.length;
        for (var di2 = 0; di2 < DRUM_ORDER.length; di2++) {
          var id2 = DRUM_ORDER[di2];
          var ry = bnd.top + (di2 + 0.5) * rowH;
          if (ry < headH - rowH || ry > bottom + rowH) continue;
          if (di2 % 2 === 0) {
            ctx.fillStyle = 'rgba(255,255,255,.022)';
            ctx.fillRect(0, bnd.top + di2 * rowH, gx, rowH);
          }
          ctx.fillStyle = 'rgba(255,255,255,.62)';
          ctx.font = (rowH >= 13 ? '10px' : '9px') + ' ui-monospace, monospace';
          ctx.fillText(String(DRUM_LABEL[id2] || id2).slice(0, 4), 3, ry + 3);
        }
      } else {
        var rng2 = this.pitchRng(trI);
        var rows2 = Math.max(1, rng2.top - rng2.bottom + 1);
        var kh = bnd.h / rows2;
        for (var pc = rng2.top; pc >= rng2.bottom; pc--) {
          var ky = bnd.top + (rng2.top - pc) * kh;
          if (ky > bnd.top + bnd.h) break;
          if (ky + kh < headH || ky > bottom) continue;
          var isBlack = [1, 3, 6, 8, 10].indexOf(((pc % 12) + 12) % 12) >= 0;
          ctx.fillStyle = isBlack ? '#141b23' : '#cfd8e0';
          ctx.fillRect(isBlack ? 0 : 2, ky, isBlack ? gx * 0.62 : gx - 4, Math.max(1, kh - 0.6));
          if (pc % 12 === 0 && kh > 7) {
            ctx.fillStyle = '#0a0f14';
            ctx.font = '8px ui-monospace, monospace';
            ctx.fillText(BS.pitch.midiToName(pc), gx - 17, ky + kh - 2);
          }
        }
      }
    }
    ctx.restore();

    // --- 横向滚动条 ---
    var sRect = this.scrollbarRect();
    ctx.fillStyle = 'rgba(255,255,255,.05)';
    ctx.fillRect(sRect.x, sRect.y, sRect.w, sRect.h);
    var thumb = this.thumbRect();
    ctx.fillStyle = 'rgba(255,255,255,.24)';
    ctx.fillRect(thumb.x, thumb.y, Math.max(18, thumb.w), thumb.h);
    // 纵向滚动条是 DOM（.ag-vscroll），见 updateVScrollbar()
  };

  /** 滚动条轨道 / 滑块矩形 */
  ArrangerEditor.prototype.scrollbarRect = function () {
    var w = this.pane.clientWidth, h = this.pane.clientHeight;
    return { x: this.gutterW, y: h - SCROLLBAR_H + 1, w: Math.max(1, w - this.gutterW), h: SCROLLBAR_H - 2 };
  };
  ArrangerEditor.prototype.thumbRect = function () {
    var r = this.scrollbarRect();
    var total = Math.max(1, this.arr.totalBeats());
    var vis = Math.min(total, this.visibleBeats());
    var w = Math.max(18, r.w * (vis / total));
    var x = r.x + (r.w - w) * U.clamp(this.scrollBeat / Math.max(1e-6, total - vis), 0, 1);
    return { x: x, y: r.y, w: w, h: r.h };
  };

  ArrangerEditor.prototype.renderBlocks = function () {
    var self = this;
    // 只清音块层：交互层要留着挂事件，清空 overlay 会把标尺/滚动条的事件面一起抹掉
    this.blockLayer.innerHTML = '';
    this.selBox = null;
    var arr = this.arr;
    var tracks = this.visibleTracks();
    if (!tracks.length) return;

    var bandCount = tracks.length;
    var paneW = this.pane.clientWidth;

    var headH = this.headerH();
    var bottom = this.contentBottom();

    tracks.forEach(function (track, vi) {
      var ti = self.origIndexOf(vi);   // 可见索引 → 原始轨索引
      var rect = self.bandRect(vi, bandCount);
      var bandTop = rect.top;
      var bandH = rect.h;
      // 纵向滚动：整条带都在视野外就跳过（音块一个都不建，滚多轨也不卡）
      if (bandTop + bandH <= headH || bandTop >= bottom) return;

      /* 音高窗口与行高按**带**算一次就够：以前写在 notes.forEach 里，
         总览时每条音块都要重新扫一遍该轨音域（O(n²)），轨一长就明显卡。 */
      var rngB = self.pitchRng(track);
      var rowsB = Math.max(1, rngB.top - rngB.bottom + 1);
      var rowHB = Math.max(5, Math.round(bandH / rowsB) - 1);

      /* 标注数据：滑音弧线 / 颤音波浪线，渲染完音块后统一画到 SVG 层 */
      var arcs = [], waves = [];

      track.notes.forEach(function (n) {
        var sel = arr.isSelected(n.id);
        var vel = n.vel === undefined ? 0.85 : n.vel;
        var baseColor = track.color || '#4fd1c5';

        var x = self.xOf(n.beat);
        var w = Math.max(4, n.len * self.pxPerBeat);
        if (x + w < self.gutterW - 20 || x > paneW + 20) return;   // 视野外

        /* 建一块（或半块）。part: 'a' 前块 / 'b' 后块 / '' 整块。
           前块不给左右缩放手柄：它的右缘是「滑音分割点」，由专用手柄管。 */
        function mk(part, left, width, pitch) {
          var el = document.createElement('div');
          el.className = 'ag-block' + (sel ? ' sel' : '') + (part ? ' ag-glide-' + part : '');
          el.dataset.id = n.id;
          el.dataset.ti = ti;
          if (part) el.dataset.part = part;
          el.style.background = baseColor;
          el.style.setProperty('--bc', baseColor);

          var yInBand, h;
          if (track.role === 'drum') {
            yInBand = self.yInBand(track, pitch, bandH);
            h = Math.max(4, bandH / DRUM_ORDER.length * 0.55);
          } else {
            /* 音块正好占一行（减 1px 留缝）：纵向缩放后行高变大，音块跟着变高，
               不会再出现「太窄点不中」；同时和左侧琴键/网格始终对齐。 */
            yInBand = U.clamp((rngB.top - pitch) / rowsB, 0, 1) * bandH;
            h = rowHB;
          }
          el.style.height = h + 'px';
          el.style.left = left + 'px';
          el.style.top = (bandTop + yInBand) + 'px';
          el.style.width = width + 'px';
          if (!sel) el.style.opacity = (0.42 + 0.58 * vel).toFixed(2);
          if (sel && part !== 'a') {
            var hl = document.createElement('i'); hl.className = 'ag-h l';
            var hr = document.createElement('i'); hr.className = 'ag-h r';
            el.appendChild(hl); el.appendChild(hr);
          }
          return { el: el, y: yInBand, h: h };
        }

        var pitchName = track.role === 'drum'
          ? (DRUM_LABEL[DRUM_PITCH_TO_ID[n.pitch]] || n.pitch)
          : BS.pitch.midiToName(n.pitch);
        var ttl = pitchName +
          ' · ' + n.beat.toFixed(3) + ' 拍 · 力度 ' + Math.round(vel * 127) +
          (n.vib > 0 ? ' · 颤音 ' + Math.round(n.vib * 100) + '%@' +
            (n.vibRate > 0 ? n.vibRate : 5.5) + 'Hz' : '');

        /* 滑音分块：glideFrom 与 pitch 不同 → 切成两块，中间弧线连接 */
        var parts = self.glideParts(track, n);
        if (parts) {
          var pxPerSec = self.pxPerBeat * (self.arr.song.bpm / 60);
          var splitW = Math.max(2, parts.sec * pxPerSec);
          var tailW = Math.max(2, w - splitW);
          var a = mk('a', x, splitW, parts.from);
          var b = mk('b', x + splitW, tailW, parts.to);
          a.el.title = b.el.title = ttl + ' · 滑音 ' + parts.sec.toFixed(2) + 's（' +
            (track.role === 'drum' ? parts.from : BS.pitch.midiToName(parts.from)) +
            ' → ' + pitchName + '）';

          // 弧线：前块右缘中点 → 后块左缘中点（两块音高不同时是一道滑梯）
          arcs.push({
            x1: x + splitW, y1: bandTop + a.y + a.h / 2,
            x2: x + splitW, y2: bandTop + b.y + b.h / 2,
            sel: sel
          });
          self.blockLayer.appendChild(a.el);
          self.blockLayer.appendChild(b.el);

          /* 滑音分割手柄：左右拖动改「滑音占多长」（整块音总长不变），
             上下方向由两块自己负责（各自调音高）。 */
          var grip = document.createElement('i');
          grip.className = 'ag-glide-grip' + (sel ? ' sel' : '');
          grip.dataset.id = n.id;
          grip.dataset.ti = ti;
          grip.title = '左右拖动：调节滑音前后长度（整块音长不变）';
          var gy = Math.min(a.y, b.y), gh = Math.max(a.y + a.h, b.y + b.h) - gy;
          grip.style.left = (x + splitW - 4) + 'px';
          grip.style.top = (bandTop + gy - 5) + 'px';
          grip.style.height = (gh + 10) + 'px';
          self.blockLayer.appendChild(grip);

          // 颤音波浪线：前后两块各画一条（深度映射振幅）
          if (parts.vib > 0) {
            var amp = 2 + parts.vib * 5;
            waves.push({ x: x, y: bandTop + a.y + a.h / 2, w: splitW, amp: amp, sel: sel });
            waves.push({ x: x + splitW, y: bandTop + b.y + b.h / 2, w: tailW, amp: amp, sel: sel });
          }
        } else {
          var one = mk('', x, w, n.pitch);
          one.el.title = ttl + (n.glide > 0 ? ' · 滑音 ' + n.glide + 's' : '');
          self.blockLayer.appendChild(one.el);
          if (n.vib > 0) {
            waves.push({ x: x, y: bandTop + one.y + one.h / 2, w: w, amp: 2 + U.clamp(n.vib, 0, 1) * 5, sel: sel });
          }
        }
      });
      if (arcs.length || waves.length) self.renderArcs(arcs, waves);
      else self.renderArcs([], []);
    });
  };

  /** 当前纵向跨度（半音数），给界面显示/测试用 */
  ArrangerEditor.prototype.pitchSpan = function () {
    return Math.max(1, this.pitchTop - this.pitchBottom);
  };

  /**
   * 保证某个音高在纵向视野内（单轨编辑）。
   * 滑音起点被拖/设到视图外时自动扩视图，否则前块会压在边缘上看不见。
   */
  ArrangerEditor.prototype.ensurePitchVisible = function (pitch) {
    if (this.viewMode !== 'track' || !isFinite(pitch)) return false;
    var span = this.pitchSpan();
    var changed = false;
    if (pitch > this.pitchTop - 1) {
      this.pitchTop = Math.min(127, pitch + 1);
      this.pitchBottom = Math.max(0, this.pitchTop - span);
      changed = true;
    } else if (pitch < this.pitchBottom + 1) {
      this.pitchBottom = Math.max(0, pitch - 1);
      this.pitchTop = Math.min(127, this.pitchBottom + span);
      changed = true;
    }
    if (changed) this.render();
    return changed;
  };

  /**
   * 滑音分块信息。返回 null 表示「不切块」：
   *   · 鼓轨 / 没有 glide / 没有 glideFrom / glideFrom === pitch → 单块
   *   · 滑音时长 >= 音块时长 → 单块（没地方放后一块）
   */
  ArrangerEditor.prototype.glideParts = function (track, n) {
    if (!n || !track || track.role === 'drum') return null;
    var g = n.glide > 0 ? Math.min(n.glide, 2) : 0;
    if (!(g > 0)) return null;
    var f = parseFloat(n.glideFrom);
    if (!isFinite(f)) return null;
    var from = Math.round(U.clamp(f, 0, 127));
    if (from === n.pitch) return null;
    var lenSec = n.len * 60 / this.arr.song.bpm;
    if (!(lenSec > 0)) return null;
    var sec = Math.min(g, Math.max(0.02, lenSec - 0.02));
    if (!(sec > 0) || sec >= lenSec) return null;
    return { from: from, to: n.pitch, sec: sec, lenSec: lenSec, vib: U.clamp(n.vib || 0, 0, 1) };
  };

  /** 画滑音弧线 + 颤音波浪线（SVG 覆盖层，跟着 render 重建） */
  ArrangerEditor.prototype.renderArcs = function (arcs, waves) {
    if (!this.arcLayer) return;
    var svg = this.arcLayer;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    var w = this.pane.clientWidth, h = this.pane.clientHeight;
    if (!w || !h) return;
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);
    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    var NS = 'http://www.w3.org/2000/svg';

    (arcs || []).forEach(function (a) {
      var mx = (a.x1 + a.x2) / 2;
      // 两块同高时向上拱一道，不同高时也是一道向上的滑梯
      var lift = Math.abs(a.y2 - a.y1) < 1 ? 16 : Math.abs(a.y2 - a.y1) * 0.35 + 8;
      var cy = Math.min(a.y1, a.y2) - lift;
      var p = document.createElementNS(NS, 'path');
      p.setAttribute('d', 'M ' + a.x1.toFixed(1) + ' ' + a.y1.toFixed(1) +
        ' Q ' + mx.toFixed(1) + ' ' + cy.toFixed(1) +
        ' ' + a.x2.toFixed(1) + ' ' + a.y2.toFixed(1));
      p.setAttribute('class', 'ag-arc' + (a.sel ? ' sel' : ''));
      svg.appendChild(p);
    });

    (waves || []).forEach(function (wv) {
      var p = document.createElementNS(NS, 'path');
      p.setAttribute('d', wavePath(wv.x, wv.y, wv.w, wv.amp));
      p.setAttribute('class', 'ag-wave' + (wv.sel ? ' sel' : ''));
      svg.appendChild(p);
    });
  };

  /* ---------------- 演奏高亮行（键盘 / 鼓垫按下时点亮对应音高那一整行） ----------------
   * 只在单轨编辑里画：总览时一屏几十条轨，高亮谁都不清楚，反而添乱。
   * 用独立的 DOM 层而不是重画 canvas —— 弹奏时按键事件很密，
   * 每次都整屏重绘会掉帧；这里通常只改 1~3 个 div。 */

  /**
   * 按住一个「键」。key 用演奏层的 holdKey（同一个音高可能被多个键同时按住），
   * pitch 是谱面上的音高（鼓轨是鼓位对应的音高）。
   */
  ArrangerEditor.prototype.hotRowOn = function (key, pitch) {
    if (pitch === undefined || pitch === null || !isFinite(pitch)) return;
    if (this.viewMode !== 'track') return;      // 只有单轨编辑才点亮
    if (!this._hotKeys) this._hotKeys = {};
    this._hotKeys[key] = pitch;
    this.renderHotRows();
  };

  /** 松开某个键：按 key 精确移除，不会误灭同音高的另一个键 */
  ArrangerEditor.prototype.hotRowOff = function (key) {
    if (!this._hotKeys || !(key in this._hotKeys)) return;
    delete this._hotKeys[key];
    this.renderHotRows();
  };

  /** 全灭（停止试听/录制/切换轨时兜底，防止高亮行卡住不灭） */
  ArrangerEditor.prototype.clearHotRows = function () {
    if (!this._hotKeys || !Object.keys(this._hotKeys).length) {
      this.renderHotRows();
      return;
    }
    this._hotKeys = {};
    this.renderHotRows();
  };

  /** 当前按住的音高（去重），给渲染与测试用 */
  ArrangerEditor.prototype.hotPitches = function () {
    var out = [], seen = {};
    var keys = this._hotKeys || {};
    for (var k in keys) {
      var p = keys[k];
      if (p === undefined || p === null || seen['p' + p]) continue;
      seen['p' + p] = true;
      out.push(p);
    }
    return out;
  };

  /** 把按住的音画到谱面上：整行高亮（鼓轨 = 那一面鼓自己的行） */
  ArrangerEditor.prototype.renderHotRows = function () {
    if (!this.hotLayer) return;
    this.hotLayer.innerHTML = '';
    if (this.viewMode !== 'track') return;
    var track = this.editTrack();
    if (!track) return;
    var pitches = this.hotPitches();
    if (!pitches.length) return;

    var paneW = this.pane.clientWidth;
    var band = this.bandRect(0, 1);
    var isDrum = track.role === 'drum';
    var rng = this.pitchRng(track);
    var rows = Math.max(1, rng.top - rng.bottom + 1);
    // 行高与音块同源（减 1px 留缝），高亮正好框住那一行音块
    var rowH = isDrum
      ? band.h / DRUM_ORDER.length
      : Math.max(5, Math.round(band.h / rows) - 1);

    var headH = this.headerH(), bottomY = this.contentBottom();
    var left = this.gutterW;
    var width = Math.max(0, paneW - this.gutterW - this.vScrollW);

    pitches.forEach(function (p) {
      // 鼓轨上不是鼓位的音高（例如接了外部 MIDI 的奇怪音高）不画
      if (isDrum && DRUM_PITCH_TO_ID[p] === undefined) return;
      var y = band.top + this.yInBand(track, p, band.h);
      if (y + rowH <= headH || y >= bottomY) return;   // 缩放后按到视野外的行
      var row = document.createElement('div');
      row.className = 'ag-hotrow';
      row.style.top = Math.round(y) + 'px';
      row.style.height = Math.max(3, Math.round(rowH)) + 'px';
      row.style.left = left + 'px';
      row.style.width = width + 'px';
      this.hotLayer.appendChild(row);
    }, this);
  };

  ArrangerEditor.prototype.renderTrackCol = function () {
    var self = this;
    this.trackCol.innerHTML = '';
    var arr = this.arr;
    var bands = this.layoutBands();
    var tracks = this.visibleTracks();

    // 顶部占位：与标尺+和弦轨同高，第一行才会和右侧第一条轨带对齐
    var head = document.createElement('div');
    head.className = 'ag-col-head';
    head.style.height = this.headerH() + 'px';
    head.textContent = '音轨';
    this.trackCol.appendChild(head);

    /* 行视口：高度与右侧内容区完全一致（不含横向滚动条），负责裁掉滚出视野的行。
       ⚠️ 平移必须放在视口里面的那层（.ag-trows）上：
       以前直接把 translateY 加在唯一的行容器上，容器自己会跟着上移，
       overflow:hidden 只裁子元素、裁不到自己 —— 轨一多（滚动条出现后）
       上半截行就压在「音轨」表头上，左边一片错位。 */
    var rowsView = document.createElement('div');
    rowsView.className = 'ag-tview';
    rowsView.style.height = this.contentH() + 'px';
    this.trackCol.appendChild(rowsView);
    this._rowsView = rowsView;

    // 行容器：跟随右侧的纵向滚动一起上下平移（表头不动，超出部分被视口裁掉）
    var rowsWrap = document.createElement('div');
    rowsWrap.className = 'ag-trows';
    rowsWrap.style.transform = 'translateY(' + (-this.scrollY) + 'px)';
    rowsView.appendChild(rowsWrap);
    this._rowsWrap = rowsWrap;

    if (!tracks.length) {
      var empty = document.createElement('div');
      empty.className = 'ag-colempty';
      empty.textContent = '还没有音轨 · 点上方「＋ 音轨」';
      rowsWrap.appendChild(empty);
      return;
    }

    tracks.forEach(function (track, vi) {
      var ti = self.origIndexOf(vi);
      var h = bands[vi] ? bands[vi].h : 76;
      var row = document.createElement('div');
      row.className = 'ag-trow' + (ti === arr.activeTrackIndex ? ' active' : '') +
        (h < 58 ? ' compact' : '');
      row.style.height = Math.round(h) + 'px';
      row.dataset.ti = String(ti);

      var line1 = document.createElement('div');
      line1.className = 'ag-tline';

      var swatch = document.createElement('span');
      swatch.className = 'ag-swatch';
      swatch.style.background = track.color || '#4fd1c5';
      line1.appendChild(swatch);

      var name = document.createElement('span');
      name.className = 'ag-tname';
      name.textContent = track.name;
      name.title = '双击重命名';
      line1.appendChild(name);

      // 鼓组轨：直接挂在鼓组通道，不需要指定声部（也不给入口）
      if (track.role === 'drum') {
        var drumTag = document.createElement('span');
        drumTag.className = 'ag-ttag drum';
        drumTag.textContent = '12 鼓';
        drumTag.title = '鼓组轨：纵向 12 面鼓、横向节拍，固定使用鼓组通道';
        line1.appendChild(drumTag);
      } else {
        // 音色（鼓组的「音色」就是鼓组本身，不需要入口）
        var tone = document.createElement('span');
        tone.className = 'ag-ttone' + (track.toneId ? '' : ' empty');
        tone.textContent = track.toneId ? shortToneName(track.toneId) : '选音色';
        tone.title = '点击更换音色';
        tone.addEventListener('click', function (e) {
          e.stopPropagation();
          self.onTonePick && self.onTonePick(ti);
        });
        line1.appendChild(tone);
      }

      var mute = document.createElement('button');
      mute.className = 'ag-tbtn' + (track.muted ? ' on' : '');
      mute.textContent = 'M';
      mute.title = '静音';
      mute.addEventListener('click', function (e) {
        e.stopPropagation();
        self.arr.pushUndo('静音');
        track.muted = !track.muted;
        self.arr.changed('track:update');
      });
      line1.appendChild(mute);

      var solo = document.createElement('button');
      solo.className = 'ag-tbtn solo' + (track.solo ? ' on' : '');
      solo.textContent = 'S';
      solo.title = '独奏';
      solo.addEventListener('click', function (e) {
        e.stopPropagation();
        track.solo = !track.solo;
        self.arr.changed('track:update');
      });
      line1.appendChild(solo);
      row.appendChild(line1);

      // 第二行：声部（仅声部轨）+ 音量/声像
      var line2 = document.createElement('div');
      line2.className = 'ag-tline mix';

      if (track.role !== 'drum') {
        /* 音轨角色：普通声部铺和弦，低音声部铺单音 bass 线（模板列表也随之换） */
        var roleSel = document.createElement('select');
        roleSel.className = 'ag-trole';
        roleSel.title = '声部轨：铺和弦 · 低音声部：铺单音 bass 线';
        [['synth', '声部'], ['bass', '低音']].forEach(function (r) {
          var ro = document.createElement('option');
          ro.value = r[0];
          ro.textContent = r[1];
          roleSel.appendChild(ro);
        });
        roleSel.value = track.role === 'bass' ? 'bass' : 'synth';
        roleSel.addEventListener('change', function (e) {
          e.stopPropagation();
          if (self.onRoleChange) self.onRoleChange(ti, roleSel.value);
        });
        roleSel.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
        line2.appendChild(roleSel);
      }

      if (track.role !== 'drum' && self.getPartOptions) {
        var sel = document.createElement('select');
        sel.className = 'ag-tpart';
        sel.title = '指定这条音轨使用哪个声部';
        var opts = self.getPartOptions() || [];
        opts.forEach(function (o) {
          if (o.drum) return;
          var op = document.createElement('option');
          op.value = String(o.index);
          op.textContent = o.name;
          sel.appendChild(op);
        });
        var used = opts.filter(function (o) {
          return o.index === track.part && o.usedBy && o.usedBy !== ti;
        })[0];
        if (used) sel.title += '（当前已被其他轨占用）';
        sel.value = String(track.part);
        sel.addEventListener('change', function (e) {
          e.stopPropagation();
          if (self.onPartChange) self.onPartChange(ti, parseInt(sel.value, 10));
        });
        sel.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
        line2.appendChild(sel);
      }

      var vol = document.createElement('input');
      vol.type = 'range';
      vol.className = 'ag-trange';
      vol.min = '0'; vol.max = '1'; vol.step = '0.01';
      vol.value = String(track.volume === undefined ? 0.85 : track.volume);
      vol.title = '音量';
      vol.addEventListener('input', function (e) {
        e.stopPropagation();
        track.volume = parseFloat(vol.value);
        self.onTrackMix(ti);
      });
      vol.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
      line2.appendChild(vol);

      var pan = document.createElement('input');
      pan.type = 'range';
      pan.className = 'ag-trange pan';
      pan.min = '-1'; pan.max = '1'; pan.step = '0.05';
      pan.value = String(track.pan || 0);
      pan.title = '声像';
      pan.addEventListener('input', function (e) {
        e.stopPropagation();
        track.pan = parseFloat(pan.value);
        self.onTrackMix(ti);
      });
      pan.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
      line2.appendChild(pan);
      row.appendChild(line2);

      row.addEventListener('click', function () {
        self.arr.setActiveTrack(ti);
      });
      row.addEventListener('dblclick', function (e) {
        // 双击音轨名 → 重命名；双击其它位置 → 进入该轨编辑
        if (e.target === name) {
          var v = global.prompt('音轨名称', track.name);
          if (v) { self.arr.pushUndo('重命名'); track.name = v; self.arr.changed('track:rename'); }
          return;
        }
        self.onOpenTrack && self.onOpenTrack(ti);
      });

      rowsWrap.appendChild(row);
    });
  };

  function shortToneName(id) {
    var names = {
      piano: '钢琴', bass: '贝斯', warmPad: '暖垫', ePiano: '电钢',
      strings: '弦乐', organ: '风琴', lead: '主音', bell: '钟琴',
      vocalAh: '人声', pluck: '拨弦', acousticGuitar: '原声吉他',
      electricGuitar: '电吉他', kick: '底鼓', snare: '军鼓',
      clap: '拍手', hihatClosed: '闭镲', hihatOpen: '开镲',
      drumkit: '鼓组（12面鼓）',
      tomLow: '低嗵', tomMid: '中嗵', tomHigh: '高嗵',
      ride: '叮镲', crash: '碎音', rim: '边击', shaker: '沙锤'
    };
    return names[id] || id;
  }
  ArrangerEditor.shortToneName = shortToneName;

  /* ================= 交互 ================= */

  ArrangerEditor.prototype.bindEvents = function () {
    var self = this;

    this.overlay.addEventListener('pointerdown', function (e) {
      self.onPointerDown(e);
    });
    // pointermove 绑在 window：拖动时指针可能移出 overlay，
    // 绑在 overlay 上会在边界断连，拖拽中途卡住。
    global.addEventListener('pointermove', function (e) {
      self.onPointerMove(e);
    });
    global.addEventListener('pointerup', function (e) {
      self.onPointerUp(e);
    });
    this.overlay.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      var rect = self.overlay.getBoundingClientRect();
      var y = e.clientY - rect.top;
      // 右键标尺 → 编辑段落标记
      if (y < self.rulerH) {
        var bar = Math.floor(Math.max(0, self.beatOf(e.clientX - rect.left)) / self.arr.barBeats());
        if (self.onRulerContext) self.onRulerContext(bar, e.clientX, e.clientY);
        return;
      }
      if (self.isReadOnly() && !e.target.closest('.ag-block')) return;
      self.openMenu(e);
    });
    this.overlay.addEventListener('dblclick', function (e) {
      // 单轨模式下双击音块：全选同音高的连续音（编辑和弦/旋律时很顺手）
      var el = e.target.closest('.ag-block');
      if (!el || self.isReadOnly()) return;
      var ti = parseInt(el.dataset.ti, 10);
      var track = self.arr.getTrack(ti);
      var id = el.dataset.id;
      var note = track && track.notes.filter(function (n) { return n.id === id; })[0];
      if (!note) return;
      self.arr.clearSelection();
      track.notes.forEach(function (n) {
        if (n.pitch === note.pitch) self.arr.selection.add(n.id);
      });
      self.arr.emit('selection:change', self.arr.selection);
      self.render();
    });

    // 滚轮：Ctrl+滚轮缩放（锚定光标下的拍），Shift+滚轮横向滚动，普通滚轮纵向平移
    this.pane.addEventListener('wheel', function (e) {
      e.preventDefault();
      /* ⚠️ 坐标必须相对 pane 自己。
         e.offsetX 是相对「事件目标」的 —— 光标压在音块上时目标就是那个音块，
         锚点会变成音块内的坐标，于是缩放时谱面横向乱跳。 */
      var rect = self.pane.getBoundingClientRect();
      var mx = e.clientX - rect.left;
      var my = e.clientY - rect.top;
      var step = Math.max(1, Math.round((self.pitchTop - self.pitchBottom) / 24));
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && self.viewMode === 'track') {
        // Ctrl+Shift+滚轮：纵向缩放，锚点取光标下的那个音高（往上滚 = 音块变高）
        var trY = self.editTrack();
        var bandY = self.bandRect(0, 1);
        self.zoomYBy(e.deltaY > 0 ? 1 / 1.15 : 1.15,
          trY ? self.pitchAt(trY, my - bandY.top, bandY.h) : null);
      } else if (e.ctrlKey || e.metaKey) {
        self.zoomBy(e.deltaY > 0 ? 1 / 1.15 : 1.15, self.beatOf(mx), mx);
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        self.scrollBy((e.deltaY > 0 || e.deltaX > 0 ? 1 : -1) * 2);
      } else if (self.hasVScroll()) {
        // 轨多到装不下：滚轮先上下滚音轨（行高不再压缩）
        self.scrollYBy(e.deltaY);
      } else {
        // 往下滚 → 看更低的音（内容向上走），与网页滚动的方向一致
        var d = (e.deltaY > 0 ? -1 : 1) * step;
        // 平移只夹边界、不改跨度（以前固定按 ±6 半音夹，缩到极限后反而推不动）
        var spanNow = Math.max(1, self.pitchTop - self.pitchBottom);
        var nt = U.clamp(self.pitchTop + d, spanNow, 127);
        self.pitchTop = nt;
        self.pitchBottom = nt - spanNow;
        self.render();
      }
    }, { passive: false });

    // 键盘：删除 / 撤销 / 重做 / 微移 / 全选
    this._onKey = function (e) {
      var tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (!self.pane.isConnected || self.pane.offsetParent === null) return;
      var arr = self.arr;
      var mod = e.ctrlKey || e.metaKey;

      if (mod && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) { if (arr.redo()) self.toast('重做：' + (arr.redoLabel() || '')); }
        else if (arr.undo()) self.toast('已撤销');
        return;
      }
      if (mod && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        if (arr.redo()) self.toast('已重做');
        return;
      }
      if (mod && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        if (self.viewMode === 'track') arr.selectAllInTrack(self.editTrackIndex);
        else arr.getTracks().forEach(function (t) { t.notes.forEach(function (n) { arr.selection.add(n.id); }); });
        arr.emit('selection:change', arr.selection);
        self.render();
        return;
      }

      /* 删除：总览与单轨编辑都允许（总览里的右键菜单本来就能删）。
         单轨编辑有两种鼠标模式，选区是改数据的前提，所以不再区分「锁不锁」。 */
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!arr.selection.size) return;
        e.preventDefault();
        arr.pushUndo('删除音块');
        var n = arr.deleteSelection();
        if (n) self.toast('已删除 ' + n + ' 个音块（Ctrl+Z 可撤销）');
        return;
      }
      if (e.key === 'Escape') {
        if (self.menu) self.closeMenu();
        self.stopAudition();       // Esc 取消时不要留尾音
        arr.clearSelection();
        self.render();
        return;
      }
      // 方向键微移：←→ 按网格，↑↓ 半音（Shift 加速）
      if (self.isReadOnly() || !arr.selection.size) return;
      var step = e.shiftKey ? arr.barBeats() : (arr.grid || 0.25);
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        arr.pushUndo('移动');
        arr.moveSelection({ dBeat: (e.key === 'ArrowRight' ? 1 : -1) * step });
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        var dir = e.key === 'ArrowUp' ? 1 : -1;
        var tr = self.editTrack();
        arr.pushUndo('移调');
        if (tr && tr.role === 'drum') arr.moveSelection({ dRow: -dir });
        else arr.moveSelection({ dPitch: dir * (e.shiftKey ? 12 : 1) });
      }
    };
    global.addEventListener('keydown', this._onKey);
  };

  /* ---------------- 右键菜单 ---------------- */

  ArrangerEditor.prototype.closeMenu = function () {
    if (!this.menu) return;
    this.menu.remove();
    this.menu = null;
  };

  ArrangerEditor.prototype.openMenu = function (e) {
    var self = this;
    var arr = this.arr;
    var el = e.target.closest('.ag-block');
    this.closeMenu();
    if (!el) return;
    var ti = parseInt(el.dataset.ti, 10);
    var id = el.dataset.id;
    if (!arr.isSelected(id)) { arr.clearSelection(); arr.select(id, false); }
    this.render();

    var menu = document.createElement('div');
    menu.className = 'ag-menu';
    var items = [
      { label: '复制到下一小节', key: 'Ctrl+D', fn: function () { arr.pushUndo('复制'); arr.duplicateToNextBar(); } },
      { label: '复制一份（原地）', key: '', fn: function () { arr.pushUndo('复制'); arr.duplicateSelection(0); } },
      { sep: true },
      { label: '量化到网格', key: '', fn: function () { arr.pushUndo('量化'); arr.quantizeSelection(); } },
      {
        label: '吸附到调性', key: '',
        fn: function () {
          arr.pushUndo('吸附到调性');
          var n = arr.snapSelectionToScale();
          var sc = (BS.arranger.SCALES || {})[arr.scale];
          self.toast(n
            ? '已吸附 ' + n + ' 个音到 ' + arr.key + ' ' + (sc ? sc.name : arr.scale)
            : '选中音符已在调内：' + arr.key + ' ' + (sc ? sc.name : arr.scale));
        }
      },
      { label: '上移半音', key: '↑', fn: function () { arr.pushUndo('移调'); arr.transposeSelection(1); } },
      { label: '下移半音', key: '↓', fn: function () { arr.pushUndo('移调'); arr.transposeSelection(-1); } },
      { label: '升八度', key: '', fn: function () { arr.pushUndo('移调'); arr.transposeSelection(12); } },
      { label: '降八度', key: '', fn: function () { arr.pushUndo('移调'); arr.transposeSelection(-12); } },
      { sep: true },
      { label: '力度 +10', key: '', fn: function () { arr.pushUndo('力度'); arr.scaleVelocity(1, 0.1); } },
      { label: '力度 -10', key: '', fn: function () { arr.pushUndo('力度'); arr.scaleVelocity(1, -0.1); } },
      { sep: true },
      { label: '滑音…', key: '', fn: function () { self.editGlide(); } },
      { label: '取消滑音', key: '', fn: function () { self.clearGlide(); } },
      { label: '颤音…', key: '', fn: function () { self.editVib(); } },
      { label: '试听', key: '', fn: function () { self.auditionSelection(); } },
      { sep: true },
      { label: '删除', key: 'Del', fn: function () { arr.pushUndo('删除'); arr.deleteSelection(); } }
    ];
    items.forEach(function (it) {
      if (it.sep) {
        var hr = document.createElement('div');
        hr.className = 'ag-menu-sep';
        menu.appendChild(hr);
        return;
      }
      var b = document.createElement('button');
      b.className = 'ag-menu-i';
      b.innerHTML = '<span>' + it.label + '</span><em>' + it.key + '</em>';
      b.addEventListener('click', function () {
        self.closeMenu();
        it.fn();
        self.render();
      });
      menu.appendChild(b);
    });
    document.body.appendChild(menu);
    var mw = menu.offsetWidth, mh = menu.offsetHeight;
    var x = Math.min(e.clientX, innerWidth - mw - 8);
    var y = Math.min(e.clientY, innerHeight - mh - 8);
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    this.menu = menu;

    var off = function (ev) {
      if (menu.contains(ev.target)) return;
      self.closeMenu();
      document.removeEventListener('pointerdown', off, true);
    };
    setTimeout(function () { document.addEventListener('pointerdown', off, true); }, 0);
    void ti;
  };

  ArrangerEditor.prototype.onPointerDown = function (e) {
    var blockEl = e.target.closest('.ag-block');
    var arr = this.arr;
    var rect = this.overlay.getBoundingClientRect();
    var x = e.clientX - rect.left;
    var y = e.clientY - rect.top;
    var pw = this.pane.clientWidth;
    var ph = this.pane.clientHeight;

    this.closeMenu();

    /* 表头（标尺 + 和弦轨）：总览视图也要能操作 */
    if (y < this.rulerH && e.button !== 2) {
      if (e.shiftKey) {
        var b0 = Math.floor(Math.max(0, this.beatOf(x)) / arr.barBeats());
        this.drag = { kind: 'loop', startBar: b0 };
        arr.setLoop(b0, b0 + 1);
      } else {
        this.setTargetBarFromX(x);
        this.drag = { kind: 'ruler' };
      }
      e.preventDefault();
      return;
    }
    if (y >= this.rulerH && y < this.headerH() && e.button !== 2) {
      // 和弦格：点一下改和弦（app 层弹和弦选择器）
      var bar = Math.floor(Math.max(0, this.beatOf(x)) / arr.barBeats());
      arr.setTargetBar(bar);
      if (this.onRequestChord) this.onRequestChord(bar, e.clientX, e.clientY);
      e.preventDefault();
      return;
    }

    // 横向滚动条
    if (y >= ph - SCROLLBAR_H && e.button !== 2) {
      this.drag = { kind: 'hscroll', startX: x, startBeat: this.scrollBeat };
      this.onPointerMove(e);
      e.preventDefault();
      return;
    }

    // 右键标尺：交给 contextmenu 弹段落标记，别顺手起一个平移拖拽
    if (e.button === 2 && y < this.rulerH) {
      e.preventDefault();
      return;
    }

    // 右键：拖拽平移视图
    if (e.button === 2) {
      e.preventDefault();
      this.drag = {
        kind: 'pan',
        startX: x, startY: y,
        startBeat: this.scrollBeat,
        startTop: this.pitchTop,
        startBottom: this.pitchBottom,
        moved: false
      };
      return;
    }

    // 左侧琴键栏：点/拖过琴键即试听
    if (x < this.gutterW && y > this.headerH()) {
      var tk = this.viewMode === 'track' ? this.editTrack() : this.arr.getTrack(this.arr.activeTrackIndex);
      if (tk) {
        var band = this.bandRect(0, this.viewMode === 'track' ? 1 : Math.max(1, this.visibleTracks().length));
        if (this.viewMode !== 'track') {
          var vi = this.trackIndexAt(y);
          band = this.bandRect(vi, Math.max(1, this.visibleTracks().length));
          tk = this.arr.getTrack(this.origIndexOf(vi)) || tk;
        }
        this.auditionNote(tk, this.pitchAt(tk, y - band.top, band.h));
        this.drag = { kind: 'keys', last: y, track: tk, band: band };
      }
      e.preventDefault();
      return;
    }

    /* 滑音分割手柄（两块中间那道）：它不属于 .ag-block，
       得在音块分支之前接住，否则会掉进「空白处」分支被当成加音/框选。
       拖动只改滑音占多长，整块音的总时长不变。 */
    var gripEl = e.target.closest && e.target.closest('.ag-glide-grip');
    if (gripEl) {
      var gti = parseInt(gripEl.dataset.ti, 10);
      var gid = gripEl.dataset.id;
      var gtrack = arr.getTrack(gti);
      var gnote = gtrack && gtrack.notes.filter(function (n) { return n.id === gid; })[0];
      if (!gnote) return;
      if (!arr.isSelected(gid)) { arr.clearSelection(); arr.select(gid, false); this.render(); }
      arr.pushUndo('调节滑音');
      this.auditionNote(gtrack, gnote.pitch);
      this.drag = {
        kind: 'glide',
        fromTrack: gti, id: gid,
        startX: x, startY: y,
        origGlide: gnote.glide > 0 ? gnote.glide : 0,
        moved: false
      };
      e.preventDefault();
      return;
    }

    if (blockEl) {
      var ti = parseInt(blockEl.dataset.ti, 10);
      var id = blockEl.dataset.id;
      var track = arr.getTrack(ti);
      var note = track && track.notes.filter(function (n) { return n.id === id; })[0];
      if (!note) return;

      var isHandle = e.target.classList.contains('ag-h');
      var side = e.target.classList.contains('r') ? 'r' : (e.target.classList.contains('l') ? 'l' : '');
      /* 命中前块还是后块：前块上下拖 = 改滑音起始音高，后块 = 改本音高 */
      var part = (blockEl.dataset.part === 'a' || blockEl.dataset.part === 'b') ? blockEl.dataset.part : '';
      var gripPitch = note.pitch;
      if (part === 'a') {
        var gf0 = parseFloat(note.glideFrom);
        gripPitch = isFinite(gf0) ? Math.round(U.clamp(gf0, 0, 127)) : note.pitch;
      }

      /* 点音块 = 选中（Shift/Ctrl 增减选择）。
         总览里也能选 —— 右键菜单要用选区；但总览不拖动，拖动只在单轨编辑里做。 */
      if (!arr.isSelected(id)) arr.select(id, e.shiftKey || e.ctrlKey);
      else if (e.shiftKey || e.ctrlKey) {
        arr.selection.delete(id);
        arr.emit('selection:change', arr.selection);
        this.render();
        return;
      }

      // 总览只读：不拖音块（但可选、可右键菜单删除）
      if (this.isReadOnly()) {
        this.auditionNote(track, gripPitch);
        return;
      }

      // Alt+拖动 → 先复制一份再拖（GarageBand/Logic 的肌肉记忆）
      if (e.altKey && !isHandle) {
        arr.pushUndo('复制音块');
        arr.duplicateSelection(0);
        var dupEl = this.overlay.querySelector('.ag-block.sel');
        if (dupEl) { id = dupEl.dataset.id; note = track.notes.filter(function (n) { return n.id === id; })[0] || note; }
      } else {
        arr.pushUndo(isHandle ? '调整时值' : '移动音块');
      }

      /* 按下先响一下：听到的是**当前**音高（拖动前的那个音）。
         拖动过程中与落点时会按新音高再响（见 auditionDragPitch / auditionDrop）。 */
      this.auditionNote(track, gripPitch);
      this._dragAud = {};   // 新一轮拖动：重置「已试听音高」记录

      var origins = {};
      arr.selectedLocations().forEach(function (l) {
        var o = { beat: l.note.beat, pitch: l.note.pitch };
        var f = parseFloat(l.note.glideFrom);
        if (isFinite(f)) o.glideFrom = Math.round(U.clamp(f, 0, 127));   // 群移时滑音起点一起动
        origins[l.note.id] = o;
      });

      this.drag = {
        kind: isHandle ? 'resize' : 'move',
        side: side,
        part: part,
        fromTrack: ti,
        id: id,
        startX: x, startY: y,
        origBeat: note.beat,
        origLen: note.len,
        origPitch: note.pitch,
        origGlideFrom: gripPitch,
        origGlide: note.glide > 0 ? note.glide : 0,
        origins: origins,
        multi: arr.selection.size > 1,
        moved: false
      };
      /* 记下这一轮已经响过的音高：同一个音高在 140ms 内不重复触发（不然会变机关枪） */
      this.markDragAudition(arr.selection.size > 1 ? 'multi' : id, gripPitch);
      e.preventDefault();
      return;
    }

    // 空白处：可能是框选或添加（总览只读 → 仅记录双击）
    this.drag = {
      kind: 'maybe-box',
      startX: x, startY: y,
      startBeat: this.beatOf(x),
      moved: false
    };
    e.preventDefault();
  };

  ArrangerEditor.prototype.onPointerMove = function (e) {
    var d = this.drag;
    if (!d) return;
    var rect = this.overlay.getBoundingClientRect();
    var x = e.clientX - rect.left;
    var y = e.clientY - rect.top;
    var dx = x - d.startX, dy = y - d.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) d.moved = true;

    if (d.kind === 'ruler') {
      this.setTargetBarFromX(x);
      return;
    }
    if (d.kind === 'loop') {
      var bb = this.arr.barBeats();
      var b1 = Math.floor(Math.max(0, this.beatOf(x)) / bb);
      var s = Math.min(d.startBar, b1), en = Math.max(d.startBar, b1) + 1;
      this.arr.setLoop(s, en);
      return;
    }
    if (d.kind === 'hscroll') {
      var track = this.scrollbarRect();
      var thumb = this.thumbRect();
      var total = this.arr.totalBeats();
      var vis = Math.min(total, this.visibleBeats());
      var per = (total - vis) / Math.max(1, track.w - thumb.w);
      this.scrollBeat = U.clamp(d.startBeat + dx * per, 0, Math.max(0, total - vis));
      this.requestRender();
      return;
    }
    if (d.kind === 'vscroll') {
      var vr = this.vScrollbarRect();
      var vtb = this.vThumbRect();
      var trackH = Math.max(1, vr.h - vtb.h);
      var per = this._maxScrollY / trackH;
      this.scrollY = U.clamp(d.startScroll + dy * per, 0, this._maxScrollY);
      this._bands = null;
      this.requestRender();
      return;
    }
    if (d.kind === 'keys') {
      var band = d.band;
      var p = this.pitchAt(d.track, y - band.top, band.h);
      if (p !== d.lastPitch) {
        d.lastPitch = p;
        this.auditionNote(d.track, p);
      }
      return;
    }

    if (d.kind === 'pan') {
      /* 抓取式平移：谱面跟着鼠标走。
         · 往左拖 → 谱面往左（看到后面的小节），往右拖 → 谱面往右
         · 往下拖 → 谱面往下（看到更高的音）
         并且锁轴：起手方向决定这次只横移或只纵移，避免斜着拖时上下乱飘。 */
      if (!d.axis && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
        d.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
      }
      var total = this.arr.totalBeats();
      var vis = Math.min(total, this.visibleBeats());
      if (d.axis !== 'y') {
        this.scrollBeat = U.clamp(d.startBeat - dx / this.pxPerBeat, 0, Math.max(0, total - vis));
      }
      if (d.axis !== 'x') {
        // 纵向：拖动像素 → 半音偏移（按内容区高度换算，与渲染同源）
        var semis = Math.round((dy / this.contentH()) * (d.startTop - d.startBottom));
        this.pitchTop = U.clamp(d.startTop + semis, d.startBottom + 6, 127);
        this.pitchBottom = U.clamp(d.startBottom + semis, 0, this.pitchTop - 6);
      }
      this.requestRender();
      return;
    }

    if (d.kind === 'maybe-box') {
      if (d.moved) {
        d.kind = 'box';
        this.showSelBox(d.startX, d.startY, x, y);
      }
      return;
    }

    if (d.kind === 'box') {
      this.showSelBox(d.startX, d.startY, x, y);
      return;
    }

    if (d.kind === 'move') {
      var arr = this.arr;
      var track = arr.getTrack(d.fromTrack);
      if (!track) return;
      var newBeat = arr.quantize(d.origBeat + dx / this.pxPerBeat);

      if (d.multi) {
        /* 群移：整组相对原始位置平移（每次都用 origins 计算，不累积误差）。
           纵向只改音高、不跨轨 —— 否则和弦会被打散。 */
        var dBeat = newBeat - d.origBeat;
        var band0 = this.bandRect(this.viewMode === 'track' ? 0 : d.fromTrack,
          this.viewMode === 'track' ? 1 : arr.trackCount());
        var pitch = this.pitchAt(track, y - band0.top, band0.h);
        var dPitch = 0, dRow = 0;
        if (track.role === 'drum') {
          var i0 = DRUM_ORDER.indexOf(DRUM_PITCH_TO_ID[d.origPitch]);
          var i1 = DRUM_ORDER.indexOf(DRUM_PITCH_TO_ID[pitch]);
          dRow = (i1 < 0 ? 0 : i1) - (i0 < 0 ? 0 : i0);
        } else {
          dPitch = pitch - d.origPitch;
        }
        var ids = Object.keys(d.origins);
        ids.forEach(function (nid) {
          var o = d.origins[nid];
          var loc = null;
          arr.getTracks().some(function (tt, ti2) {
            var f = tt.notes.filter(function (n) { return n.id === nid; })[0];
            if (f) { loc = { ti: ti2, note: f }; return true; }
            return false;
          });
          if (!loc) return;
          loc.note.beat = arr.snapTick(Math.max(0, o.beat + dBeat));
          if (track.role === 'drum') {
            if (dRow) {
              var oi = DRUM_ORDER.indexOf(DRUM_PITCH_TO_ID[o.pitch]);
              var ni = U.clamp((oi < 0 ? DRUM_ORDER.length - 1 : oi) + dRow, 0, DRUM_ORDER.length - 1);
              loc.note.pitch = DRUM_PITCH[DRUM_ORDER[ni]];
            }
          } else if (dPitch) {
            loc.note.pitch = U.clamp(o.pitch + dPitch, 0, 127);
          }
          // 滑音起点跟着一起平移，否则群移后两块会「脱钩」
          if (o.glideFrom !== undefined && dPitch) {
            loc.note.glideFrom = U.clamp(o.glideFrom + dPitch, 0, 127);
          }
        });
        arr.getTracks().forEach(function (tt) {
          tt.notes.sort(function (a, b) { return a.beat - b.beat; });
        });
        arr.changed('note:move');
        /* 群移试听：每次移动响的是**第一个音**（按时间最早的那个）。
           音高跟着一起变的话，响的也是它移动后的新音高。 */
        var firstM = this.firstSelectedNote();
        if (firstM) this.auditionDragPitch(firstM.track, firstM.note.pitch, 'multi');
      } else {
        var targetTi = this.scopeTrackIndex(this.trackIndexAt(y));
        var targetTrack = arr.getTrack(targetTi);
        if (targetTrack) {
          var rect2 = this.bandRect(this.viewMode === 'track' ? 0 : targetTi,
            this.viewMode === 'track' ? 1 : arr.trackCount());
          var newPitch = this.pitchAt(targetTrack, y - rect2.top, rect2.h);
          if (d.part === 'a') {
            /* 拖**前块**：上下只改滑音起点音高（后块的音高不能被带着走），
               左右仍然是整体移动 —— 两块同属一个音，当然一起动。 */
            var fromPitch = U.clamp(newPitch, 0, 127);
            arr.updateNote(d.fromTrack, d.id, { beat: newBeat, glideFrom: fromPitch });
            // 拖出视野就扩视图：否则前块压在边缘上，像「滑音没生效」
            this.ensurePitchVisible(fromPitch);
            this.auditionDragPitch(targetTrack, fromPitch, d.id);
          } else {
            arr.moveNote(d.fromTrack, d.id, targetTi, newBeat, newPitch);
            /* 试听的是**落点音高**（此刻该音块所在的那个音），
               不是按下时那个旧音高 —— 否则拖到哪都是老声音。 */
            this.auditionDragPitch(targetTrack, newPitch, d.id);
          }
        }
        /* ⚠️ 只更新「当前所在轨」，origBeat / origPitch 必须保持**按下时**的值。
           之前这里把 origBeat 改成 newBeat，而 dx 始终是相对 startX 的总位移 →
           每帧把位移重复叠加一次：拖 100px 走到 1.5 倍位置，拖回去也回不到原位。 */
        d.fromTrack = targetTi;
      }
      this.requestRender();
      return;
    }

    /* 滑音分割手柄：只改滑音占多长（秒），整块音的总时长不变。
       秒 ↔ 像素：pxPerBeat × (bpm / 60)。 */
    if (d.kind === 'glide') {
      var arr3 = this.arr;
      var tr3 = arr3.getTrack(d.fromTrack);
      var nt3 = tr3 && tr3.notes.filter(function (n) { return n.id === d.id; })[0];
      if (!nt3) return;
      var pxPerSec = this.pxPerBeat * (arr3.song.bpm / 60);
      var lenSec = nt3.len * 60 / arr3.song.bpm;
      var next = U.clamp(d.origGlide + dx / pxPerSec, 0.01, Math.max(0.02, lenSec - 0.01));
      if (Math.abs(next - (nt3.glide || 0)) > 1e-4) {
        arr3.updateNote(d.fromTrack, d.id, { glide: Math.round(next * 1000) / 1000 });
      }
      this.requestRender();
      return;
    }

    if (d.kind === 'resize') {
      var arr2 = this.arr;
      var tr = arr2.getTrack(d.fromTrack);
      var nt = tr && tr.notes.filter(function (n) { return n.id === d.id; })[0];
      if (!nt) return;
      if (d.side === 'r') {
        var newLen = arr2.quantize(d.origLen + dx / this.pxPerBeat);
        arr2.updateNote(d.fromTrack, d.id, { len: Math.max(BS.arranger.TICK, newLen) });
      } else {
        var delta = arr2.quantize(dx / this.pxPerBeat);
        var nb = d.origBeat + delta;
        var nl = d.origLen - delta;
        if (nb < 0) { nb = 0; nl = d.origLen + d.origBeat; }
        if (nl < BS.arranger.TICK) { nl = BS.arranger.TICK; nb = d.origBeat + d.origLen - BS.arranger.TICK; }
        arr2.updateNote(d.fromTrack, d.id, { beat: nb, len: nl });
      }
      this.requestRender();
    }
  };

  ArrangerEditor.prototype.onPointerUp = function (e) {
    var d = this.drag;
    this.drag = null;
    this.hideSelBox();
    if (!d) return;

    if (this.vbar) this.vbar.classList.remove('drag');
    if (d.kind === 'pan' || d.kind === 'keys' || d.kind === 'hscroll' || d.kind === 'vscroll') {
      this.render();
      return;
    }
    if (d.kind === 'ruler' || d.kind === 'loop') return;

    /* 播放中单击谱面 = 跳到该拍继续播（像播放器的进度条）。
       回调由 app 层给：返回 true 表示已接管，本次不再加音/开轨。 */
    if (d.kind === 'maybe-box' && !d.moved && this.onSeek && this.onSeek(this.beatOf(d.startX))) {
      return;
    }

    // 总览视图：单击/双击只用于打开单轨编辑，不改谱面
    if (this.isReadOnly()) {
      var lc = this._lastClick;
      this._lastClick = null;
      if (d.kind === 'maybe-box' && !d.moved && lc && Date.now() - lc.t < 400) {
        this.onOpenTrack(lc.ti);
      } else if (d.kind === 'maybe-box' && !d.moved) {
        this._lastClick = { x: d.startX, y: d.startY, t: Date.now(), ti: this.trackIndexAt(d.startY) };
      }
      return;
    }

    if (d.kind === 'maybe-box' && !d.moved) {
      /* 单击空白处：
         「添加」模式 = 直接加一个音块（原来勾上「允许修改」的行为）；
         「框选」模式 = 只清掉选区，绝不误加音。 */
      if (this.isAddTool()) this.addBlockAt(e);
      else { this.arr.clearSelection(); }
    } else if (d.kind === 'box') {
      this.applyBoxSelection();
    } else if (d.kind === 'move') {
      /* 落点定音：拖到最终位置时响一次那儿的音高。
         ⚠️ 之前只在下按时响过一次（拖动前的音高），拖完了听着还是老音高 ——
         像是没拖上，所以这里必须按落点再响一次。 */
      this.auditionDrop(d);
    }
    this.render();
  };

  /** 像素 y → 轨索引（按布局带判定，鼓组带更高也准确） */
  ArrangerEditor.prototype.trackIndexAt = function (y) {
    if (this.viewMode === 'track') return this.editTrackIndex;
    var bands = this.layoutBands();
    if (!bands.length) return 0;
    for (var i = 0; i < bands.length; i++) {
      if (y < bands[i].top + bands[i].h) return bands[i].ti;
    }
    return bands[bands.length - 1].ti;
  };

  /** 标尺上的 x → 目标小节（0 起） */
  ArrangerEditor.prototype.setTargetBarFromX = function (x) {
    var bb = this.arr.barBeats();
    var beat = Math.max(0, this.beatOf(x));
    // arr.setTargetBar 会触发 change → 界面重绘（同一小节不重复触发）
    this.arr.setTargetBar(Math.floor(beat / bb));
  };

  /** 在点击位置添加音块 */
  ArrangerEditor.prototype.addBlockAt = function (e) {
    var arr = this.arr;
    if (!arr.trackCount()) { this.toast('请先添加音轨'); return; }
    var rect = this.overlay.getBoundingClientRect();
    var x = e.clientX - rect.left;
    var y = e.clientY - rect.top;
    if (x < this.gutterW || y < this.headerH() || y > this.contentBottom()) return;
    var ti = this.scopeTrackIndex(this.trackIndexAt(y));
    var track = arr.getTrack(ti);
    if (!track) return;

    var band = this.bandRect(this.viewMode === 'track' ? 0 : ti,
      this.viewMode === 'track' ? 1 : arr.trackCount());
    var pitch = this.pitchAt(track, y - band.top, band.h);
    var beat = arr.quantize(Math.max(0, this.beatOf(x)));

    arr.pushUndo('添加音块');
    var n = arr.addNote(ti, beat, arr.grid, pitch, 0.85);
    if (n) {
      arr.select(n.id, false);
      this.auditionNote(track, pitch);
      if (this.onChange) this.onChange('add');
    }
  };

  /* ---------------- 试听 ---------------- */

  ArrangerEditor.prototype.auditionNote = function (track, pitch) {
    if (!track || track.muted) return;
    var vol = track.volume === undefined ? 1 : track.volume;
    try {
      if (track.role === 'drum') {
        var rack = this.getDrumRack();
        if (!rack) return;
        rack.hitPitch(pitch, U.clamp(0.9 * vol, 0.05, 1));
        return;
      }
      var ti = this.arr.getTracks().indexOf(track);
      var part = this.getPart(ti < 0 ? this.arr.activeTrackIndex : ti);
      if (!part || !part.buffer) return;
      /* 锁时长变调：未命中缓存时 noteOn 会退回变速变调（时值随音高变）。
         这里不等 —— 拖着琴键试听必须跟手；只在后台把该音高补算进缓存，
         下一次点同一个音就是锁时长的。整段播放前另有等待逻辑。 */
      if (part.pitchMode === 'stretch' && BS.app && BS.app.ctx && BS.pitchAlgo) {
        BS.pitchAlgo.prewarm(BS.app.ctx, part.buffer, part.id, [pitch],
          part.rootNote, part.transpose, part.fine, part.stretchQuality);
      }
      var voice = part.noteOn(pitch, U.clamp(0.85 * vol, 0.05, 1));
      setTimeout(function () {
        try { voice && voice.release && voice.release(); } catch (err) { /* noop */ }
      }, 420);
    } catch (err) { /* 试听失败不影响编辑 */ }
  };

  /**
   * 记下「这个音高刚响过」。
   * 拖动时同一个音高在 140ms 内不重复触发 —— 否则一路拖着鼠标会变成机关枪。
   */
  ArrangerEditor.prototype.markDragAudition = function (tag, pitch) {
    if (!this._dragAud) this._dragAud = {};
    this._dragAud[tag] = { pitch: Math.round(pitch), t: Date.now() };
  };

  /**
   * 拖动过程中的试听：响的是**当前音高**（拖动后的那个音）。
   * tag 用来区分「单块拖动」和「整组拖动」——同一组里只该有一个声音在响。
   */
  ArrangerEditor.prototype.auditionDragPitch = function (track, pitch, tag) {
    if (!track || !isFinite(pitch)) return;
    pitch = Math.round(pitch);
    if (!this._dragAud) this._dragAud = {};
    var now = Date.now();
    var last = this._dragAud[tag];
    if (last && last.pitch === pitch && (now - last.t) < 140) return;
    this._dragAud[tag] = { pitch: pitch, t: now };
    this.auditionNote(track, pitch);
  };

  /**
   * 选区里的「第一个音」（按时间最早，同拍时按轨序）。
   * 整组拖动时用它试听 —— 用户拖的是一组，听到的应该是这组的第一个音。
   */
  ArrangerEditor.prototype.firstSelectedNote = function () {
    var locs = this.arr.selectedLocations();
    var best = null;
    for (var i = 0; i < locs.length; i++) {
      var l = locs[i];
      if (!best ||
        l.note.beat < best.note.beat - 1e-9 ||
        (Math.abs(l.note.beat - best.note.beat) < 1e-9 && l.ti < best.ti)) best = l;
    }
    return best;
  };

  /**
   * 拖动结束（落点）时试听：响的是音块**落点处**的音高。
   * ⚠️ 之前只在按下时响一次（拖动前的音高），拖到新位置听着还是老音高，
   * 像是没拖上 —— 所以落点必须再响一次，而且响的是新音高。
   */
  ArrangerEditor.prototype.auditionDrop = function (d) {
    var first = this.firstSelectedNote();
    if (!first) return;
    var p = first.note.pitch;
    // 拖的是滑音前块（part='a'）时，响的是滑音起点音高
    if (d && d.part === 'a') {
      var gf = parseFloat(first.note.glideFrom);
      if (isFinite(gf)) p = Math.round(U.clamp(gf, 0, 127));
    }
    this._dragAud = {};
    this.auditionNote(first.track, Math.round(p));
  };

  /**
   * 立刻收掉所有试听音。
   * 「取消编辑」时如果还留着 420ms 的尾音/鼓采样，听感上就像取消没生效。
   */
  ArrangerEditor.prototype.stopAudition = function () {
    try {
      var rack = this.getDrumRack();
      if (rack && rack.allNotesOff) rack.allNotesOff();
    } catch (e) { /* noop */ }
    try {
      for (var i = 0; i < this.arr.trackCount(); i++) {
        if (this.arr.getTrack(i).role === 'drum') continue;
        var p = this.getPart(i);
        if (p && p.allNotesOff) p.allNotesOff();
      }
    } catch (e) { /* noop */ }
  };

  /* ---------------- 音符修饰（滑音 / 颤音） ---------------- */

  /** 同轨上、时间早于 note 的最近一个音的音高（自动填滑音起点用） */
  ArrangerEditor.prototype.prevNotePitch = function (track, note) {
    var best = null, bestBeat = -Infinity;
    track.notes.forEach(function (n) {
      if (n === note || n.mute) return;
      if (n.beat < note.beat - 1e-6 && n.beat > bestBeat) { bestBeat = n.beat; best = n.pitch; }
    });
    return best;
  };

  /**
   * 右键菜单：设置滑音。
   * 新模型：音块切成两块 —— 前一块用「起始音高」glideFrom、后一块用本音高，
   * 中间弧线连接；滑音时长决定分割点位置。没设过起始音高时自动取同轨上一个音。
   */
  ArrangerEditor.prototype.editGlide = function () {
    var arr = this.arr;
    var self = this;
    var locs = arr.selectedLocations();
    var cur = 0, hasFrom = false;
    locs.forEach(function (l) {
      if (l.note.glide > cur) cur = l.note.glide;
      if (l.note.glideFrom !== undefined && l.note.glideFrom !== null) hasFrom = true;
    });
    var s = global.prompt(
      '滑音时长（秒，0–2；0 = 关闭）\n' +
      '音块会切成两块：前一块用「起始音高」，后一块用本音高，中间弧线连接。\n' +
      (hasFrom ? '已设起始音高：直接改时长即可'
        : '未设起始音高：将自动取同轨上一个音的音高'),
      cur ? String(cur) : '0.12');
    if (s === null) return;
    var v = parseFloat(s);
    if (!isFinite(v) || v < 0) { this.toast('滑音只接受 0–2 秒'); return; }
    arr.pushUndo('滑音');
    var n = 0;
    locs.forEach(function (l) {
      if (l.track.role === 'drum') return;
      var note = l.note;
      if (v <= 0) {
        delete note.glide; delete note.glideFrom;
      } else {
        if (note.glideFrom === undefined || note.glideFrom === null) {
          var from = self.prevNotePitch(l.track, note);
          note.glideFrom = from === null ? note.pitch : from;
        }
        note.glide = Math.round(Math.min(v, 2) * 1000) / 1000;
      }
      n++;
    });
    if (n) {
      arr.changed('note:mod');
      /* 起始音高可能落在当前视野外：扩一下视图，前块才看得见 */
      locs.forEach(function (l) {
        var f = parseFloat(l.note.glideFrom);
        if (isFinite(f)) self.ensurePitchVisible(Math.round(f));
      });
    }
    this.toast(!n ? '鼓轨没有滑音'
      : (v > 0 ? '滑音 ' + v + 's · ' + n + ' 个音（拖中间手柄可调前后长度）'
        : '已关闭滑音'));
  };

  /** 右键菜单：取消选中音的滑音（连起始音高一起清掉） */
  ArrangerEditor.prototype.clearGlide = function () {
    var arr = this.arr;
    var locs = arr.selectedLocations();
    var hit = 0;
    locs.forEach(function (l) {
      if (l.track.role === 'drum') return;
      if (l.note.glide > 0 || (l.note.glideFrom !== undefined && l.note.glideFrom !== null)) hit++;
    });
    if (!hit) { this.toast('选中音没有滑音'); return; }
    arr.pushUndo('取消滑音');
    locs.forEach(function (l) {
      if (l.track.role === 'drum') return;
      delete l.note.glide;
      delete l.note.glideFrom;
    });
    arr.changed('note:mod');
    this.toast('已取消滑音 · ' + hit + ' 个音');
  };

  /** 右键菜单：颤音深度 + 速率。深度 0 = 关闭 */
  ArrangerEditor.prototype.editVib = function () {
    var arr = this.arr;
    var curD = 0, curR = 0;
    arr.selectedLocations().forEach(function (l) {
      if (l.note.vib > curD) curD = l.note.vib;
      if (l.note.vibRate > curR) curR = l.note.vibRate;
    });
    var s = global.prompt('颤音深度（0–1，0 = 关闭）', curD ? String(curD) : '0.35');
    if (s === null) return;
    var d = parseFloat(s);
    if (!isFinite(d) || d < 0) { this.toast('颤音深度只接受 0–1'); return; }
    if (d <= 0) {
      arr.pushUndo('颤音');
      var off = arr.setNoteModifiers({ vib: 0 });
      this.toast(off ? '已关闭颤音' : '鼓轨没有颤音');
      return;
    }
    var sr = global.prompt('颤音速率（Hz，0.5–14）', curR ? String(curR) : '5.5');
    if (sr === null) return;
    var r = parseFloat(sr);
    if (!isFinite(r) || r <= 0) r = 5.5;
    arr.pushUndo('颤音');
    var n = arr.setNoteModifiers({ vib: d, vibRate: r });
    this.toast(!n ? '鼓轨没有颤音'
      : '颤音 ' + Math.round(d * 100) + '% · ' + (Math.round(r * 10) / 10) + 'Hz · ' + n + ' 个音');
  };

  ArrangerEditor.prototype.auditionSelection = function () {
    var self = this;
    var locs = this.arr.selectedLocations().slice(0, 12);
    var play = function () {
      locs.forEach(function (l, i) {
        setTimeout(function () { self.auditionNote(l.track, l.note.pitch); }, i * 90);
      });
    };
    if (!BS.app || !BS.app.ctx || !BS.pitchAlgo) { play(); return; }

    /* 锁时长变调：多选试听是一串音，退回变速变调会明显听出时值不齐，
       先把这批音高算好再放（最多等 1.5s，超时照常出声）。 */
    var byPart = {}, jobs = [];
    locs.forEach(function (l) {
      if (!l.track || l.track.role === 'drum') return;
      var ti = self.arr.getTracks().indexOf(l.track);
      var p = self.getPart(ti < 0 ? self.arr.activeTrackIndex : ti);
      if (!p || !p.buffer || p.pitchMode !== 'stretch') return;
      var k = p.id || String(ti);
      if (!byPart[k]) { byPart[k] = { part: p, notes: [] }; jobs.push(byPart[k]); }
      byPart[k].notes.push(l.note.pitch);
    });
    if (!jobs.length) { play(); return; }
    Promise.all(jobs.map(function (j) {
      return BS.pitchAlgo.warmNotes(BS.app.ctx, j.part.buffer, j.part.id, j.notes,
        j.part.rootNote, j.part.transpose, j.part.fine, j.part.stretchQuality,
        { timeoutMs: 1500 });
    })).then(play, play);
  };

  /* ---------------- 框选 ---------------- */

  ArrangerEditor.prototype.showSelBox = function (x1, y1, x2, y2) {
    if (!this.selBox) {
      this.selBox = document.createElement('div');
      this.selBox.className = 'ag-selbox';
      this.blockLayer.appendChild(this.selBox);
    }
    var l = Math.min(x1, x2), t = Math.min(y1, y2);
    this.selBox.style.left = l + 'px';
    this.selBox.style.top = t + 'px';
    this.selBox.style.width = Math.abs(x2 - x1) + 'px';
    this.selBox.style.height = Math.abs(y2 - y1) + 'px';
    this.selBox.style.display = '';
  };

  ArrangerEditor.prototype.hideSelBox = function () {
    if (this.selBox) this.selBox.style.display = 'none';
  };

  /** 单轨模式下只允许操作当前轨 */
  ArrangerEditor.prototype.scopeTrackIndex = function (ti) {
    if (this.viewMode === 'track') return this.editTrackIndex;
    return ti;
  };

  ArrangerEditor.prototype.applyBoxSelection = function () {
    var arr = this.arr;
    var self = this;
    var box = this.selBox;
    if (!box) return;
    var bx = parseFloat(box.style.left) || 0;
    var by = parseFloat(box.style.top) || 0;
    var bw = parseFloat(box.style.width) || 0;
    var bh = parseFloat(box.style.height) || 0;

    arr.clearSelection();
    var visible = this.visibleTracks();
    var count = Math.max(1, visible.length);

    visible.forEach(function (track, vi) {
      var band = self.bandRect(vi, count);
      var isDrum = track.role === 'drum';
      var rng = self.pitchRng(track);
      var rows = Math.max(1, rng.top - rng.bottom + 1);
      // 行高与音块渲染同源（减 1px 留缝），缩放下「框住即选中」也成立
      var nh = isDrum
        ? band.h / DRUM_ORDER.length * 0.7
        : Math.max(5, Math.round(band.h / rows) - 1);

      track.notes.forEach(function (n) {
        var nx = self.xOf(n.beat);
        var nw = Math.max(4, n.len * self.pxPerBeat);
        var ny = isDrum
          ? band.top + self.yInBand(track, n.pitch, band.h)
          : band.top + U.clamp((rng.top - n.pitch) / rows, 0, 1) * band.h;
        if (nx + nw >= bx && nx <= bx + bw && ny + nh >= by && ny <= by + bh) {
          arr.selection.add(n.id);
        }
      });
    });
    arr.emit('selection:change', arr.selection);
  };

  /* ---------------- 视图操作 ---------------- */

  /* ---------------- 纵向（音高方向）缩放 ----------------
     音域宽的轨在单轨编辑里会被压成每行几像素高，音块窄到点不中也拖不动。
     这里缩放的量是「一屏覆盖多少个半音」：跨度越小 → 行高越大 → 音块越高。
     横向缩放改 pxPerBeat，纵向改 pitchTop/pitchBottom，两者互不影响。 */

  /**
   * 纵向缩放。f > 1 = 放大（音块变高）。
   * anchorPitch 是锚点音高（一般取光标下的那个音），缩放前后它在屏幕上的位置不动；
   * 缺省用当前视图中心，缩放后视野不乱跳。
   */
  ArrangerEditor.prototype.zoomYBy = function (f, anchorPitch) {
    if (!(f > 0) || !isFinite(f)) return false;
    var span = Math.max(1, this.pitchTop - this.pitchBottom);
    // 跨度 = 基准跨度 / 倍率：倍率是连续的，span 只是取整后的结果，
    // 所以 +/- 交替不会累积取整误差（52 → 33 → 52，而不是 53）
    var base = this._zoomYBase > 0 ? this._zoomYBase : span;
    var z = (this.zoomY > 0 ? this.zoomY : 1) * f;
    z = U.clamp(z, base / MAX_PITCH_SPAN, base / MIN_PITCH_SPAN);
    var next = U.clamp(Math.round(base / z), MIN_PITCH_SPAN, MAX_PITCH_SPAN);
    if (next === span) return false;   // 已经顶到跨度上下限：倍率不记，避免状态漂移
    this.zoomY = z;

    var a = (typeof anchorPitch === 'number' && isFinite(anchorPitch))
      ? anchorPitch : (this.pitchTop + this.pitchBottom) / 2;
    var r = U.clamp((this.pitchTop - a) / span, 0, 1);   // 锚点在视图里的相对位置
    var top = a + r * next;
    var bottom = top - next;
    // 顶到 0/127 边界时整体挪回来，跨度保持不变
    if (top > 127) { top = 127; bottom = 127 - next; }
    if (bottom < 0) { bottom = 0; top = next; }

    this.pitchTop = Math.round(top);
    this.pitchBottom = Math.round(bottom);
    this.render();
    return true;
  };

  /** 当前纵向跨度（半音数），给界面显示/测试用 */
  ArrangerEditor.prototype.pitchSpan = function () {
    return Math.max(1, this.pitchTop - this.pitchBottom);
  };

  /** 横向缩放：以某点为锚点；anchorBeat 为空则以目标小节为中心 */
  ArrangerEditor.prototype.zoomBy = function (f, anchorBeat, anchorX) {
    var arr = this.arr;
    if (anchorBeat === undefined) anchorBeat = arr.targetBar * arr.barBeats();
    if (anchorX === undefined) anchorX = this.pane.clientWidth / 2;
    this.pxPerBeat = U.clamp(this.pxPerBeat * f, 6, 600);
    // 锚点下的拍缩放前后保持不动；同时夹住左右边界，别缩到空白区
    var max = Math.max(0, arr.totalBeats() - this.visibleBeats());
    this.scrollBeat = U.clamp(anchorBeat - (anchorX - this.gutterW) / this.pxPerBeat, 0, max);
    this.render();
  };

  ArrangerEditor.prototype.fit = function () {
    var total = Math.max(1, this.arr.totalBeats());
    var w = Math.max(80, this.pane.clientWidth - this.gutterW - 4);
    this.pxPerBeat = U.clamp(w / total, 6, 600);
    this.scrollBeat = 0;
    this.render();
  };

  ArrangerEditor.prototype.scrollBy = function (beats) {
    var max = Math.max(0, this.arr.totalBeats() - this.visibleBeats());
    this.scrollBeat = U.clamp(this.scrollBeat + beats, 0, max);
    this.render();
  };

  ArrangerEditor.prototype.scrollToBar = function (bar, center) {
    var bb = this.arr.barBeats();
    var target = bar * bb;
    var vis = this.visibleBeats();
    this.scrollBeat = Math.max(0, center ? target - vis / 2 : target);
    this.scrollBeat = Math.min(this.scrollBeat, Math.max(0, this.arr.totalBeats() - vis));
  };

  /* ================= 播放头 ================= */

  ArrangerEditor.prototype.setPlayhead = function (beat) {
    var x = this.xOf(beat);
    if (x < this.gutterW - 20 || x > this.pane.clientWidth + 20) {
      this.playhead.style.display = 'none';
      return;
    }
    this.playhead.style.display = '';
    // 右侧留出纵向滚动条的宽度，别让进度线压在滚动条下面
    var maxX = this.pane.clientWidth - this.vScrollW - 2;
    this.playhead.style.left = U.clamp(x, this.gutterW, maxX) + 'px';
    // 播放中加亮：整条竖线 + 顶部箭头，一眼看出播到哪
    this.playhead.classList.add('on');
  };

  /** 停止播放：收掉播放头 */
  ArrangerEditor.prototype.hidePlayhead = function () {
    this.playhead.style.display = 'none';
    this.playhead.classList.remove('on');
  };

  /** 把某条轨滚进视野（加轨 / 切轨时用）：轨多时不压缩而是滚动到它 */
  ArrangerEditor.prototype.ensureTrackVisible = function (ti) {
    var vi = this.viewMode === 'track' ? 0 : this.visibleTracks().indexOf(this.arr.getTrack(ti));
    if (vi < 0) return;
    var bands = this.layoutBands();
    var b = bands[vi];
    if (!b) return;
    var top = this.headerH(), bottom = this.contentBottom();
    if (b.top < top) this.scrollYBy(b.top - top);
    else if (b.top + b.h > bottom) this.scrollYBy(b.top + b.h - bottom);
  };

  /**
   * 播放跟随：播放头出视窗就**整段翻页**，谱面跟着重画。
   *
   * ⚠️ 以前这里只改 scrollBeat 却不 render()，画布永远是旧的一页，
   *    于是播放头（DOM 元素）在冻结的谱面上滑到右边缘后消失/跳回，
   *    看起来就是「进度线在最后一段不停循环，谱面不跟着走」。
   *    另外旧版还带一个「回退分支」，在连续滚动策略下会和前进分支互相打架。
   */
  ArrangerEditor.prototype.scrollToBeat = function (beat) {
    var vis = this.visibleBeats();
    var maxStart = Math.max(0, this.arr.totalBeats() - vis);
    var start = U.clamp(this.scrollBeat, 0, maxStart);
    // 播放头出左边界（循环回跳 / 倒退）或快走到右缘 90% → 整段翻页。
    // ⚠️ 目标位置要用「拍」绝对量算：beat - 播放头距左侧的拍数。
    //    写成 beatOf(像素) 会把当前 scrollBeat 也算进去，播放头在视窗左侧外侧时
    //    每帧都会命中「出左边界」→ 每帧往前蹭一点，实测 scrollBeat 一路飙到曲末。
    if (beat < start || beat > start + vis * 0.9) {
      var leadPx = Math.max(40, (this.pane.clientWidth - this.gutterW) * 0.12);
      var leadBeats = leadPx / this.pxPerBeat;
      start = U.clamp(beat - leadBeats, 0, maxStart);
    }
    if (start !== this.scrollBeat) {
      this.scrollBeat = start;
      this.render();      // 不重画的话谱面不会跟着翻页
    }
  };

  /** 翻页 + 落播放头：必须先翻页再定位，否则播放头用的是上一页的坐标 */
  ArrangerEditor.prototype.followBeat = function (beat) {
    this.scrollToBeat(beat);
    this.setPlayhead(beat);
  };

  ArrangerEditor.prototype.destroy = function () {
    global.removeEventListener('keydown', this._onKey);
    this.closeMenu();
  };

  BS.arrangerEditor = ArrangerEditor;
})(typeof window !== 'undefined' ? window : globalThis);

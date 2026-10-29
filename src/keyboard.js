/* BandSynth · keyboard.js
 * 虚拟键盘：鼠标/触摸滑奏 + 电脑键盘映射 + 力度控制
 * 电脑键盘布局（两排，覆盖两个八度）：
 *   Z S X D C V G B H N J M , L . ; /   →  C3 C#3 D3 ... D4
 *   Q 2 W 3 E R 5 T 6 Y 7 U I 9 O 0 P   →  C4 C#4 D4 ... C5
 *   A / W / S / E / D / F / T / G / Y / H / U / J / K
 *     → 八度切换 Z/X（低）、↑/↓ 或 [ ] 微调
 */
(function (global) {
  'use strict';
  var BS = global.BS;
  var U = BS.util, P = BS.pitch;

  /* 模式 A 的键位 → 音高：依赖当前音域（音区起点随范围自适应），
   * 所以不能用静态表，得实时算。 */
  function keyToPitch(key, lowNote) {
    return BS.keymodes.pitchOfKey(key, lowNote);
  }

  var BLACK = [1, 3, 6, 8, 10];

  function Keyboard(opts) {
    opts = opts || {};
    /* 起始八度范围：默认 C1–C5 … C4–C8（一屏 4 个八度，起始永远是 C） */
    this.minOctave = opts.minOctave === undefined ? 1 : opts.minOctave;
    this.maxOctave = opts.maxOctave === undefined ? 4 : opts.maxOctave;
    this.octave = U.clamp(opts.octave === undefined ? 3 : opts.octave, this.minOctave, this.maxOctave);
    this.numOctaves = opts.numOctaves || 4;
    this.velocity = opts.velocity === undefined ? 0.85 : opts.velocity;
    this.onNoteOn = opts.onNoteOn || function () {};
    this.onNoteOff = opts.onNoteOff || function () {};
    this.onVelocityChange = opts.onVelocityChange || function () {};

    /* 角色：'perform' = 演奏台键盘（注册到仲裁器的 synth 通道）；
     *       'display' = 只显示的键盘（下落谱面页），**不注册**到任何通道。
     * 早期所有键盘实例都注册 synth handler，下落谱面页的键盘建立时
     * 会把演奏台的 handler 顶掉 → 演奏页按键无声。 */
    this.role = opts.role || 'perform';

    // 键盘模式：全应用统一 'C' = 一字排开（A/B 保留实现，但界面不再提供切换）
    this.mode = opts.mode || 'C';
    // 模式 B 的基准八度（根音 C 的位置）
    this.baseOctave = opts.baseOctave === undefined ? 4 : opts.baseOctave;
    // 双手模式的根音基准（C 的 MIDI），随当前音域更新
    this.rootBase = 60;
    // 模式 B 的按住状态
    this._leftRoot = null;
    this._rightDegree = null;
    this._comboFired = false;
    this._comboNote = null;
    this._comboNotes = [];
    this._roots = new Set();
    this._degrees = new Set();

    // baseNote：显式指定最低音（下落谱面 / 编曲演奏条与谱面音域精确对齐）。
    // 不传时：起始音永远是 C —— octave 是「音名八度」，C3 = MIDI 48。
    if (opts.baseNote !== undefined) {
      this._baseNote = opts.baseNote;
      this.lowNote = opts.baseNote;
      this.octave = Math.floor(this.lowNote / 12) - 1;
    } else {
      this.lowNote = (this.octave + 1) * 12;
    }
    this.highNote = this.lowNote + this.numOctaves * 12;
    this.held = new Map();       // note -> source ('mouse'|'key')
    this.root = document.createElement('div');
    this.root.className = 'keyboard';

    this.build();
    this.bindPointer();
    this.bindComputerKeys();
  }

  Keyboard.prototype.build = function () {
    this.root.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.className = 'kb-wrap';

    // 白键容器（用 grid 保证均分）
    var whites = document.createElement('div');
    whites.className = 'kb-whites';
    this.whiteKeys = [];
    var whiteCount = 0;
    for (var n = this.lowNote; n <= this.highNote; n++) {
      if (BLACK.indexOf(((n % 12) + 12) % 12) >= 0) continue;
      whiteCount++;
    }
    whites.style.setProperty('--white-count', whiteCount);

    this.keyMap = new Map();

    for (var i = 0; i < whiteCount; i++) {
      var k = document.createElement('div');
      k.className = 'kb-key white';
      whites.appendChild(k);
    }
    this.whiteEls = Array.prototype.slice.call(whites.children);

    // 黑键层
    var blacks = document.createElement('div');
    blacks.className = 'kb-blacks';
    this.blackEls = [];

    var wi = 0;
    for (var n2 = this.lowNote; n2 <= this.highNote; n2++) {
      var pc = ((n2 % 12) + 12) % 12;
      var isBlack = BLACK.indexOf(pc) >= 0;
      if (!isBlack) {
        this._bindKey(this.whiteEls[wi], n2);
        wi++;
      } else {
        var bk = document.createElement('div');
        bk.className = 'kb-key black';
        // 黑键定位：位于其左侧白键的右边界
        bk.style.left = (wi / whiteCount * 100) + '%';
        blacks.appendChild(bk);
        this.blackEls.push(bk);
        this._bindKey(bk, n2);
      }
    }

    wrap.appendChild(whites);
    wrap.appendChild(blacks);

    // 八度标记：定位到对应 C 白键的左边缘
    // 每个八度含 7 个白键，故第 o 个 C 位于第 (o*7) 个白键处
    var marks = document.createElement('div');
    marks.className = 'kb-marks';
    for (var o = 0; o < this.numOctaves; o++) {
      var m = document.createElement('div');
      m.className = 'kb-octave-mark';
      m.textContent = 'C' + (this.octave + o);
      var wi2 = o * 7;
      if (wi2 < whiteCount) m.style.left = (wi2 / whiteCount * 100) + '%';
      marks.appendChild(m);
    }
    wrap.appendChild(marks);

    /* 键位标注
     * 直接挂在各自的琴键元素上（而不是放在一个覆盖层里），
     * 这样白键和黑键都能精确标注，定位天然正确。
     * 配色按老板要求：**白键黑字、黑键白字**（跟着键色反色）。 */
    this._renderLabels();

    this.root.appendChild(wrap);
    this.wrap = wrap;
  };

  /* ================= 键位标注 =================
   * 标注直接挂在琴键元素上：
   *   · 白键 → 黑字（浅底深字）
   *   · 黑键 → 白字（深底浅字）
   * 模式 A：标出该音高对应的电脑键
   * 模式 B：默认标根音键；**按下根音后改为标级数键**
   */

  /** 清除所有标注 */
  Keyboard.prototype._clearLabels = function () {
    var self = this;
    this.keyMap.forEach(function (el) {
      var old = el.querySelector('.kb-keylabel');
      if (old) old.remove();
    });
    void self;
  };

  /** 给某个键加标注 */
  Keyboard.prototype._addLabel = function (note, text, cls) {
    var el = this.keyMap.get(note);
    if (!el) return;
    var isBlack = el.classList.contains('black');
    var lab = document.createElement('div');
    lab.className = 'kb-keylabel' + (isBlack ? ' on-black' : ' on-white') +
                   (cls ? ' ' + cls : '');
    lab.textContent = text;
    el.appendChild(lab);
  };

  /** 重绘标注（模式或状态变化时调用） */
  Keyboard.prototype._renderLabels = function () {
    this._clearLabels();
    if (this.mode === 'B') this._renderLabelsDual();
    else if (this.mode === 'C') this._renderLabelsLine();
    else this._renderLabelsSingle();
  };

  /* 模式 C：一字排开 —— 白键一排、黑键一排，各自从音域最低的 C 起铺 */
  Keyboard.prototype._renderLabelsLine = function () {
    var self = this;
    var km = BS.keymodes;
    var byNote = {};
    km.LINE_WHITES.concat(km.LINE_BLACKS).forEach(function (kk) {
      var n = km.pitchOfLineKey(kk, self.lowNote);
      if (n === null) return;
      if (n < self.lowNote || n > self.highNote) return;
      byNote[n] = kk.toUpperCase();
    });
    Object.keys(byNote).forEach(function (ns) {
      self._addLabel(parseInt(ns, 10), byNote[ns]);
    });
  };

  /* 模式 A：音高直通 —— 在每个琴键上标出对应的电脑键 */
  Keyboard.prototype._renderLabelsSingle = function () {
    var self = this;
    var byNote = {};
    var km = BS.keymodes;
    Object.keys(km.KEY_SEMI).forEach(function (kk) {
      var n = km.pitchOfKey(kk, self.lowNote);
      if (n === null) return;
      if (n < self.lowNote || n > self.highNote) return;
      // 键位表保证一音一键，这里仍做合并以防将来改动
      byNote[n] = byNote[n] ? byNote[n] + '/' + kk.toUpperCase() : kk.toUpperCase();
    });
    Object.keys(byNote).forEach(function (ns) {
      self._addLabel(parseInt(ns, 10), byNote[ns]);
    });
  };

  /* 模式 B：双手（左右分工）
   * · 未按根音 → 显示根音键（键盘左半区）
   * · 已按根音 → 隐藏根音、改显示级数键（键盘右半区，按当前根音定位）
   */
  Keyboard.prototype._renderLabelsDual = function () {
    var self = this;
    var km = BS.keymodes;
    var hasRoot = !!(this._roots && this._roots.size);
    var rootKey = null;
    if (hasRoot) {
      var arr = Array.from(this._roots);
      rootKey = arr[arr.length - 1];
    }

    /* 未按根音：标出所有「根音键」（左半区，低八度） */
    if (!hasRoot) {
      var rootMap = {};
      km.ROOT_GROUPS.forEach(function (gid) {
        km.GROUPS.forEach(function (g) {
          if (g.id !== gid) return;
          g.keys.forEach(function (kk, idx) {
            var n = km.pitchOfKey(kk, self.lowNote);
            if (n === null) return;
            if (n < self.lowNote || n > self.highNote) return;
            if (!rootMap[n]) rootMap[n] = kk.toUpperCase();
          });
        });
      });
      Object.keys(rootMap).forEach(function (ns) {
        self._addLabel(parseInt(ns, 10), rootMap[ns], 'is-root');
      });
      return;
    }

    /* 已按根音：标出级数键（按当前根音算实际音高位置） */
    var rootMidi = km.rootPitchOf(rootKey, self.lowNote);
    if (rootMidi === null) return;
    var degreeMap = {};
    km.DEGREE_GROUPS.forEach(function (gid) {
      km.GROUPS.forEach(function (g) {
        if (g.id !== gid) return;
        g.keys.forEach(function (kk) {
          var d = km.degreeOf(kk);
          if (!d) return;
          var n = km.pitchFromRoot(rootMidi, d.degree, d.octOffset);
          if (n < self.lowNote || n > self.highNote) return;
          degreeMap[n] = (degreeMap[n] ? degreeMap[n] + '/' : '') + kk.toUpperCase();
        });
      });
    });
    Object.keys(degreeMap).forEach(function (ns) {
      self._addLabel(parseInt(ns, 10), degreeMap[ns], 'is-degree');
    });
  };

  Keyboard.prototype._whiteNoteAt = function (i) {
    var n = this.lowNote, count = 0;
    while (count <= i) {
      if (BLACK.indexOf(((n % 12) + 12) % 12) < 0) {
        if (count === i) return n;
        count++;
      }
      n++;
    }
    return n;
  };

  Keyboard.prototype._bindKey = function (el, note) {
    this.keyMap.set(note, el);
    el.dataset.note = String(note);
    el.setAttribute('aria-label', P.midiToName(note));
  };

  /* ---------------- 指针交互 ---------------- */
  Keyboard.prototype.bindPointer = function () {
    var self = this;
    var lastNote = null;

    function noteFromPoint(x, y) {
      var el = document.elementFromPoint(x, y);
      while (el && !el.classList.contains('kb-key')) el = el.parentElement;
      if (!el || !el.dataset.note) return null;
      return parseInt(el.dataset.note, 10);
    }

    function down(e) {
      if (e.button !== undefined && e.button !== 0) return;
      var note = noteFromPoint(e.clientX, e.clientY);
      if (note === null) return;
      self.root.setPointerCapture && self.root.setPointerCapture(e.pointerId);
      lastNote = note;
      self._press(note, 'mouse', self._velFromY(e.clientY, note));
      e.preventDefault();
    }

    function move(e) {
      if (lastNote === null) return;
      // 多点触控时不做滑奏（滑奏仅鼠标）
      if (e.pointerType && e.pointerType !== 'mouse') return;
      var note = noteFromPoint(e.clientX, e.clientY);
      if (note === null || note === lastNote) return;
      var vel = self._velFromY(e.clientY, note);
      self._release(lastNote, 'mouse');
      lastNote = note;
      self._press(note, 'mouse', vel);
    }

    function up() {
      if (lastNote !== null) { self._release(lastNote, 'mouse'); lastNote = null; }
    }

    this.root.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  /* 纵向位置决定力度：越靠上越轻（模拟真实触键） */
  Keyboard.prototype._velFromY = function (clientY, note) {
    var el = this.keyMap.get(note);
    if (!el) return this.velocity;
    var r = el.getBoundingClientRect();
    if (r.height < 4) return this.velocity;
    var t = U.clamp((clientY - r.top) / r.height, 0, 1);
    return U.clamp(0.45 + t * 0.55, 0.1, 1);
  };

  /* ---------------- 电脑键盘 ---------------- */
  /** 切换键盘模式：A = 音高直通；B = 左手根音 + 右手级数；C = 一字排开 */
  Keyboard.prototype.setMode = function (mode) {
    mode = (mode === 'B' || mode === 'C') ? mode : 'A';
    if (this.mode === mode) return;
    this.allOff();
    this.mode = mode;
    this._leftRoot = null;
    this._rightDegree = null;
    this._comboFired = false;
    this._comboNote = null;
    this.build();
    this._renderLabels();
    BS.emit('kb:mode', mode);
  };

  /**
   * 当前模式下某键的音高（A 音高直通 / C 一字排开 共用这一条路径）。
   * 模式 B 走根音+级数，不经过这里。
   */
  Keyboard.prototype._pitchForKey = function (k) {
    if (this.mode === 'C') return BS.keymodes.pitchOfLineKey(k, this.lowNote);
    return keyToPitch(k, this.lowNote);
  };

  /* 模式 B：左手根音 + 右手级数
   * 语义：
   *   · 左右手同时按下才发声，松开任意一个即结束
   *   · 右手可**同时按住多个级数** → 一次弹出一个和弦
   *   · 左手按住 1 号区或 3 号区选根音（3 号区高两个八度）
   *   · 右手 2 号区 = 根音同八度的级数，4 号区 = 高一个八度的级数
   */

  /** 模式 B：左手根音按下 */
  Keyboard.prototype._pressLeft = function (key) {
    this._leftRoot = key;
    this._roots = this._roots || new Set();
    this._roots.add(key);
    this._tryCombo();
    // 按下根音 → 标注从「根音键」切成「级数键」
    this._renderLabels();
    this._emitRootChanged();
  };

  /** 根音变化 → 通知外部更新提示（当前根音名） */
  Keyboard.prototype._emitRootChanged = function () {
    if (BS.on) BS.emit('kb:root', {
      key: this._leftRoot,
      name: this._leftRoot ? BS.keymodes.rootNameOf(this._leftRoot, this.lowNote) : null
    });
  };

  /** 模式 B：右手级数按下 */
  Keyboard.prototype._pressRight = function (key) {
    this._rightDegree = key;
    this._degrees = this._degrees || new Set();
    this._degrees.add(key);
    this._tryCombo();
  };

  /** 重新计算应该发声的音集合并同步到音频层 */
  Keyboard.prototype._tryCombo = function () {
    var arr = BS.keymodes;
    var roots = Array.from(this._roots || []);
    var degs = Array.from(this._degrees || []);
    if (!roots.length || !degs.length) { this._endCombo(); return; }

    // 单一根音：取最后按下的那个（老板：单一根音下的多级）
    var rootKey = roots[roots.length - 1];
    // 根音 = 按下的那个键本身的音高（不是音区起点 C）
    var rootMidi = arr.rootPitchOf(rootKey, this.lowNote);
    if (rootMidi === null) { this._endCombo(); return; }

    // 每个级数算一个音；4 号区高八度
    var want = {};
    var low = this.lowNote;
    degs.forEach(function (dk) {
      var d = arr.degreeOf(dk, low);
      if (!d) return;
      var n = arr.pitchFromRoot(rootMidi, d.degree, d.octOffset);
      want[n] = true;
    });

    // 已经发声的先停掉（重新组合）
    var self = this;
    var cur = this._comboNotes || [];
    var curSet = {};
    cur.forEach(function (n) { curSet[n] = true; });
    cur.forEach(function (n) {
      if (!want[n]) self._releaseCombo(n);
    });
    // 新增的发声
    var next = [];
    Object.keys(want).forEach(function (ns) {
      var n = parseInt(ns, 10);
      if (!curSet[n]) self._press(n, 'combo', self.velocity);
      next.push(n);
    });
    this._comboNotes = next;
  };

  /** 模式 B：松开左手 → 结束组合音 */
  Keyboard.prototype._releaseLeft = function (key) {
    if (this._roots) this._roots.delete(key);
    if (!this._roots || !this._roots.size) this._leftRoot = null;
    this._tryCombo();
    // 松开根音 → 标注回到「根音键」
    this._renderLabels();
    this._emitRootChanged();
  };

  /** 模式 B：松开右手 → 结束组合音 */
  Keyboard.prototype._releaseRight = function (key) {
    if (this._degrees) this._degrees.delete(key);
    if (!this._degrees || !this._degrees.size) this._rightDegree = null;
    this._tryCombo();
  };

  /** 结束组合音：释放已发声的音并清除状态 */
  Keyboard.prototype._endCombo = function () {
    var self = this;
    (this._comboNotes || []).forEach(function (n) { self._releaseCombo(n); });
    this._comboNotes = [];
    this._comboFired = false;
    this._comboNote = null;
  };

  /* 组合音（模式B）专用：强制释放，不受 mouse 来源保护影响 */
  Keyboard.prototype._releaseCombo = function (note) {
    if (!this.held.has(note)) return;
    this.held.delete(note);
    var el = this.keyMap.get(note);
    if (el) el.classList.remove('active');
    this.onNoteOff(note);
  };

  /* 键盘事件统一由 BS.keyArb 分发（避免与鼓组、全局快捷键冲突） */
  Keyboard.prototype.bindComputerKeys = function () {
    var self = this;
    this._keyMapEls = [];
    if (this._keysBound) this.destroy();   // 重复调用时先解绑，避免一次按键触发多次

    this._onKeyDown = function (e) {
      if (e.repeat) return;
      // e.target 可能为 null（仲裁器转发时构造的是简化事件对象）
      var el = e.target || null;
      var tag = (el && el.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || (el && el.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      var k = e.key.toLowerCase();

      // 音域切换：只认方向键。
      // ⚠️ '[' / ']' 是 2 号区的演奏键，绝不能当音域切换。
      if (k === 'arrowleft') { self.setOctave(self.octave - 1); e.preventDefault(); return; }
      if (k === 'arrowright') { self.setOctave(self.octave + 1); e.preventDefault(); return; }

      // 模式 B：1/3 号区 = 根音（左手），2/4 号区 = 级数（右手）
      if (self.mode === 'B') {
        var role = BS.keymodes.handRole(k);
        if (role === 'root') {
          e.preventDefault();
          self._pressLeft(k);
          return;
        }
        if (role === 'degree') {
          e.preventDefault();
          self._pressRight(k);
          return;
        }
        return;
      }

      // 模式 A / C：按当前模式的键位表实时算音高
      var note = self._pitchForKey(k);
      if (note === null) return;
      if (note < self.lowNote || note > self.highNote) return;
      e.preventDefault();

      var el = self.keyMap.get(note);
      if (el && !self._keyMapEls.some(function (x) { return x.note === note; })) {
        self._keyMapEls.push({ note: note, el: el });
      }
      self._press(note, 'key', self.velocity);
    };

    this._onKeyUp = function (e) {
      var k = e.key.toLowerCase();
      // 模式 B：释放根音 / 级数
      if (self.mode === 'B') {
        var role2 = BS.keymodes.handRole(k);
        if (role2 === 'root') { self._releaseLeft(k); return; }
        if (role2 === 'degree') { self._releaseRight(k); return; }
        return;
      }

      // 模式 A / C
      var note = self._pitchForKey(k);
      if (note === null) return;
      var idx = self._keyMapEls.findIndex(function (x) { return x.note === note; });
      if (idx >= 0) self._keyMapEls.splice(idx, 1);
      self._release(note, 'key');
    };

    this._onBlur = function () { self.allOff(); };

    // 不直接绑 window —— 交给仲裁器统一分发，避免多监听器互相抢键。
    // 必须用 bind 保住 this：_handleKey 内部要用 this._onKeyDown。
    if (BS.keyArb && this.role === 'perform') {
      // 传 owner，仲裁器会 bind 到它 —— 即使外部直接传方法引用也不会丢 this
      BS.keyArb.setSynthHandler(this._handleKey, this);
    }
    this._keysBound = true;
  };

  /** 仲裁器调用的按键处理（key, event, isKeyUp） */
  Keyboard.prototype._handleKey = function (key, e, isKeyUp) {
    // 构造完整的事件对象：_onKeyDown 会读 target / ctrlKey 等字段
    var fake = {
      key: key,
      target: null,
      repeat: false,
      ctrlKey: false, metaKey: false, altKey: false,
      preventDefault: function () {}, stopPropagation: function () {}
    };
    if (isKeyUp) { this._onKeyUp(fake); return; }
    this._onKeyDown(fake);
  };

  /* 解绑全局键盘事件。
   * 谱面模式的琴键会被重建（音域随曲谱变），若不解绑，
   * 旧的监听器会一直响应，造成「一次按键响多次」与内存泄漏。 */
  Keyboard.prototype.destroy = function () {
    if (!this._keysBound) return;
    // 只有 perform 角色的键盘注册过 synth handler，也只有它能清
    if (BS.keyArb && this.role === 'perform') BS.keyArb.setSynthHandler(null);
    this._keysBound = false;
    this._onKeyDown = this._onKeyUp = this._onBlur = null;
  };

  /* ---------------- 音符开关 ---------------- */
  Keyboard.prototype._press = function (note, source, vel) {
    if (note < this.lowNote || note > this.highNote) return;
    var existing = this.held.get(note);
    if (existing) {
      // 已按下：仅更新力度
      this.onVelocityChange(note, vel);
      return;
    }
    this.held.set(note, source);
    var el = this.keyMap.get(note);
    if (el) el.classList.add('active');
    this.onNoteOn(note, vel);
  };

  Keyboard.prototype._release = function (note, source) {
    if (!this.held.has(note)) return;
    // 若同一音还被其他来源按住，不释放
    var el = this.keyMap.get(note);
    if (el && source === 'mouse' && this._keyMapEls.some(function (x) { return x.note === note; })) return;
    this.held.delete(note);
    if (el) el.classList.remove('active');
    this.onNoteOff(note);
  };

  Keyboard.prototype.allOff = function () {
    if (this._comboFired || (this._comboNotes && this._comboNotes.length)) this._endCombo();
    this._leftRoot = null;
    this._rightDegree = null;
    if (this._roots) this._roots.clear();
    if (this._degrees) this._degrees.clear();
    var notes = Array.from(this.held.keys());
    for (var i = 0; i < notes.length; i++) {
      var el = this.keyMap.get(notes[i]);
      if (el) el.classList.remove('active');
      this.held.delete(notes[i]);
      this.onNoteOff(notes[i]);
    }
    this._keyMapEls.length = 0;
  };

  /* 外部（如步进音序）触发的音也要点亮 */
  Keyboard.prototype.lightOn = function (note, vel) {
    var el = this.keyMap.get(note);
    if (el) el.classList.add('active');
    void vel;
  };
  Keyboard.prototype.lightOff = function (note) {
    var el = this.keyMap.get(note);
    if (el) el.classList.remove('active');
  };

  Keyboard.prototype.setOctave = function (o) {
    // 起始八度只能落在 [minOctave, maxOctave]：C1–C5 … C4–C8（一屏 4 个八度）
    o = U.clamp(o, this.minOctave, this.maxOctave);
    if (o === this.octave) return;
    this.allOff();
    this.octave = o;
    // baseNote 模式下 lowNote 由外部指定，不能被 octave 覆盖
    if (this._baseNote === undefined) {
      this.lowNote = (o + 1) * 12;      // 起始永远是 C：octave 3 → C3 = 48
      this.highNote = this.lowNote + this.numOctaves * 12;
    }
    this.build();
    this._renderLabels();
    BS.emit('kb:octave', o);
  };

  Keyboard.prototype.setVelocity = function (v) {
    this.velocity = U.clamp(v, 0.1, 1);
    this.onVelocityChange(null, this.velocity);
  };

  BS.Keyboard = Keyboard;
  BS.KEYMAP = BS.keymodes.GROUPS;   // 键位表（物理位映射）

})(window);

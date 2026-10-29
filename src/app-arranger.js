/* BandSynth · app-arranger.js
 * 编曲界面的接线层。
 *
 * 职责：
 *   1. 初始化 BS.arranger 与 BS.arrangerEditor
 *   2. 总设定（Key / BPM / 拍号 / 小节数 / 吸附）
 *   3. 音轨管理（增删、选音色、鼓/合成器）
 *   4. 和弦库 + 节奏型填充
 *   5. 试听 / 录制
 *   6. **统一音色选择器**：所有「选择音色」的界面都从这里取数据，
 *      声部增删时全部同步刷新（需求 3 的关键）
 */
(function (global) {
  'use strict';
  var BS = global.BS;
  var U = BS.util;

  var App = BS.app;

  /* 元素缓存：app.js 的 els 是私有的，这里独立取一份。
     必须在 app.js 加载后（本文件在 app.js 之后引入）才能拿到。 */
  var els = {};
  function cacheEls() {
    var ids = ['agHost', 'agPlay', 'agStop', 'agRecord', 'agKey', 'agScale',
      'agBpm', 'agSig', 'agBars', 'agBarsAdd', 'agBarsDel', 'agGrid',
      'agAddTrack', 'agDelTrack', 'agStatus', 'agStatus2',
      'agBarSel', 'agBarDel', 'agChord', 'agPattern', 'agFill', 'agCountIn',
      'agSelectAll', 'agDelSel',
      'agUndo', 'agRedo', 'agLoop',
      'agZoomIn', 'agZoomOut', 'agFit', 'agProg', 'agProgApply',
      'agEditBar', 'agEditTitle', 'agEditSave', 'agEditCancel',
      'agEditToolWrap', 'agEditToolSelect', 'agEditToolAdd', 'agEditHint',
      'agEditSolo', 'agEditSoloWrap',
      'agEditZoomYIn', 'agEditZoomYOut',
      'agInstrument', 'agInstTitle', 'agInstHint', 'agInstBody',
      'agInstOctDown', 'agInstOctUp'];
    ids.forEach(function (id) { els[id] = document.getElementById(id); });
  }

  /* ======================================================================
   * 统一音色来源
   * ── 需求 3：所有可指定音色的界面都要同步 ──
   * 音色有三个来源：
   *   ① 引擎里的声部（engine.parts）—— 用户自己装的采样，最优先
   *   ② 采样库里的预设（library.listPresets）—— 保存的音色
   *   ③ 内置音色（factory.list）—— 24 种合成音色
   * 任何界面要「选音色」都调 BS.tonePicker.options()，
   * 并在 parts:changed / library:changed 时重新拉取。
   * ==================================================================== */

  var TonePicker = BS.tonePicker = {
    _cache: null,

    /** 返回 [{ value, label, group, kind }] */
    options: function (opts) {
      opts = opts || {};
      var out = [];

      // ① 引擎声部
      var parts = App.engine ? App.engine.parts : [];
      parts.forEach(function (p, i) {
        out.push({
          value: 'part:' + i,
          label: (p.name || p.bufferName || ('声部 ' + (i + 1))) + (p.isDrumGroup ? '（整套鼓）' : ''),
          group: '当前声部',
          kind: 'part',
          partIndex: i,
          toneId: p._toneId || null,
          isDrum: !!p.isDrumGroup
        });
      });

      // ② 采样库预设
      try {
        var presets = BS.library.listPresets ? BS.library.listPresets() : [];
        presets.forEach(function (pre) {
          out.push({
            value: 'preset:' + pre.id,
            label: pre.name,
            group: '采样库音色',
            kind: 'preset',
            presetId: pre.id,
            toneId: pre.toneId || null,
            sampleId: pre.sampleId || null
          });
        });
      } catch (e) { /* 库未初始化 */ }

      // ③ 内置音色
      if (BS.factory && BS.factory.list) {
        BS.factory.list().forEach(function (id) {
          var pre = BS.factory.preset(id);
          out.push({
            value: 'builtin:' + id,
            label: (pre && pre.name) || id,
            group: BS.factory.isDrum && BS.factory.isDrum(id) ? '内置鼓组' : '内置音色',
            kind: 'builtin',
            toneId: id,
            isDrum: BS.factory.isDrum ? BS.factory.isDrum(id) : false
          });
        });
      }

      void opts;
      return out;
    },

    /** 按 value 找描述 */
    find: function (value) {
      var list = this.options();
      for (var i = 0; i < list.length; i++) if (list[i].value === value) return list[i];
      return null;
    },

    /**
     * 把音色描述应用到一个声部（会创建/复用声部）。
     * @returns {number} 声部索引
     */
    applyToPart: function (partIndex, value) {
      var desc = this.find(value);
      if (!desc) return partIndex;

      if (desc.kind === 'part') {
        // 已经是某个声部 → 复制其参数到目标声部
        var src = App.engine.parts[desc.partIndex];
        var dst = App.engine.parts[partIndex];
        if (!src || !dst || src === dst) return partIndex;
        copyPartParams(src, dst);
        if (src.buffer) { dst.setBuffer(src.buffer, src.bufferName); dst.endSec = src.bufferDuration; }
        dst._toneId = src._toneId || null;
        return partIndex;
      }

      if (desc.kind === 'preset') {
        var p = App.engine.parts[partIndex];
        if (!p) return partIndex;
        BS.library.getPreset(desc.presetId).then(function (pre) {
          if (!pre) { toast('预设已不存在', 3000); return; }
          BS.library.applyPreset(p, pre);
          p._presetId = pre.id;
          p._toneId = pre.toneId || null;
          // 采样引用
          if (pre.sampleId) {
            BS.library.getSample(pre.sampleId).then(function (rec) {
              if (rec && App.ctx) {
                p.setBuffer(BS.library.recordToBuffer(App.ctx, rec), rec.name);
                p._librarySampleId = rec.id;
                p.endSec = p.bufferDuration;
              }
            });
          }
          renderAllPartsUI();
        });
        return partIndex;
      }

      // 内置音色
      var target = App.engine.parts[partIndex];
      if (!target) return partIndex;
      var buf = BS.factory.buffer(App.ctx, desc.toneId);
      if (buf) {
        target.setBuffer(buf, '内置:' + desc.toneId);
        target.endSec = buf.duration;
      }
      var pre2 = BS.factory.preset(desc.toneId);
      if (pre2) {
        if (pre2.mode) { target.mode = pre2.mode; target._modeUser = true; }
        if (pre2.pitchMode) target.pitchMode = pre2.pitchMode;
        if (pre2.root !== undefined) target.rootNote = pre2.root;
        if (pre2.amp) target.amp = Object.assign({}, target.amp, pre2.amp);
        if (pre2.filter) target.filter = Object.assign({}, target.filter, pre2.filter);
      }
      target._toneId = desc.toneId;
      return partIndex;
    }
  };

  function copyPartParams(src, dst) {
    var fields = ['mode', 'startSec', 'endSec', 'reverse', 'rootNote', 'transpose', 'fine',
      'keyTrack', 'pitchMode', 'stretchQuality', 'drive', 'unison', 'detune',
      'sampleGain', 'volume', 'pan', 'sendReverb', 'sendDelay',
      'maxVoices', 'velocityToGain', 'portamento'];
    fields.forEach(function (k) { dst[k] = src[k]; });
    dst.amp = Object.assign({}, src.amp);
    dst.filter = Object.assign({}, src.filter);
    dst.filter2 = Object.assign({}, src.filter2);
    dst._modeUser = true;             // 复制过来的播放模式视为已选定
  }

  /** 刷新所有依赖声部列表的界面 */
  function renderAllPartsUI() {
    if (App.renderParts) App.renderParts();
    if (App.refreshTonePickers) App.refreshTonePickers();
  }
  BS.renderAllPartsUI = renderAllPartsUI;

  /* ======================================================================
   * 锁时长变调（stretch）预热
   * ── 为什么播放前要等 ──
   * WSOLA 是后台分片算的。缓存没命中时 Part.noteOn 会**立刻退回变速变调**：
   * 音高是对的，但时值跟着音高变（升八度短一半）。放在编曲里就是同一个
   * pad 音色在不同音高上长短不一、卡不进小节 —— 听起来像「时值没锁住」。
   * 所以起播前先按本曲**实际用到的音高**算完缓存（而不是每 3 个半音粗预热），
   * 算完再起播：宁可等一两秒，也不要听错的时值。
   * ==================================================================== */

  /** 收集编曲里各声部实际用到的音高（鼓轨不走音高体系，跳过） */
  function stretchJobs(arr) {
    var byPart = {}, order = [];
    arr.getTracks().forEach(function (t) {
      if (t.role === 'drum') return;
      var p = App.engine && App.engine.parts[t.part];
      if (!p || !p.buffer || p.pitchMode !== 'stretch') return;
      var key = p.id || ('part' + t.part);
      if (!byPart[key]) { byPart[key] = { part: p, notes: [] }; order.push(key); }
      var bucket = byPart[key].notes;
      (t.notes || []).forEach(function (n) {
        if (n && !n.mute && typeof n.pitch === 'number') bucket.push(n.pitch);
      });
    });
    return order.map(function (k) { return byPart[k]; })
      .filter(function (j) { return j.notes.length > 0; });
  }

  /** 同步数一下还差多少个音高没算（用于决定要不要挡住起播） */
  function stretchMissing(jobs) {
    var n = 0, map = BS.pitchAlgo.cache.map;
    jobs.forEach(function (j) {
      var quality = j.part.stretchQuality || 'medium';
      var seen = {};
      j.notes.forEach(function (note) {
        var r = BS.pitchAlgo.ratioForNote(note, j.part.rootNote, j.part.transpose, j.part.fine);
        if (!r) return;
        var k = BS.pitchAlgo.cache.key(j.part.id, r, quality);
        if (seen[k]) return;
        seen[k] = 1;
        if (!map.has(k)) n++;
      });
    });
    return n;
  }

  /** 预热并等待就绪；没有需要算的就立刻 resolve */
  function prepareStretch(jobs) {
    if (!App.ctx || !jobs || !jobs.length) return Promise.resolve({ total: 0, pending: 0 });
    var ps = jobs.map(function (j) {
      return BS.pitchAlgo.warmNotes(App.ctx, j.part.buffer, j.part.id, j.notes,
        j.part.rootNote, j.part.transpose, j.part.fine, j.part.stretchQuality,
        { timeoutMs: 20000 });
    });
    return Promise.all(ps).then(function (res) {
      var out = { total: 0, pending: 0 };
      res.forEach(function (r) { out.total += r.total; out.pending += r.pending; });
      return out;
    });
  }

  /** 进编曲页时在后台把本曲用到的音高算好（不等，纯粹让第一次试听别卡） */
  function prewarmArrangementStretch() {
    var arr = AG.arr;
    if (!arr || !App.ctx) return;
    var jobs = stretchJobs(arr);
    if (jobs.length) prepareStretch(jobs);
  }

  /* ======================================================================
   * 音色选择界面注册表
   * ── 需求 3：声部增删时，所有可指定音色的界面都要同步更新 ──
   * 任何界面想「让用户选音色」，就调 BS.tonePicker.register(refreshFn)，
   * 之后引擎声部一变，它会自动被调用。
   * ==================================================================== */

  TonePicker._subs = [];

  /** 注册一个需要同步的界面刷新函数，返回注销函数 */
  TonePicker.register = function (fn) {
    if (typeof fn !== 'function') return function () {};
    TonePicker._subs.push(fn);
    return function () {
      var i = TonePicker._subs.indexOf(fn);
      if (i >= 0) TonePicker._subs.splice(i, 1);
    };
  };

  /** 通知所有订阅者刷新（声部/库变化时调用） */
  TonePicker.refreshAll = function () {
    TonePicker._subs.slice().forEach(function (fn) {
      try { fn(); } catch (e) { console.error('音色选择器刷新失败', e); }
    });
  };

  /**
   * 生成一个「音色下拉框」并自动注册同步。
   * @param el       <select> 元素
   * @param opts     { onChange(value), value, filter(desc) }
   */
  TonePicker.fillSelect = function (el, opts) {
    opts = opts || {};
    if (!el) return;
    function fill() {
      var cur = el.value;
      el.innerHTML = '';
      var list = TonePicker.options();
      var groups = {};
      list.forEach(function (o) {
        if (opts.filter && !opts.filter(o)) return;
        (groups[o.group] = groups[o.group] || []).push(o);
      });
      Object.keys(groups).forEach(function (g) {
        var og = document.createElement('optgroup');
        og.label = g;
        groups[g].forEach(function (o) {
          var op = document.createElement('option');
          op.value = o.value;
          op.textContent = o.label;
          og.appendChild(op);
        });
        el.appendChild(og);
      });
      if (cur) el.value = cur;
      else if (opts.value) el.value = opts.value;
    }
    fill();
    TonePicker.register(fill);
    if (opts.onChange) el.addEventListener('change', function () { opts.onChange(el.value); });
    el._toneFill = fill;
  };

  /* ======================================================================
   * 编曲界面
   * ==================================================================== */

  var AG = App.ag = {
    arr: null,
    editor: null,
    recording: false,
    recStartBeat: 0,
    recLastBeat: 0,
    /* 走带状态唯一来源是 App.sequencer；这里只记「是否由编曲页发起」，
       播放头位置一律读 sequencer.beatPosition()，不再自己计时。 */
    _playing: false,
    _countingIn: false,
    _countInTimer: null,
    _stretchToken: 0,    // 锁时长变调预热的取消令牌（停止/重播时作废）
    _preparing: false,   // 正在等锁时长变的缓存就绪（还没真正起播）
    _soloEditPreview: true,  // 单轨编辑时试听只放本轨（默认开）
    _held: {}            // 录制中按住的键 → { id, beat, pitch, voice, trackIndex }
  };

  function toast(msg, dur) { if (App.toast) App.toast(msg, dur); }

  /** 初始化编曲页（惰性：首次进入才建） */
  function ensureArranger() {
    // 用 _ready 而不是 AG.arr 判断：初始化中途失败时 AG.arr 可能已赋值，
    // 若只看 AG.arr 会跳过重建，导致 editor 永远为 null。
    if (AG._ready && AG.arr && AG.editor) return AG.arr;
    AG.arr = null;
    AG.editor = null;
    AG._ready = false;

    if (!App.engine) { toast('请先点击页面任意处启动音频引擎'); return null; }
    cacheEls();
    if (!els.agHost) { toast('编曲界面未就绪'); return null; }

    AG.arr = new BS.arranger({ song: null });
    // 若已有曲谱，直接载进来
    if (App.song) {
      AG.arr.setSong(cloneSong(App.song));
      // 继承原曲谱的轨（补 role/toneId）
      adoptTracks();
    } else {
      AG.arr.setSong({
        version: 1, name: '新编曲', bpm: 120, timeSignature: [4, 4],
        swing: 0, tracks: []
      });
    }

    AG.editor = new BS.arrangerEditor({
      host: els.agHost,
      arranger: AG.arr,
      getPart: function (ti) {
        var t = AG.arr.getTrack(ti);
        if (!t || !App.engine) return null;
        return App.engine.parts[t.part];
      },
      getDrumRack: function () { return App.drumRack; },
      onRequestChord: function (bar, x, y) { openChordPicker(bar, x, y); },
      onRulerContext: function (bar, x, y) { openSectionPicker(bar, x, y); },
      onTrackMix: function (ti) { applyTrackMix(ti); },
      // 轨头「声部」下拉：列出现有声部（鼓组声部不参与，鼓组轨固定走鼓组通道）
      getPartOptions: function () {
        if (!App.engine) return [];
        var tracks = AG.arr ? AG.arr.getTracks() : [];
        return App.engine.parts.map(function (p, i) {
          var owner = -1;
          tracks.forEach(function (t, ti) {
            if (t.role !== 'drum' && t.part === i) owner = ti;
          });
          return {
            index: i,
            name: p.name || p.bufferName || ('声部 ' + (i + 1)),
            drum: !!p.isDrumGroup,
            usedBy: owner
          };
        });
      },
      onPartChange: function (ti, partIndex) { changeTrackPart(ti, partIndex); },
      onRoleChange: function (ti, role) { changeTrackRole(ti, role); },
      onToolChange: function (tool) { syncEditTool(tool); },
      // 播放中单击谱面 → 从该拍继续播（播放器式的进度跳转）
      onSeek: function (beat) { return seekToBeat(beat); },
      toast: toast,
      onChange: function () { renderAgStatus(); }
    });
    AG.editor.onTonePick = function (ti) { pickToneForTrack(ti); };
    syncEditTool(AG.editor.editTool);   // 分段开关的初始状态（框选）
    bindInstControls();
    // 双击音轨 → 进入单轨编辑
    AG.editor.onOpenTrack = function (ti) { openTrackEdit(ti); };
    AG.editor.onEditModeChange = function (mode, ti) { onEditModeChanged(mode, ti); };

    AG.arr.on('change', function () {
      /* ⚠️ 不要在这里调 App.renderParts()。
         拖动音块时 updateNote 会高频触发 change，而 renderParts 会重建
         左侧整列声部卡片（含 20+ 个旋钮 DOM）→ 掉帧，还会打断正在输入的名称。
         声部增删本身有 parts:changed 事件，那边已经负责重绘。
         requestRender 在拖动中合并到下一帧。 */
      AG.editor && AG.editor.requestRender();
      /* 激活轨/角色变了 → 底部演奏条跟着换（声部↔鼓组、低音↔普通） */
      var at = AG.arr.getActiveTrack();
      var key = AG.arr.activeTrackIndex + '|' + (at ? at.role : '') + '|' + (at ? at.part : '');
      if (AG._instKey !== key) { AG._instKey = key; syncInstrument(); }
      renderAgStatus();
    });
    AG.arr.on('history', function () { syncHistoryButtons(); });
    // 声部/库变化 → 音轨列表里的音色名要跟着更新
    TonePicker.register(function () {
      if (!AG.arr) return;
      // 同步轨的 toneId（声部可能被换掉）
      AG.arr.getTracks().forEach(function (t) {
        var p = App.engine && App.engine.parts[t.part];
        if (p && p._toneId) t.toneId = p._toneId;
      });
      AG.editor && AG.editor.render();
    });

    AG.arr.on('selection:change', function (sel) {
      renderAgStatus(sel);
      AG.editor && AG.editor.render();
    });

    buildAgControls();
    bindRecKeys();
    AG._ready = true;

    /* 进页面就能用的最小结构：
       · 鼓组永远只有一条完整音轨（多条自动合并，缺失自动补上，且放在最上面）
       · 空工程再补一条声部音轨，避免「进来一片空白不知道点哪」 */
    consolidateDrumTracks(false);
    normalizeDrumName();
    var wasEmpty = !AG.arr.trackCount();
    if (wasEmpty || drumTrackIndex() < 0) ensureDrumTrack();
    // 默认音轨优先绑到现成声部（钢琴），没有空闲声部才新建
    if (wasEmpty) addPartTrack(firstFreePartIndex(), '音轨 1');
    sanitizeTrackParts();
    focusFirstPartTrack();
    syncInstrument();
    // 编曲页始终是「编曲乐器」上下文：在这里按键只响当前轨，不串到演奏/鼓组页
    if (BS.keyArb && (!App.stage || App.stage === 'arrange')) BS.keyArb.setContext('arrange');
    renderAgStatus();
    return AG.arr;
  }

  /** 演奏条上方的音域 ±（和键盘 ← → 走同一条逻辑） */
  function bindInstControls() {
    if (AG._instCtlBound) return;
    AG._instCtlBound = true;
    if (els.agInstOctDown) {
      els.agInstOctDown.addEventListener('click', function () { shiftOctave(-1); });
    }
    if (els.agInstOctUp) {
      els.agInstOctUp.addEventListener('click', function () { shiftOctave(1); });
    }
  }

  function cloneSong(song) {
    return JSON.parse(JSON.stringify({
      version: song.version || 1,
      name: song.name, bpm: song.bpm, timeSignature: song.timeSignature,
      swing: song.swing, tracks: song.tracks.map(function (t) {
        return {
          name: t.name, part: t.part,
          volume: t.volume, pan: t.pan, muted: t.muted, solo: t.solo,
          notes: t.notes.map(function (n) {
            var x = { beat: n.beat, len: n.len, pitch: n.pitch, vel: n.vel };
            if (n.glide > 0) x.glide = n.glide;          // 音符修饰也要一并带走
            if (n.vib > 0) { x.vib = n.vib; if (n.vibRate > 0) x.vibRate = n.vibRate; }
            return x;
          })
        };
      })
    }));
  }

  /** 把原曲谱的轨纳入编曲，补上 role / toneId */
  function adoptTracks() {
    var arr = AG.arr;
    if (!arr || !arr.getSong()) return;
    arr.getTracks().forEach(function (t, i) {
      t.role = t.role || (arr.guessRole(t) ? 'drum' : (arr.isBassName(t) ? 'bass' : 'synth'));
      t.color = t.color || BS.arranger.TRACK_COLORS[i % BS.arranger.TRACK_COLORS.length];
      if (!t.toneId) {
        // 尝试从绑定的声部推断
        var p = App.engine && App.engine.parts[t.part];
        if (p && p._toneId) t.toneId = p._toneId;
      }
    });
  }

  /* ---------------- 控件构建 ---------------- */

  function buildAgControls() {
    // 调性
    fillSelect(els.agKey, BS.arrangerLib.NOTE_NAMES.map(function (n) {
      return { v: n, l: n };
    }));
    // 调式
    fillSelect(els.agScale, Object.keys(BS.arrangerLib.SCALES).map(function (k) {
      return { v: k, l: BS.arrangerLib.SCALES[k].name };
    }));
    // 拍号
    fillSelect(els.agSig, ['4/4', '3/4', '6/8', '2/4', '5/4', '7/8', '12/8'].map(function (s) {
      return { v: s, l: s };
    }));
    // 吸附
    fillSelect(els.agGrid, BS.arranger.GRID_OPTIONS.map(function (g) {
      return { v: String(g.v), l: g.label };
    }));
    // 和弦库
    fillSelect(els.agChord, []);
    // 模板（节奏型 / 鼓型，按当前轨类型切换）
    refreshPatternOptions();
    // 和弦进行预设
    fillSelect(els.agProg, BS.arrangerLib.PROGRESSIONS.map(function (p) {
      return { v: p.id, l: p.name };
    }));

    // 同步初值
    syncAgControls();

    // 绑定
    els.agKey.addEventListener('change', function () {
      AG.arr.setKey(els.agKey.value, els.agScale.value);
      fillChordOptions();
    });
    els.agScale.addEventListener('change', function () {
      AG.arr.setKey(els.agKey.value, els.agScale.value);
      fillChordOptions();
    });
    els.agBpm.addEventListener('change', function () {
      AG.arr.setBpm(parseInt(els.agBpm.value, 10) || 120);
      els.agBpm.value = AG.arr.getSong().bpm;
      pushTempo();
    });
    els.agSig.addEventListener('change', function () {
      var p = els.agSig.value.split('/');
      AG.arr.setTimeSignature(parseInt(p[0], 10), parseInt(p[1], 10));
      pushSig();
    });
    els.agBars.addEventListener('change', function () {
      AG.arr.setLength(parseInt(els.agBars.value, 10) || 16);
      els.agBars.value = AG.arr.lengthBars;
    });
    els.agBarsAdd.addEventListener('click', function () {
      AG.arr.extendBars(4);
      els.agBars.value = AG.arr.lengthBars;
    });
    els.agBarsDel.addEventListener('click', function () {
      AG.arr.extendBars(-4);
      els.agBars.value = AG.arr.lengthBars;
    });
    els.agGrid.addEventListener('change', function () {
      AG.arr.grid = parseFloat(els.agGrid.value) || 1 / 16;
    });
    els.agChord.addEventListener('change', renderAgStatus);
    // 选模板时试听一小节（原来这功能挂在模板 chips 上，chips 与下拉重复，已合并到下拉）
    els.agPattern.addEventListener('change', function () {
      previewPattern(els.agPattern.value);
      renderAgStatus();
    });

    els.agAddTrack.addEventListener('click', openAddTrackDialog);
    els.agDelTrack.addEventListener('click', function () {
      if (!AG.arr) return;
      var t = AG.arr.getActiveTrack();
      if (!t) { toast('还没有音轨'); return; }
      if (AG.arr.trackCount() <= 1) { toast('至少保留一条音轨'); return; }
      if (AG.arr.selection.size) AG.arr.clearSelection();
      AG.arr.pushUndo('删除音轨');
      var at = AG.arr.activeTrackIndex;
      AG.arr.removeTrack(at);
      if (AG.editor) AG.editor.stopAudition();
      toast('已删除音轨「' + t.name + '」（Ctrl+Z 可撤销）');
      renderAgStatus();
    });

    els.agBarDel.addEventListener('click', function () {
      var bars = parseBarSelection(els.agBarSel.value);
      if (!bars.length) { toast('请先在小节框输入要删除的小节，如 1-4,7', 3500); return; }
      AG.arr.pushUndo('删除小节');
      var n = AG.arr.deleteBars(bars);
      toast(n > 0 ? ('已删除 ' + n + ' 个音块（Ctrl+Z 可撤销）') : '所选小节没有内容');
      renderAgStatus();
    });
    els.agFill.addEventListener('click', fillCurrentBar);
    els.agSelectAll.addEventListener('click', function () {
      AG.arr.selectAllInTrack(AG.arr.activeTrackIndex);
      renderAgStatus();
    });
    els.agDelSel.addEventListener('click', function () {
      if (!AG.arr.selection.size) { toast('没有选中的音块'); return; }
      AG.arr.pushUndo('删除音块');
      var n = AG.arr.deleteSelection();
      toast(n ? ('已删除 ' + n + ' 个音块（Ctrl+Z 可撤销）') : '没有选中的音块');
      renderAgStatus();
    });

    /* 撤销 / 重做 / 循环 / 缩放 */
    if (els.agUndo) els.agUndo.addEventListener('click', function () {
      if (AG.arr.undo()) toast('已撤销：' + (AG.arr.redoLabel() || ''));
      renderAgStatus();
    });
    if (els.agRedo) els.agRedo.addEventListener('click', function () {
      if (AG.arr.redo()) toast('已重做');
      renderAgStatus();
    });
    if (els.agLoop) els.agLoop.addEventListener('click', function () {
      if (AG.arr.loop) { AG.arr.clearLoop(); toast('已取消循环'); }
      else {
        var s = AG.arr.targetBar;
        var e = Math.min(AG.arr.lengthBars, s + 4);
        AG.arr.setLoop(s, e);
        toast('循环第 ' + (s + 1) + '–' + e + ' 小节（Shift+拖标尺可改）');
      }
      renderAgStatus();
    });
    if (els.agZoomIn) els.agZoomIn.addEventListener('click', function () { AG.editor.zoomBy(1.3); });
    if (els.agZoomOut) els.agZoomOut.addEventListener('click', function () { AG.editor.zoomBy(1 / 1.3); });
    if (els.agFit) els.agFit.addEventListener('click', function () { AG.editor.fit(); });

    /* 一键铺和弦进行 */
    if (els.agProgApply) els.agProgApply.addEventListener('click', function () {
      var prog = (BS.arrangerLib.PROGRESSIONS || []).filter(function (p) {
        return p.id === els.agProg.value;
      })[0];
      if (!prog) return;
      AG.arr.pushUndo('铺和弦进行');
      var ti = AG.arr.activeTrackIndex;
      var startBar = AG.arr.targetBar;
      var applied = AG.arr.applyProgression(startBar, prog.degrees, {
        trackIndex: ti,
        patternId: els.agPattern.value,
        octave: 3
      });
      /* 光标跟着铺到下一小节：连续铺进行时不用每次手动点标尺。
         已铺到曲末就不再前进（避免下次覆盖最后一小节）。 */
      var nextBar = startBar + applied;
      if (nextBar < AG.arr.lengthBars) {
        AG.arr.setTargetBar(nextBar);
        if (AG.editor) {
          AG.editor.scrollToBar(nextBar, true);
          AG.editor.render();
        }
      }
      toast('已从第 ' + (startBar + 1) + ' 小节铺 ' + applied + ' 小节：' + prog.name +
        '（光标已在第 ' + (AG.arr.targetBar + 1) + ' 小节 · Ctrl+Z 可撤销）', 3500);
      renderAgStatus();
    });

    /* 单轨编辑的鼠标模式：框选 / 添加（原来那个「允许修改」勾选框换成了它） */
    if (els.agEditToolSelect) els.agEditToolSelect.addEventListener('click', function () {
      if (!AG.editor) return;
      AG.editor.setEditTool('select');
      toast('框选模式：拖动空白处框选音块 · 选区可整组横/纵移动（每次移动响第一个音）· Delete 删除选中', 3200);
    });
    if (els.agEditToolAdd) els.agEditToolAdd.addEventListener('click', function () {
      if (!AG.editor) return;
      AG.editor.setEditTool('add');
      toast('添加模式：左键点击空白处直接加音 · 拖动音块移动（落点响该处音高）· Delete 删除选中', 3200);
    });
    /* 纵向（音高方向）缩放：音域宽的轨在单轨编辑里音块只有几像素高，点不中 */
    if (els.agEditZoomYIn) els.agEditZoomYIn.addEventListener('click', function () {
      if (AG.editor) AG.editor.zoomYBy(1.3);
    });
    if (els.agEditZoomYOut) els.agEditZoomYOut.addEventListener('click', function () {
      if (AG.editor) AG.editor.zoomYBy(1 / 1.3);
    });
    /* 单轨编辑试听：默认只放本轨（编辑一条轨时听到整首伴奏反而听不清细节）。 */
    if (els.agEditSolo) els.agEditSolo.addEventListener('change', function () {
      AG._soloEditPreview = !!els.agEditSolo.checked;
      if (els.agEditSoloWrap) els.agEditSoloWrap.classList.toggle('on', AG._soloEditPreview);
      toast(AG._soloEditPreview
        ? '单轨试听：只播放正在编辑的轨'
        : '单轨试听已关闭：试听播放整首', 2200);
      // 正在播就按新设置从当前位置重排，否则要等下一次播放才生效
      if (AG._playing && App.sequencer && App.sequencer.playing) {
        var b = App.sequencer.beatPosition ? App.sequencer.beatPosition() : 0;
        stopArrangement();
        playArrangement({ fromBeat: b });
      }
    });
    if (els.agEditSave) els.agEditSave.addEventListener('click', saveTrackEdit);
    if (els.agEditCancel) els.agEditCancel.addEventListener('click', cancelTrackEdit);

    els.agPlay.addEventListener('click', playArrangement);
    els.agStop.addEventListener('click', stopArrangement);
    els.agRecord.addEventListener('click', toggleRecord);

    fillChordOptions();
  }

  function fillSelect(sel, items) {
    if (!sel) return;
    sel.innerHTML = '';
    items.forEach(function (it) {
      var o = document.createElement('option');
      o.value = it.v;
      o.textContent = it.l;
      sel.appendChild(o);
    });
  }

  function fillChordOptions() {
    if (!els.agChord || !AG.arr) return;
    var chords = AG.arr.chordsInKey(AG.arr.key, AG.arr.scale);
    var items = [];
    chords.forEach(function (c) {
      items.push({ v: c.root + '|' + c.quality, l: c.root + BS.arrangerLib.CHORD_QUALITIES[c.quality].symbol });
    });
    // 额外提供所有品质供自由选择
    Object.keys(BS.arrangerLib.CHORD_QUALITIES).forEach(function (q) {
      var qq = BS.arrangerLib.CHORD_QUALITIES[q];
      items.push({ v: '|' + q, l: '（任意根音）' + qq.name });
    });
    var cur = els.agChord.value;
    fillSelect(els.agChord, items);
    if (cur) els.agChord.value = cur;
  }

  /* ---------------- 模板条（悬停试听 / 点击选用） ---------------- */

  var _previewTimer = null;
  var _previewVoices = [];
  var _previewSeq = 0;          // 预热期间可能被取消，用序号作废迟到的起播

  function cancelPreview() {
    _previewSeq++;
    if (_previewTimer) { clearTimeout(_previewTimer); _previewTimer = null; }
    _previewVoices.forEach(function (v) {
      try { v && v.release && v.release(); } catch (e) { /* noop */ }
    });
    _previewVoices = [];
  }

  /** 试听当前模板（1 小节），不写入数据 —— 听到的就是点下去会填的 */
  function previewPattern(patternId) {
    if (!AG.arr || !App.ctx) return;
    var arr = AG.arr;
    var ti = arr.activeTrackIndex;
    var t = arr.getTrack(ti);
    if (!t) return;
    cancelPreview();
    var seq = _previewSeq;

    var cv = (els.agChord && els.agChord.value) || '';
    var parts = cv.split('|');
    var chord = arr.getChord(arr.targetBar);
    var root = parts[0] || (chord ? chord.root : arr.key);
    var qual = parts[1] || (chord ? chord.quality : 'maj');
    var pitches = arr.chordPitches(root, qual, 3);
    var list = arr.patternNotes(arr.targetBar, pitches, patternId, { role: t.role });
    if (!list.length) return;

    var secPerBeat = 60 / (arr.getSong().bpm || 120);
    var t0 = arr.targetBar * arr.barBeats();
    var part = t.role === 'drum' ? null : App.engine.parts[t.part];

    var play = function () {
      if (seq !== _previewSeq) return;      // 已被取消 / 换了模板
      list.slice(0, 48).forEach(function (x) {
        var delay = Math.max(0, (x.beat - t0) * secPerBeat) * 1000;
        setTimeout(function () {
          if (seq !== _previewSeq) return;
          try {
            if (t.role === 'drum') {
              if (App.drumRack) App.drumRack.hitPitch(x.pitch, 0.85);
            } else if (part && part.buffer) {
              var v = part.noteOn(x.pitch, 0.8);
              if (v) _previewVoices.push(v);
            }
          } catch (e) { /* noop */ }
        }, delay);
      });
      _previewTimer = setTimeout(cancelPreview, arr.barBeats() * secPerBeat * 1000 + 400);
    };

    /* 锁时长变调：模板试听同样不能退回变速变调（时值会随音高变），
       先把这几个音高算好，通常几十毫秒；算不完就先按变速变调出声。 */
    if (part && part.buffer && part.pitchMode === 'stretch') {
      BS.pitchAlgo.warmNotes(App.ctx, part.buffer, part.id,
        list.map(function (x) { return x.pitch; }),
        part.rootNote, part.transpose, part.fine, part.stretchQuality, { timeoutMs: 1200 })
        .then(play, play);
    } else {
      play();
    }
  }

  /** 切轨/改角色后：模板列表要跟着换（鼓轨给鼓型） */
  function refreshPatternOptions() {
    if (!AG.arr || !els.agPattern) return;
    var list = AG.arr.patternsFor(AG.arr.activeTrackIndex);
    var cur = els.agPattern.value;
    fillSelect(els.agPattern, list.map(function (p) { return { v: p.id, l: p.name }; }));
    var stillThere = list.some(function (p) { return p.id === cur; });
    if (cur && stillThere) els.agPattern.value = cur;
  }

  /* ---------------- 和弦格：点一下改和弦 ---------------- */

  function openChordPicker(bar, cx, cy) {
    if (!AG.arr) return;
    var arr = AG.arr;
    var host = document.getElementById('agChordPop');
    if (!host) {
      host = document.createElement('div');
      host.id = 'agChordPop';
      host.className = 'ag-chordpop';
      document.body.appendChild(host);
    }
    host.innerHTML = '';

    var title = document.createElement('div');
    title.className = 'ag-chordpop-t';
    title.textContent = '第 ' + (bar + 1) + ' 小节 和弦';
    host.appendChild(title);

    var wrap = document.createElement('div');
    wrap.className = 'ag-chordpop-g';
    arr.chordsInKey(arr.key, arr.scale).forEach(function (c) {
      var q = BS.arrangerLib.CHORD_QUALITIES[c.quality];
      var b = document.createElement('button');
      b.className = 'ag-chordpop-i';
      b.textContent = c.root + (q ? q.symbol : '');
      b.addEventListener('click', function () {
        closeChordPicker();
        chooseChord(bar, c.root, c.quality);
      });
      wrap.appendChild(b);
    });
    host.appendChild(wrap);

    var wrap2 = document.createElement('div');
    wrap2.className = 'ag-chordpop-g';
    ['maj7', 'min7', 'dom7', 'sus4', 'add9', 'dim'].forEach(function (q) {
      var b = document.createElement('button');
      b.className = 'ag-chordpop-i alt';
      b.textContent = arr.key + (BS.arrangerLib.CHORD_QUALITIES[q] || {}).symbol;
      b.addEventListener('click', function () {
        closeChordPicker();
        chooseChord(bar, arr.key, q);
      });
      wrap2.appendChild(b);
    });
    host.appendChild(wrap2);

    var clr = document.createElement('button');
    clr.className = 'ag-chordpop-i clear';
    clr.textContent = '清除该小节和弦';
    clr.addEventListener('click', function () {
      closeChordPicker();
      arr.pushUndo('清除和弦');
      arr.clearChord(bar);
      renderAgStatus();
    });
    host.appendChild(clr);

    host.style.display = 'block';
    var r = host.getBoundingClientRect();
    host.style.left = Math.min(cx - r.width / 2, innerWidth - r.width - 10) + 'px';
    host.style.top = Math.min(cy + 8, innerHeight - r.height - 10) + 'px';
  }

  function closeChordPicker() {
    var host = document.getElementById('agChordPop');
    if (host) host.style.display = 'none';
  }

  /**
   * 设定小节和弦：若该小节在当前轨已经有音符，按当前模板重铺 ——
   * 改和弦立刻听到新和声，不用再点一次「填充」。
   */
  function chooseChord(bar, root, quality) {
    var arr = AG.arr;
    if (!arr) return;
    arr.pushUndo('改和弦');
    arr.setChord(bar, root, quality);
    arr.setTargetBar(bar);

    var ti = arr.activeTrackIndex;
    var t = arr.getTrack(ti);
    var bb = arr.barBeats();
    var hasNotes = t && t.notes.some(function (n) {
      return n.beat < (bar + 1) * bb && n.beat + n.len > bar * bb;
    });
    if (t && hasNotes) {
      var pitches = arr.chordPitches(root, quality, 3);
      arr.fillBar(ti, bar, pitches, els.agPattern.value, {
        drumPitch: t.role === 'drum' ? 36 : undefined
      });
    }
    // 下拉框跟着显示当前小节和弦，保持「看到的就是听到的」
    if (els.agChord) {
      var v = root + '|' + quality;
      if (Array.prototype.some.call(els.agChord.options, function (o) { return o.value === v; })) {
        els.agChord.value = v;
      }
    }
    toast('第 ' + (bar + 1) + ' 小节 → ' + arr.chordLabel(bar));
    renderAgStatus();
  }

  /* ---------------- 标尺右键：段落标记 ---------------- */

  var SECTION_PRESETS = ['前奏', '主歌', '预副歌', '副歌', '桥段', '间奏', '尾奏'];

  function openSectionPicker(bar, cx, cy) {
    if (!AG.arr) return;
    var arr = AG.arr;
    var host = document.getElementById('agSecPop');
    if (!host) {
      host = document.createElement('div');
      host.id = 'agSecPop';
      host.className = 'ag-chordpop';
      document.body.appendChild(host);
    }
    host.innerHTML = '';

    var cur = arr.sectionAt(bar);

    var title = document.createElement('div');
    title.className = 'ag-chordpop-t';
    title.textContent = '第 ' + (bar + 1) + ' 小节 · 段落' + (cur ? '：' + cur.name : '（未标记）');
    host.appendChild(title);

    var wrap = document.createElement('div');
    wrap.className = 'ag-chordpop-g';
    SECTION_PRESETS.forEach(function (name) {
      var b = document.createElement('button');
      b.className = 'ag-chordpop-i' + (cur && cur.name === name ? ' on' : '');
      b.textContent = name;
      b.addEventListener('click', function () { applySection(bar, name); });
      wrap.appendChild(b);
    });
    host.appendChild(wrap);

    var inp = document.createElement('input');
    inp.className = 'ag-secpop-in';
    inp.type = 'text';
    inp.maxLength = 12;
    inp.placeholder = '自定义段落名（留空 = 清除标记）';
    inp.value = cur ? cur.name : '';
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        applySection(bar, inp.value.trim());
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeSectionPicker();
      }
    });
    host.appendChild(inp);

    var row = document.createElement('div');
    row.className = 'ag-chordpop-g';
    var ok = document.createElement('button');
    ok.className = 'ag-chordpop-i';
    ok.textContent = cur ? '改名' : '添加标记';
    ok.addEventListener('click', function () { applySection(bar, inp.value.trim()); });
    row.appendChild(ok);
    if (cur) {
      var del = document.createElement('button');
      del.className = 'ag-chordpop-i clear';
      del.textContent = '删除该标记';
      del.addEventListener('click', function () { applySection(bar, ''); });
      row.appendChild(del);
    }
    host.appendChild(row);

    host.style.display = 'block';
    var r = host.getBoundingClientRect();
    host.style.left = Math.max(8, Math.min(cx - r.width / 2, innerWidth - r.width - 10)) + 'px';
    host.style.top = Math.min(cy + 8, innerHeight - r.height - 10) + 'px';
    inp.focus();
    inp.select();

    // 点浮层外面关闭（只挂一次，触发后自摘）
    setTimeout(function () {
      var off = function (ev) {
        if (host.contains(ev.target)) return;
        document.removeEventListener('pointerdown', off, true);
        closeSectionPicker();
      };
      document.addEventListener('pointerdown', off, true);
    }, 0);
  }

  function closeSectionPicker() {
    var host = document.getElementById('agSecPop');
    if (host) host.style.display = 'none';
  }

  /** 写入段落标记（可撤销）；name 为空即删除 */
  function applySection(bar, name) {
    var arr = AG.arr;
    if (!arr) return;
    closeSectionPicker();
    arr.pushUndo(name ? '段落标记' : '清除段落');
    arr.setSection(bar, name);
    toast('第 ' + (bar + 1) + ' 小节 → ' + (name || '无段落标记'));
    renderAgStatus();
  }

  /* ---------------- 轨混音 ---------------- */

  function applyTrackMix(ti) {
    var arr = AG.arr;
    if (!arr || !App.engine) return;
    var t = arr.getTrack(ti);
    if (!t) return;
    if (t.role === 'drum') {
      /* 鼓轨：音量/声像由播放事件按轨带 gain/pan，试听在 editor.auditionNote 里
         按轨音量缩放力度。这里不再强行把鼓组总线解除静音（那会覆盖用户在鼓组页的静音）。 */
      return;
    }
    var p = App.engine.parts[t.part];
    if (!p) return;
    p.volume = t.volume === undefined ? 0.85 : t.volume;
    p.pan = t.pan || 0;
  }

  function syncHistoryButtons() {
    if (!AG.arr) return;
    if (els.agUndo) {
      els.agUndo.disabled = !AG.arr.canUndo();
      els.agUndo.title = AG.arr.canUndo() ? ('撤销：' + AG.arr.undoLabel() + ' (Ctrl+Z)') : '没有可撤销的操作';
    }
    if (els.agRedo) {
      els.agRedo.disabled = !AG.arr.canRedo();
      els.agRedo.title = AG.arr.canRedo() ? ('重做：' + AG.arr.redoLabel() + ' (Ctrl+Shift+Z)') : '没有可重做的操作';
    }
  }

  function syncAgControls() {
    if (!AG.arr) return;
    var song = AG.arr.getSong();
    if (els.agKey) els.agKey.value = AG.arr.key;
    if (els.agScale) els.agScale.value = AG.arr.scale;
    if (els.agBpm) els.agBpm.value = song.bpm;
    if (els.agSig) els.agSig.value = song.timeSignature.join('/');
    if (els.agBars) els.agBars.value = AG.arr.lengthBars;
    if (els.agGrid) els.agGrid.value = String(AG.arr.grid);
  }

  /* ---------------- 速度 / 拍号：编曲页是唯一入口 ----------------
   * 顶栏的速度/拍号控件已移除，编曲页改完直接同步到 song / 序列器 / 引擎，
   * 保证「看到的速度」=「播放的速度」=「导出/渲染用的速度」。 */

  /** 编曲页 → App.song / 引擎 */
  function pushTempo() {
    if (!AG.arr) return;
    var v = AG.arr.getSong().bpm;
    if (App.applyTempo) App.applyTempo(v);
    else if (App.song) App.song.bpm = v;
  }

  function pushSig() {
    if (!AG.arr) return;
    var sig = AG.arr.getSong().timeSignature;
    if (App.applyTimeSignature) App.applyTimeSignature(sig);
  }

  /* ---------------- 音轨管理 ---------------- */

  /** 第一条鼓轨的索引（-1 = 没有） */
  function drumTrackIndex() {
    if (!AG.arr) return -1;
    var ts = AG.arr.getTracks();
    for (var i = 0; i < ts.length; i++) if (ts[i].role === 'drum') return i;
    return -1;
  }

  /**
   * 鼓组只保留一条完整音轨。
   * 以前连点「+ 鼓轨」会堆出多条鼓轨，鼓组被拆成好几块，
   * 播放时听起来没事、编排时却看不出「一套鼓」。这里把多余的鼓轨并进第一条。
   */
  function consolidateDrumTracks(announce) {
    var arr = AG.arr;
    if (!arr) return -1;
    var ts = arr.getTracks();
    var keeper = null;
    for (var i = 0; i < ts.length; i++) {
      if (ts[i].role === 'drum') { keeper = ts[i]; break; }
    }
    if (!keeper) return -1;

    var extras = ts.filter(function (t) { return t.role === 'drum' && t !== keeper; });
    if (!extras.length) return arr.getTracks().indexOf(keeper);

    extras.forEach(function (t) {
      t.notes.forEach(function (n) { keeper.notes.push(n); });
      t.notes.length = 0;
      arr.removeTrack(arr.getTracks().indexOf(t));
    });
    keeper.notes.sort(function (a, b) { return a.beat - b.beat; });
    arr.changed('track:drum-merge');
    if (announce) toast('已把多条鼓轨合并为一条鼓组轨');
    return arr.getTracks().indexOf(keeper);
  }

  /**
   * 旧曲谱/导入的鼓轨常叫「底鼓」「军鼓」（那时一轨只放一面鼓）。
   * 现在鼓轨是**整套鼓**，名字只写一面鼓会让人以为只有那一面，统一改成「鼓组」。
   * 用户自己起的名字（不在鼓名表里）保持不动。
   */
  function normalizeDrumName() {
    var arr = AG.arr;
    if (!arr) return;
    var LABEL = BS.arrangerLib.DRUM_LABEL || {};
    var drumNames = Object.keys(LABEL).map(function (id) { return LABEL[id]; });
    arr.getTracks().forEach(function (t) {
      if (t.role !== 'drum') return;
      if (drumNames.indexOf(t.name) >= 0) t.name = '鼓组';
    });
  }

  /** 保证有一条鼓组轨（不新建重复的）；返回其索引 */
  function ensureDrumTrack() {
    var arr = ensureArranger();
    if (!arr) return -1;
    var idx = consolidateDrumTracks(false);
    if (idx >= 0) return idx;
    if (App.ensureDrumRack) App.ensureDrumRack();
    var t = arr.addTrack({ name: '鼓组', role: 'drum', partIndex: -1, toneId: 'drumkit' });
    return t ? arr.getTracks().indexOf(t) : -1;
  }

  /**
   * 第一个还没被别的轨占用的声部索引；一个都没有时返回 -1（调用方按「新建声部」处理）。
   * 进编曲页补默认音轨时用它 —— 直接用现成的钢琴/贝斯/原声吉他，
   * 别再凭空多建一个重复声部。
   */
  function firstFreePartIndex() {
    if (!App.engine) return -1;
    var parts = App.engine.parts;
    var used = {};
    if (AG.arr) {
      AG.arr.getTracks().forEach(function (t) {
        if (t.role !== 'drum') used[t.part] = true;
      });
    }
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] && !parts[i].isDrumGroup && !used[i] && !parts[i]._usedByTrack) return i;
    }
    return -1;
  }

  /** 新建一条声部音轨；partIndex < 0 = 新建声部 */
  function addPartTrack(partIndex, name) {
    var arr = ensureArranger();
    if (!arr) return -1;
    if (!App.engine) { toast('请先启动音频引擎'); return -1; }
    var p = App.engine.parts[partIndex];
    if (!p) {
      BS.factory.makePart(App.engine, 'piano', {});
      partIndex = App.engine.parts.length - 1;
      p = App.engine.parts[partIndex];
    }
    if (!p) { toast('创建声部失败'); return -1; }
    p._usedByTrack = true;
    var t = arr.addTrack({
      name: name || ('音轨 ' + (arr.trackCount() + 1)),
      role: 'synth',
      partIndex: partIndex,
      toneId: p._toneId || 'piano'
    });
    if (!t) return -1;
    var idx = arr.getTracks().indexOf(t);
    arr.setActiveTrack(idx);
    // 轨多到需要滚动时，新加的轨要自动滚进视野（否则看不到刚加的那条）
    if (AG.editor && AG.editor.ensureTrackVisible) AG.editor.ensureTrackVisible(idx);
    return idx;
  }

  /** 添加音轨：先选类型（声部音轨 / 鼓组音轨），再选声部与名称 */
  function openAddTrackDialog() {
    var arr = ensureArranger();
    if (!arr) return;
    if (!App.engine) { toast('请先点击页面任意位置启动音频引擎'); return; }

    var parts = App.engine.parts.map(function (p, i) {
      return { index: i, name: p.name || p.bufferName || ('声部 ' + (i + 1)), drum: !!p.isDrumGroup };
    }).filter(function (p) { return !p.drum; });
    var partOpts = parts.map(function (p) {
      return '<option value="' + p.index + '">' + U.escapeHtml(p.name) + '</option>';
    }).join('');
    var hasDrum = drumTrackIndex() >= 0;

    var html =
      '<div class="ag-addkind-row">' +
        '<label class="ag-addkind"><input type="radio" name="agAddKind" value="synth" checked>' +
          '<span>声部音轨</span><em>绑定一个声部</em></label>' +
        '<label class="ag-addkind">' +
          '<input type="radio" name="agAddKind" value="drum">' +
          '<span>鼓组音轨</span><em>整套鼓，一条轨</em></label>' +
      '</div>' +
      '<div class="ag-addfield" id="agAddPartField"><span>声部</span>' +
        '<select class="sel" id="agNewPart">' +
          '<option value="new" selected>＋ 新建声部（钢琴）</option>' + partOpts +
        '</select>' +
      '</div>' +
      '<div class="ag-addfield"><span>名称</span>' +
        '<input class="text-input" id="agNewName" placeholder="留空自动命名"></div>' +
      '<p class="ag-addhint" id="agAddHint">声部音轨 = 一条轨绑定一个声部，可在轨头随时更换。</p>' +
      '<div class="modal-actions">' +
        '<button class="btn" data-act="no">取消</button>' +
        '<button class="btn primary" data-act="yes">创建音轨</button>' +
      '</div>';

    BS.modal.show('添加音轨', html, function (box) {
      var kind = 'synth';
      var partField = box.querySelector('#agAddPartField');
      var hint = box.querySelector('#agAddHint');
      var nameInput = box.querySelector('#agNewName');
      box.querySelectorAll('input[name="agAddKind"]').forEach(function (r) {
        r.addEventListener('change', function () {
          if (!r.checked) return;
          kind = r.value;
          partField.style.display = kind === 'drum' ? 'none' : '';
          hint.textContent = kind === 'drum'
            ? (hasDrum
              ? '已有鼓组轨：创建会直接切换到那条轨（鼓组永远只有一条）。'
              : '鼓组音轨是一条完整轨：纵向 12 面鼓、横向节拍，直接使用鼓组通道。')
            : '声部音轨 = 一条轨绑定一个声部，可在轨头随时更换。';
        });
      });
      box.querySelector('[data-act="no"]').addEventListener('click', function () { BS.modal.close(); });
      box.querySelector('[data-act="yes"]').addEventListener('click', function () {
        var name = nameInput.value.trim();
        BS.modal.close();
        if (kind === 'drum') {
          var di = ensureDrumTrack();
          if (di >= 0) {
            AG.arr.setActiveTrack(di);
            toast(hasDrum ? '已切换到鼓组轨（始终只有一条）' : '已添加鼓组轨');
          }
        } else {
          var v = box.querySelector('#agNewPart').value;
          var pi = v === 'new' ? -1 : parseInt(v, 10);
          addPartTrack(pi, name);
          toast('已添加音轨' + (name ? '「' + name + '」' : '') + '，可在轨头更换声部');
        }
        renderAgStatus();
      });
      nameInput.focus();
    });
  }

  /**
   * 轨的 part 索引必须指向真实存在的声部。
   * 旧曲谱/导入数据里常留着越界索引（比如 2 个声部、轨却写 3），
   * 结果就是「音轨看得见、点了没声」。这里统一兜底重绑。
   */
  function sanitizeTrackParts() {
    var arr = AG.arr, eng = App.engine;
    if (!arr || !eng) return;
    var n = eng.parts.length;
    arr.getTracks().forEach(function (t) {
      if (t.role === 'drum') { t.part = -1; return; }
      if (typeof t.part === 'number' && t.part >= 0 && t.part < n && eng.parts[t.part]) return;
      var pick = -1, i;
      for (i = 0; i < n; i++) {
        if (eng.parts[i] && !eng.parts[i].isDrumGroup && !eng.parts[i]._usedByTrack) { pick = i; break; }
      }
      if (pick < 0) {
        for (i = 0; i < n; i++) {
          if (eng.parts[i] && !eng.parts[i].isDrumGroup) { pick = i; break; }
        }
      }
      if (pick < 0 && BS.factory) {
        BS.factory.makePart(eng, 'piano', {});
        pick = eng.parts.length - 1;
      }
      if (pick >= 0) {
        t.part = pick;
        eng.parts[pick]._usedByTrack = true;
        if (!t.toneId) t.toneId = eng.parts[pick]._toneId || null;
      }
    });
  }

  /** 默认活动轨放在第一条声部轨上：进页面就能直接加音，模板也对应声部音色 */
  function focusFirstPartTrack() {
    var arr = AG.arr;
    if (!arr) return;
    var ts = arr.getTracks();
    for (var i = 0; i < ts.length; i++) {
      if (ts[i].role !== 'drum') { arr.setActiveTrack(i); return; }
    }
  }

  /**
   * 音轨角色切换：声部轨（铺和弦）/ 低音声部（铺单音 bass 线）。
   * 切完立刻把模板下拉换成角色对应的那一套。
   */
  function changeTrackRole(ti, role) {
    var arr = AG.arr;
    var t = arr && arr.getTrack(ti);
    if (!t || t.role === 'drum') return;
    role = role === 'bass' ? 'bass' : 'synth';
    if (t.role === role) return;
    // 动了哪条轨就激活哪条：模板/和弦/填充按钮都跟着这条轨走
    if (arr.activeTrackIndex !== ti) arr.setActiveTrack(ti);
    arr.pushUndo('切换音轨角色');
    t.role = role;
    // 和弦型模板在低音轨上没意义（反之亦然）→ 换成本类第一个
    var list = arr.patternsFor(ti);
    if (els.agPattern && list.length &&
        !list.some(function (p) { return p.id === els.agPattern.value; })) {
      els.agPattern.value = list[0].id;
    }
    arr.changed('track:role');
    refreshPatternOptions();
    renderAgStatus();
    toast(role === 'bass'
      ? '「' + t.name + '」→ 低音声部：铺满时只铺单音 bass 线'
      : '「' + t.name + '」→ 声部轨：铺满时铺和弦', 2600);
  }

  /** 单轨编辑「编辑模式」开关（框选 / 添加）的界面同步 */
  function syncEditTool(tool) {
    var sel = tool !== 'add';
    if (els.agEditToolSelect) els.agEditToolSelect.classList.toggle('on', sel);
    if (els.agEditToolAdd) els.agEditToolAdd.classList.toggle('on', !sel);
    if (els.agEditHint) {
      els.agEditHint.textContent = sel
        ? '框选：拖动框选音块 · 整组横/纵移动（响第一个音）· Delete 删除'
        : '添加：左键点空白加音 · 拖动音块移动（响落点音高）· Delete 删除';
    }
  }

  /** 轨头声部下拉：把这条轨重新绑到另一个声部 */
  function changeTrackPart(ti, partIndex) {
    var arr = AG.arr;
    if (!arr || !App.engine) return;
    var t = arr.getTrack(ti);
    var p = App.engine.parts[partIndex];
    if (!t || !p || t.role === 'drum' || t.part === partIndex) return;
    arr.pushUndo('指定声部');
    var old = App.engine.parts[t.part];
    if (old && old !== p) old._usedByTrack = false;
    t.part = partIndex;
    p._usedByTrack = true;
    t.toneId = p._toneId || t.toneId;
    applyTrackMix(ti);
    arr.changed('track:part');
    renderAgStatus();
    toast('「' + t.name + '」→ 声部「' + (p.name || p.bufferName || ('声部 ' + (partIndex + 1))) + '」');
  }

  /** 打开音色选择对话框 */
  function pickToneForTrack(ti) {
    var arr = AG.arr;
    if (!arr) return;
    var t = arr.getTrack(ti);
    if (!t) return;

    var opts = TonePicker.options();
    var groups = {};
    opts.forEach(function (o) { (groups[o.group] = groups[o.group] || []).push(o); });

    var html = '<div class="ag-pick">';
    Object.keys(groups).forEach(function (g) {
      html += '<div class="ag-pick-g">' + g + '</div><div class="ag-pick-items">';
      groups[g].forEach(function (o) {
        html += '<button class="ag-pick-i" data-v="' + o.value + '">' + o.label + '</button>';
      });
      html += '</div>';
    });
    html += '</div>';

    BS.modal.show('选择音色 · ' + t.name, html, function (box) {
      box.querySelectorAll('.ag-pick-i').forEach(function (b) {
        b.addEventListener('click', function () {
          var v = b.dataset.v;
          var desc = TonePicker.find(v);
          // 鼓轨只能用鼓音色，合成器轨不能用鼓
          if (t.role === 'drum' && desc && !desc.isDrum && desc.kind === 'builtin') {
            toast('鼓轨只能选鼓音色', 2500);
            return;
          }
          if (t.role !== 'drum' && desc && desc.isDrum) {
            toast('声部轨不能选鼓音色，请用鼓组轨', 2500);
            return;
          }
          TonePicker.applyToPart(t.part, v);
          t.toneId = desc ? (desc.toneId || null) : null;
          arr.changed('track:tone');
          BS.modal.close();
          toast('音色已更换');
        });
      });
    });
  }

  function renameTrack(ti) {
    var arr = AG.arr;
    if (!arr) return;
    var t = arr.getTrack(ti);
    if (!t) return;
    var v = global.prompt('轨道名称', t.name);
    if (v === null) return;
    arr.updateTrack(ti, { name: v.trim() || t.name });
    renderAgStatus();
  }

  /* ---------------- 和弦填充 ---------------- */

  function fillCurrentBar() {
    var arr = AG.arr;
    if (!arr) return;
    if (!arr.trackCount()) { toast('请先添加音轨', 2500); return; }

    var ti = arr.activeTrackIndex;
    var t = arr.getTrack(ti);
    if (!t) return;

    /* 目标小节来自顶部标尺。
       ⚠️ 以前取的是「播放头所在小节」，而播放头只在播放中存在，
       一按停止就被清空 → 永远填第 1 小节。 */
    var bar = U.clamp(arr.targetBar, 0, arr.lengthBars - 1);

    var cv = els.agChord.value || '';
    var parts = cv.split('|');
    var chord = arr.getChord(bar);
    var rootName = parts[0] || (chord ? chord.root : arr.key);
    var quality = parts[1] || (chord ? chord.quality : 'maj');
    var pitches = arr.chordPitches(rootName, quality, 3);

    var pat = els.agPattern.value || 'full';
    var opts = { vel: 0.8 };
    if (t.role === 'drum') opts.drumPitch = 36;   // 鼓轨默认落底鼓（原来是和弦音高→中嗵）

    arr.pushUndo('填充小节');
    var n = arr.fillBar(ti, bar, pitches, pat, opts);

    /* 和弦写进和弦轨：标尺下方立刻显示 C / Am / F / G，
       「这一小节是什么和弦」不用切换页面或看 toast。 */
    if (rootName && t.role !== 'drum') arr.setChord(bar, rootName, quality);

    // 填完自动进下一小节：连续铺和弦进行不必每小节再点一次标尺
    if (bar + 1 < arr.lengthBars) arr.setTargetBar(bar + 1);

    renderAgStatus();
    var q = BS.arrangerLib.CHORD_QUALITIES[quality] || {};
    var pname = (arr.getPattern(pat) || {}).name || pat;
    toast('第 ' + (bar + 1) + ' 小节 ← ' +
      (t.role === 'drum' ? '鼓型'
        : t.role === 'bass' ? ('低音 ' + rootName)
          : rootName + (q.symbol || '')) +
      ' · ' + pname + '（' + n + ' 个音 · Ctrl+Z 可撤销）');
  }

  /** 解析小节选择 "1-4,7" → [0,1,2,3,6]（0-based） */
  function parseBarSelection(str) {
    var out = [];
    if (!str) return out;
    str.split(/[,，\s]+/).forEach(function (part) {
      if (!part) return;
      var m = /^(\d+)\s*[-~]\s*(\d+)$/.exec(part);
      if (m) {
        var a = parseInt(m[1], 10), b = parseInt(m[2], 10);
        if (a > b) { var t = a; a = b; b = t; }
        for (var i = a; i <= b; i++) out.push(i - 1);
      } else if (/^\d+$/.test(part)) {
        out.push(parseInt(part, 10) - 1);
      }
    });
    return out.filter(function (x) { return x >= 0; });
  }

  /* ---------------- 试听 ---------------- */

  /**
   * 播放编曲。
   * @param {object} opts { fromBeat, countIn }
   *   fromBeat  起始拍（默认目标小节）
   *   countIn   预备小节数（默认 0）
   *
   * ⚠️ 播放头不再自己用 performance.now 计时：
   *   音频是 sequencer 按 ctx.currentTime 排的，视觉另起一套时钟必然漂移，
   *   而且 AG._playheadBeat 是视觉时间 → 录制落点也跟着错。
   *   现在统一由 app.js 的 tick 读 sequencer.beatPosition() 驱动（onTick）。
   */
  /**
   * 单轨编辑时「试听只放本轨」生效的轨索引；返回 -1 表示不隔离。
   * 只在单轨编辑视图 + 开关打开时生效，总览播放永远是整首。
   */
  function isolatedTrackIndex() {
    if (!AG._soloEditPreview) return -1;
    if (!AG.editor || AG.editor.viewMode !== 'track') return -1;
    var arr = AG.arr;
    if (!arr) return -1;
    var ti = AG.editor.editTrackIndex;
    if (!(ti >= 0) || ti >= arr.trackCount()) return -1;
    return ti;
  }

  function playArrangement(opts) {
    opts = opts || {};
    var arr = ensureArranger();
    if (!arr || !App.engine) return;
    if (!arr.trackCount()) { toast('还没有音轨', 2500); return; }

    // 纯函数生成播放用 song：不再污染 App.song 的旧对象，也不会继承旧的 loopBars
    var song = arr.toSong();
    App.song = song;          // 工程保存 / 渲染读到的是当前编曲内容

    /* 单轨编辑：交给 sequencer 的是一份「其余轨静音」的拷贝。
       ⚠️ 不能把静音写进 App.song / arr 数据 —— 那会被工程保存和导出带走。 */
    var onlyTi = isolatedTrackIndex();
    var playSong = onlyTi >= 0 ? arr.toSong({ onlyTrackIndex: onlyTi }) : song;

    var startBeat = opts.fromBeat;
    if (startBeat === undefined) startBeat = arr.targetBeat();
    startBeat = Math.max(0, startBeat);
    var fromSec = startBeat * 60 / song.bpm;

    App.sequencer.setSong(playSong);
    /* 播放中改轨的声部要立刻生效：排程时按实时轨取 part。
       （setSong 传的是 toSong() 快照，不改这里的话改声部要等下次播放） */
    App.sequencer.trackOf = function (ti) { return arr.getTrack(ti); };

    /* 声部参数：把轨的音量/声像落到声部上（混音条就地在轨头调）。
       鼓轨不占声部，走鼓组通道的按轨 gain/pan。 */
    arr.getTracks().forEach(function (t) {
      if (t.role === 'drum') return;
      var p = App.engine.parts[t.part];
      if (!p) return;
      p.volume = t.volume === undefined ? p.volume : t.volume;
      p.pan = t.pan || 0;
    });

    // 循环区间内起播：目标小节在区间外时从区间头开始
    if (arr.loop && (startBeat < arr.loop.start * arr.barBeats() ||
        startBeat >= arr.loop.end * arr.barBeats())) {
      startBeat = arr.loop.start * arr.barBeats();
      fromSec = startBeat * 60 / song.bpm;
    }

    /* 锁时长变调：先把本曲用到的音高算完再起播（见 prepareStretch 上方说明）。
       期间用户再点停止/播放 → 令牌作废，不会出现「等完了又自己开始播」。 */
    if (!opts._stretchReady) {
      var stretchList = stretchJobs(arr);
      if (stretchList.length && stretchMissing(stretchList) > 0) {
        var token = ++AG._stretchToken;
        /* 预热期间用「预备」状态挡住录制落点：否则这段时间按的键会落在旧拍上
           （recNoteOn 只看 _countingIn，不看走带是否已启动）。 */
        AG._preparing = true;
        AG._countingIn = true;
        renderAgStatus();
        toast('正在准备锁时长变调，稍后开始播放…', 3000);
        prepareStretch(stretchList).then(function (r) {
          if (token !== AG._stretchToken) return;      // 期间被停止 / 重新播放
          AG._preparing = false;
          if (r.pending) toast('仍有 ' + r.pending + ' 个音高没算完，先用变速变调兜底', 3000);
          playArrangement(Object.assign({}, opts, { _stretchReady: true }));
        }, function () {
          if (token !== AG._stretchToken) return;
          playArrangement(Object.assign({}, opts, { _stretchReady: true }));
        });
        return;
      }
    }

    AG._playing = true;
    clearTimeout(AG._countInTimer);

    var countIn = opts.countIn || 0;
    if (countIn > 0) {
      /* 预备拍：先用精确的音频时钟打拍子，再启动序列器。
         视觉保持在 0（还没开始走带），录制入口在 _countingIn 期间屏蔽。 */
      AG._countingIn = true;
      var spb = 60 / song.bpm, bb = song.timeSignature[0];
      var t0 = App.ctx.currentTime + 0.15;
      if (App.metronome) {
        for (var i = 0; i < bb * countIn; i++) {
          App.metronome.click(t0 + i * spb, i % bb === 0);
        }
      }
      AG._countInTimer = setTimeout(function () {
        AG._countingIn = false;
        App.sequencer.play(fromSec);
      }, (0.15 + bb * countIn * spb) * 1000);
    } else {
      AG._countingIn = false;
      App.sequencer.play(fromSec);
    }

    if (AG.editor) AG.editor.followBeat(startBeat);   // 起播点先翻页进视野，再落播放头
    renderAgStatus();
  }

  function stopArrangement() {
    clearTimeout(AG._countInTimer);
    AG._stretchToken++;        // 让还在等待预热的播放请求作废
    AG._preparing = false;
    AG._countingIn = false;
    releaseAllRecNotes();
    if (AG.recording) stopRecording();
    if (App.sequencer) App.sequencer.stop();
    AG._playing = false;
    AG._playheadBeat = undefined;
    releaseInstNotes();
    if (AG.editor) {
      AG.editor.stopAudition();      // 鼓采样/试听尾音一起收掉
      AG.editor.hidePlayhead();
      AG.editor.render();
    }
    renderAgStatus();
  }

  /** 编曲页是否在前台（空格归属判断用） */
  function isArrangeActive() {
    var el = document.getElementById('stageArrange');
    return !!(el && el.classList.contains('active'));
  }

  /** 空格 / ▶ 按钮：播放 ↔ 停止 */
  function togglePlay() {
    // 预热中也算「正在启动」：此时再按一次应当是取消，而不是重新排队
    if (AG._playing || AG._preparing || (App.sequencer && App.sequencer.playing)) stopArrangement();
    else playArrangement({});
  }

  /**
   * 每帧调用（由 app.js 的主循环驱动），把播放头对齐到音频时钟。
   * @param {number} beat sequencer.beatPosition()
   */
  function onTick(beat) {
    if (!AG._playing) return;
    // 序列器已自行结束（播到尾 或 别处按了暂停）
    if (!App.sequencer || !App.sequencer.playing) {
      if (!AG._countingIn) {
        AG._playing = false;
        AG._playheadBeat = undefined;
        if (AG.recording) stopRecording();
        /* 走带自己停了（录到曲末最常见）：播放头必须跟着收掉，
           否则那根竖线会冻在原地，看着像还在录/还在播。 */
        if (AG.editor) AG.editor.hidePlayhead();
        renderAgStatus();
      }
      return;
    }
    AG._playheadBeat = beat;
    if (AG.editor) AG.editor.followBeat(beat);   // 先翻页再落播放头
  }

  /* ---------------- 录制 ----------------
   * 完整链路：按键 → 仲裁器（上下文必须是 'arrange'）→ 监听发声 + 记录起点
   *          → 松键 → 用时值算出 len 并回写。
   * 以前的三处断点：
   *   ① 编曲页的键盘上下文是 'other'，仲裁器根本不分发 → 按键无反应
   *   ② 不发声，录的时候听不到自己弹的
   *   ③ 落点用视觉播放头、时值恒为网格，松键直接 return
   */

  function toggleRecord() {
    if (AG.recording) { stopRecording(); return; }

    var arr = ensureArranger();
    if (!arr) return;
    if (!arr.trackCount()) { toast('请先添加音轨', 2500); return; }
    var t = arr.getActiveTrack();
    if (!t) return;

    AG.recording = true;
    AG._held = {};
    // 关键：把键盘上下文切到编曲页，否则按键永远到不了录制器
    if (BS.keyArb) BS.keyArb.setContext('arrange');
    els.agRecord.classList.add('on');
    els.agRecord.textContent = '■ 停止录制';

    // 从目标小节起走带（不在播放中时），可选预备拍
    if (!AG._playing && !(App.sequencer && App.sequencer.playing)) {
      var countIn = (els.agCountIn && els.agCountIn.checked) ? 1 : 0;
      playArrangement({ fromBeat: arr.targetBeat(), countIn: countIn });
    }

    renderAgStatus();
    toast('录制中 → 「' + t.name + '」· 从第 ' + (arr.targetBar + 1) +
      ' 小节开始 · ' + (t.role === 'drum' ? '空格/字母键打鼓' : '电脑键盘演奏') +
      ' · Esc 停止', 4200);
  }

  function stopRecording() {
    AG.recording = false;
    releaseAllRecNotes();
    releaseInstNotes();
    // 收尾后仍留在编曲页：继续用当前轨试听，别把键盘上下文切走
    if (BS.keyArb) BS.keyArb.setContext('arrange');
    if (els.agRecord) {
      els.agRecord.classList.remove('on');
      els.agRecord.textContent = '● 录制';
    }
    /* 走带已经不在跑（录到曲末 / 序列器自己停了）→ 进度竖线也要收掉，
       否则停下录制后那根线一直冻在谱面上。还在播就留着，它还得跟音频走。 */
    if (AG.editor && !(App.sequencer && App.sequencer.playing)) {
      AG._playing = false;
      AG._playheadBeat = undefined;
      AG.editor.hidePlayhead();
    }
    renderAgStatus();
  }

  /** 当前录制落点（拍）：播放中取音频时钟，未播放取目标小节起点 */
  function recBeat() {
    if (App.sequencer && App.sequencer.playing) return App.sequencer.beatPosition();
    var arr = AG.arr;
    return arr ? arr.targetBeat() : 0;
  }

  /** 键 → 鼓位 id（复用鼓组页的唯一键位表，不再维护第二份） */
  function drumIdOfKey(k) {
    var km = (BS.drumKit && BS.drumKit.KEYMAP) || null;
    if (!km) return null;
    for (var id in km) {
      if (km.hasOwnProperty(id) && km[id] === k) return id;
    }
    return null;
  }

  /** 松键：释放监听音，并把时值写回 */
  function recNoteOff(k) {
    var h = AG._held[k];
    if (!h) return;
    delete AG._held[k];
    if (h.voice && h.voice.release) { try { h.voice.release(); } catch (e) { /* noop */ } }
    if (!h.id || !AG.arr) return;

    var arr = AG.arr;
    var grid = arr.grid || 1 / 16;
    var len = arr.quantize(recBeat() - h.beat);
    if (!(len > 0)) len = grid;            // 点一下就松开：至少一个网格
    arr.updateNote(h.trackIndex, h.id, { len: arr.snapTick(len) });
  }

  /** 落一个录制音（电脑键盘与 MIDI 共用） */
  function recStart(holdKey, pitch, vel, drumId, isDrum) {
    if (!AG.recording || AG._countingIn) return;
    var arr = AG.arr;
    if (!arr) return;
    var ti = arr.activeTrackIndex;
    var t = arr.getTrack(ti);
    if (!t) return;
    if (AG._held[holdKey]) return;         // 同键/同音重复

    var beat = arr.snapTick(Math.max(0, recBeat()));

    // 监听：录进什么就听到什么
    var voice = null;
    if (isDrum) {
      if (App.drumRack && drumId) App.drumRack.hit(drumId, vel);
    } else {
      var p = App.engine.parts[t.part];
      if (p && p.buffer) voice = p.noteOn(pitch, vel);
    }

    var n = arr.addNote(ti, beat, arr.grid || 1 / 16, pitch, vel);
    AG._held[holdKey] = {
      id: n && n.id, beat: beat, pitch: pitch, voice: voice,
      trackIndex: ti, drumId: drumId
    };
    renderAgStatus();
  }

  /** 按下：监听发声 + 落一个音符（时值先按网格，松键时再改） */
  function recNoteOn(k) {
    if (!AG.recording || AG._countingIn) return;
    var arr = AG.arr;
    if (!arr) return;
    var t = arr.getTrack(arr.activeTrackIndex);
    if (!t) return;

    var isDrum = t.role === 'drum';
    var pitch, drumId = null;
    if (isDrum) {
      drumId = drumIdOfKey(k);
      if (!drumId) return;
      pitch = BS.arrangerEditor.ID_TO_DRUM_PITCH[drumId];
    } else {
      if (!(k in REC_KEYMAP)) return;
      pitch = 48 + REC_KEYMAP[k];          // C3 起
    }

    var vel = App.keyboard ? U.clamp(App.keyboard.velocity, 0.05, 1) : 0.85;
    recStart(k, pitch, vel, drumId, isDrum);
  }

  /* ---------------- MIDI 输入 ---------------- */

  function drumIdOfPitch(pitch) {
    var map = BS.arrangerEditor.DRUM_PITCH_TO_ID;
    return map && map[pitch] ? map[pitch] : null;
  }

  /**
   * MIDI 键盘按下。录制中 → 录入；未录制 → 只发声（当试音键盘用）。
   * 音高直接来自设备，不经过电脑键盘映射表。
   */
  function midiNoteOn(pitch, vel) {
    var arr = AG.arr;
    if (!arr || !arr.trackCount()) return;
    var t = arr.getTrack(arr.activeTrackIndex);
    if (!t) return;
    var isDrum = t.role === 'drum';
    var drumId = isDrum ? (drumIdOfPitch(pitch) || 'kick') : null;
    var rawPitch = pitch;                      // 设备原始音高（鼓轨会被换成鼓位音高）
    if (isDrum) pitch = BS.arrangerEditor.ID_TO_DRUM_PITCH[drumId];

    /* 谱面高亮：与电脑键盘/鼓垫一致。鼓轨的落音音高与设备音高不同，
       所以把「设备音高 → 谱面音高」记下来，松键时才能精确灭掉。 */
    if (AG.editor && AG.editor.hotRowOn) {
      AG._hotRowByRaw = AG._hotRowByRaw || {};
      AG._hotRowByRaw[rawPitch] = pitch;
      AG.editor.hotRowOn('m' + pitch, pitch);
    }

    if (!AG.recording) {
      if (isDrum) {
        if (App.drumRack) App.drumRack.hit(drumId, vel);
      } else {
        var p = App.engine && App.engine.parts[t.part];
        if (p && p.buffer) {
          AG._midiAudition = AG._midiAudition || {};
          var v = p.noteOn(pitch, vel);
          if (v) AG._midiAudition[pitch] = v;
        }
      }
      return;
    }
    recStart('m' + pitch, pitch, vel, drumId, isDrum);
  }

  function midiNoteOff(pitch) {
    if (AG.editor && AG.editor.hotRowOff) {
      var map = AG._hotRowByRaw || {};
      var mapped = map[pitch];
      if (mapped === undefined) mapped = pitch;
      AG.editor.hotRowOff('m' + mapped, mapped);
      delete map[pitch];
    }
    recNoteOff('m' + pitch);
    var a = AG._midiAudition;
    if (a && a[pitch]) {
      try { a[pitch].release && a[pitch].release(); } catch (e) { /* noop */ }
      delete a[pitch];
    }
  }

  /** 停止录制/停止播放时释放所有监听音 */
  function releaseAllRecNotes() {
    var held = AG._held || {};
    Object.keys(held).forEach(function (k) {
      var h = held[k];
      if (h.voice && h.voice.release) { try { h.voice.release(); } catch (e) { /* noop */ } }
    });
    AG._held = {};
    AG._hotRowByRaw = {};
    // 停止录制/播放时把谱面高亮一起收掉（松键事件可能永远不来了）
    if (AG.editor && AG.editor.clearHotRows) AG.editor.clearHotRows();
  }

  /* ================= 编曲页演奏条 =================
   * 声部轨 → 黑白琴键（复用演奏页的 Keyboard，但 role:'display'
   *           **不注册**到键盘仲裁器，按键统一由 arrangeKey 处理，
   *           因此不会和演奏页/鼓组页抢键）
   * 鼓组轨 → 一行 12 个鼓垫（横排省高度）
   * 不录制时也会发声（纯试听）；录制时额外把音符写进当前轨。
   */
  var Inst = {
    kind: '',      // 'synth' | 'drum'
    kb: null,      // BS.Keyboard 实例
    pads: [],      // 鼓垫 DOM
    shift: 0,      // 非低音轨的音域偏移（八度），← → / 音域 ± 调整
    held: {}       // holdKey -> { voice, pitch }
  };

  /* 音域：一屏 4 个八度，起始永远是 C。
     · 低音轨锁定 C1–C5
     · 其它轨跟随演奏页（C1–C5 … C4–C8），← → 在这 4 档之间平移 */
  var INST_OCTAVES = 4;
  var BASS_LOW_NOTE = 24;      // C1
  var LOW_MIN = 24;            // C1：起始音下限
  var LOW_MAX = 60;            // C4：起始音上限（C4–C8 就到顶了）

  /**
   * 琴键起始音（低音轨锁定 / 其它轨跟随演奏页）。
   * · 低音轨：固定 C1，不响应音域键
   * · 其它轨：默认取演奏页键盘的 lowNote —— 这样同一个键在两个页面是**同一个音**，
   *   再用 ← → （或演奏条 ±）整体平移一个八度，范围 C1 起 … C4 起
   */
  function instBaseNote(t) {
    if (t && t.role === 'bass') return BASS_LOW_NOTE;
    var perf = App.keyboard ? App.keyboard.lowNote : 48;   // 演奏页默认 C3 = 48
    return U.clamp(perf + Inst.shift * 12, LOW_MIN, LOW_MAX);
  }

  /** 音域平移一个八度；返回是否真的变了（低音轨 / 到边界时不动） */
  function shiftOctave(dir) {
    var t = AG.arr && AG.arr.getActiveTrack();
    if (!t) return false;
    if (t.role === 'bass') {
      toast('低音轨锁定在低声部（C1–C5），音域不可调', 1600);
      return false;
    }
    var perf = App.keyboard ? App.keyboard.lowNote : 48;
    var cur = U.clamp(perf + Inst.shift * 12, LOW_MIN, LOW_MAX);
    var low = U.clamp(cur + (dir < 0 ? -12 : 12), LOW_MIN, LOW_MAX);
    if (low === cur) {
      toast(dir > 0 ? '已到最高音域（C4–C8）' : '已到最低音域（C1–C5）', 1400);
      return false;
    }
    releaseInstNotes();          // 换音域前先收掉正按着的音，避免挂音
    if (AG.recording) releaseAllRecNotes();
    Inst.shift = Math.round((low - perf) / 12);
    syncInstrument();
    return true;
  }

  /** 进编曲页时把音域偏移清零：默认与演奏页键盘同一个音域 */
  function resetInstShift() {
    if (!Inst.shift) return;
    Inst.shift = 0;
    releaseInstNotes();
    syncInstrument();
  }

  /** 谱面里正选中音块时，← → 归「移动音块」，别抢去做音域切换 */
  function editorUsesArrows() {
    var ed = AG.editor;
    if (!ed || !ed.arr || !ed.pane) return false;
    if (!ed.pane.isConnected || ed.pane.offsetParent === null) return false;
    if (typeof ed.isReadOnly === 'function' && ed.isReadOnly()) return false;
    return !!(ed.arr.selection && ed.arr.selection.size);
  }

  function instVelocity() {
    return App.keyboard ? U.clamp(App.keyboard.velocity, 0.05, 1) : 0.85;
  }

  /** 电脑键 → 音高：和演奏页同一张「一字排开」表（同一个键 = 同一个音） */
  function instPitchOfKey(k) {
    var low = Inst.kb ? Inst.kb.lowNote
      : (App.keyboard ? App.keyboard.lowNote : BASS_LOW_NOTE);
    return BS.keymodes.pitchOfLineKey(k, low);
  }

  /** 构建/刷新演奏条：跟着「当前激活轨」换琴键或鼓垫 */
  function syncInstrument() {
    var body = els.agInstBody;
    if (!body || !AG.arr) return;
    // 组件没加载时别抛异常：这里一炸会把整个 ensure() 中断（编辑器/音轨都建不出来）
    if (!BS.Keyboard) return;
    var t = AG.arr.getActiveTrack();
    var kind = t && t.role === 'drum' ? 'drum' : 'synth';

    /* 音域 ± 只对可移动音域的琴键有意义：
       鼓垫轨没有音域；低音轨锁死在低声部 → 都禁用 */
    var octLocked = (kind === 'drum') || (t && t.role === 'bass');
    if (els.agInstOctDown) els.agInstOctDown.disabled = octLocked;
    if (els.agInstOctUp) els.agInstOctUp.disabled = octLocked;

    if (els.agInstTitle) {
      els.agInstTitle.textContent = t
        ? ('演奏 · ' + t.name +
           (t.role === 'drum' ? '（鼓组）' : t.role === 'bass' ? '（低音）' : ''))
        : '演奏';
    }

    if (kind === 'drum') {
      if (Inst.kind !== 'drum') {
        releaseInstNotes();
        body.innerHTML = '';
        Inst.kb = null;
        buildPads(body);
        Inst.kind = 'drum';
      }
      if (els.agInstHint) {
        els.agInstHint.textContent = '点击鼓垫或按电脑键盘打鼓 · 录制时写入鼓组轨';
      }
      return;
    }

    var base = instBaseNote(t);
    if (Inst.kind !== 'synth' || !Inst.kb || Inst.kb.lowNote !== base) {
      releaseInstNotes();
      body.innerHTML = '';
      Inst.kb = new BS.Keyboard({
        octave: Math.floor(base / 12) - 1,   // 音名八度：C1 = 24
        baseNote: base,
        numOctaves: INST_OCTAVES,            // 和演奏页一样：4 个八度
        role: 'display',              // 不注册仲裁器：按键统一走 arrangeKey
        mode: 'C',                    // 一字排开：和演奏页同一套键位
        onNoteOn: function (n, v) { instNoteOn('m' + n, n, null, false, v); },
        onNoteOff: function (n) { instNoteOff('m' + n); }
      });
      body.appendChild(Inst.kb.root);
      Inst.kind = 'synth';
    }
    if (els.agInstHint) {
      var info = BS.pitch.midiToName(base) + '–C' +
        (Math.floor(base / 12) - 1 + INST_OCTAVES);
      if (t && t.role === 'bass') {
        info += ' · 低音锁定';
      } else {
        info += ' · ← → 调音域' +
          (Inst.shift ? '（' + (Inst.shift > 0 ? '+' : '') + Inst.shift + '）' : '');
      }
      els.agInstHint.textContent = '点击琴键或按电脑键盘试听（' + info + '）· 录制时写入当前轨';
    }
  }

  /** 鼓垫：12 面鼓排成一行 */
  function buildPads(body) {
    var wrap = document.createElement('div');
    wrap.className = 'ag-pads';
    Inst.pads = [];
    var order = (BS.arrangerEditor && BS.arrangerEditor.DRUM_ORDER) || [];
    var label = BS.arrangerLib.DRUM_LABEL || {};
    var km = (BS.drumKit && BS.drumKit.KEYMAP) || {};

    order.forEach(function (id) {
      var pad = document.createElement('button');
      pad.className = 'ag-pad';
      pad.dataset.drum = id;
      pad.title = (label[id] || id) + (km[id] ? '（' + km[id].toUpperCase() + '）' : '');

      var nm = document.createElement('span');
      nm.className = 'ag-pad-name';
      nm.textContent = label[id] || id;
      var kk = document.createElement('span');
      kk.className = 'ag-pad-key';
      kk.textContent = km[id] || '';
      pad.appendChild(nm);
      pad.appendChild(kk);

      var pitch = BS.arrangerEditor.ID_TO_DRUM_PITCH[id];
      var holdKey = 'p' + id;
      pad.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        pad.classList.add('on');
        instNoteOn(holdKey, pitch, id, true);
      });
      var up = function () {
        pad.classList.remove('on');
        instNoteOff(holdKey);
      };
      pad.addEventListener('pointerup', up);
      pad.addEventListener('pointerleave', up);
      pad.addEventListener('pointercancel', up);
      Inst.pads.push(pad);
      wrap.appendChild(pad);
    });
    body.appendChild(wrap);
  }

  /** 起音：录制中 → 走 recStart（发声 + 落音符）；否则只发声 */
  function instNoteOn(holdKey, pitch, drumId, isDrum, vel) {
    var arr = AG.arr;
    if (!arr) return;
    var t = arr.getActiveTrack();
    if (!t) return;
    vel = vel || instVelocity();

    /* 谱面高亮：按下即点亮对应音高那一行（录制中也亮，方便对照落音位置）。
       放在录制分支之前 —— 录制时也要亮。 */
    if (AG.editor && AG.editor.hotRowOn) AG.editor.hotRowOn(holdKey, pitch);

    if (AG.recording) { recStart(holdKey, pitch, vel, drumId, isDrum); return; }
    if (Inst.held[holdKey]) return;

    var voice = null;
    if (isDrum) {
      if (App.drumRack && drumId) App.drumRack.hit(drumId, vel);
    } else {
      var p = App.engine && App.engine.parts[t.part];
      if (p) {
        if (p.buffer) voice = p.noteOn(pitch, vel);
        else if (p.isDrumGroup === false && p.noteOn) voice = p.noteOn(pitch, vel);
      }
    }
    Inst.held[holdKey] = { voice: voice, pitch: pitch };
    if (!isDrum && Inst.kb) Inst.kb.lightOn(pitch);
  }

  function instNoteOff(holdKey) {
    if (AG.editor && AG.editor.hotRowOff) AG.editor.hotRowOff(holdKey);
    if (AG.recording) { recNoteOff(holdKey); return; }
    var h = Inst.held[holdKey];
    if (!h) return;
    delete Inst.held[holdKey];
    if (h.voice && h.voice.release) { try { h.voice.release(); } catch (e) { /* noop */ } }
    if (h.pitch !== null && h.pitch !== undefined && Inst.kb) Inst.kb.lightOff(h.pitch);
  }

  function releaseInstNotes() {
    Object.keys(Inst.held).forEach(function (k) {
      var h = Inst.held[k];
      if (h && h.voice && h.voice.release) { try { h.voice.release(); } catch (e) { /* noop */ } }
    });
    Inst.held = {};
    if (Inst.kb) Inst.kb.allOff();
    // 兜底：松键事件丢了（切轨/失焦）也不会留一条高亮行
    if (AG.editor && AG.editor.clearHotRows) AG.editor.clearHotRows();
  }

  /** 鼓垫高亮（电脑键盘打鼓时同步闪） */
  function flashPad(id, on) {
    for (var i = 0; i < Inst.pads.length; i++) {
      if (Inst.pads[i].dataset.drum === id) Inst.pads[i].classList.toggle('on', !!on);
    }
  }

  /**
   * 编曲页**唯一**的乐器通道（仲裁器 context='arrange' 时只分发给它）。
   * 当前轨是鼓组 → 打鼓；是声部/低音 → 弹该轨的音色。
   * 所以这里演奏的永远是「选中的那条轨」，不会串到演奏页/鼓组页。
   */
  function arrangeKey(k, isKeyUp) {
    var arr = AG.arr;
    if (!arr || !arr.trackCount()) return;
    var t = arr.getActiveTrack();
    if (!t) return;

    if (t.role === 'drum') {
      var id = drumIdOfKey(k);
      if (!id) return;
      var pitch = BS.arrangerEditor.ID_TO_DRUM_PITCH[id];
      if (isKeyUp) { instNoteOff(k); flashPad(id, false); }
      else { instNoteOn(k, pitch, id, true); flashPad(id, true); }
      return;
    }

    var p = instPitchOfKey(k);
    if (p === null) return;
    if (isKeyUp) instNoteOff(k);
    else instNoteOn(k, p, null, false);
  }

  /* ---------------- 播放位置跳转 ---------------- */

  /** 播放中单击谱面：从该拍继续播（录制中不允许跳，避免打断录制） */
  function seekToBeat(beat) {
    var arr = AG.arr;
    if (!arr || !AG._playing || AG.recording) return false;
    var b = U.clamp(beat, 0, Math.max(0, arr.totalBeats() - 0.001));
    playArrangement({ fromBeat: b });
    toast('▶ 从第 ' + ((b / arr.barBeats()) + 1).toFixed(2) + ' 小节继续', 1600);
    return true;
  }

  /* ---------------- 单轨编辑模式 ---------------- */

  /** 打开某轨的单轨编辑（先存快照，取消时可回滚） */
  function openTrackEdit(ti) {
    var arr = AG.arr;
    if (!arr || !AG.editor) return;
    if (ti < 0 || ti >= arr.trackCount()) return;
    AG._editSnapshot = arr.snapshot();
    /* 记住进入编辑时的撤销深度：取消时把编辑期间压入的撤销点裁掉，
       否则「取消」之后按 Ctrl+Z 会回到编辑中途的状态。 */
    AG._editUndoDepth = arr._undo.length;
    AG._editTrackIndex = ti;
    AG.editor.enterTrackEdit(ti);
  }

  /** 视图模式变化 → 更新 UI */
  function onEditModeChanged(mode, ti) {
    if (!els.agEditBar) return;
    if (mode === 'track') {
      var t = AG.arr && AG.arr.getTrack(ti);
      els.agEditBar.classList.remove('hide');
      els.agEditTitle.textContent = '正在编辑：' + (t ? t.name : '音轨');
      /* 单轨编辑可改谱：鼠标模式（框选 / 添加）由顶部分段开关决定，
         这里只把界面同步到当前模式。 */
      if (AG.editor) syncEditTool(AG.editor.editTool);
    } else {
      els.agEditBar.classList.add('hide');
      if (AG.editor) AG.editor.pane.classList.add('readonly');
    }
    /* 进出单轨编辑时若正在播放，按当前「试听仅本轨」设置从当前位置重排，
       否则会出现「进了单轨编辑还在放整首」的错位感。 */
    if (AG._playing && App.sequencer && App.sequencer.playing) {
      var b = App.sequencer.beatPosition ? App.sequencer.beatPosition() : 0;
      stopArrangement();
      playArrangement({ fromBeat: b });
      return;
    }
    renderAgStatus();
  }

  /** 保存：保留修改，回到总览 */
  function saveTrackEdit() {
    var arr = AG.arr;
    if (!arr || !AG.editor) return;
    AG._editSnapshot = null;      // 保存后不再需要回滚点
    AG._editUndoDepth = undefined;
    AG._editTrackIndex = -1;
    AG.editor.exitTrackEdit();
    toast('已保存修改（Ctrl+Z 仍可逐次撤销）');
  }

  /** 取消：回滚到进入编辑前的状态，回到总览 */
  function cancelTrackEdit() {
    var arr = AG.arr;
    if (!arr || !AG.editor) return;
    if (AG._editSnapshot) arr.restore(AG._editSnapshot);
    // 裁掉编辑期间产生的撤销点（回滚后它们指向的状态已不存在）
    if (AG._editUndoDepth !== undefined && arr._undo.length > AG._editUndoDepth) {
      arr._undo.length = AG._editUndoDepth;
      arr._redo.length = 0;
      arr.emit('history');
    }
    AG._editSnapshot = null;
    AG._editUndoDepth = undefined;
    AG._editTrackIndex = -1;
    AG.editor.exitTrackEdit();
    toast('已取消修改');
  }

  /* ---------------- 状态显示 ---------------- */

  function renderAgStatus(sel) {
    if (!AG.arr) return;
    if (!els.agStatus) cacheEls();
    var arr = AG.arr;
    var song = arr.getSong();
    var notes = 0;
    arr.getTracks().forEach(function (t) { notes += t.notes.length; });
    var bars = arr.lengthBars;

    if (els.agStatus) {
      els.agStatus.textContent = arr.trackCount() + ' 轨 · ' + notes + ' 音块 · ' +
        bars + ' 小节 · ' + song.bpm + ' BPM · ' + song.timeSignature.join('/') +
        ' · ' + arr.key + ' ' + (BS.arrangerLib.SCALES[arr.scale] || {}).name;
    }
    if (els.agStatus2) {
      var selCount = sel ? sel.size : arr.selection.size;
      var selTxt = selCount ? ('已选中 ' + selCount + ' 个音块') : '';
      var iso = isolatedTrackIndex();
      var recTxt = AG.recording
        ? ('● 录制中' + (AG._countingIn ? '（预备拍…）' : '') + (iso >= 0 ? '（仅本轨）' : ''))
        : (AG._playing ? ('▶ 播放中' + (iso >= 0 ? '（仅本轨）' : '')) : '就绪');
      var chordTxt = arr.getChord(arr.targetBar)
        ? ('和弦 ' + arr.chordLabel(arr.targetBar)) : '';
      var act = arr.getActiveTrack();
      var actTxt = act
        ? ('当前：' + act.name +
           (act.role === 'bass' ? '（低音）' : act.role === 'drum' ? '（鼓组）' : ''))
        : '';
      els.agStatus2.textContent =
        (actTxt ? actTxt + ' · ' : '') +
        '目标：第 ' + (arr.targetBar + 1) + ' 小节' +
        (chordTxt ? ' · ' + chordTxt : '') +
        (selTxt ? ' · ' + selTxt : '') + ' · ' + recTxt;
    }
    // 填充按钮直接写清「填哪一小节」：不用先点一次再看 toast
    if (els.agFill) {
      els.agFill.textContent = '填充第 ' + (arr.targetBar + 1) + ' 小节 →';
      els.agFill.title = '把当前和弦 + 节奏型写入第 ' + (arr.targetBar + 1) +
        ' 小节（点顶部标尺可换小节）';
    }
    // 循环区间就地显示
    if (els.agLoop) {
      els.agLoop.classList.toggle('on', !!arr.loop);
      els.agLoop.textContent = arr.loop
        ? ('循环 ' + (arr.loop.start + 1) + '–' + arr.loop.end)
        : '循环';
    }

    syncHistoryButtons();
    // 切轨后模板列表要换成该轨可用的（鼓轨 → 鼓型）
    if (AG._chipTrack !== arr.activeTrackIndex || AG._chipRole !== (arr.getActiveTrack() || {}).role) {
      AG._chipTrack = arr.activeTrackIndex;
      AG._chipRole = (arr.getActiveTrack() || {}).role;
      refreshPatternOptions();
    }
  }

  /* ---------------- 导入：按轨名匹配声部 ---------------- */

  /**
   * 导入 song 到编曲。
   * 规则（P1 起不再自动建「带音色的声部」）：
   *   · 按轨名匹配已有声部（声部名 == 轨名，或声部名包含轨名）→ 直接挂上去
   *   · 匹配不到 → 建一个**空声部**（只有名字，没有音色/采样，noteOn 直接返 null，
   *     所以不出声）；要什么音色由用户在轨头「选音色」里自己挑
   *   · 不再按内置音色名/采样库预设自动创建声部 —— 那会凭空多出一堆
   *     「孙燕姿 - 我不难过_人声」之类的声部，还把音色猜错
   */
  /**
   * 规范化音符列表。
   *
   * 目标：支持**和弦**（同起点多音）与**长短音重叠**（不同起点、时长交叠）。
   * 这两类在数据层都是「一轨多个 note，各自带 beat/len」，天然兼容，
   * 这里只做三件事：
   *   1. 数值兜底（beat/len/vel 非法时给默认值，pitch 缺失直接丢弃该音符）
   *   2. **不裁剪重叠** —— 交叠的音原样保留
   *   3. 同一轨内按 beat 排序（渲染与命中依赖顺序）
   */
  function normalizeNotes(list) {
    if (!Array.isArray(list)) return [];
    var out = [];
    var tick = BS.arranger.TICK;
    list.forEach(function (n) {
      if (!n) return;
      // pitch 是必须的（合成器是 MIDI 音高，鼓轨是鼓位 id）
      var pitch = n.pitch;
      if (pitch === undefined || pitch === null) return;
      if (typeof pitch === 'string' && !pitch.length) return;
      if (typeof pitch === 'number' && !isFinite(pitch)) return;
      var beat = parseFloat(n.beat);
      if (!isFinite(beat) || beat < 0) beat = 0;
      var len = parseFloat(n.len);
      // 非法/非正数 → 给 1 拍的合理默认（而不是最小 tick，那几乎听不见）
      if (!isFinite(len) || len <= 0) len = 1;
      // 合法但比最小 tick 还短 → 抬到 tick
      if (len < tick) len = tick;
      var vel = parseFloat(n.vel);
      if (!isFinite(vel)) vel = 0.85;
      out.push({
        beat: beat,
        len: len,
        pitch: pitch,
        vel: U.clamp(vel, 0, 1)
      });
    });
    // 排序（稳定：同 beat 保持原顺序 → 和弦的叠放次序稳定）
    out.sort(function (a, b) { return a.beat - b.beat; });
    return out;
  }

  function importIntoArranger(song, sourceName) {
    var arr = ensureArranger();
    if (!arr || !App.engine) return null;

    var tracks = song.tracks || [];
    var used = {};

    // 先建立「轨名 → 声部索引」的候选表
    var partByName = {};
    App.engine.parts.forEach(function (p, i) {
      var n = (p.name || p.bufferName || '').trim();
      if (n && partByName[n] === undefined) partByName[n] = i;
    });

    var created = [];
    var matched = 0;
    var unmatched = [];
    var kitIndex = -1;   // 鼓组声部索引（所有鼓轨共用）

    tracks.forEach(function (t, i) {
      var trackName = (t.name || ('轨道 ' + (i + 1))).trim();
      var partIndex = -1;
      var isDrumTrack = arr.guessRole(t);

      // ① 精确匹配声部名
      if (partByName[trackName] !== undefined) {
        partIndex = partByName[trackName];
        matched++;
      } else {
        // ② 模糊匹配（声部名包含轨名，或反之）
        for (var k in partByName) {
          if (k && (k.indexOf(trackName) >= 0 || trackName.indexOf(k) >= 0)) {
            partIndex = partByName[k];
            matched++;
            break;
          }
        }
      }

      if (isDrumTrack) {
        // 鼓轨：走独立鼓组通道，part = -1，不占声部索引。
        // 必须在这里直接结束 —— 后面还有 if (partIndex < 0) 的分支，
        // -1 会被它当成「没匹配上」而重新建声部。
        if (App.ensureDrumRack) App.ensureDrumRack();
        used[i] = -1;
        matched++;
        return;
      }

      if (partIndex < 0) {
        /* ③ 没有合适声部 → 建一个**空声部**（只有名字，没有音色/采样）。
           不自动套内置音色、不查采样库预设：音色让用户自己挑，
           否则一个「孙燕姿 - 我不难过_人声」的轨会被塞个钢琴音色，还得手动改。 */
        var np = App.engine.addPart({ name: trackName });
        partIndex = App.engine.parts.length - 1;
        partByName[trackName] = partIndex;
        unmatched.push(trackName);
      }

      used[i] = partIndex;
    });

    // 构造编曲数据
    var data = {
      version: 1, type: 'arranger',
      name: song.name || (sourceName || '导入的编曲'),
      bpm: song.bpm || 120,
      timeSignature: song.timeSignature || [4, 4],
      swing: song.swing || 0,
      /* 小节数用**导入结果**的，而不是当前编曲的旧内容长度：
         以前 `Math.ceil(arr.contentBars() || 4)` 取的是替换前的旧值，
         导入长曲子时会被旧长度截断（只能靠下面「按内容补足」兜回来）。 */
      lengthBars: (function () {
        var lb = parseInt(song.lengthBars, 10);
        if (lb > 0) return lb;
        var barBeats = song.timeSignature && song.timeSignature[0] ? song.timeSignature[0] : 4;
        var end = 0;
        tracks.forEach(function (t) {
          (t.notes || []).forEach(function (n) {
            if (!n) return;                       // 导出的 JSON 里可能有空洞占位
            end = Math.max(end, (n.beat || 0) + (n.len || 0));
          });
        });
        return Math.max(1, Math.ceil(end / barBeats) || 4);
      })(),
      key: arr.key, scale: arr.scale,
      tracks: tracks.map(function (t, i) {
        // role 优先用文件里带的；没有才靠音高猜
        var role = t.role || (arr.guessRole(t) ? 'drum' : (arr.isBassName(t) ? 'bass' : 'synth'));
        // 挂到已有声部时，轨头音色名显示那个声部的真实音色（空声部就显示「选音色」）
        var pi = used[i] === undefined ? i : used[i];
        var bound = pi >= 0 ? App.engine.parts[pi] : null;
        return {
          name: t.name || ('轨道 ' + (i + 1)),
          part: pi,
          role: role,
          drum: role === 'drum' ? (t.drum || 'kit') : undefined,
          toneId: t.toneId || (bound && bound._toneId) || null,
          color: t.color || null,
          volume: t.volume === undefined ? 0.85 : t.volume,
          pan: t.pan || 0,
          muted: !!t.muted, solo: !!t.solo,
          notes: normalizeNotes(t.notes)
        };
      })
    };

    arr.fromJSON(data);

    // 长度按内容补足
    var cb = arr.contentBars();
    if (cb > arr.lengthBars) arr.setLength(cb);

    /* ⚠️ 速度 / 拍号必须推到界面与引擎。
       以前只 fromJSON：编曲内部 song.bpm 已是新值（播放是对的），
       但顶栏输入框和 App.song / 引擎还是旧速度 —— 用户看到「BPM 没更新」，
       演奏台和节拍器也仍按旧速度跑。 */
    syncAgControls();
    pushTempo();
    pushSig();

    // 鼓组统一：导入的旧曲谱常把鼓拆成多条（每面鼓一轨）→ 合并成一条鼓组轨
    consolidateDrumTracks(false);
    normalizeDrumName();
    if (drumTrackIndex() < 0) ensureDrumTrack();
    focusFirstPartTrack();

    // 音轨占用标记（鼓轨不占 part）
    arr.getTracks().forEach(function (t) {
      if (t.role === 'drum') return;
      var p = App.engine.parts[t.part];
      if (p) { p._usedByTrack = true; p._toneId = p._toneId || null; }
    });

    renderAllPartsUI();
    renderAgStatus();
    return { matched: matched, created: created, unmatched: unmatched };
  }

  /* ---------------- 键盘录入 ---------------- */

  /* 电脑键盘 → 音高（与演奏台的映射一致，跨两个八度） */
  var REC_KEYMAP = {
    'z': 0, 's': 1, 'x': 2, 'd': 3, 'c': 4, 'v': 5, 'g': 6, 'b': 7,
    'h': 8, 'n': 9, 'j': 10, 'm': 11,
    ',': 12, 'l': 13, '.': 14, ';': 15, '/': 16,
    'q': 12, '2': 13, 'w': 14, '3': 15, 'e': 16, 'r': 17, '5': 18,
    't': 19, '6': 20, 'y': 21, '7': 22, 'u': 23,
    'i': 24, '9': 25, 'o': 26, '0': 27, 'p': 28
  };

  function bindRecKeys() {
    if (AG._recBound) return;
    AG._recBound = true;

    /* 录制走仲裁器（全应用唯一键盘入口）。
       上下文由 toggleRecord → setContext('arrange') 设定，
       键盘按下/松开成对交给 recNoteOn / recNoteOff。 */
    if (BS.keyArb) {
      /* 编曲页只走这一条乐器通道：
         录制中就录、没录制就试听；且永远只服务「当前激活轨」的音色。 */
      BS.keyArb.setHandler('rec', function (k, e, isKeyUp) {
        arrangeKey(k, !!isKeyUp);
      });
    }
  }

  /* ---------------- 持久化 ---------------- */

  /** 编曲快照（工程文件用）：含 lengthBars / key / scale / 轨的 role+toneId */
  function arrangerToJSON() {
    var arr = AG.arr;
    if (!arr || !arr.getSong()) return null;
    return arr.toJSON();
  }

  /** 从工程恢复编曲（没有编曲数据则忽略） */
  function arrangerFromJSON(data) {
    if (!data || !data.tracks) return null;
    var arr = ensureArranger();
    if (!arr) return null;
    arr.fromJSON(data);
    syncAgControls();
    fillChordOptions();
    pushTempo();
    pushSig();
    if (AG.editor) AG.editor.render();
    renderAgStatus();
    return arr;
  }

  /* ---------------- 声部变动 ---------------- */

  /** 声部被删：重映射所有轨的 part 索引（否则整体串音） */
  function onPartRemoved(index, remaining) {
    if (!AG.arr) return;
    var lost = AG.arr.remapAfterPartRemoved(index, remaining);
    if (lost.length) {
      toast(lost.length + ' 条音轨的原音色已被删除，已临时指向其他声部，请重新指定音色', 5000);
    }
    if (AG.editor) AG.editor.render();
    renderAgStatus();
  }

  /* ---------------- 曲谱 JSON：导入 / 导出 / 格式示例 ----------------
   * 文件内容 = 编曲页的曲谱结构（Arranger.toJSON），字段一览：
   *   version       1
   *   type          "arranger"
   *   name          曲名
   *   bpm           速度
   *   timeSignature [分子, 分母]
   *   swing         摇摆 0~1
   *   lengthBars    编曲长度（小节）
   *   key / scale   调性（如 "C" / "major"）
   *   grid          吸附步长（拍）：1 · 1/2 · 1/4 · 1/8 · 1/16 · 1/32
   *   targetBar     定位小节
   *   chords        [{bar, root, quality}]  quality 取 maj/min/dim/aug/maj7/min7/dom7/sus2/sus4/add9/6…（见 CHORD_QUALITIES）
   *   loop          {start, end} 或 null（单位：小节）
   *   sections      [{bar, name}]
   *   structure     "track-flat"
   *   tracks        [{name, part, role, toneId, color, volume, pan, muted, solo,
   *                   notes:[{beat, len, pitch, vel?}]}]
   *     · beat / len 单位是「拍」，pitch 是 MIDI 音高（36 = C2；鼓轨用鼓音高 36/38/42…）
   *     · part 是声部索引，鼓轨固定 -1；role 取 "drum" | "bass" | "synth"
   *     · vel 省略即为默认力度（0.85）
   */

  var JSON_TYPE = 'arranger';

  /** 导出：当前编曲 → 曲谱 JSON（返回文件名） */
  function exportJSON() {
    var data = arrangerToJSON();
    if (!data) { toast('编曲页还没准备好，先切到编曲页再导出', 3000); return null; }
    var name = String(data.name || '曲子').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || '曲子';
    U.download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), name + '.json');
    return name + '.json';
  }

  /** 导入前把外部数据收成规范形状（容忍工程片段 / 老 song JSON） */
  function normalizeJSON(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('不是有效的 JSON 对象');
    }
    if (!data.tracks && data.arranger) data = data.arranger;      // 直接粘 .bsproj 片段
    if (!data.tracks && data.song && data.song.tracks) data = data.song;
    if (data.type && data.type !== JSON_TYPE && data.type !== 'song') {
      throw new Error('格式不符：type 应为 "' + JSON_TYPE + '"');
    }
    if (!Array.isArray(data.tracks)) throw new Error('缺少 tracks 数组');
    return data;
  }

  /** 导入：曲谱 JSON → 编曲页（严格按编曲结构恢复，并修好声部索引） */
  function importJSON(data, sourceName) {
    var obj = normalizeJSON(data);
    var arr = ensureArranger();
    if (!arr) throw new Error('音频还没启动，先点一下界面完成启动');
    arr.fromJSON(obj);
    sanitizeTrackParts();        // 越界的 part 自动改绑到真实声部
    focusFirstPartTrack();
    syncAgControls();            // 小节数 / 调性 / 拍号 / 速度等控件跟上
    pushTempo();                 // 速度 / 拍号同步到引擎
    pushSig();
    AG._instKey = null;
    syncInstrument();
    if (AG.editor) AG.editor.render();
    renderAgStatus();
    // 切到编曲页，让用户直接看到导入结果
    var tab = document.querySelector('.stage-tab[data-stage="arrange"]');
    if (tab && !tab.classList.contains('active')) tab.click();
    if (sourceName) toast('已导入曲谱：' + (arr.getSong().name || sourceName), 2600);
    return arr;
  }

  /** 格式示例：一份能直接导回来的完整曲谱（4 小节，鼓 + 贝斯 + 和弦 + 旋律） */
  var SAMPLE_JSON = {
    version: 1,
    type: 'arranger',
    name: '示例：四小节流行',
    bpm: 100,
    timeSignature: [4, 4],
    swing: 0,
    lengthBars: 4,
    key: 'C',
    scale: 'major',
    grid: 0.25,
    targetBar: 0,
    chords: [
      { bar: 0, root: 'C', quality: 'maj' },
      { bar: 1, root: 'A', quality: 'min' },
      { bar: 2, root: 'F', quality: 'maj' },
      { bar: 3, root: 'G', quality: 'dom7' }
    ],
    loop: { start: 0, end: 4 },
    sections: [
      { bar: 0, name: 'A' },
      { bar: 2, name: 'B' }
    ],
    structure: 'track-flat',
    tracks: [
      {
        name: '鼓组',
        part: -1,                 // 鼓轨固定 -1：走独立鼓组通道
        role: 'drum',
        toneId: null,
        color: '#ff6b6b',
        volume: 0.9,
        pan: 0,
        muted: false,
        solo: false,
        notes: [
          { beat: 0, len: 0.5, pitch: 36, vel: 0.95 },   // 底鼓
          { beat: 1, len: 0.5, pitch: 38, vel: 0.9 },    // 军鼓
          { beat: 2, len: 0.5, pitch: 36, vel: 0.9 },
          { beat: 3, len: 0.5, pitch: 38, vel: 0.9 },
          { beat: 0, len: 0.25, pitch: 42, vel: 0.55 },  // 闭合踩镲
          { beat: 1, len: 0.25, pitch: 42, vel: 0.5 },
          { beat: 2, len: 0.25, pitch: 42, vel: 0.55 },
          { beat: 3, len: 0.25, pitch: 42, vel: 0.5 }
        ]
      },
      {
        name: '贝斯',
        part: 0,                  // 声部索引：必须是当前工程里真实存在的声部
        role: 'bass',             // 低音轨：演奏条锁定 C1–C5
        toneId: 'bass',
        color: '#4fd1c5',
        volume: 0.85,
        pan: 0,
        muted: false,
        solo: false,
        notes: [
          { beat: 0, len: 1.5, pitch: 36 },              // C2
          { beat: 1.5, len: 0.5, pitch: 36 },
          { beat: 2, len: 2, pitch: 45 },                // A2
          { beat: 4, len: 2, pitch: 41 },                // F2
          { beat: 6, len: 2, pitch: 43 }                 // G2
        ]
      },
      {
        name: '和弦',
        part: 0,
        role: 'synth',
        toneId: 'piano',
        color: '#f6c667',
        volume: 0.7,
        pan: 0,
        muted: false,
        solo: false,
        notes: [
          // 同一拍多个 pitch = 和弦
          { beat: 0, len: 2, pitch: 48 }, { beat: 0, len: 2, pitch: 52 }, { beat: 0, len: 2, pitch: 55 },
          { beat: 2, len: 2, pitch: 45 }, { beat: 2, len: 2, pitch: 48 }, { beat: 2, len: 2, pitch: 52 },
          { beat: 4, len: 2, pitch: 41 }, { beat: 4, len: 2, pitch: 45 }, { beat: 4, len: 2, pitch: 48 },
          { beat: 6, len: 2, pitch: 43 }, { beat: 6, len: 2, pitch: 47 }, { beat: 6, len: 2, pitch: 50 }
        ]
      },
      {
        name: '旋律',
        part: 0,
        role: 'synth',
        toneId: 'saw',
        color: '#a78bfa',
        volume: 0.75,
        pan: 0.1,
        muted: false,
        solo: false,
        notes: [
          { beat: 0, len: 1, pitch: 72, vel: 0.8 },
          { beat: 1, len: 0.5, pitch: 74, vel: 0.75 },
          { beat: 1.5, len: 0.5, pitch: 76, vel: 0.7 },
          { beat: 2, len: 2, pitch: 79, vel: 0.85 },
          { beat: 4, len: 1, pitch: 76, vel: 0.75 },
          { beat: 5, len: 1, pitch: 72, vel: 0.7 }
        ]
      }
    ]
  };

  function sampleJSON() { return JSON.parse(JSON.stringify(SAMPLE_JSON)); }

  /** 复制一份格式示例到剪贴板（file:// 下没有 clipboard API 时退回 execCommand） */
  function copySample() {
    var text = JSON.stringify(sampleJSON(), null, 2);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () { return legacyCopy(text); });
    }
    return legacyCopy(text);
  }

  function legacyCopy(text) {
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      if (ok) resolve(text);
      else reject(new Error('浏览器不允许写剪贴板，请手动复制'));
    });
  }

  /* ---------------- 对外接口 ---------------- */

  BS.appArranger = {
    ensure: ensureArranger,
    importSong: importIntoArranger,
    pickTone: pickToneForTrack,
    recordNote: recNoteOn,
    midiNoteOn: midiNoteOn,
    midiNoteOff: midiNoteOff,
    togglePlay: togglePlay,
    play: playArrangement,
    stop: stopArrangement,
    /* 进编曲页时后台预热锁时长变调的缓存（不阻塞，只让首次试听别用错时值） */
    prewarmStretch: prewarmArrangementStretch,
    stopRecord: function () { if (AG.recording) stopRecording(); },
    isActive: isArrangeActive,
    onTick: onTick,
    onPartRemoved: onPartRemoved,
    getSong: function () { return AG.arr ? AG.arr.toSong() : null; },
    toJSON: arrangerToJSON,
    loadJSON: arrangerFromJSON,
    /* 曲谱 JSON：导出下载 / 导入恢复 / 格式示例（复制到剪贴板） */
    exportJSON: exportJSON,
    importJSON: importJSON,
    sampleJSON: sampleJSON,
    copySample: copySample,
    getTargetBar: function () { return AG.arr ? AG.arr.targetBar : 0; },
    setTargetBar: function (bar) { if (AG.arr) AG.arr.setTargetBar(bar); },
    refresh: function () {
      if (AG.arr) { AG.arr.changed('refresh'); renderAgStatus(); }
    },
    getEditor: function () { return AG.editor; },
    getArr: function () { return AG.arr; },
    /* 音域切换（← → / 演奏条 ± 共用）：低音轨锁定、鼓组轨无音域 */
    shiftOctave: shiftOctave,
    /* 谱面里选中了音块 → ← → 归「移动音块」，别拿去切音域 */
    editorUsesArrows: editorUsesArrows,
    resetInstShift: resetInstShift,
    getInstShift: function () { return Inst.shift; },
    getInstLow: function () { return Inst.kb ? Inst.kb.lowNote : null; }
  };

  /* 声部增删 → 所有音色选择界面同步 */
  BS.on('parts:changed', function () {
    TonePicker.refreshAll();
    if (BS.app && BS.app.refreshTonePickers) BS.app.refreshTonePickers();
  });

  /* 采样库变化（预设增删改名）→ 同样要同步 */
  BS.on('library:changed', function () {
    TonePicker.refreshAll();
  });

})(typeof window !== 'undefined' ? window : globalThis);

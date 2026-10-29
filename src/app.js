/* BandSynth · app.js
 * 主应用：装配引擎、声部、键盘、序列器、界面；实现完整交互。
 */
(function (global) {
  'use strict';
  var BS = global.BS;
  var U = BS.util, P = BS.pitch, W = BS.widgets;

  var App = BS.app = {
    ctx: null,
    engine: null,
    sequencer: null,
    metronome: null,
    keyboard: null,
    song: null,
    currentPartIndex: 0,
    followMode: false,       // 跟随伴奏演奏
    stretchMode: false,
    ui: {}
  };

  var els = {};

  /* ================= 启动 ================= */
  function boot() {
    cacheEls();
    bindGlobal();
    /* 下拉框统一换成自绘的深色弹层：
       原生 select 的选项面板由系统绘制（Windows 上是白底），配色改不动，
       而且它一拿到焦点就会吃掉空格/方向键。 */
    if (BS.dropdown) BS.dropdown.auto();
    setupAudioOnFirstGesture();
    buildUI();
    buildKeyboard();
    bindKeyMode();
    initDefaultSong();
    // 采样库异步初始化（不阻塞界面）
    BS.library.init().then(function () {
      renderLibraryPanel();
    }).catch(function () { /* 已在 init 内降级 */ });
    // 库文件导入
    if (els.libFile) {
      els.libFile.addEventListener('change', function () {
        var f = els.libFile.files && els.libFile.files[0];
        if (!f) return;
        toast('正在解码并入库：' + f.name);
        BS.loader.decodeFile(App.ctx, f).then(function (buf) {
          var rec = BS.library.bufferToRecord(buf, stripExt(f.name), f.name);
          return BS.library.putSample(rec);
        }).then(function (r) {
          toast('已入库：' + r.name);
          renderLibraryPanel();
        }).catch(function (err) {
          toast('入库失败：' + err.message, 5000);
        }).then(function () { els.libFile.value = ''; });
      });
    }
    // 切到采样库页时刷新
    // 初始键盘上下文：演奏页
    if (BS.keyArb) BS.keyArb.setContext('perform');

    BS.on('stage:change', function (stage) {
      App.stage = stage;
      // 只要离开编曲页，录制都必须收尾：否则键盘上下文被切走、音符还挂在半空
      if (stage !== 'arrange' && BS.appArranger) BS.appArranger.stopRecord();
      // 键盘上下文：决定哪些键位生效（演奏页只有键盘，鼓组页只有鼓）
      if (BS.keyArb) {
        if (stage === 'drums') BS.keyArb.setContext('drums');
        else if (stage === 'perform') BS.keyArb.setContext('perform');
        else if (stage === 'arrange') BS.keyArb.setContext('arrange');
        else BS.keyArb.setContext('other');
      }
      if (stage === 'library') renderLibraryPanel();
      else if (stage === 'drums') ensureDrumKit();
      else if (stage === 'arrange') {
        if (BS.appArranger) {
          var ag = BS.appArranger.ensure();
          // 每次进编曲页，演奏条音域回到与演奏页键盘一致的位置
          if (ag && BS.appArranger.resetInstShift) BS.appArranger.resetInstShift();
          // 后台把本曲用到的音高算进「锁时长变调」缓存：之后点音块试听就是锁时长的
          if (ag && BS.appArranger.prewarmStretch) {
            requestAnimationFrame(function () { BS.appArranger.prewarmStretch(); });
          }
          if (ag && BS.appArranger.getEditor()) {
            // 容器尺寸在页签显示后才确定，下一帧重绘
            requestAnimationFrame(function () { BS.appArranger.getEditor().render(); });
          }
        }
      }
    });
    // 存储内容变化时自动刷新（当前在采样库页才重绘，避免无谓开销）
    BS.on('library:changed', function () {
      if (els.stageLibrary && els.stageLibrary.classList.contains('active')) {
        renderLibraryPanel();
      }
    });
    BS.on('library:ready', function () { renderLibraryPanel(); });
    BS.on('library:usage', function (u) {
      var box = document.getElementById('libUsage');
      if (!box) return;
      box.textContent = BS.library.usedBytes
        ? '已占用 ' + BS.library.formatBytes(BS.library.usedBytes) +
          (BS.library.quotaBytes ? ' / 可用约 ' + BS.library.formatBytes(BS.library.quotaBytes) : '')
        : '';
    });
    BS.on('library:warn', function (msg) { toast(msg, 6000); });
    requestAnimationFrame(tick);
  }

  function cacheEls() {
    var ids = ['audioGate', 'appRoot', 'partList', 'partEditor', 'stageTabs', 'transportBar',
      'metroBtn', 'transportPos', 'barBeat', 'rampSection', 'masterVol', 'reverbType',
      'reverbReturn', 'delayTime', 'delayFb', 'delayReturn', 'meterFill', 'meterPeak',
      'voiceCount', 'cpuText', 'stretchToggle', 'renderBtn', 'renderInfo',
      'toast', 'exportBtn', 'addPartBtn', 'importSong', 'exportSong', 'songJson', 'songSample',
      'octaveLabel', 'velSlider', 'octDown', 'octUp', 'partCount', 'renderProgress',
      'renderPlay', 'renderStems', 'renderLoopOnly',
      'masterKnobs', 'masterMute', 'soloReset', 'libraryPanel', 'libFile', 'stageLibrary',
      // 鼓组
      'stageDrums', 'drumKitHost', 'drumVelSlider', 'drumFollow', 'drumInitBtn', 'drumInitHint',
      // 工程
      'projectName', 'projSave', 'projLoad', 'projQuickSave', 'projQuickLoad', 'projFile',
      // 编曲
      'stageArrange', 'agHost', 'agPlay', 'agStop', 'agRecord', 'agKey', 'agScale',
      'agBpm', 'agSig', 'agBars', 'agBarsAdd', 'agBarsDel', 'agGrid',
      'agAddTrack', 'agDelTrack', 'agStatus', 'agStatus2',
      'agBarSel', 'agBarDel', 'agChord', 'agPattern', 'agFill',
      'agSelectAll', 'agDelSel', 'agSelInfo',
      // 演奏
      'currentTone', 'followMode', 'keyModeSeg', 'handSeg', 'handSwitchWrap', 'kbRef',
      'midiBadge'];
    ids.forEach(function (id) { els[id] = document.getElementById(id); });
  }

  function setupAudioOnFirstGesture() {
    var started = false;
    function start() {
      if (started) return;
      started = true;
      initAudio();
      if (els.audioGate) {
        els.audioGate.classList.add('hide');
        setTimeout(() => { if (els.audioGate && els.audioGate.parentElement) els.audioGate.remove(); }, 400);
      }
      setupMIDI();
      document.removeEventListener('pointerdown', start);
      document.removeEventListener('keydown', start);
    }
    document.addEventListener('pointerdown', start);
    document.addEventListener('keydown', start);
  }

  /* ================= MIDI 输入（Web MIDI） ================= */

  var _midiVoices = {};

  /**
   * 接 MIDI 键盘：
   *   · 编曲页录制中 → 录进当前轨（音高直接来自设备，忽略电脑键盘映射）
   *   · 其它页 → 直接在当前声部发声（弹一下就能听）
   */
  function setupMIDI() {
    if (App._midiBound || !navigator.requestMIDIAccess) return;
    App._midiBound = true;
    navigator.requestMIDIAccess({ sysex: false }).then(function (access) {
      var count = 0;
      function bind(port) {
        if (!port || port.type !== 'input') return;
        count++;
        port.onmidimessage = onMIDIMessage;
      }
      access.inputs.forEach(bind);
      access.onstatechange = function (e) {
        if (e.port && e.port.type === 'input' && e.port.state === 'connected') bind(e.port);
        updateMidiBadge();
      };
      App._midiAccess = access;
      updateMidiBadge();
    }).catch(function () {
      // 没有 MIDI 设备/权限：静默，不影响其它功能
      App._midiBound = false;
    });
  }

  function updateMidiBadge() {
    if (!els.midiBadge) return;
    var n = 0;
    if (App._midiAccess) App._midiAccess.inputs.forEach(function () { n++; });
    els.midiBadge.textContent = n ? ('MIDI ' + n) : 'MIDI —';
    els.midiBadge.classList.toggle('on', n > 0);
    els.midiBadge.title = n
      ? '已连接 ' + n + ' 个 MIDI 输入：编曲页录制时可直接弹奏录入'
      : '未检测到 MIDI 输入设备（浏览器需要 https/localhost，或使用电脑键盘）';
  }

  function onMIDIMessage(msg) {
    var d = msg.data || [];
    var st = d[0] & 0xf0;
    var pitch = d[1];
    var vel = (d[2] === undefined ? 100 : d[2]) / 127;
    if (st !== 0x90 && st !== 0x80) return;
    var on = st === 0x90 && vel > 0;

    if (App.stage === 'arrange' && BS.appArranger && BS.appArranger.midiNoteOn) {
      if (on) BS.appArranger.midiNoteOn(pitch, Math.max(0.05, vel));
      else BS.appArranger.midiNoteOff(pitch);
      return;
    }

    var p = App.engine && App.engine.parts[App.currentPartIndex];
    if (!p || !p.buffer) return;
    if (on) {
      var v = p.noteOn(pitch, vel);
      if (v) _midiVoices[pitch] = v;
    } else {
      var vv = _midiVoices[pitch];
      if (vv) { try { vv.release(); } catch (e) { /* noop */ } delete _midiVoices[pitch]; }
    }
  }

  function initAudio() {
    var AC = global.AudioContext || global.webkitAudioContext;
    App.ctx = new AC({ latencyHint: 'interactive' });
    if (App.ctx.state === 'suspended') App.ctx.resume();

    App.engine = new BS.Engine(App.ctx);
    App.engine.setReverbType('hall');
    App.metronome = new BS.Metronome(App.ctx, App.engine.master);
    // 试听通路：接主输出但绕过声部 ADSR/滤波，保证听到素材原貌
    App.audition = new BS.trim.SampleAudition(App.ctx, App.engine.master);

    App.sequencer = new BS.Sequencer(App.engine, {
      song: App.song,
      onStateChange: onSeqState,
      onEvent: function (e) {
        App.keyboard && App.keyboard.lightOn(e.ev.pitch);
        setTimeout(() => App.keyboard && App.keyboard.lightOff(e.ev.pitch), e.ev.duration * 1000);
      }
    });

    /* 默认声部：内置音色，让用户开箱即用。
       钢琴（铺和弦/旋律）+ 贝斯（低音）+ 原声吉他（分解/扫弦），三条轨刚好能直接编曲；
       顺序即声部序号，钢琴放 0 号，进页面默认选中的就是它。 */
    BS.factory.makePart(App.engine, 'piano', { volume: 0.8 });
    BS.factory.makePart(App.engine, 'bass', { volume: 0.75 });
    BS.factory.makePart(App.engine, 'acousticGuitar', { volume: 0.75 });

    App.engine.setMaster(0.85);
    toast('音频引擎已启动');
    renderParts();   // 重建声部面板，此时 getAudition() 已可用
    if (App.trimPanel && App.trimPanel.syncAudition) App.trimPanel.syncAudition();
    syncEngineTempo();

    bindDrumKit();
    bindProjectBar();
    updateCurrentTone();
  }

  /* ======================================================================
   * 鼓组：独立逻辑 —— 鼓位 → 声部，不经音高体系
   * ==================================================================== */

  /** 把内置鼓音色参数应用到声部。
   *  关键：鼓不走音高体系 —— keyTrack=false 使 effectiveRatio 恒为 1，
   *  传 rootNote 触发时 playbackRate = 1，绝不变调。
   *  preset() 返回的是共享对象，必须逐字段拷贝，直接改会污染全局预设。 */
  function applyDrumPreset(part, toneId) {
    var preset = BS.factory.preset(toneId) || {};
    if (preset.mode) part.mode = preset.mode;
    if (preset.pitchMode) part.pitchMode = preset.pitchMode;
    if (preset.root !== undefined) part.rootNote = preset.root;
    if (preset.amp) part.amp = Object.assign({}, part.amp, preset.amp);
    if (preset.filter) part.filter = Object.assign({}, part.filter, preset.filter);
    part.keyTrack = false;     // 鼓：不做键盘跟随
    part.transpose = 0;
    part.fine = 0;
    return part;
  }

  /** 鼓位是否可用（鼓组通道里有这个鼓） */
  function hasDrum(drumId) {
    return !!(App.drumRack && App.drumRack.has(drumId));
  }

  /** 为缺失的鼓位自动创建声部 */
  /* 鼓组通道：与 engine.parts 完全独立。
   * 鼓组不占声部槽、不出现在声部面板、不会被合成器键盘误触发。 */
  function ensureDrumRack() {
    if (!App.engine) return null;
    if (!App.drumRack) {
      App.drumRack = new BS.DrumRack({
        ctx: App.ctx,
        dest: App.engine.master,
        factory: BS.factory
      });
      App.drumRack.loadDefaultKit({ volume: 0.85, sendReverb: 0.08 });
      // 绑到序列器：鼓轨事件走这条通道
      if (App.sequencer) App.sequencer.setDrumRack(App.drumRack);
    } else if (App.sequencer && !App.sequencer.drumRack) {
      App.sequencer.setDrumRack(App.drumRack);
    }
    return App.drumRack;
  }

  function ensureDrumKit() {
    if (!App.drums && els.drumKitHost) {
      ensureDrumRack();
      App.drums = new BS.drumKit({
        engine: App.engine,
        rack: App.drumRack,
        getRack: function () { return App.drumRack; },
        getVelocity: function () {
          return els.drumVelSlider ? parseFloat(els.drumVelSlider.value) / 100 : 0.85;
        },
        onHit: function (drumId, vel) { /* 手动敲击时的反馈已由 flash 处理 */ }
      });
      els.drumKitHost.appendChild(App.drums.root);
      App.drums.attach(els.drumKitHost);
      App.drums.attach(els.drumKitHost);
      if (els.drumVelSlider) {
        els.drumVelSlider.addEventListener('input', function () {
          App.drums.setVolume(parseFloat(els.drumVelSlider.value) / 100);
        });
      }
      // 未初始化的鼓位标灰
      markDrumPads();
    }
  }

  function markDrumPads() {
    if (!App.drums) return;
    BS.drumKit.DRUM_IDS.forEach(function (d) {
      var pad = App.drums.pads.get(d);
      if (pad) pad.classList.toggle('missing', !hasDrum(d));
    });
  }

  function bindDrumKit() {
    ensureDrumKit();
    if (!els.drumInitBtn) return;

    function doInit() {
      if (!App.engine) { toast('请先点击页面任意处启动音频引擎'); return; }
      ensureDrumRack();
      var rack = App.drumRack;
      renderParts();
      markDrumPads();
      var n = rack ? rack.drumIds().length : 0;
      if (els.drumInitHint) {
        els.drumInitHint.textContent = '鼓组已就绪 · ' + n + ' 面鼓 · 独立通道';
        els.drumInitHint.className = 'mini-hint ok';
      }
      toast('鼓组已就绪（' + n + ' 面鼓，走独立通道，不占用合成器声部）');
    }

    els.drumInitBtn.addEventListener('click', doInit);
    els.drumFollow.addEventListener('change', function () {
      App.drumFollow = els.drumFollow.checked;
      toast(App.drumFollow ? '鼓组将跟随曲谱触发' : '鼓组改为手动演奏');
    });
    // 缺鼓时提示
    BS.on('drums:missing', function (d) {
      toast('鼓位「' + d.label + '」还没有对应声部，点「生成鼓组声部」', 3500);
    });
  }

  /* ======================================================================
   * 工程保存 / 加载
   * ==================================================================== */

  function bindProjectBar() {
    if (!els.projSave) return;

    function capture() {
      if (!App.engine) { toast('请先启动音频引擎'); return null; }
      try {
        return BS.project.capture(App, { drumMap: App.drumMap });
      } catch (e) {
        toast('保存失败：' + e.message, 4000);
        return null;
      }
    }

    els.projSave.addEventListener('click', function () {
      var data = capture();
      if (!data) return;
      var nm = BS.project.download(data, els.projectName.value.trim());
      toast('已保存工程 ' + nm + '（' + data.parts.length + ' 声部' +
            (data.song ? ' + 曲谱' : '') + '）');
    });

    els.projLoad.addEventListener('click', function () { els.projFile.click(); });

    els.projFile.addEventListener('change', function () {
      var f = els.projFile.files[0];
      if (!f) return;
      BS.project.readFile(f).then(function (data) {
        return restoreProject(data);
      }).catch(function (e) {
        toast('加载失败：' + e.message, 5000);
      });
      els.projFile.value = '';
    });

    // 快速存档（localStorage）
    els.projQuickSave.addEventListener('click', function () {
      var data = capture();
      if (!data) return;
      try {
        localStorage.setItem('bandsynth.quickProject', BS.project.toJSON(data, false));
        toast('已快速存档（' + data.parts.length + ' 声部）');
      } catch (e) {
        toast('快速存档失败：存储空间不足或被禁用', 4000);
      }
    });

    els.projQuickLoad.addEventListener('click', function () {
      var txt = localStorage.getItem('bandsynth.quickProject');
      if (!txt) { toast('还没有快速存档'); return; }
      try {
        restoreProject(BS.project.parse(txt));
      } catch (e) {
        toast('读取失败：' + e.message, 4000);
      }
    });

    /* ---- 曲谱 JSON：读写的都是编曲页那份结构 ---- */
    if (els.importSong && els.songJson) {
      els.importSong.addEventListener('click', function () { els.songJson.click(); });
      els.songJson.addEventListener('change', function () {
        var f = els.songJson.files && els.songJson.files[0];
        if (!f) return;
        var fr = new FileReader();
        fr.onload = function () {
          try {
            var data = JSON.parse(String(fr.result));
            BS.appArranger.importJSON(data, f.name);
          } catch (e) {
            toast('曲谱导入失败：' + e.message, 6000);
          }
        };
        fr.onerror = function () { toast('读不到这个文件', 4000); };
        fr.readAsText(f);
        els.songJson.value = '';
      });
    }

    if (els.exportSong) {
      els.exportSong.addEventListener('click', function () {
        var name = BS.appArranger.exportJSON();
        if (name) toast('已导出曲谱 JSON：' + name, 3000);
      });
    }

    if (els.songSample) {
      els.songSample.addEventListener('click', function () {
        BS.appArranger.copySample().then(function () {
          toast('格式示例已复制到剪贴板，保存成 .json 即可导入', 4200);
        }).catch(function (e) {
          toast('复制失败：' + (e.message || e), 5000);
        });
      });
    }
  }

  function restoreProject(data) {
    if (!App.engine) { toast('请先启动音频引擎'); return; }
    toast('正在加载工程…', 1600);
    return BS.project.restore(App, data).then(function (r) {
      // 同步 UI
      renderParts();
      updateCurrentTone();
      markDrumPads();
      if (r.song) {
        App.song = r.song;
        if (App.sequencer) App.sequencer.setSong(r.song);
        applyTempo(r.song.bpm);
        applyTimeSignature(r.song.timeSignature);
      }
      if (els.projectName) els.projectName.value = data.name || '我的工程';
      // 主控与演奏 UI 同步
      var mv = App.engine ? App.engine.masterValue : 0.85;
      if (els.masterVol) {
        els.masterVol.value = mv;
        if (App.ui.masterVolKnob) App.ui.masterVolKnob.set(U.gainToDb(mv));
      }
      if (App._reverbType && els.reverbType) els.reverbType.value = App._reverbType;
      if (els.followMode) els.followMode.checked = !!App.followMode;
      if (els.velSlider && App.keyboard) els.velSlider.value = Math.round(App.keyboard.velocity * 100);
      updateOctLabel();
      r.warnings.forEach(function (w) { toast(w, 5000); });
      toast('工程已加载：' + r.parts.length + ' 声部' +
            (r.song ? ' + 曲谱《' + r.song.name + '》' : ''));
    }).catch(function (e) {
      toast('加载失败：' + e.message, 5000);
    });
  }

  /** 更新「当前音色」显示 */
  function updateCurrentTone() {
    if (!els.currentTone || !App.engine) return;
    var p = App.engine.parts[App.currentPartIndex];
    if (!p) { els.currentTone.textContent = '—'; return; }
    var label = p.name || p.bufferName || '未装载';
    els.currentTone.textContent = p._isDrum ? ('[鼓] ' + label) : label;
  }

  /* ================= UI 构建 ================= */
  function buildUI() {
    buildTransport();
    buildMasterSection();
    renderParts();
    bindRenderControls();
    bindKeyboardKeys();
  }

  function bindGlobal() {
    document.addEventListener('pointerdown', function () {
      if (App.ctx && App.ctx.state === 'suspended') App.ctx.resume();
    }, { once: false });
    bindFocusRelease();
  }

  /* ================= 焦点回收 =================
   * 点完按钮 / 开关 / 下拉，焦点会留在那个控件上，接着按快捷键全被它吃掉：
   *   · 焦点在 <select> → 按空格是展开下拉，不是播放
   *   · 焦点在 <button> → 按空格是浏览器默认「再点一次这个按钮」
   *   · 焦点在 <input type=checkbox> → 键盘处理当成「正在输入」直接忽略
   * 于是必须先在空白处点一下才恢复。这里在控件完成操作后主动交还焦点，
   * 文本输入框除外 —— 那类控件用户可能还在打字。
   */
  function isTextEntry(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    var tag = (el.tagName || '').toLowerCase();
    if (tag === 'textarea') return true;
    if (tag !== 'input') return false;
    var t = (el.type || 'text').toLowerCase();
    return t === 'text' || t === 'number' || t === 'search' || t === 'email' ||
      t === 'password' || t === 'url' || t === 'tel' || t === 'date' || t === 'time';
  }

  function releaseFocus() {
    var el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return;
    if (isTextEntry(el)) return;            // 还在打字：不抢焦点
    /* 自绘下拉的按钮例外：弹层展开时要靠方向键在选项间移动（见 src/dropdown.js），
       它在关闭时会自己把焦点交还页面。 */
    if (el.classList && el.classList.contains('dd-btn')) return;
    try { el.blur(); } catch (e) { /* noop */ }
  }

  function bindFocusRelease() {
    if (App._focusReleaseBound) return;
    App._focusReleaseBound = true;

    // 按钮 / 开关 / 滑块 / 分段控件 / 菜单项 / label：点完就交还焦点
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      if (t.closest('button, input[type=checkbox], input[type=radio], input[type=range],' +
        ' select, .seg-i, .ag-menu-i, .km-seg, label')) {
        setTimeout(releaseFocus, 0);
      }
    }, true);

    /* 下拉框不在这里处理：原生 select 已被 src/dropdown.js 换成自绘深色弹层，
       它在关闭时自己交还焦点。用 change→blur 反而会在「用方向键浏览选项」时
       把还没选完的弹层关掉。 */

    // 文本输入框按回车 = 输入完成，交还焦点（改完 BPM 直接按空格就能播放）。
    // 这里要绕过 releaseFocus 的保护：那层保护是「输入中别抢焦点」，
    // 而回车恰恰表示输入结束。textarea / 可编辑区除外（回车是换行）。
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.keyCode !== 13) return;
      var el = document.activeElement;
      if (!isTextEntry(el)) return;
      if ((el.tagName || '').toLowerCase() === 'textarea' || el.isContentEditable) return;
      setTimeout(function () { try { el.blur(); } catch (err) { /* noop */ } }, 0);
    }, true);
  }

  /* ---------- 走带 ----------
   * 播放 / 停止 / 速度 / 拍号 / 循环都已归编曲页，顶栏只留节拍器与电平表。
   * 编曲页改速度时通过 App.applyTempo / App.applyTimeSignature 同步到引擎与 song。 */
  function buildTransport() {
    if (els.metroBtn) {
      els.metroBtn.addEventListener('click', function () {
        App.metronomeOn = !App.metronomeOn;
        els.metroBtn.classList.toggle('active', App.metronomeOn);
      });
    }

    // 演奏台工具栏上的跟随模式复选框
    if (els.followMode) {
      els.followMode.checked = !!App.followMode;
      els.followMode.addEventListener('change', function () {
        App.followMode = els.followMode.checked;
        toast(App.followMode ? '跟随伴奏模式' : '单音色模式：只响当前选中的音色');
      });
    }
  }

  /** 速度统一入口：编曲页改 BPM 时用它同步 song / 序列器 / 引擎 */
  function applyTempo(bpm) {
    bpm = U.clamp(Math.round(bpm * 10) / 10, 20, 400);
    if (App.song) App.song.bpm = bpm;
    if (App.sequencer) App.sequencer.setTempo(bpm);
    syncEngineTempo();
    return bpm;
  }
  App.applyTempo = applyTempo;

  /** 拍号统一入口 */
  function applyTimeSignature(sig) {
    if (!Array.isArray(sig) || sig.length < 2) return;
    sig = [sig[0], sig[1]];
    if (App.song) {
      App.song.timeSignature = sig;
      if (!App.song.loopBars) App.song.loopBars = 0;
    }
    if (App.engine) App.engine.setTimeSignature(sig);
  }
  App.applyTimeSignature = applyTimeSignature;

  function syncEngineTempo() {
    if (App.engine && App.song) App.engine.setTempo(App.song.bpm);
  }

  function onSeqState() { /* 顶栏不再有 ▶ 按钮，播放状态由编曲页自己显示 */ }

  /** 没有琴谱页之后，song 只是编曲/渲染/工程的内部载体 */
  function initDefaultSong() {
    App.song = {
      version: 1, name: '未命名', bpm: 120,
      timeSignature: [4, 4], swing: 0, tracks: []
    };
    if (App.sequencer) App.sequencer.setSong(App.song);
  }

  /* ---------- 主控 / FX ---------- */
  function buildMasterSection() {
    // 主控旋钮组（音量 dB 刻度更符合调音习惯）
    var mk = els.masterKnobs;
    if (mk) {
      mk.innerHTML = '';
      App.ui.masterVolKnob = W.knob({
        label: '主音量', min: -60, max: 12, value: U.gainToDb(0.85), default: U.gainToDb(0.85), unit: 'dB',
        onChange: function (db) {
          var g = U.dbToGain(db);
          App.masterMuted = false;
          if (els.masterMute) els.masterMute.classList.remove('active');
          if (App.engine) App.engine.setMaster(g);
          if (els.masterVol) els.masterVol.value = Math.min(1.2, g);
        }
      });
      mk.appendChild(App.ui.masterVolKnob.el);

      App.ui.masterDriveKnob = W.knob({
        label: '总驱动', min: 0, max: 1, value: 0, default: 0,
        onChange: function (v) {
          if (App.engine) App.engine.setMasterDrive(v);
          if (els.masterDrive) els.masterDrive.value = v;
        }
      });
      mk.appendChild(App.ui.masterDriveKnob.el);
    }

    els.masterVol.addEventListener('input', function () {
      var g = parseFloat(els.masterVol.value);
      App.masterMuted = false;
      if (els.masterMute) els.masterMute.classList.remove('active');
      if (els.masterMute) els.masterMute.textContent = '静音';
      if (App.engine) App.engine.setMaster(g);
      if (App.ui.masterVolKnob) App.ui.masterVolKnob.set(U.gainToDb(g));
    });

    // 静音开关
    if (els.masterMute) {
      els.masterMute.addEventListener('click', function () {
        App.masterMuted = !App.masterMuted;
        els.masterMute.classList.toggle('active', App.masterMuted);
        els.masterMute.textContent = App.masterMuted ? '已静音' : '静音';
        if (!App.engine) return;
        if (App.masterMuted) {
          App.masterMutedGain = App.engine.master.gain.value;
          App.engine.setMaster(0);
        } else {
          App.engine.setMaster(App.masterMutedGain || 0.85);
          if (App.ui.masterVolKnob) App.ui.masterVolKnob.set(U.gainToDb(App.engine.master.gain.value));
        }
      });
    }

    // 一键取消所有独奏
    if (els.soloReset) {
      els.soloReset.addEventListener('click', function () {
        if (!App.engine) return;
        App.engine.parts.forEach(function (p) { p.solo = false; });
        App.engine.refreshAudible();
        renderParts();
        toast('已取消全部独奏');
      });
    }

    els.reverbType.addEventListener('change', function () {
      if (App.engine) App.engine.setReverbType(els.reverbType.value);
    });
    els.reverbReturn.addEventListener('input', function () {
      if (App.engine) App.engine.reverbReturn.gain.value = parseFloat(els.reverbReturn.value);
    });
    els.delayTime.addEventListener('input', function () {
      if (!App.engine) return;
      var d = parseFloat(els.delayTime.value);
      App.engine.delay.delayTime.value = U.clamp(d, 0.01, 1.9);
    });
    els.delayFb.addEventListener('input', function () {
      if (App.engine) App.engine.setDelayFeedback(parseFloat(els.delayFb.value));
    });
    els.delayReturn.addEventListener('input', function () {
      if (App.engine) App.engine.delayReturn.gain.value = parseFloat(els.delayReturn.value);
    });

    els.addPartBtn.addEventListener('click', function () {
      if (!App.engine) { toast('请先点击页面任意处启动音频'); return; }
      var ids = BS.factory.list();
      var id = ids[Math.floor(Math.random() * ids.length)];
      BS.factory.makePart(App.engine, id, {});
      renderParts();
      toast('已添加声部：' + (BS.PRESETS[id] ? BS.PRESETS[id].name : id));
    });
  }

  /* ================= 声部管理 ================= */
  function renderParts() {
    if (!App.engine || !els.partList) return;
    els.partList.innerHTML = '';
    App.engine.parts.forEach(function (part, i) {
      var card = document.createElement('div');
      card.className = 'part-card' + (i === App.currentPartIndex ? ' active' : '');

      var head = document.createElement('div');
      head.className = 'part-head';

      var idx = document.createElement('span');
      idx.className = 'part-index';
      idx.textContent = (i + 1);
      head.appendChild(idx);

      var nm = document.createElement('input');
      nm.className = 'part-name';
      nm.value = part.name;
      nm.addEventListener('change', function () { part.name = nm.value; });
      head.appendChild(nm);

      var mute = document.createElement('button');
      mute.className = 'part-btn' + (part.muted ? ' active warn' : '');
      mute.textContent = 'M';
      mute.title = '静音';
      mute.addEventListener('click', function (e) {
        e.stopPropagation();
        part.muted = !part.muted;
        App.engine.refreshAudible();
        renderParts();
      });
      head.appendChild(mute);

      var solo = document.createElement('button');
      solo.className = 'part-btn' + (part.solo ? ' active' : '');
      solo.textContent = 'S';
      solo.title = '独奏';
      solo.addEventListener('click', function (e) {
        e.stopPropagation();
        part.solo = !part.solo;
        App.engine.refreshAudible();
        renderParts();
      });
      head.appendChild(solo);

      var del = document.createElement('button');
      del.className = 'part-btn danger';
      del.textContent = '×';
      del.title = '删除声部';
      del.addEventListener('click', function (e) {
        e.stopPropagation();
        /* 删除声部会让后面所有声部的序号前移。
           轨里存的是数字索引 → 必须重映射，否则整盘音轨音色错位。 */
        var removedIndex = App.engine.parts.findIndex(function (p) { return p.id === part.id; });
        App.engine.removePart(part.id);
        App.currentPartIndex = 0;
        if (BS.appArranger && BS.appArranger.onPartRemoved) {
          BS.appArranger.onPartRemoved(removedIndex, App.engine.parts.length);
        }
        renderParts();
      });
      head.appendChild(del);
      card.appendChild(head);

      var info = document.createElement('div');
      info.className = 'part-info';
      info.textContent = part.buffer
        ? (part.bufferName || '采样') + ' · ' + part.bufferDuration.toFixed(2) + 's · ' + P.midiToName(part.rootNote)
        : '未装载采样';
      card.appendChild(info);

      var knobRow = document.createElement('div');
      knobRow.className = 'part-knobs';

      var volK = W.knob({
        label: '音量', min: 0, max: 1.2, value: part.volume, default: 0.85, unit: '%',
        onChange: function (v) { part.volume = v; part.applyAudible(); }
      });
      knobRow.appendChild(volK.el);

      var panK = W.knob({
        label: '声像', min: -1, max: 1, value: part.pan, default: 0, bipolar: true, unit: 'pan',
        onChange: function (v) { part.pan = v; if (part.panNode) part.panNode.pan.value = v; }
      });
      knobRow.appendChild(panK.el);
      card.appendChild(knobRow);

      card.addEventListener('click', function () {
        if (App.currentPartIndex === i) return;
        // 切换声部时停止试听，避免上一声部的音频继续响
        if (App.audition) App.audition.stop();
        // 演奏中的音也一并停掉，避免切换后两个音色叠着响
        if (App.engine) App.engine.allNotesOff();
        App.currentPartIndex = i;
        renderParts();
        renderPartEditor();
        updateCurrentTone();
      });

      els.partList.appendChild(card);
    });

    els.partCount.textContent = App.engine.parts.length;
    renderPartEditor();
  }

  /* ---------- 单声部参数编辑器 ---------- */
  function renderPartEditor() {
    var box = els.partEditor;
    if (!box) return;
    box.innerHTML = '';
    var part = App.engine && App.engine.parts[App.currentPartIndex];
    if (!part) {
      box.innerHTML = '<div class="empty-hint">无选中声部</div>';
      return;
    }

    var title = document.createElement('div');
    title.className = 'editor-title';
    title.textContent = '声部参数 · ' + part.name;
    box.appendChild(title);

    /* 采样装载 */
    var p1 = W.panel('采样');
    var fileRow = document.createElement('div');
    fileRow.className = 'file-row';
    var fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.className = 'file-input';
    fileInput.accept = BS.loader.acceptAttr;
    fileInput.addEventListener('change', function () {
      if (fileInput.files && fileInput.files[0]) loadSampleIntoPart(part, fileInput.files[0]);
    });
    fileRow.appendChild(fileInput);

    var builtinSel = W.select({
      options: [{ value: '', label: '载入内置音色…' }].concat(BS.factory.list().map(function (id) {
        return { value: id, label: (BS.PRESETS[id] ? BS.PRESETS[id].name : id) };
      })),
      onChange: function (v) {
        if (!v) return;
        loadBuiltinIntoPart(part, v);
      }
    });
    fileRow.appendChild(builtinSel.el);
    p1.add(fileRow);

    var waveBox = document.createElement('div');
    waveBox.className = 'wave-box';
    if (part.buffer) {
      // 交互式裁剪 + 试听面板
      var api = BS.createTrimPanel(waveBox, {
        getPart: function () { return App.engine.parts[App.currentPartIndex]; },
        // 动态取：面板在音频引擎启动前就已渲染，不能固化引用
        getAudition: function () { return App.audition; },
        ctx: function () { return App.ctx; },
        toast: toast,
        onRefresh: function () {
          renderParts();
          renderPartEditor();
        }
      });
      if (api) App.trimPanel = api;
    } else {
      var hint = document.createElement('div');
      hint.className = 'empty-hint';
      hint.textContent = '未装载采样';
      waveBox.appendChild(hint);
    }
    p1.add(waveBox);

    var sampleInfo = document.createElement('div');
    sampleInfo.className = 'sample-info';
    if (part.buffer) {
      sampleInfo.innerHTML = '<b>' + U.escapeHtml(part.bufferName || '采样') + '</b> · ' +
        part.buffer.duration.toFixed(3) + 's · ' + part.buffer.sampleRate + 'Hz · ' +
        part.buffer.numberOfChannels + 'ch';
    }
    p1.add(sampleInfo);

    /* 保存区：存入库 / 导出 WAV / 存预设 */
    if (part.buffer) {
      var saveBox = document.createElement('div');
      saveBox.className = 'save-box';

      var nameRow = document.createElement('div');
      nameRow.className = 'save-name-row';
      var nameLabel = document.createElement('label');
      nameLabel.className = 'mini-label';
      nameLabel.textContent = '名称';
      var nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'save-name';
      nameInput.value = part._saveName || stripExt(part.bufferName || part.name);
      nameInput.placeholder = '给这个音色起个名字';
      nameInput.addEventListener('input', function () { part._saveName = nameInput.value; });
      nameRow.appendChild(nameLabel);
      nameRow.appendChild(nameInput);
      saveBox.appendChild(nameRow);

      var saveBtns = document.createElement('div');
      saveBtns.className = 'save-btns';

      var libBtn = document.createElement('button');
      libBtn.className = 'btn small primary';
      libBtn.textContent = '存入采样库';
      libBtn.title = '把当前采样（含裁剪）保存到浏览器本地，下次直接调用';
      libBtn.addEventListener('click', function () {
        libBtn.disabled = true;
        libBtn.textContent = '保存中…';
        BS.exporter.saveToLibrary(App.ctx, part, { name: nameInput.value.trim() })
          .then(function (rec) {
            toast('已存入采样库：' + rec.name + '（' + BS.library.formatBytes(
              rec.length * rec.channels.length * 4) + '）');
            renderParts();
            renderLibraryPanel();
          })
          .catch(function (err) {
            toast('保存失败：' + err.message, 5000);
          })
          .then(function () {
            libBtn.disabled = false;
            libBtn.textContent = part._librarySampleId ? '更新采样库' : '存入采样库';
          });
      });
      if (part._librarySampleId) libBtn.textContent = '更新采样库';
      saveBtns.appendChild(libBtn);

      var wavBtn = document.createElement('button');
      wavBtn.className = 'btn small';
      wavBtn.textContent = '导出 WAV';
      wavBtn.title = '导出当前听到的声音：应用选区裁剪、反向、采样音量与 5ms 淡入淡出';
      saveBtns.appendChild(wavBtn);

      var preBtn = document.createElement('button');
      preBtn.className = 'btn small';
      preBtn.textContent = '存为预设';
      preBtn.title = '保存声部全套参数（含当前采样引用），可在「采样库」页一键还原';
      preBtn.addEventListener('click', function () {
        preBtn.disabled = true;
        BS.library.init().then(function () {
          var preset = BS.library.capturePreset(part, part._librarySampleId);
          preset.name = nameInput.value.trim() || preset.name;
          return BS.library.putPreset(preset);
        }).then(function (p) {
          part._presetId = p.id;
          toast('已保存预设：' + p.name);
          renderLibraryPanel();
        }).catch(function (err) {
          toast('预设保存失败：' + err.message, 5000);
        }).then(function () { preBtn.disabled = false; });
      });
      saveBtns.appendChild(preBtn);

      saveBox.appendChild(saveBtns);

      // 导出选项
      var optRow = document.createElement('div');
      optRow.className = 'save-opts';
      var chkRange = document.createElement('label');
      chkRange.className = 'chk';
      var cb1 = document.createElement('input');
      cb1.type = 'checkbox'; cb1.checked = true;
      cb1.addEventListener('change', function () { part._expRange = cb1.checked; });
      chkRange.appendChild(cb1);
      chkRange.appendChild(document.createTextNode(' 仅导出选区'));
      optRow.appendChild(chkRange);

      var chkNorm = document.createElement('label');
      chkNorm.className = 'chk';
      var cb2 = document.createElement('input');
      cb2.type = 'checkbox';
      cb2.checked = !!part._expNormalize;
      cb2.addEventListener('change', function () { part._expNormalize = cb2.checked; });
      chkNorm.appendChild(cb2);
      chkNorm.appendChild(document.createTextNode(' 归一化'));
      optRow.appendChild(chkNorm);

      var chkFade = document.createElement('label');
      chkFade.className = 'chk';
      var cb3 = document.createElement('input');
      cb3.type = 'checkbox'; cb3.checked = part._expFade !== false;
      cb3.addEventListener('change', function () { part._expFade = cb3.checked; });
      chkFade.appendChild(cb3);
      chkFade.appendChild(document.createTextNode(' 5ms 淡化'));
      optRow.appendChild(chkFade);

      saveBox.appendChild(optRow);

      // 导出按钮绑定（须在选项创建后，用 onclick 保证只有一个处理器）
      wavBtn.onclick = function () {
        wavBtn.disabled = true;
        wavBtn.textContent = '导出中…';
        BS.exporter.download(App.ctx, part, {
          fileName: nameInput.value.trim(),
          applyRange: part._expRange !== false,
          normalize: !!part._expNormalize,
          fadeMs: part._expFade === false ? 0 : 5
        }).then(function (r) {
          toast('已导出 ' + r.name + (r.clipped ? '（已削波保护）' : ''));
        }).catch(function (err) {
          toast('导出失败：' + err.message, 5000);
        }).then(function () {
          wavBtn.disabled = false;
          wavBtn.textContent = '导出 WAV';
        });
      };

      p1.add(saveBox);
    }

    // 采样音量 + 原声高
    var knobRow1 = W.row();
    knobRow1.appendChild(W.knob({
      label: '采样音量', min: -40, max: 12, value: U.gainToDb(part.sampleGain), default: 0, unit: 'dB',
      onChange: function (v) {
        part.sampleGain = U.dbToGain(v);
        BS.pitchAlgo.cache.clear();
      }
    }).el);
    knobRow1.appendChild(W.knob({
      label: '包络音量', min: 0, max: 2, value: part.amp.gain, default: 0.9,
      onChange: function (v) { part.amp.gain = v; }
    }).el);
    knobRow1.appendChild(W.knob({
      label: '原声高', min: 12, max: 108, value: part.rootNote, default: 60, unit: 'st',
      format: function (v) { return P.midiToName(v); },
      onChange: function (v) {
        var n = Math.round(v);
        if (n === part.rootNote) return;
        part.rootNote = n;
        BS.pitchAlgo.invalidate();     // 音高比全变了，旧缓存不能再用
      }
    }).el);
    p1.add(knobRow1);

    /* 手动重识别：装载时会自动跑一次，改了裁剪/换素材后可以再点一次。
       「原声高」= 采样本身的音高，按这个键播放是原速（playbackRate = 1）。 */
    var rootRow = W.row();
    var detectBtn = document.createElement('button');
    detectBtn.className = 'btn small';
    detectBtn.textContent = '识别原声高';
    detectBtn.title = '分析采样基频，填入「原声高」；识别不可靠时会提示，不会乱改';
    detectBtn.addEventListener('click', function () {
      detectPartRoot(part);
      renderPartEditor();
    });
    rootRow.appendChild(detectBtn);
    var rootHint = document.createElement('span');
    rootHint.className = 'mini-label';
    rootHint.textContent = '原声高错了 → 弹对应音时速度/音高都会偏';
    rootRow.appendChild(rootHint);
    p1.add(rootRow);

    var modeSeg = W.segment({
      label: '播放模式',
      options: [
        { value: 'oneshot', label: '单次' },
        { value: 'gate', label: '门控' },
        { value: 'loop', label: '循环' }
      ],
      value: part.mode,
      onChange: function (v) {
        part.mode = v;
        part._modeUser = true;      // 用户自己选过：以后换采样不要再改默认值
        // 下面的 ADSR 提示要跟着模式变（函数提升，调用时已定义）
        if (typeof syncAmpHint === 'function') syncAmpHint();
      }
    });
    p1.add(modeSeg.el);

    var pitchSeg = W.segment({
      label: '变调算法',
      options: [
        { value: 'varispeed', label: '变速变调', title: '采样机传统方式：音高变化时长度同步变化，零延迟' },
        { value: 'stretch', label: '锁时长变调', title: 'WSOLA 时间伸缩：音高任意变化而长度不变' }
      ],
      value: part.pitchMode,
      onChange: function (v) {
        part.pitchMode = v;
        if (v === 'stretch') {
          App.stretchMode = true;
          prewarmStretch(part);
          toast('锁时长变调：首次触发会用变速变调兜底，后台预计算后自动升级');
        } else {
          toast('变速变调模式');
        }
      }
    });
    p1.add(pitchSeg.el);

    var revBtn = W.toggle({ label: '反向', value: part.reverse, onChange: function (v) { part.reverse = v; } });
    var trimBtn = W.toggle({
      label: '裁剪静音', value: false, onChange: function (v) {
        if (!v || !part.buffer) return;
        var before = part.buffer.duration;
        var r = BS.loader.trimSilence(App.ctx, part.buffer, -48);
        part.setBuffer(r.buffer, (part.bufferName || '') + ' [裁剪]');
        renderParts(); renderPartEditor();
        var cut = before - r.buffer.duration;
        // 反馈要说清「裁了多少、用的什么阈值」，否则用户无法判断是否该裁
        var threshDb = r.thresh > 0 ? (20 * Math.log10(r.thresh)).toFixed(0) : '-inf';
        var msg = cut < 0.002
          ? '未找到可裁的静音（该素材没有静音段，已按峰值 -35dB 判定）'
          : ('已裁 ' + cut.toFixed(3) + 's：' + before.toFixed(3) + 's → ' +
             r.buffer.duration.toFixed(3) + 's（阈值 ' + threshDb + 'dB）');
        toast(msg);
        // 无静音可裁时提示如何调整
        if (cut < 0.002 && r.hasRealSilence === false) {
          toast('该素材无静音区（渐入/渐弱），如需更激进可提高余量');
        }
      }
    });
    var normBtn = W.toggle({
      label: '归一化', value: false, onChange: function (v) {
        if (!v || !part.buffer) return;
        var g = BS.loader.normalize(part.buffer, 0.98);
        var ch = part.buffer.numberOfChannels;
        for (var c = 0; c < ch; c++) {
          var d = part.buffer.getChannelData(c);
          for (var i = 0; i < d.length; i++) d[i] = U.clamp(d[i] * g, -1, 1);
        }
        BS.pitchAlgo.cache.clear();
        toast('已归一化，增益 ×' + g.toFixed(2));
      }
    });
    var monoBtn = W.toggle({
      label: '转单声道', value: part.buffer && part.buffer.numberOfChannels === 1, onChange: function (v) {
        if (!v || !part.buffer) return;
        part.setBuffer(BS.loader.toMono(App.ctx, part.buffer), part.bufferName);
        renderParts(); renderPartEditor();
      }
    });
    var bRow = W.row(revBtn.el, trimBtn.el, normBtn.el, monoBtn.el);
    p1.add(bRow);

    box.appendChild(p1.el);

    /* 音高 */
    var p2 = W.panel('音高');
    var row2 = W.row();
    row2.appendChild(W.knob({
      label: '移调', min: -24, max: 24, value: part.transpose, default: 0, unit: 'st',
      onChange: function (v) { part.transpose = Math.round(v); }
    }).el);
    row2.appendChild(W.knob({
      label: '微调', min: -100, max: 100, value: part.fine, default: 0, unit: 'ct', bipolar: true,
      onChange: function (v) { part.fine = Math.round(v); }
    }).el);
    row2.appendChild(W.knob({
      label: '滑音', min: 0, max: 1, value: part.portamento, default: 0, unit: 's',
      onChange: function (v) { part.portamento = v; }
    }).el);
    p2.add(row2);
    p2.add(W.toggle({ label: '音高跟随键盘', value: part.keyTrack, onChange: function (v) { part.keyTrack = v; } }).el);
    p2.add(W.knob({
      label: '复音数', min: 1, max: 32, value: part.maxVoices, default: 16, unit: '',
      format: function (v) { return String(Math.round(v)); },
      onChange: function (v) { part.maxVoices = Math.round(v); }
    }).el);
    box.appendChild(p2.el);

    /* 滤波 */
    var p3 = W.panel('滤波与包络');
    p3.add(W.segment({
      label: '滤波类型',
      options: [
        { value: 'lowpass', label: 'LP' }, { value: 'highpass', label: 'HP' },
        { value: 'bandpass', label: 'BP' }, { value: 'notch', label: '陷波' },
        { value: 'peaking', label: '峰化' }, { value: 'lowshelf', label: '低架' },
        { value: 'highshelf', label: '高架' }
      ],
      value: part.filter.type,
      onChange: function (v) {
        part.filter.type = v;
        /* 切到带通时给一组能立刻听出「带通」的两个边：
           默认截止 18k 等于低通全开，配 200Hz 低切听起来只是高通。
           这里只在明显不合理时改默认值（用户自己调过的就别覆盖）。 */
        if (v === 'bandpass') {
          if (part.filter.cutoff > 8000 || part.filter.cutoff < 400) part.filter.cutoff = 4000;
          var lo = part.filter.lowCut;
          if (!(lo > 20) || lo > part.filter.cutoff * 0.8) {
            part.filter.lowCut = Math.max(40, Math.round(part.filter.cutoff / 8));
          }
        }
        renderPartEditor();      // 换类型要换旋钮（带通给低切 / 高切两个频率）
      }
    }).el);

    var row3 = W.row();
    if (part.filter.type === 'bandpass') {
      /* 带通 = 低切(高通) + 高切(低通)。单个 Biquad bandpass 只有中心频率 + Q，
         用户没法分别选保留下限和保留上限 —— 所以这里必须给两个频率。 */
      row3.appendChild(W.knob({
        label: '低切', min: 20, max: 8000, value: part.filter.lowCut, default: 200,
        curve: 'log', unit: 'Hz',
        onChange: function (v) { part.filter.lowCut = v; }
      }).el);
      row3.appendChild(W.knob({
        label: '高切', min: 60, max: 20000, value: part.filter.cutoff, default: 4000,
        curve: 'log', unit: 'Hz',
        onChange: function (v) { part.filter.cutoff = v; }
      }).el);
    } else {
      row3.appendChild(W.knob({
        label: '截止', min: 30, max: 20000, value: part.filter.cutoff, default: 18000, curve: 'log', unit: 'Hz',
        onChange: function (v) { part.filter.cutoff = v; }
      }).el);
    }
    row3.appendChild(W.knob({
      label: '共振', min: 0.1, max: 24, value: part.filter.resonance, default: 0.8, curve: 'log', unit: '',
      onChange: function (v) { part.filter.resonance = v; }
    }).el);
    row3.appendChild(W.knob({
      label: '包络量', min: -1, max: 1, value: part.filter.envAmount, default: 0, bipolar: true, unit: '',
      onChange: function (v) { part.filter.envAmount = v; }
    }).el);
    p3.add(row3);

    p3.add(W.segment({
      label: '滤波包络',
      options: [{ value: 0, label: '关' }, { value: 0.25, label: '轻' }, { value: 0.5, label: '中' }, { value: 1, label: '强' }],
      value: part.filter.envAmount,
      onChange: function (v) { part.filter.envAmount = v; }
    }).el);

    var row4 = W.row();
    row4.appendChild(W.knob({ label: 'F.起音', min: 0.001, max: 2, value: part.filter.envAttack, default: 0.01, unit: 's', onChange: function (v) { part.filter.envAttack = v; } }).el);
    row4.appendChild(W.knob({ label: 'F.衰减', min: 0.005, max: 3, value: part.filter.envDecay, default: 0.2, unit: 's', onChange: function (v) { part.filter.envDecay = v; } }).el);
    p3.add(row4);

    var row5 = W.row();
    row5.appendChild(W.knob({ label: 'A.起音', min: 0.001, max: 3, value: part.amp.attack, default: 0.005, unit: 's', onChange: function (v) { part.amp.attack = v; } }).el);
    row5.appendChild(W.knob({ label: 'A.衰减', min: 0.005, max: 3, value: part.amp.decay, default: 0.12, unit: 's', onChange: function (v) { part.amp.decay = v; } }).el);
    row5.appendChild(W.knob({ label: 'A.持续', min: 0, max: 1, value: part.amp.sustain, default: 0.8, onChange: function (v) { part.amp.sustain = v; } }).el);
    row5.appendChild(W.knob({ label: 'A.释音', min: 0.005, max: 5, value: part.amp.release, default: 0.18, unit: 's', onChange: function (v) { part.amp.release = v; } }).el);
    p3.add(row5);

    /* 播放模式提示：三种模式在编曲/导出与键盘上的行为都不同，写明免得以为无效。
       单次：采样整段播完，音符时值不影响长度（编曲里也不循环补满）
       门控：编曲里到音符末尾收尾；键盘上松开键才走释音
       循环：采样循环，编曲里响到音符结束
       syncAmpHint 定义在后面，靠函数提升在下面的模式切换回调里调用。 */
    var ampHint = document.createElement('div');
    ampHint.className = 'mini-hint';
    ampHint.style.margin = '2px 0 0';
    function syncAmpHint() {
      if (part.mode === 'oneshot') {
        ampHint.textContent = '「单次」模式：采样整段播完，音符长短不影响长度（编曲里也不会循环补满）；A.持续 / A.释音 会被采样末尾截断';
      } else if (part.mode === 'gate') {
        ampHint.textContent = '「门控」模式：编曲里到音符末尾收尾（采样先放完就停，不循环）；键盘上松开键才走释音';
      } else {
        ampHint.textContent = '「循环」模式：采样循环播放，编曲里一直响到音符结束';
      }
    }
    p3.add(ampHint);
    syncAmpHint();

    p3.add(W.toggle({ label: '启用第二滤波器', value: part.filter2.enabled, onChange: function (v) { part.filter2.enabled = v; renderPartEditor(); } }).el);
    if (part.filter2.enabled) {
      var row6 = W.row();
      row6.appendChild(W.knob({ label: 'F2 截止', min: 20, max: 18000, value: part.filter2.cutoff, default: 80, curve: 'log', unit: 'Hz', onChange: function (v) { part.filter2.cutoff = v; } }).el);
      row6.appendChild(W.knob({ label: 'F2 共振', min: 0.1, max: 20, value: part.filter2.resonance, default: 0.5, curve: 'log', onChange: function (v) { part.filter2.resonance = v; } }).el);
      p3.add(row6);
    }
    box.appendChild(p3.el);

    /* 音色塑造 */
    var p4 = W.panel('音色与混音', { collapsed: true });
    var row7 = W.row();
    row7.appendChild(W.knob({ label: '驱动', min: 0, max: 1, value: part.drive, default: 0, onChange: function (v) { part.drive = v; } }).el);
    row7.appendChild(W.knob({ label: '齐奏', min: 1, max: 7, value: part.unison, default: 1, format: function (v) { return String(Math.round(v)); }, onChange: function (v) { part.unison = Math.round(v); } }).el);
    row7.appendChild(W.knob({ label: '失谐', min: 0, max: 50, value: part.detune, default: 0, unit: 'ct', onChange: function (v) { part.detune = v; } }).el);
    p4.add(row7);

    var row8 = W.row();
    row8.appendChild(W.knob({ label: '混响送出', min: 0, max: 1, value: part.sendReverb, default: 0.15, onChange: function (v) { part.sendReverb = v; part.revSend.gain.value = v; } }).el);
    row8.appendChild(W.knob({ label: '延迟送出', min: 0, max: 1, value: part.sendDelay, default: 0, onChange: function (v) { part.sendDelay = v; part.dlySend.gain.value = v; } }).el);
    row8.appendChild(W.knob({ label: '力度感应', min: 0, max: 1, value: part.velocityToGain, default: 0.7, onChange: function (v) { part.velocityToGain = v; } }).el);
    p4.add(row8);
    box.appendChild(p4.el);

    /* 采样处理：降噪 / 信噪比提升（直接改写当前声部的采样，可撤销一次） */
    var p5 = W.panel('采样处理（降噪 / 信噪比）', { collapsed: true });
    var dnPanel = BS.createDenoisePanel({
      getPart: function () { return part; },
      toast: toast,
      onChange: function () { renderPartEditor(); }
    });
    if (dnPanel) p5.add(dnPanel);
    box.appendChild(p5.el);
  }

  /* ================= 采样库面板 ================= */
  function stripExt(name) {
    return String(name || '').replace(/\.[a-z0-9]+$/i, '');
  }

  function renderLibraryPanel() {
    var host = els.libraryPanel;
    if (!host) return;
    var scrollTop = host.scrollTop;
    host.innerHTML = '';

    /* --- 存储状态 --- */
    var statusBox = document.createElement('div');
    statusBox.className = 'lib-status';
    var backendName = { idb: 'IndexedDB', local: '本地存储', memory: '仅内存' }[BS.library.backend] || '初始化中';
    statusBox.innerHTML =
      '<div class="lib-status-row"><span class="mini-label">存储方式</span>' +
      '<b>' + backendName + '</b></div>' +
      '<div class="lib-hint">' + U.escapeHtml(BS.library.describeBackend()) + '</div>';
    if (BS.library.backend !== 'idb') {
      var warn = document.createElement('div');
      warn.className = 'lib-warn';
      warn.textContent = BS.library.backend === 'local'
        ? '提示：当前浏览器限制了大容量存储，采样会以有损方式保存且容量约 5MB。建议改用 Chrome/Edge 的普通窗口（非 file://）打开以获得完整容量。'
        : '提示：浏览器禁用了持久化存储，保存的内容在刷新后丢失，请及时导出 WAV。';
      statusBox.appendChild(warn);
    }
    var usage = document.createElement('div');
    usage.className = 'lib-hint';
    usage.id = 'libUsage';
    statusBox.appendChild(usage);
    host.appendChild(statusBox);

    /* --- 采样列表 --- */
    var sec1 = document.createElement('div');
    sec1.className = 'lib-section';
    var h1 = document.createElement('div');
    h1.className = 'lib-head';
    h1.innerHTML = '<span>采样库</span><span class="badge" id="libSampleCount">0</span>';
    var importBtn = document.createElement('button');
    importBtn.className = 'btn small';
    importBtn.textContent = '导入文件…';
    importBtn.addEventListener('click', function () { els.libFile.click(); });
    h1.appendChild(importBtn);
    sec1.appendChild(h1);
    var list1 = document.createElement('div');
    list1.className = 'lib-list';
    list1.id = 'libSampleList';
    sec1.appendChild(list1);
    host.appendChild(sec1);

    /* --- 预设列表 --- */
    var sec2 = document.createElement('div');
    sec2.className = 'lib-section';
    var h2 = document.createElement('div');
    h2.className = 'lib-head';
    h2.innerHTML = '<span>预设音色</span><span class="badge" id="libPresetCount">0</span>';
    sec2.appendChild(h2);
    var list2 = document.createElement('div');
    list2.className = 'lib-list';
    list2.id = 'libPresetList';
    sec2.appendChild(list2);
    var presetHint = document.createElement('div');
    presetHint.className = 'lib-hint';
    presetHint.textContent = '预设保存声部全套参数（滤波器、包络、变调算法等）。加载时若采样不在库中，会提示并沿用当前采样。';
    sec2.appendChild(presetHint);
    host.appendChild(sec2);

    host.scrollTop = scrollTop;

    // 异步填充
    BS.library.init().then(function () {
      return Promise.all([BS.library.listSamples(), BS.library.listPresets()]);
    }).then(function (res) {
      var samples = res[0], presets = res[1];
      fillSampleList(samples || []);
      fillPresetList(presets || []);
      BS.library.refreshUsage();
    }).catch(function (err) {
      toast('读取采样库失败：' + err.message, 4000);
    });

    function fillSampleList(items) {
      var box = document.getElementById('libSampleList');
      if (!box) return;
      box.innerHTML = '';
      var cnt = document.getElementById('libSampleCount');
      if (cnt) cnt.textContent = items.length;
      if (!items.length) {
        var empty = document.createElement('div');
        empty.className = 'lib-empty';
        empty.textContent = '还没有保存任何采样。在声部面板点「存入采样库」，或点上方「导入文件…」。';
        box.appendChild(empty);
        return;
      }
      items.forEach(function (it) { box.appendChild(sampleRow(it)); });
    }

    function sampleRow(it) {
      var row = document.createElement('div');
      row.className = 'lib-item';

      var info = document.createElement('div');
      info.className = 'lib-item-info';
      var nm = document.createElement('div');
      nm.className = 'lib-item-name';
      nm.textContent = it.name || '未命名';
      nm.title = '点击重命名';
      nm.addEventListener('click', function () {
        var nn = prompt('重命名采样', it.name);
        if (nn === null) return;
        BS.library.renameSample(it.id, nn).then(function () {
          toast('已重命名为 ' + nn);
          renderLibraryPanel();
          renderParts();
        });
      });
      info.appendChild(nm);
      var meta = document.createElement('div');
      meta.className = 'lib-item-meta';
      meta.textContent = (it.length / (it.sampleRate || 44100)).toFixed(2) + 's · ' +
        it.sampleRate + 'Hz · ' + (it.chCount || 1) + 'ch · ' +
        BS.library.formatBytes(it.length * (it.chCount || 1) * 4);
      info.appendChild(meta);
      row.appendChild(info);

      var acts = document.createElement('div');
      acts.className = 'lib-item-acts';

      var audition = document.createElement('button');
      audition.className = 'lib-act';
      audition.textContent = '试听';
      audition.title = '试听这条采样';
      audition.addEventListener('click', function () {
        BS.library.getSample(it.id).then(function (rec) {
          if (!rec) { toast('采样数据已丢失', 3000); return; }
          var buf = BS.library.recordToBuffer(App.ctx, rec);
          if (!App.audition) { toast('请先点击页面启动音频引擎', 3000); return; }
          App.audition.play(buf, 0, buf.duration, { rate: 1 });
          audition.textContent = '停止';
          audition.classList.add('active');
          var iv = setInterval(function () {
            if (!App.audition.playing) {
              clearInterval(iv);
              audition.textContent = '试听';
              audition.classList.remove('active');
            }
          }, 120);
        });
      });
      acts.appendChild(audition);

      var load = document.createElement('button');
      load.className = 'lib-act';
      load.textContent = '载入选中声部';
      load.addEventListener('click', function () {
        loadSampleIntoPart(App.engine.parts[App.currentPartIndex], null, it.id);
      });
      acts.appendChild(load);

      var newPart = document.createElement('button');
      newPart.className = 'lib-act';
      newPart.textContent = '新建声部';
      newPart.title = '用这条采样创建一个新声部';
      newPart.addEventListener('click', function () {
        var p = App.engine.addPart({ name: it.name });
        BS.library.getSample(it.id).then(function (rec) {
          var buf = BS.library.recordToBuffer(App.ctx, rec);
          p.setBuffer(buf, rec.name);
          p._librarySampleId = it.id;
          detectPartRoot(p);            // 原声高按实际音高识别，不再是硬编码 C4
          App.currentPartIndex = App.engine.parts.length - 1;
          renderParts();
          updateCurrentTone();
          toast('已新建声部：' + it.name);
        });
      });
      acts.appendChild(newPart);

      var del = document.createElement('button');
      del.className = 'lib-act danger';
      del.textContent = '删除';
      del.addEventListener('click', function () {
        if (!confirm('删除采样「' + (it.name) + '」？\n使用此采样的预设将无法还原音频。')) return;
        BS.library.deleteSample(it.id).then(function () {
          toast('已删除');
          renderLibraryPanel();
        });
      });
      acts.appendChild(del);

      row.appendChild(acts);
      return row;
    }

    function fillPresetList(items) {
      var box = document.getElementById('libPresetList');
      if (!box) return;
      box.innerHTML = '';
      var cnt = document.getElementById('libPresetCount');
      if (cnt) cnt.textContent = items.length;
      if (!items.length) {
        var empty = document.createElement('div');
        empty.className = 'lib-empty';
        empty.textContent = '还没有预设。在声部面板调好参数后点「存为预设」。';
        box.appendChild(empty);
        return;
      }
      items.forEach(function (p) {
        var row = document.createElement('div');
        row.className = 'lib-item';

        var info = document.createElement('div');
        info.className = 'lib-item-info';
        var nm = document.createElement('div');
        nm.className = 'lib-item-name';
        nm.textContent = p.name || '未命名预设';
        nm.title = '点击重命名';
        nm.addEventListener('click', function () {
          var nn = prompt('重命名预设', p.name);
          if (nn === null) return;
          BS.library.renamePreset(p.id, nn).then(function () { renderLibraryPanel(); });
        });
        info.appendChild(nm);
        var meta = document.createElement('div');
        meta.className = 'lib-item-meta';
        meta.textContent = (p.bufferName ? p.bufferName + ' · ' : '') +
          '原声高 ' + P.midiToName(p.rootNote) +
          (p.params && p.params.pitchMode === 'stretch' ? ' · 锁时长' : '') +
          ' · ' + new Date(p.createdAt || Date.now()).toLocaleString('zh-CN', {
            month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
          });
        info.appendChild(meta);
        row.appendChild(info);

        var acts = document.createElement('div');
        acts.className = 'lib-item-acts';

        var apply = document.createElement('button');
        apply.className = 'lib-act primary';
        apply.textContent = '应用到选中声部';
        apply.addEventListener('click', function () {
          applyPresetToPart(p, App.currentPartIndex);
        });
        acts.appendChild(apply);

        var asNew = document.createElement('button');
        asNew.className = 'lib-act';
        asNew.textContent = '新建声部';
        asNew.addEventListener('click', function () {
          var idx = App.engine.parts.length;
          App.engine.addPart({ name: p.name });
          applyPresetToPart(p, idx, true);
        });
        acts.appendChild(asNew);

        var del = document.createElement('button');
        del.className = 'lib-act danger';
        del.textContent = '删除';
        del.addEventListener('click', function () {
          if (!confirm('删除预设「' + (p.name) + '」？')) return;
          BS.library.deletePreset(p.id).then(function () {
            toast('已删除');
            renderLibraryPanel();
          });
        });
        acts.appendChild(del);

        row.appendChild(acts);
        box.appendChild(row);   // 必须插入 DOM，否则 forEach 的返回值被丢弃
      });
    }
  }

  /* 应用预设到指定声部（含采样还原） */
  function applyPresetToPart(preset, partIndex, isNew) {
    var part = App.engine.parts[partIndex];
    if (!part) { toast('声部不存在'); return; }

    var chain = Promise.resolve();
    if (preset.sampleId) {
      chain = BS.library.getSample(preset.sampleId).then(function (rec) {
        if (rec) {
          var buf = BS.library.recordToBuffer(App.ctx, rec);
          part.setBuffer(buf, rec.name);
          part._librarySampleId = rec.id;
        } else {
          toast('预设引用的采样已不存在，沿用当前采样', 4000);
        }
      });
    }
    chain.then(function () {
      BS.library.applyPreset(part, preset);
      part._presetId = preset.id;
      part._modeUser = true;           // 预设自带播放模式：视为已选定
      if (isNew) App.currentPartIndex = partIndex;
      renderParts();
      updateCurrentTone();
      toast('已应用预设：' + preset.name);
    }).catch(function (err) {
      toast('应用失败：' + err.message, 4000);
    });
  }

  /* ================= 采样装载 ================= */
  /* 外部采样（文件 / 采样库）默认用「门控」：编曲里音符时值说了算，短音符不会
     把整段采样放完。想让采样整段播完或不循环，在声部设置里切「单次」。
     用户自己选过播放模式就不动他的选择。 */
  function applySampleDefaultMode(part) {
    if (part._modeUser) return;
    part.mode = 'gate';
  }

  function loadSampleIntoPart(part, file, libraryId) {
    // 从采样库加载
    if (libraryId) {
      BS.library.init().then(function () {
        return BS.library.getSample(libraryId);
      }).then(function (rec) {
        if (!rec) { toast('采样数据已丢失', 4000); return; }
        var buf = BS.library.recordToBuffer(App.ctx, rec);
        part.setBuffer(buf, rec.name);
        part._librarySampleId = rec.id;
        part.endSec = buf.duration;
        applySampleDefaultMode(part);
        detectPartRoot(part);            // 先识别原声高，再渲染（卡片上显示的就是识别值）
        renderParts();
        renderPartEditor();
        toast('已从采样库载入：' + rec.name + (part._modeUser ? '' : '（播放模式：门控）'));
        prewarmStretch(part);
      }).catch(function (err) { toast('载入失败：' + err.message, 4000); });
      return;
    }

    if (!file) return;
    toast('正在解码：' + file.name + '（' + BS.loader.describeFormat(file.name) + '）');
    BS.loader.decodeFile(App.ctx, file).then(function (buffer) {
      part.setBuffer(buffer, file.name);
      if (part.bufferDuration > 0) part.endSec = part.bufferDuration;
      part._librarySampleId = null;   // 新文件尚未入库
      applySampleDefaultMode(part);
      detectPartRoot(part);           // 自动识别原声高（不可靠时保留默认并提示）
      renderParts();
      renderPartEditor();
      toast('已装载 ' + file.name + ' · ' + buffer.duration.toFixed(2) + 's' +
        (part._modeUser ? '' : '（播放模式：门控）'));
      prewarmStretch(part);
    }).catch(function (err) {
      toast(err.message, 7000);
      console.error(err);
    });
  }

  function loadBuiltinIntoPart(part, id) {
    var buf = BS.factory.buffer(App.ctx, id);
    if (!buf) { toast('音色生成失败：' + id); return; }
    var preset = BS.PRESETS[id] || {};
    part.setBuffer(buf, '内置:' + id);
    part.rootNote = preset.root === undefined ? 60 : preset.root;
    part.mode = preset.mode || 'oneshot';
    part._modeUser = true;           // 预设自带播放模式：视为已选定
    if (preset.amp) Object.assign(part.amp, preset.amp);
    if (preset.filter) Object.assign(part.filter, preset.filter);
    part.name = preset.name || id;
    part.endSec = buf.duration;
    renderParts();
    renderPartEditor();
    prewarmStretch(part);
  }

  function prewarmStretch(part) {
    if (!part.buffer || part.pitchMode !== 'stretch') return;
    var notes = [];
    for (var n = 36; n <= 96; n += 3) notes.push(n);
    BS.pitchAlgo.prewarm(App.ctx, part.buffer, part.id, notes, part.rootNote, part.transpose, part.fine, part.stretchQuality);
  }

  /* ================= 采样原声高识别 =================
   * 装载采样后自动跑一次。旧行为是一律给 C4(60) —— 那只是默认值、不是分析结果：
   * 录一个 A2 的贝斯，按 C4 会加速（音高一起偏），这就是「初始音高是错的」。
   * 识别不可靠时**保持原值并明确告知**，绝不静默瞎猜（可手动改「原声高」）。
   */
  function detectPartRoot(part, silent) {
    if (!part || !part.buffer) return null;
    var r = null;
    try { r = BS.loader.detectRootNote(part.buffer); } catch (e) { r = null; }
    var base = P.midiToName(part.rootNote);

    if (!r) {
      if (!silent) {
        toast('未能识别音高：这段素材没有明确基频（鼓/噪声/和弦）。原声高保持 ' +
          base + '，可手动调整', 6000);
      }
      return null;
    }
    if (r.conf < 0.5) {
      if (!silent) {
        toast('音高识别把握不大（' + Math.round(r.conf * 100) + '%）：疑似 ' +
          P.midiToName(r.midi) + ' ' + r.refFreq.toFixed(1) + 'Hz。原声高保持 ' +
          base + '，需要的话手动改', 6000);
      }
      return r;
    }
    part.rootNote = r.midi;
    BS.pitchAlgo.invalidate();        // 根音变了 → 旧音高比的缓存全部作废
    renderParts();
    prewarmStretch(part);
    if (!silent) {
      toast('原声高已自动识别：' + P.midiToName(r.midi) + '（实测 ' +
        r.refFreq.toFixed(1) + 'Hz，偏差 ' + (r.cents >= 0 ? '+' : '') +
        r.cents + ' 音分）', 5000);
    }
    return r;
  }

  /* ================= 键盘 ================= */
  function buildKeyboard() {
    var host = document.getElementById('keyboardHost');
    if (!host) return;
    App.keyboard = new BS.Keyboard({
      octave: 3,
      numOctaves: 4,
      mode: 'C',                     // 统一「一字排开」键位
      velocity: 0.85,
      onNoteOn: function (note, vel) { playNote(note, vel); },
      onNoteOff: function (note) { releaseNote(note); }
    });
    host.appendChild(App.keyboard.root);

    els.octDown.addEventListener('click', function () { App.keyboard.setOctave(App.keyboard.octave - 1); updateOctLabel(); });
    els.octUp.addEventListener('click', function () { App.keyboard.setOctave(App.keyboard.octave + 1); updateOctLabel(); });
    els.velSlider.addEventListener('input', function () {
      App.keyboard.setVelocity(parseFloat(els.velSlider.value) / 100);
    });
    updateOctLabel();
    BS.on('kb:octave', updateOctLabel);
  }

  /* 键盘模式：**只有「一字排开」这一种**（演奏页与编曲页共用）
   * 白键 qwertyuiop[]zxcvbnm,./ · 黑键 2356790=asfgjkl，从当前音域最低的 C 起
   * A 音高直通 / B 双手 的实现仍在键盘组件里，但界面不再提供切换。 */
  function bindKeyMode() {
    BS.keymodes.current = 'C';
    if (App.keyboard && App.keyboard.mode !== 'C') {
      App.keyboard.setMode('C');
      App.keyboard.allOff();
    }
    // 换手选项早已隐藏（固定右手模式），这里保持隐藏
    if (els.handSwitchWrap) {
      els.handSwitchWrap.classList.add('hide');
      els.handSwitchWrap.style.display = 'none';
    }
    updateKeyRef();
  }

  /* 快捷键说明面板：只显示当前模式相关的那条（现在只有「一字排开」） */
  function updateKeyRef() {
    if (!els.kbRef) return;
    var mode = App.keyboard ? App.keyboard.mode : 'C';
    els.kbRef.querySelectorAll('.kb-ref-item[data-mode]').forEach(function (item) {
      item.hidden = item.dataset.mode !== mode;
    });

    // 动态提示：当前音域下键位表的覆盖范围（一字排开用自己那张表）
    var zh = document.getElementById('agZoneHint');
    if (zh && App.keyboard && BS.keymodes) {
      var audit;
      if (mode === 'C') {
        audit = BS.keymodes.auditLineMap();
        var baseC = BS.keymodes.basePitch(App.keyboard.lowNote);
        audit.table = audit.table.map(function (t) {
          return { key: t.key, midi: baseC + t.semi };
        });
        audit.summary.totalKeys = audit.table.length;
      } else {
        audit = BS.keymodes.auditKeyMap(App.keyboard.lowNote);
      }
      var first = audit.table.length ? audit.table.reduce(function (a, t) {
        return a === null || t.midi < a.midi ? t : a;
      }, null) : null;
      var last = audit.table.length ? audit.table.reduce(function (a, t) {
        return a === null || t.midi > a.midi ? t : a;
      }, null) : null;
      var rangeTxt = first && last
        ? (BS.pitch.midiToName(first.midi) + ' – ' + BS.pitch.midiToName(last.midi) +
           '（' + audit.summary.totalKeys + ' 键）')
        : '无键位';
      zh.textContent = '当前音域覆盖：' + rangeTxt +
        (audit.errors.length ? ' ⚠ 键位表异常：' + audit.errors[0] : '');
      zh.classList.toggle('kb-ref-warn', audit.errors.length > 0);
    }
    var hh = document.getElementById('agHandHint');
    if (hh && App.keyboard && BS.keymodes) {
      var kb = App.keyboard;
      // 当前选中的根音（真实音名，不是区起点）
      var rootKey = null;
      if (kb._roots && kb._roots.size) {
        var rk = Array.from(kb._roots);
        rootKey = rk[rk.length - 1];
      }
      var rootTxt = rootKey
        ? ('当前根音 ' + BS.keymodes.rootNameOf(rootKey, kb.lowNote) +
           '（' + rootKey.toUpperCase() + ' 键）')
        : '先按左半区选根音';
      hh.textContent = rootTxt + ' · 级1=根音本身，之后按级数键';
    }
  }

  function updateOctLabel() {
    if (els.octaveLabel && App.keyboard) {
      els.octaveLabel.textContent = 'C' + App.keyboard.octave + '–C' + (App.keyboard.octave + App.keyboard.numOctaves);
    }
  }

  /* 演奏时响应的声部
   * 单一音色模式（默认）：只响当前选中的声部 —— 演奏时监听「我在调什么音色」，
   * 若所有非静音声部齐发，调音色就完全听不出区别了。
   * 跟随模式：响最后一个声部（预留给「配着伴奏即兴」）。 */
  function performParts() {
    if (!App.engine) return [];
    if (App.followMode) {
      return App.engine.parts.slice(-1);
    }
    var p = App.engine.parts[App.currentPartIndex];
    if (!p) return [];
    if (p.muted) return [];
    return p.buffer ? [p] : [];
  }

  function playNote(note, vel) {
    var parts = performParts();
    if (!parts.length) {
      if (App.engine && App.engine.parts[App.currentPartIndex] &&
          !App.engine.parts[App.currentPartIndex].buffer) {
        toast('当前音色未装载采样，请在下方声部卡片里装载或选择音色');
      } else {
        toast('当前音色已静音');
      }
      return;
    }
    var now = App.ctx.currentTime;
    for (var i = 0; i < parts.length; i++) {
      var v = parts[i].noteOn(note, vel, now);
      if (v) {
        v._releaseOnKeyUp = true;
      }
    }
    App._heldNote = App._heldNote || {};
    App._heldNote[note] = parts.slice();
  }

  function releaseNote(note) {
    var parts = App._heldNote && App._heldNote[note];
    if (!parts) return;
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      // 释放该声部中此音高对应的 voice
      p.voices.slice().forEach(function (v) {
        if (v.note === note && !v.released) v.release();
      });
    }
    delete App._heldNote[note];
  }

  /* 全局快捷键 */
  /* 全局快捷键（播放/停止/八度）由键盘仲裁器统一分发，
     避免与鼓组、合成器键盘抢同一个键。 */
  function bindKeyboardKeys() {
    if (!BS.keyArb) return;
    BS.keyArb._globalHandler = function (action) {
      // 编曲页的空格/停止归编曲页（走它自己的播放入口），否则按空格播的是琴谱页的歌
      var inArrange = BS.appArranger && BS.appArranger.isActive();
      if (action === 'playPause') {
        if (inArrange) { BS.appArranger.togglePlay(); return; }
        if (!App.sequencer) return;
        if (App.sequencer.playing) App.sequencer.pause();
        else App.sequencer.play();
      } else if (action === 'stop' || action === 'stopUp') {
        if (inArrange && BS.appArranger) BS.appArranger.stop();
        if (App.sequencer) App.sequencer.stop();
        if (App.engine) App.engine.allNotesOff();
        if (App.keyboard) App.keyboard.allOff();
        if (App.audition) App.audition.stop();
        if (App.trimPanel) App.trimPanel.stop();
        if (App.drums) App.drums.allNotesOff();
        if (BS.keyArb) BS.keyArb.releaseAll();
      } else if (action === 'octaveDown' || action === 'octaveUp') {
        var dir = action === 'octaveUp' ? 1 : -1;
        /* 编曲页：← → 调的是编曲页演奏条的音域（低音轨锁定不响应）。
           谱面里选中音块时留给「移动音块」，避免一次按键既移块又换八度。 */
        if (inArrange && BS.appArranger && BS.appArranger.shiftOctave) {
          if (!BS.appArranger.editorUsesArrows()) BS.appArranger.shiftOctave(dir);
        } else if (App.keyboard) {
          App.keyboard.setOctave(App.keyboard.octave + dir);
        }
      }
    };
    BS.keyArb.bind();
  }

  /* ================= 渲染 ================= */
  function bindRenderControls() {
    els.renderBtn.addEventListener('click', function () { renderSong('play'); });
    els.exportBtn.addEventListener('click', function () { renderSong('download'); });
    if (els.renderStems) els.renderStems.addEventListener('click', function () { renderStems(); });
    if (els.renderPlay) els.renderPlay.addEventListener('click', function () { toggleRenderPreview(); });
  }

  /* ---------------- 渲染结果试听 ---------------- */

  var _renderPreview = { src: null, playing: false, startedAt: 0, dur: 0 };

  function stopRenderPreview() {
    if (_renderPreview.src) {
      try { _renderPreview.src.stop(); } catch (e) { /* 已结束 */ }
      _renderPreview.src.disconnect && _renderPreview.src.disconnect();
    }
    _renderPreview.src = null;
    _renderPreview.playing = false;
    if (els.renderPlay) els.renderPlay.textContent = '▶ 播放结果';
  }

  function playRenderBuffer(buffer) {
    if (!buffer || !App.ctx) return;
    stopRenderPreview();
    var src = App.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(App.ctx.destination);
    src.onended = function () {
      _renderPreview.playing = false;
      if (els.renderPlay) els.renderPlay.textContent = '▶ 播放结果';
    };
    src.start();
    _renderPreview.src = src;
    _renderPreview.playing = true;
    _renderPreview.dur = buffer.duration;
    _renderPreview.startedAt = App.ctx.currentTime;
    if (els.renderPlay) els.renderPlay.textContent = '■ 停止';
  }

  function toggleRenderPreview() {
    if (_renderPreview.playing) { stopRenderPreview(); return; }
    if (!App._lastRender) { toast('还没有渲染结果'); return; }
    playRenderBuffer(App._lastRender);
  }

  /* ---------------- 渲染源：编曲优先 ---------------- */

  /**
   * 决定渲染哪个谱：
   *   · 编曲页有内容 → 用编曲（含长度/循环/各轨音量），不必先「试听」同步
   *   · 否则退回 App.song（工程自带的那份）
   * @returns {{song:object, source:string}}
   */
  function songForRender() {
    var arr = BS.appArranger && BS.appArranger.getArr ? BS.appArranger.getArr() : null;
    if (!arr || !arr.trackCount()) return { song: App.song, source: '当前曲谱' };

    var loopOnly = els.renderLoopOnly && els.renderLoopOnly.checked;
    var song = arr.toSong();
    var source = '编曲页';

    if (arr.loop && loopOnly) {
      var bb = arr.barBeats();
      var a = arr.loop.start * bb;
      var b = arr.loop.end * bb;
      song.loopBars = 0;
      song.loopStartBars = 0;
      song.lengthBars = arr.loop.end - arr.loop.start;
      song.tracks = song.tracks.map(function (t) {
        var notes = [];
        (t.notes || []).forEach(function (n) {
          var s = Math.max(n.beat, a);
          var e = Math.min(n.beat + (n.len || 0), b);
          if (e - s > 1e-6) {
            var o = { beat: s - a, len: e - s, pitch: n.pitch, vel: n.vel };
            // 裁剪循环区间时音符修饰要跟着走，否则导出会丢掉滑音/颤音
            if (n.glide > 0) o.glide = n.glide;
            if (n.glideFrom !== undefined && n.glideFrom !== null) o.glideFrom = n.glideFrom;
            if (n.vib > 0) { o.vib = n.vib; if (n.vibRate > 0) o.vibRate = n.vibRate; }
            notes.push(o);
          }
        });
        return Object.assign({}, t, { notes: notes });
      });
      source = '编曲页 · 循环 ' + (arr.loop.start + 1) + '–' + arr.loop.end;
    } else {
      // 整曲渲染时去掉循环，避免渲染结果只有一个小节
      song.loopBars = 0;
      song.loopStartBars = 0;
    }
    return { song: song, source: source };
  }

  function buildRenderSpecs() {
    var specs = App.engine.parts.map(function (p) {
      return {
        buffer: p.buffer, bufferName: p.bufferName, rootNote: p.rootNote,
        transpose: p.transpose, fine: p.fine, mode: p.mode,
        startSec: p.startSec, endSec: p.endSec, reverse: p.reverse,
        volume: p.volume, pan: p.pan, sampleGain: p.sampleGain,
        sendReverb: p.sendReverb, sendDelay: p.sendDelay,
        filter: p.filter, amp: p.amp, name: p.name
      };
    });
    // 鼓组走独立通道，不在 parts 里
    if (App.drumRack) {
      specs.drumRack = {
        drumIds: App.drumRack.drumIds(),
        volume: App.drumRack.volume,
        pan: App.drumRack.pan,
        sendReverb: App.drumRack.sendReverb
      };
    }
    return specs;
  }

  /** 渲染进行中的即时反馈：已用时间 + 阶段（不伪造百分比） */
  function startRenderFeedback(label) {
    var t0 = performance.now();
    if (els.renderProgress) {
      els.renderProgress.style.width = '35%';
      els.renderProgress.classList.add('busy');
    }
    var timer = setInterval(function () {
      if (!els.renderInfo) return;
      els.renderInfo.textContent = (label || '渲染中') + '… 已用 ' +
        ((performance.now() - t0) / 1000).toFixed(1) + 's';
    }, 200);
    return {
      stop: function (text) {
        clearInterval(timer);
        if (els.renderProgress) {
          els.renderProgress.style.width = '100%';
          els.renderProgress.classList.remove('busy');
          setTimeout(function () { els.renderProgress.style.width = '0%'; }, 900);
        }
        if (text && els.renderInfo) els.renderInfo.textContent = text;
      },
      elapsed: function () { return ((performance.now() - t0) / 1000).toFixed(1); }
    };
  }

  /**
   * @param {string} mode 'play' | 'download'
   */
  function renderSong(mode) {
    var pick = songForRender();
    var song = pick.song;
    if (!song || !song.tracks || !song.tracks.length) { toast('没有可渲染的乐谱'); return; }
    if (!App.engine || !App.engine.parts.length) { toast('请先添加声部并装载采样'); return; }

    // 检查每个 part 是否有采样（鼓轨 part=-1 走鼓组通道）
    var missing = [];
    song.tracks.forEach(function (t) {
      if (t.role === 'drum' || t.part === -1) {
        if (!App.drumRack) missing.push(t.name + '（鼓组未初始化）');
        return;
      }
      var p = App.engine.parts[t.part];
      if (!p || !p.buffer) missing.push(t.name);
    });
    if (missing.length && !confirm('以下音轨未绑定采样：' + missing.join('、') + '\n继续渲染（这些轨将被跳过）？')) return;

    els.renderBtn.disabled = true;
    var fb = startRenderFeedback('渲染中（' + pick.source + '）');

    BS.renderer.render({
      song: song,
      parts: buildRenderSpecs(),
      sampleRate: 44100,
      tail: 2.0
    }).then(function (buffer) {
      var msg = '渲染完成（' + pick.source + '）：' + U.fmtTime(buffer.duration) +
        '，耗时 ' + fb.elapsed() + 's';
      fb.stop(msg);
      toast(msg);
      App._lastRender = buffer;
      if (els.renderPlay) els.renderPlay.disabled = false;

      // 渲染源就是当前编曲 → 让工程保存看到同一份内容
      if (pick.source.indexOf('编曲页') === 0) {
        App.song = song;
      }

      if (mode === 'play') {
        playRenderBuffer(buffer);
      } else if (mode === 'download') {
        var ab = BS.wav.encode(buffer, { bitDepth: 16, channels: 2 });
        var blob = new Blob([ab], { type: 'audio/wav' });
        var name = (song.name || '伴奏').replace(/[\\/:*?"<>|]/g, '_');
        U.download(blob, name + '_' + song.bpm + 'bpm.wav');
        toast('已导出 WAV');
      }
    }).catch(function (err) {
      console.error(err);
      fb.stop('渲染失败：' + err.message);
      toast('渲染失败：' + err.message, 6000);
    }).then(function () {
      els.renderBtn.disabled = false;
    });
  }

  /**
   * 分轨导出：每条音轨单独渲染一个 WAV。
   * 逐轨顺序渲染，进度与文件名就地反馈。
   */
  function renderStems() {
    var pick = songForRender();
    var song = pick.song;
    if (!song || !song.tracks.length) { toast('没有可导出的音轨'); return; }
    if (!App.engine || !App.engine.parts.length) { toast('请先添加声部并装载采样'); return; }

    var specs = buildRenderSpecs();
    var list = song.tracks.filter(function (t) { return t.notes && t.notes.length; });
    if (!list.length) { toast('音轨里还没有音符'); return; }

    stopRenderPreview();
    els.renderStems.disabled = true;
    var base = (song.name || '编曲').replace(/[\\/:*?"<>|]/g, '_');
    var i = 0;

    function next() {
      if (i >= list.length) {
        els.renderStems.disabled = false;
        if (els.renderInfo) els.renderInfo.textContent = '分轨导出完成：' + list.length + ' 个 WAV';
        toast('分轨导出完成：' + list.length + ' 个文件');
        return;
      }
      var track = list[i];
      var idx = i;
      i++;
      if (els.renderInfo) {
        els.renderInfo.textContent = '分轨导出 ' + i + '/' + list.length + '：' + track.name +
          '（已用 ' + ((performance.now() - t0) / 1000).toFixed(1) + 's）';
      }
      if (els.renderProgress) els.renderProgress.style.width = (i / list.length * 100).toFixed(0) + '%';

      var sub = {
        version: 1, name: base, bpm: song.bpm, timeSignature: song.timeSignature,
        swing: song.swing || 0, lengthBars: song.lengthBars, loopBars: 0,
        tracks: [track]
      };
      BS.renderer.renderToWav({
        song: sub, parts: specs, sampleRate: 44100, tail: 2, bitDepth: 16, channels: 2
      }).then(function (blob) {
        var safe = (track.name || ('轨' + (idx + 1))).replace(/[\\/:*?"<>|]/g, '_');
        U.download(blob, base + '_' + (idx + 1) + '_' + safe + '.wav');
        setTimeout(next, 200);          // 给浏览器下载队列一点间隔
      }).catch(function (err) {
        console.warn('分轨渲染失败', track.name, err);
        toast('「' + track.name + '」分轨渲染失败：' + err.message, 4000);
        setTimeout(next, 120);
      });
    }
    var t0 = performance.now();
    next();
  }

  /* ================= 主循环 ================= */
  var lastMeterReset = 0;
  function tick() {
    requestAnimationFrame(tick);
    if (!App.engine) return;

    // 电平表
    var lvl = App.engine.getLevel();
    var pct = U.clamp(lvl.peak * 100, 0, 100);
    els.meterFill.style.width = pct + '%';
    if (pct > 92) els.meterFill.classList.add('hot'); else els.meterFill.classList.remove('hot');

    var now = performance.now();
    if (now - lastMeterReset > 900) {
      lastMeterReset = now;
      els.meterPeak.style.left = pct + '%';
    }

    els.voiceCount.textContent = App.engine.activeVoices;

    // 播放进度
    if (App.sequencer && App.sequencer.song) {
      var prog = App.sequencer.getProgress();
      els.barBeat.textContent = prog.bar + ' . ' + Math.floor(prog.beatInBar + 1e-6);
      els.transportPos.textContent = U.fmtTime(App.sequencer.position());

      /* 编曲页播放头：直接读音频时钟（与音符排程同源），
         不再让编辑器自己用 performance.now 计时 —— 那必然越放越偏。
         不限定 playing：播到尾/被暂停时也要让编曲页收尾（否则状态卡在「播放中」）。 */
      if (BS.appArranger && BS.appArranger.isActive()) {
        BS.appArranger.onTick(App.sequencer.beatPosition());
      }

      // 节拍器
      if (App.metronomeOn && App.sequencer.playing) {
        scheduleMetronome(prog);
      }
    }
  }

  var lastMetroBeat = -1;
  function scheduleMetronome(prog) {
    var song = App.sequencer.song;
    var spb = 60 / song.bpm;
    var beat = Math.floor(prog.effBeat);
    if (beat === lastMetroBeat) return;
    lastMetroBeat = beat;
    var when = App.ctx.currentTime + 0.01;
    App.metronome.click(when, ((beat % song.timeSignature[0]) + song.timeSignature[0]) % song.timeSignature[0] === 0);
  }

  /* ================= 提示 ================= */
  var toastTimer = null;
  function toast(msg, duration) {
    if (!els.toast) { console.log('[toast]', msg); return; }
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.classList.remove('show'); }, duration || 3200);
  }
  App.toast = toast;
  // 导出给独立模块（app-arranger.js 等）使用
  App.renderParts = renderParts;
  App.ensureDrumRack = ensureDrumRack;
  App.hasDrum = hasDrum;
  App.getEls = function () { return els; };
  App.setEls = function (e) { els = e; };

  /* ================= 快捷键 ================= */
  BS.on('parts:changed', function () { renderParts(); });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})(window);

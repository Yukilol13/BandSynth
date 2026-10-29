/* BandSynth · import-song.js
 * 「导入成谱」页：① 导入音频/分轨 ② 分轨归类（鼓/贝斯/人声/钢琴/吉他/混音）
 *                ③ 自动生成鼓谱 + 置信度自检 → 写入编曲。
 *
 * 分轨策略（P1）：页面不跑分离模型（file:// 下没有 Worker，也不想背几十 MB 权重），
 * 由用户在外部（UVR5 / Demucs）分好再导入；只给一个文件时按「混音」处理并提示质量有限。
 *
 * 谱面真值：直接产出琴谱 JSON（version/bpm/timeSignature/tracks[].notes[]），
 * 交给 BS.appArranger.importSong() 落到编曲页，用户继续用现成编辑器校对。
 */
(function (global) {
  'use strict';

  var BS = global.BS;
  var U = BS.util;
  var App = BS.app;

  /* 文件角色：按文件名猜，猜不出让人在列表里改 */
  var ROLE_DEFS = [
    { id: 'drums', label: '鼓', kw: /(drum|perc|beat|鼓|节奏|打击)/i },
    { id: 'bass', label: '贝斯', kw: /(bass|低音|贝斯)/i },
    { id: 'vocals', label: '人声', kw: /(vocal|vox|voice|sing|人声|唱)/i },
    { id: 'piano', label: '钢琴', kw: /(piano|keys?|keyboard|钢琴|键)/i },
    { id: 'guitar', label: '吉他', kw: /(guitar|吉他)/i },
    { id: 'other', label: '其他', kw: /(other|inst|accomp|music|伴奏|其他)/i },
    { id: 'mixed', label: '整首混音', kw: /(mix|master|full|song|整首|混音)/i }
  ];
  var ROLE_LABEL = {};
  ROLE_DEFS.forEach(function (r) { ROLE_LABEL[r.id] = r.label; });

  var els = {};
  var state = {
    files: [],          // {file, role, buffer, name, duration}
    drumsBuf: null,     // 分析用的打击源（priority: drums stem > mixed）
    mixedBuf: null,
    bassBuf: null,      // 贝斯分轨
    harmonicBufs: [],   // 钢琴 / 吉他 / 其他（兼容旧逻辑，和声计算仍用合并结果）
    stems: [],          // 分轨清单：[{role, name, buffer|midi}] —— 一个文件一条轨，混音不算分轨
    midiFiles: [],      // 已解析的 MIDI 文件：[{name, tracks:[...]}]（P1 外部转写入口）
    result: null,       // 分析结果（含 hits / bass / chords / song）
    playing: null,      // 'stem' | 'chart' | null
    sourceNode: null,
    chartTimer: null,
    selectedBar: 0,
    busy: false,
    dragDepth: 0,
    /* 谱面视窗（横轴时间轴）：viewSec = 0 表示「适配整首」 */
    viewSec: 0,         // 可见时长（秒）
    viewStart: 0,       // 视窗左边缘（音频秒）
    playClock: null,    // 播放时钟 { ctxStart, startSec }
    playSec: null,      // 当前播放头位置（音频秒，无播放时为 null）
    raf: 0
  };

  /* ================= DOM ================= */

  function init() {
    if (els.root) return true;
    els.root = document.getElementById('stageImport');
    if (!els.root) return false;

    els.file = document.getElementById('imFile');
    els.pick = document.getElementById('imPick');
    els.fileList = document.getElementById('imFiles');
    els.analyzeBtn = document.getElementById('imAnalyze');
    els.status = document.getElementById('imStatus');
    els.progress = document.getElementById('imProgress');
    els.progressFill = document.getElementById('imProgressFill');
    els.canvas = document.getElementById('imCanvas');
    els.zoomIn = document.getElementById('imZoomIn');
    els.zoomOut = document.getElementById('imZoomOut');
    els.fit = document.getElementById('imFit');
    els.zoomLabel = document.getElementById('imZoomLabel');
    els.params = document.getElementById('imParams');
    els.bpm = document.getElementById('imBpm');
    els.sig = document.getElementById('imSig');
    els.grid = document.getElementById('imGrid');
    els.mul2 = document.getElementById('imMul2');
    els.div2 = document.getElementById('imDiv2');
    els.conf = document.getElementById('imConf');
    els.counts = document.getElementById('imCounts');
    els.log = document.getElementById('imLog');
    els.playStem = document.getElementById('imPlayStem');
    els.playChart = document.getElementById('imPlayChart');
    els.write = document.getElementById('imWrite');
    els.exportBtn = document.getElementById('imExport');
    els.clearBtn = document.getElementById('imClear');

    els.file.addEventListener('change', function () {
      addFiles(Array.prototype.slice.call(els.file.files || []));
      els.file.value = '';
    });
    bindDrop();
    els.analyzeBtn.addEventListener('click', function () { analyzeNow(); });
    els.clearBtn.addEventListener('click', clearAll);
    els.playStem.addEventListener('click', function () { toggleStem(); });
    els.playChart.addEventListener('click', function () { toggleChart(); });
    els.write.addEventListener('click', writeToArranger);
    els.exportBtn.addEventListener('click', exportJSON);

    // 参数一改，只重排网格（不重跑分析）：立刻能看到谱面变化
    els.bpm.addEventListener('change', rebuildFromParams);
    els.sig.addEventListener('change', rebuildFromParams);
    els.grid.addEventListener('change', rebuildFromParams);
    els.mul2.addEventListener('click', function () { scaleTempo(2); });
    els.div2.addEventListener('click', function () { scaleTempo(0.5); });

    els.canvas.addEventListener('click', function (e) {
      if (!state.result) return;
      var r = els.canvas.getBoundingClientRect();
      var t = secAtX(e.clientX - r.left, r.width);
      var res = state.result;
      var beat = (t - chartZeroSec(res)) / res.spb;
      state.selectedBar = U.clamp(Math.floor(beat / res.barBeats), 0, res.lengthBars - 1);
      draw();
    });

    /* 横轴缩放：按钮 + Ctrl/⌘+滚轮（以光标为锚点）+ Shift+滚轮平移 */
    if (els.zoomIn) els.zoomIn.addEventListener('click', function () { zoomView(1.3); });
    if (els.zoomOut) els.zoomOut.addEventListener('click', function () { zoomView(1 / 1.3); });
    if (els.fit) els.fit.addEventListener('click', function () { state.viewSec = 0; state.viewStart = 0; syncZoomLabel(); draw(); });
    els.canvas.addEventListener('wheel', function (e) {
      if (!state.result) return;
      var r = els.canvas.getBoundingClientRect();
      var x = e.clientX - r.left;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoomView(e.deltaY > 0 ? 1 / 1.15 : 1.15, x, r.width);
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        var dir = (e.deltaY > 0 || e.deltaX > 0) ? 1 : -1;
        state.viewStart += dir * viewSpanSec() * 0.12;
        clampView(); draw();
      }
    }, { passive: false });

    if (global.ResizeObserver) {
      new ResizeObserver(function () { clampView(); draw(); }).observe(els.canvas);
    }
    setEnabled(false);
    log('先把音频拖/选进来：一个分轨文件生成一条音轨（鼓/贝斯/人声/钢琴/吉他/其他各自独立）；只给整首混音时只能出鼓谱');
    return true;
  }

  function log(msg) {
    if (!els.log) return;
    var line = document.createElement('div');
    line.className = 'im-log-line';
    line.textContent = msg;
    els.log.appendChild(line);
    while (els.log.children.length > 8) els.log.removeChild(els.log.firstChild);
  }

  function setStatus(msg, cls) {
    if (!els.status) return;
    els.status.textContent = msg || '—';
    els.status.className = 'mini-hint' + (cls ? ' ' + cls : '');
  }

  function setProgress(p, label) {
    if (!els.progress) return;
    if (p === null) {
      /* ⚠️ 收尾必须把状态文字一起复位。
         以前只 add('hide') 隐藏进度条，状态行永远停在最后一条
         「量化 MIDI … 30%」—— 分析其实早就成功了，看起来却像卡死在 30%。 */
      els.progress.classList.add('hide');
      if (els.status && /…\s*\d+%$/.test(els.status.textContent || '')) setStatus('就绪');
      return;
    }
    els.progress.classList.remove('hide');
    els.progressFill.style.width = Math.round(U.clamp(p, 0, 1) * 100) + '%';
    if (label) setStatus(label + ' … ' + Math.round(p * 100) + '%');
  }

  /** 网格 → 可读标签（三连音不是「1/N」，别用 4/grid 硬算） */
  function gridLabel(g) {
    if (BS.midi && BS.midi.gridLabel) return BS.midi.gridLabel(g);
    return '1/' + Math.round(4 / g);
  }

  /** 用户在下拉里选的网格 → 归一化（0.333333 这种字符串要还原成 1/3） */
  function normalizeGrid(v) {
    var g = parseFloat(v);
    if (!(g > 0)) return 0.25;
    var cands = [0.5, 1 / 3, 0.25, 1 / 6, 0.125];
    for (var i = 0; i < cands.length; i++) {
      if (Math.abs(cands[i] - g) < 0.01) return cands[i];
    }
    return g;
  }

  /** MIDI 自带的速度/拍号（多文件时取出现最多的速度、第一个拍号） */
  function midiMeta() {
    var bpms = {}, meter = null;
    state.midiFiles.forEach(function (mf) {
      var v = mf.bpmDominant || mf.bpm;
      if (v > 0) {
        var k = (Math.round(v * 10) / 10).toFixed(1);
        bpms[k] = (bpms[k] || 0) + 1;
      }
      if (!meter && mf.meter && mf.meter.num) meter = mf.meter;
    });
    var keys = Object.keys(bpms).sort(function (a, b) { return bpms[b] - bpms[a]; });
    return { bpm: keys.length ? parseFloat(keys[0]) : 0, meter: meter, allBpms: keys };
  }

  function setEnabled(on) {
    [els.analyzeBtn, els.playStem, els.playChart, els.write, els.exportBtn].forEach(function (b) {
      if (b) b.disabled = !on;
    });
    if (els.params) els.params.classList.toggle('disabled', !on);
  }

  /* ================= 拖拽导入 ================= */

  /** 拖的东西里有没有文件（拖选中的文字/片段不算） */
  function hasFiles(e) {
    var dt = e.dataTransfer;
    if (!dt) return false;
    if (dt.types) {
      for (var i = 0; i < dt.types.length; i++) if (dt.types[i] === 'Files') return true;
    }
    return false;
  }

  function filesOf(e) {
    var out = [];
    var list = e.dataTransfer && e.dataTransfer.files;
    for (var i = 0; list && i < list.length; i++) out.push(list[i]);
    return out;
  }

  /**
   * 整页接收拖拽：音乐文件拖到窗口任意位置都能用 —— 不在导入页就自动切过来。
   * 只在「有文件」时接管，其他拖拽（选中的音符、时间轴片段）一律不干扰。
   */
  function bindDrop() {
    var root = els.root;
    var timer = null;
    var over = function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      root.classList.add('dragover');
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () { root.classList.remove('dragover'); }, 1200);
    };
    var drop = function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (timer) clearTimeout(timer);
      root.classList.remove('dragover');
      var files = filesOf(e);
      if (!files.length) return;
      var tab = document.querySelector('.stage-tab[data-stage="import"]');
      if (tab && !root.classList.contains('active')) tab.click();
      init();
      addFiles(files);
    };
    document.addEventListener('dragover', over);
    document.addEventListener('drop', drop);
    // 拖出窗口时清掉高亮
    document.addEventListener('dragleave', function (e) {
      if (timer) clearTimeout(timer);
      if (!e.relatedTarget) root.classList.remove('dragover');
    });
  }

  /* ================= 导入 ================= */

  function guessRole(name) {
    for (var i = 0; i < ROLE_DEFS.length; i++) {
      if (ROLE_DEFS[i].kw.test(name)) return ROLE_DEFS[i].id;
    }
    return null;
  }

  function addFiles(files) {
    if (!files.length) return;
    if (!App.ctx) { toastWarn('请先点击页面任意处启动音频引擎'); return; }
    // MIDI / CSV（外部转写工具产物）不进音频解码链：单独解析成「轨」
    var midis = files.filter(function (f) { return /\.midi?$/i.test(f.name); });
    var csvs = files.filter(function (f) { return /\.csv$/i.test(f.name); });
    var audios = files.filter(function (f) { return !/\.(midi?|csv)$/i.test(f.name); });
    state.files = state.files.concat(audios.map(function (f) {
      return { file: f, name: f.name, role: guessRole(f.name), buffer: null, duration: 0 };
    }));
    // 只有一个文件 → 当整首混音；多文件里没猜出角色的，默认「其他」
    if (state.files.length === 1) state.files[0].role = state.files[0].role || 'mixed';
    state.files.forEach(function (it) {
      if (!it.role) it.role = state.files.length === 1 ? 'mixed' : 'other';
    });
    if (midis.length) parseMidiFiles(midis);
    // Basic Pitch 会同时输出 .mid 和 .csv：同名的 CSV 直接跳过（MIDI 信息更全）
    var midiBases = {};
    midis.forEach(function (f) { midiBases[stripExt(f.name).toLowerCase()] = 1; });
    var csvOnly = csvs.filter(function (f) { return !midiBases[stripExt(f.name).toLowerCase()]; });
    csvs.filter(function (f) { return midiBases[stripExt(f.name).toLowerCase()]; }).forEach(function (f) {
      log('跳过 ' + f.name + '：已有同名 .mid（内容一致，避免重复出轨）');
    });
    if (csvOnly.length) parseCsvFiles(csvOnly);
    renderFileList();
    decodeAll();
  }

  /* 音符文件（.mid/.csv）的角色/音色：按文件名猜，和音频分轨同一套关键词 */
  var NOTE_TONE = {
    drums: 'drumkit', bass: 'bass', vocals: 'vocalAh', piano: 'piano',
    guitar: 'acousticGuitar', other: 'warmPad', mixed: 'warmPad'
  };
  var NOTE_ROLE = { drums: 'drum', bass: 'bass' };
  function noteFileRole(name) {
    var role = guessRole(name) || 'other';
    return {
      role: NOTE_ROLE[role] || 'synth',
      toneId: NOTE_TONE[role] || 'warmPad',
      label: (ROLE_LABEL[role] || '其他'),
      guessed: role
    };
  }

  /** 「孙燕姿 - 我不难过_人声_basic_pitch」→「孙燕姿 - 我不难过_人声」 */
  function shortStemName(name) {
    return stripExt(name).replace(/[ _-](basic[ _-]?pitch|bp)$/i, '');
  }

  /** MIDI 文件 → 解析成轨（P1：外部转写工具产物，按本曲网格量化） */
  function parseMidiFiles(midis) {
    if (!BS.midi) { toastWarn('MIDI 解析模块未加载'); return; }
    setStatus('解析 MIDI 中 …');
    var chain = Promise.resolve();
    midis.forEach(function (f) {
      chain = chain.then(function () {
        return readArrayBuffer(f).then(function (ab) {
          var hint = noteFileRole(f.name);
          var base = shortStemName(f.name);
          var parsed = null;
          try {
            parsed = BS.midi.parse(ab, {
              name: base, role: hint.role, toneId: hint.toneId, label: hint.label
            });
          } catch (e) { parsed = null; }
          if (!parsed) { log('MIDI 解析失败：' + f.name); return; }
          var tracks = parsed.tracks.filter(function (t) { return t.notes.length; });
          if (!tracks.length) { log('MIDI 里没有音符：' + f.name); return; }
          // 单轨文件不必加序号，多轨文件用「文件名 · 轨名」区分
          var solo = tracks.length === 1;
          state.midiFiles.push({
            name: f.name,
            bpm: parsed.bpm,                       // 起始速度（音符秒值按它换算）
            bpmDominant: parsed.bpmDominant || parsed.bpm,
            tempoCount: parsed.tempoCount || 1,
            meter: parsed.meter || { num: 4, den: 4 },
            durationSec: parsed.durationSec,
            tracks: tracks.map(function (t) {
              return {
                name: solo ? base : (base + ' · ' + t.name),
                role: t.role, toneId: t.toneId, label: t.label, guessed: hint.guessed,
                notes: t.notes
              };
            })
          });
          var extra = tracks.length === 1 && tracks[0].mergedFrom
            ? '（模型按音高分了 ' + tracks[0].mergedFrom + ' 个通道，已合并）' : '';
          log('MIDI 已解析：' + f.name + ' → ' + tracks.length + ' 轨 · ' +
            tracks[0].notes.length + ' 音 · ' + Math.round(parsed.durationSec) + 's' + extra);
        }).catch(function (err) {
          log('MIDI 读取失败：' + f.name + '（' + (err && err.message ? err.message : err) + '）');
        });
      });
    });
    chain.then(function () {
      syncBuffers();
      renderFileList();
      if (state.stems.length) setEnabled(true);
    });
  }

  /** Basic Pitch 的 CSV（start,end,midi,velocity,pitch_bend…）→ 一条轨 */
  function parseCsvFiles(csvs) {
    setStatus('解析 CSV 中 …');
    var chain = Promise.resolve();
    csvs.forEach(function (f) {
      chain = chain.then(function () {
        return readTextFile(f).then(function (text) {
          var hint = noteFileRole(f.name);
          var lines = String(text).split(/\r?\n/);
          var notes = [];
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line || /^[a-z_]/i.test(line)) continue;      // 表头
            var c = line.split(',');
            var t0 = parseFloat(c[0]), t1 = parseFloat(c[1]), midi = parseFloat(c[2]);
            if (!isFinite(t0) || !isFinite(t1) || !isFinite(midi)) continue;
            var vel = c.length > 3 ? parseFloat(c[3]) : 80;
            notes.push({
              t: t0, dur: Math.max(0.02, t1 - t0), pitch: Math.round(midi),
              vel: Math.round(Math.min(1, (isFinite(vel) ? vel : 80) / 100) * 100) / 100
            });
          }
          if (!notes.length) { log('CSV 里没有音符：' + f.name); return; }
          notes.sort(function (a, b) { return a.t - b.t; });
          var end = notes.reduce(function (a, n) { return Math.max(a, n.t + n.dur); }, 0);
          state.midiFiles.push({
            name: f.name,
            bpm: 0,
            durationSec: end,
            tracks: [{
              name: shortStemName(f.name), role: hint.role, toneId: hint.toneId,
              label: hint.label, guessed: hint.guessed, notes: notes
            }]
          });
          log('CSV 已解析：' + f.name + ' → 1 轨 · ' + notes.length + ' 音 · ' +
            Math.round(end) + 's（CSV 不带速度，MIDI-only 时按 120 BPM）');
        }).catch(function (err) {
          log('CSV 读取失败：' + f.name + '（' + (err && err.message ? err.message : err) + '）');
        });
      });
    });
    chain.then(function () {
      syncBuffers();
      renderFileList();
      if (state.stems.length) setEnabled(true);
    });
  }

  function readArrayBuffer(file) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(fr.result); };
      fr.onerror = function () { rej(fr.error || new Error('读取失败')); };
      fr.readAsArrayBuffer(file);
    });
  }

  function readTextFile(file) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(fr.result); };
      fr.onerror = function () { rej(fr.error || new Error('读取失败')); };
      fr.readAsText(file);
    });
  }

  function decodeAll() {
    var pending = state.files.filter(function (f) { return !f.buffer; });
    if (!pending.length) { syncBuffers(); return; }
    setStatus('解码中 …');
    var chain = Promise.resolve();
    pending.forEach(function (it) {
      chain = chain.then(function () {
        return BS.loader.decodeFile(App.ctx, it.file).then(function (buf) {
          it.buffer = buf;
          it.duration = buf.duration;
        }).catch(function (err) {
          it.error = err.message || '解码失败';
          log('解码失败：' + it.name + '（' + it.error + '）');
        });
      });
    });
    chain.then(function () {
      renderFileList();
      syncBuffers();
      var ok = state.files.filter(function (f) { return f.buffer; });
      setStatus(ok.length ? ('已就绪 ' + ok.length + ' 个文件 · 点「开始分析」') : '没有可用的音频', ok.length ? 'ok' : 'warn');
      if (ok.length) setEnabled(true);
    });
  }

  function syncBuffers() {
    state.drumsBuf = null;
    state.mixedBuf = null;
    state.bassBuf = null;
    state.harmonicBufs = [];
    state.stems = [];
    state.files.forEach(function (f) {
      if (!f.buffer) return;
      if (f.role === 'drums' && !state.drumsBuf) state.drumsBuf = f.buffer;
      if (f.role === 'bass' && !state.bassBuf) state.bassBuf = f.buffer;
      if (f.role === 'mixed' && !state.mixedBuf) state.mixedBuf = f.buffer;
      if (f.role === 'piano' || f.role === 'guitar' || f.role === 'other') {
        state.harmonicBufs.push(f.buffer);
      }
      // 一个分轨文件 = 一条音轨；「整首混音」只是音频源，不当分轨（否则会跟真分轨重复）
      if (f.role && f.role !== 'mixed') {
        state.stems.push({ role: f.role, name: f.name, buffer: f.buffer });
      }
    });
    // MIDI 分轨（P1）：外部转写工具的产物，一个 MIDI 轨一条音轨
    state.midiFiles.forEach(function (mf) {
      mf.tracks.forEach(function (t) {
        state.stems.push({
          role: 'midi', name: t.name,
          midi: { notes: t.notes, role: t.role, toneId: t.toneId, label: t.label }
        });
      });
    });
    // 有鼓轨用鼓轨；没有鼓轨但有混音用混音；都没有就拿第一个文件凑合
    if (!state.drumsBuf && !state.mixedBuf && !state.bassBuf) {
      var first = state.files.filter(function (f) { return f.buffer; })[0];
      if (first) state.mixedBuf = first.buffer;
    }
  }

  /** 分轨角色 → 音轨名（同名分轨自动加序号，保证一文件一轨不会互相覆盖） */
  var STEM_TRACK_NAME = {
    drums: '鼓组', bass: '贝斯', vocals: '人声',
    piano: '钢琴', guitar: '吉他', other: '其他'
  };

  function labeledStems() {
    var used = {};
    var out = [];
    state.stems.forEach(function (s) {
      // MIDI 轨沿用解析出的轨名（可能就是「钢琴」「主旋律」），不套角色模板
      if (s.role === 'midi') {
        if (!s.midi) return;
        out.push({ role: 'midi', name: s.name, midi: s.midi });
        return;
      }
      var base = STEM_TRACK_NAME[s.role];
      if (!base || !s.buffer) return;
      used[base] = (used[base] || 0) + 1;
      out.push({
        role: s.role,
        name: used[base] > 1 ? base + ' ' + used[base] : base,
        buffer: s.buffer
      });
    });
    return out;
  }

  function renderFileList() {
    if (!els.fileList) return;
    els.fileList.innerHTML = '';
    state.files.forEach(function (it, i) {
      var row = document.createElement('div');
      row.className = 'im-file' + (it.buffer ? '' : ' pending') + (it.error ? ' bad' : '');

      var name = document.createElement('span');
      name.className = 'im-fname';
      name.textContent = it.name;
      name.title = it.name;
      row.appendChild(name);

      var sel = document.createElement('select');
      sel.className = 'sel im-frole';
      ['drums', 'bass', 'vocals', 'piano', 'guitar', 'other', 'mixed'].forEach(function (r) {
        var op = document.createElement('option');
        op.value = r;
        op.textContent = ROLE_LABEL[r];
        sel.appendChild(op);
      });
      sel.value = it.role;
      sel.addEventListener('change', function () {
        it.role = sel.value;
        // 混音只能有一个：改成混音时把别的混音降级成「其他」
        if (it.role === 'mixed') {
          state.files.forEach(function (x) { if (x !== it && x.role === 'mixed') x.role = 'other'; });
        }
        syncBuffers();
        renderFileList();
      });
      row.appendChild(sel);

      var dur = document.createElement('span');
      dur.className = 'im-fdur';
      dur.textContent = it.error ? '解码失败' : (it.buffer ? fmtDur(it.duration) : '解码中');
      row.appendChild(dur);

      var del = document.createElement('button');
      del.className = 'im-fdel';
      del.textContent = '✕';
      del.title = '移除';
      del.addEventListener('click', function () {
        state.files.splice(i, 1);
        syncBuffers();
        renderFileList();
        if (!state.files.length) { setEnabled(false); setStatus('—'); }
      });
      row.appendChild(del);
      els.fileList.appendChild(row);
    });

    // MIDI 文件（P1）：一条 MIDI 轨 = 一条音轨，展示轨名/音色/音数
    state.midiFiles.forEach(function (mf, mi) {
      mf.tracks.forEach(function (t, ti) {
        var row = document.createElement('div');
        row.className = 'im-file';

        var name = document.createElement('span');
        name.className = 'im-fname';
        name.textContent = (mf.tracks.length > 1 ? mf.name + ' · ' : '') + t.name;
        name.title = mf.name + ' → ' + t.name;
        row.appendChild(name);

        var role = document.createElement('span');
        role.className = 'im-fdur';
        role.textContent = (t.label || 'MIDI') + ' · ' + t.notes.length + ' 音';
        row.appendChild(role);

        var del = document.createElement('button');
        del.className = 'im-fdel';
        del.textContent = '✕';
        del.title = '移除';
        del.addEventListener('click', function () {
          mf.tracks.splice(ti, 1);
          if (!mf.tracks.length) state.midiFiles.splice(mi, 1);
          syncBuffers();
          renderFileList();
          if (!state.files.length && !state.midiFiles.length) { setEnabled(false); setStatus('—'); }
        });
        row.appendChild(del);
        els.fileList.appendChild(row);
      });
    });
  }

  function fmtDur(sec) {
    sec = Math.max(0, sec || 0);
    var m = Math.floor(sec / 60), s = Math.round(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function clearAll() {
    stopPlayback();
    state.files = [];
    state.result = null;
    state.drumsBuf = state.mixedBuf = state.bassBuf = null;
    state.harmonicBufs = [];
    state.stems = [];
    state.midiFiles = [];
    state.viewSec = 0;
    state.viewStart = 0;
    syncZoomLabel();
    if (els.fileList) els.fileList.innerHTML = '';
    if (els.conf) els.conf.innerHTML = '<span class="im-empty">还没有分析结果</span>';
    if (els.counts) els.counts.innerHTML = '';
    setEnabled(false);
    setStatus('—');
    setProgress(null);
    draw();
  }

  /* ================= 分析 ================= */

  function analyzeNow() {
    if (state.busy) return;
    syncBuffers();
    var drumSrc = state.drumsBuf || state.mixedBuf;
    var midiStems = labeledStems().filter(function (s) { return s.role === 'midi'; });
    if (!drumSrc) {
      // 只有 MIDI（没有音频）：用 MIDI 自带的速度直接建网格，不走音频分析
      if (midiStems.length) { analyzeMidiOnly(midiStems); return; }
      toastWarn(state.bassBuf || state.harmonicBufs.length
        ? '还需要鼓轨（或整首混音）来确定节拍网格'
        : '先导入音频');
      return;
    }

    stopPlayback();
    state.busy = true;
    setEnabled(false);
    setProgress(0, '准备');
    var t0 = performance.now();
    var src = {
      name: state.files.length === 1 ? stripExt(state.files[0].name) : '导入成谱',
      mixed: state.mixedBuf,
      drums: state.drumsBuf,
      // 分轨清单：一个文件一条轨（含人声），分析层按这个生成 tracks[]
      stems: labeledStems()
    };
    var params = { name: src.name };

    BS.analysis.analyze(src, params, function (p, label) { setProgress(p, label); })
      .then(function (res) {
        state.result = res;
        state.files.forEach(function (f) {
          if (f.buffer && (f.role === 'drums')) res.stemName = f.name;
        });
        applyResultToUI(res);
        /* MIDI 与音频同时导入时：MIDI 的速度/拍号是「真值」，
           音频估计常带零点几 BPM 的尾差（99.7 / 100.3），以 MIDI 为准。 */
        applyMidiTempoOverride(res);
        var ms = Math.round(performance.now() - t0);
        var trackTxt = (res.song ? res.song.tracks : []).map(function (t) {
          return t.name + ' ' + t.notes.length;
        }).join(' · ');
        log('分析完成：' + (trackTxt || (res.hits.length + ' 个鼓点')) +
            (res.chords.length ? ' · ' + res.chords.length + ' 个和弦' : '') +
            ' · ' + res.lengthBars + ' 小节 · ' + fmtDur(res.durationSec) +
            ' 素材 · 用时 ' + (ms / 1000).toFixed(1) + 's');
        if (res.key) log('调性估计：' + res.key.root + (res.key.mode === 'major' ? ' 大调' : ' 小调'));
        // MIDI 与音频分轨同一乐器时提示一下：内容是重复的，留哪条自己定
        var dupes = {};
        state.midiFiles.forEach(function (mf) {
          mf.tracks.forEach(function (t) {
            if (t.guessed && state.files.some(function (f) { return f.role === t.guessed; })) dupes[t.guessed] = 1;
          });
        });
        var dupeList = Object.keys(dupes).map(function (r) { return ROLE_LABEL[r] || r; });
        if (dupeList.length) {
          log('提示：MIDI 与音频分轨「' + dupeList.join('、') +
            '」是同一乐器的两份转写，内容重复 —— 留精度高的那条，另一条可删');
        }
        if (!state.stems.length) {
          log('提示：只导入了整首混音，只出鼓谱；导入分轨（鼓/贝斯/人声/钢琴/吉他/其他）才会一个文件一条轨');
        } else if (!state.stems.filter(function (s) { return s.role === 'vocals'; }).length) {
          log('提示：没导入人声分轨，人声轨为空（人声不会并进和声轨）');
        }
        if (res.source === 'mixed') {
          log('提示：用的是整首混音，鼓/贝斯的低频与人声会互相干扰，建议先分轨再导入');
        }
        if (res.confidence.ambiguousTempo) {
          log('提示：速度存在半速/倍速歧义，听一下「试听谱面」，不对就点 ×2 / ÷2');
        }
        setProgress(null);
        setStatus('分析完成 · ' + res.bpm + ' BPM · ' + res.meter.num + '/4 · ' + gridLabel(res.grid), 'ok');
        setEnabled(true);
      })
      .catch(function (err) {
        console.error(err);
        setProgress(null);
        setEnabled(true);
        setStatus('分析失败', 'warn');
        log('分析失败：' + (err && err.message ? err.message : err));
      })
      .then(function () { state.busy = false; });
  }

  /**
   * 音频分析完成后，用 MIDI 自带的速度/拍号校正结果。
   * 只改「速度/拍号」这两个标注，不动秒级真值（hits 的 t），
   * 所以走 rebuildFromParams 重排网格是安全的：拍位变了，音还是那些音。
   */
  function applyMidiTempoOverride(res) {
    if (!res || res.source === 'midi') return;
    var meta = midiMeta();
    if (!(meta.bpm > 0)) return;
    if (!(res.midiTracks && res.midiTracks.length)) return;   // 没有 MIDI 音符轨就别听它的

    var changed = false;
    var rel = Math.abs(res.bpm - meta.bpm) / meta.bpm;
    if (rel < 0.01 && Math.abs(res.bpm - meta.bpm) > 0.05) {
      log('速度以 MIDI 为准：' + meta.bpm + ' BPM（音频估计 ' + res.bpm.toFixed(1) + '）');
      if (els.bpm) els.bpm.value = String(meta.bpm);
      changed = true;
    } else if (rel > 0.05) {
      log('提示：MIDI 是 ' + meta.bpm + ' BPM，音频估计 ' + res.bpm.toFixed(1) +
        ' BPM，差太多（拍点可能对不上）。可试 ×2 / ÷2，或手动填 MIDI 的速度');
    }
    if (meta.meter && meta.meter.num) {
      var bb = Math.max(1, Math.round(meta.meter.num * 4 / (meta.meter.den || 4)));
      if (bb !== res.meter.num) {
        log('拍号以 MIDI 为准：' + meta.meter.num + '/' + (meta.meter.den || 4) +
          '（音频估计 ' + res.meter.num + '/4）');
        setSelectValue(els.sig, bb, bb + '/4');
        changed = true;
      }
    }
    if (changed) rebuildFromParams();
  }

  /**
   * 只导入了 MIDI（没音频）：用 MIDI 自带的速度 / 拍号建网格，并做三件事：
   *   ① 按「同时性」聚类——和弦的几个音不会被拆到相邻格；
   *   ② 自动估计网格（1/8 / 1/16 / 1/32 / 三连音）——不再死写 1/16；
   *   ③ 估全局偏移并整体平移——转写延迟 / 前导空白导致的半格错位会被纠正。
   * 整个过程同步完成，进度条只用来提示「在对齐」。
   */
  function analyzeMidiOnly(midiStems) {
    stopPlayback();
    state.busy = true;
    setEnabled(false);
    setProgress(0.3, '对齐 MIDI');
    try {
      // ---- 1) 速度：MIDI 主导速度（多文件不一致时用出现最多的那个） ----
      var meta = midiMeta();
      var bpm = Math.round((meta.bpm || 120) * 10) / 10;
      var spb = 60 / bpm;
      if (meta.allBpms && meta.allBpms.length > 1) {
        log('提示：几个 MIDI 的速度不一致（' + meta.allBpms.join(' / ') +
          ' BPM），已按 ' + bpm + ' BPM 建网格；不对可在「速度」里改');
      }

      // ---- 2) 拍号：用 MIDI 的拍号 meta（以前一律 4/4） ----
      var meterNum = 4, meterDen = 4, hasMeter = false;
      if (meta.meter && meta.meter.num) {
        meterNum = meta.meter.num;
        meterDen = meta.meter.den || 4;
        hasMeter = true;
      }
      // 本项目一拍 = 四分音符，所以每小节拍数 = 分子 × 4 / 分母（6/8 → 3 拍）
      var barBeats = Math.max(1, Math.round(meterNum * 4 / meterDen));
      if (hasMeter && meterDen !== 4) {
        log('拍号 ' + meterNum + '/' + meterDen + '：本项目以四分音符为一拍，已按每小节 ' +
          barBeats + ' 拍排布');
      }

      // ---- 3) 对齐：聚类 + 自动网格 + 全局偏移 ----
      var lists = midiStems.map(function (s) {
        return (s.midi.notes || []).map(function (n) {
          return { pitch: n.pitch, t: n.t, dur: n.dur, vel: n.vel };
        });
      });
      var align = (BS.midi && BS.midi.alignNotes)
        ? BS.midi.alignNotes(lists, spb)
        : { notes: lists, grid: 0.25, gridLabel: '1/16', biasSec: 0, residualMs: 0, hit: 1, confident: false };
      var grid = align.grid;
      var biasSec = align.biasSec || 0;

      // ---- 4) 量化成拍位（量化用对齐后的时刻，rawNotes 保留原始秒值供改 BPM 重排） ----
      var midiTracks = midiStems.map(function (s, i) {
        var aligned = (align.notes[i] || []).map(function (n) {
          return { midi: n.pitch, t: n.t, dur: n.dur, rms: n.vel };
        });
        /* ⚠️ 这里 biasSec 必须传 0：aligned 的 t 已经被整体平移过了，
           再减一次 biasSec 会变成「双重平移」（第一个音会被拉到负拍丢掉）。 */
        var notes = BS.analysis.polyTrackNotes(aligned, 0, 0, spb, grid);
        var raw = (s.midi.notes || []).map(function (n) {
          return { pitch: n.pitch, t: n.t, dur: n.dur, vel: n.vel };
        });
        return {
          name: s.name || ('MIDI ' + (i + 1)),
          role: s.midi.role || 'synth',
          toneId: s.midi.toneId || null,
          notes: notes,
          rawNotes: raw            // 秒级真值（未平移），改 BPM 时重排用
        };
      }).filter(function (t) { return t.notes.length; });

      var endBeat = 0;
      midiTracks.forEach(function (t) {
        t.notes.forEach(function (n) { endBeat = Math.max(endBeat, n.beat + n.len); });
      });
      var lengthBars = Math.max(1, Math.ceil(endBeat / barBeats));
      var gridMs = grid * spb * 1000;
      var alignConf = U.clamp(1 - (align.residualMs || 0) / Math.max(1, gridMs * 0.5), 0, 1);
      var meterConf = hasMeter ? 1 : 0.5;

      var res = {
        bpm: bpm, spb: spb, meter: { num: barBeats, den: 4, phase: 0 },
        barBeats: barBeats, grid: grid, lengthBars: lengthBars,
        totalBeats: endBeat, hits: [], song: null, counts: {},
        bass: null, bassNotes: [], chords: [], chordSegs: [], key: null, padNotes: [],
        source: 'midi', onsets: 0,
        durationSec: endBeat * spb + Math.max(0, biasSec),
        vocalTracks: [], harmonicTracks: [], midiTracks: midiTracks,
        /* 对齐诊断：界面上要能看出「凭什么这样量化」 */
        midiAlign: {
          gridLabel: align.gridLabel || gridLabel(grid),
          biasMs: Math.round(biasSec * 1000),
          residualMs: Math.round(align.residualMs || 0),
          hit: align.hit,
          confident: !!align.confident,
          meter: meterNum + '/' + meterDen,
          tempoCount: Math.max.apply(null, [1].concat(state.midiFiles.map(function (f) {
            return f.tempoCount || 1;
          })))
        },
        confidence: {
          overall: U.clamp(0.34 * 1 + 0.22 * meterConf + 0.30 * alignConf + 0.14 * 0, 0, 1),
          tempo: 1, meter: meterConf, align: alignConf, classes: 0, chords: 0, bass: 0,
          residualMs: align.residualMs || 0, gridMs: gridMs, ambiguousTempo: false
        },
        barScores: [], biasSec: biasSec, phaseBeats: 0, beatTimes: [], peaks: []
      };

      res.song = buildSong(res);
      state.result = res;
      applyResultToUI(res);
      log('MIDI 导入：' + midiTracks.length + ' 轨 · ' + bpm + ' BPM · ' + meterNum + '/' + meterDen +
        ' · 网格 ' + gridLabel(grid) +
        (biasSec ? '（整体平移 ' + Math.round(biasSec * 1000) + 'ms 对齐）' : '') +
        ' · ' + lengthBars + ' 小节' +
        (align.hit >= 0.7 ? '' :
          '（只有 ' + Math.round(align.hit * 100) + '% 的音符贴网格，节奏可能有偏差）'));
      if (res.midiAlign.tempoCount > 1) {
        log('注意：MIDI 里有 ' + res.midiAlign.tempoCount + ' 段速度变化，已按主导 ' +
          bpm + ' BPM 建网格；真正变速的曲子后半段拍位会偏，可分段处理');
      }
      setProgress(null);
      setStatus('已就绪 · ' + bpm + ' BPM · ' + barBeats + '/4 · ' + gridLabel(grid), 'ok');
      setEnabled(true);
    } catch (err) {
      /* ⚠️ 以前这里没有 try/catch：一旦抛错，self.busy 永远是 true、
         进度条永远停在 30%，再点「开始分析」直接被 busy 挡掉 —— 只能刷新页面。 */
      console.error(err);
      setProgress(null);
      setStatus('分析失败', 'warn');
      log('分析失败：' + (err && err.message ? err.message : err));
      setEnabled(true);
    } finally {
      state.busy = false;
    }
  }

  /** 把 select 设为「数值最接近的那个选项」；没有对应选项就补一个（如 5/4、三连音网格） */
  function setSelectValue(sel, value, labelText) {
    if (!sel) return;
    var best = null, bestD = Infinity;
    for (var i = 0; i < sel.options.length; i++) {
      var d = Math.abs(parseFloat(sel.options[i].value) - value);
      if (d < bestD) { bestD = d; best = sel.options[i]; }
    }
    if (best && bestD < 1e-3) { sel.value = best.value; return; }
    if (!labelText) return;
    var op = document.createElement('option');
    op.value = String(value);
    op.textContent = labelText;
    sel.appendChild(op);
    sel.value = op.value;
  }

  function applyResultToUI(res) {
    if (els.bpm) els.bpm.value = String(res.bpm);
    setSelectValue(els.sig, res.meter.num, res.meter.num + '/4');
    setSelectValue(els.grid, res.grid, gridLabel(res.grid));
    // 新结果先回到「适配整首」，缩放状态不跨素材继承
    state.viewSec = 0;
    state.viewStart = 0;
    syncZoomLabel();
    renderConfidence(res);
    draw();
  }

  function renderConfidence(res) {
    if (!els.conf) return;
    var c = res.confidence;
    var pct = function (v) { return Math.round(U.clamp(v, 0, 1) * 100) + '%'; };
    var tone = c.overall >= 0.75 ? 'good' : (c.overall >= 0.5 ? 'ok' : 'bad');
    var rows = confRow('速度', c.tempo) + confRow('拍号', c.meter) +
      confRow('网格对齐', c.align) + confRow('鼓分类', c.classes);
    if (res.bassNotes && res.bassNotes.length) rows += confRow('贝斯音高', c.bass);
    if (res.chords && res.chords.length) rows += confRow('和弦', c.chords);

    var keyTxt = res.key
      ? ('调性 ' + res.key.root + (res.key.mode === 'major' ? ' 大调' : ' 小调'))
      : '';
    var extra = (keyTxt ? keyTxt + ' · ' : '') + '节拍残差 ' + c.residualMs.toFixed(0) + 'ms';
    if (res.midiAlign) {
      extra += ' · 网格 ' + res.midiAlign.gridLabel;
      if (res.midiAlign.biasMs) extra += ' · 平移 ' + res.midiAlign.biasMs + 'ms';
      if (res.midiAlign.meter) extra += ' · MIDI ' + res.midiAlign.meter;
    }
    els.conf.innerHTML =
      '<div class="im-conf-main ' + tone + '">' +
        '<b>' + pct(c.overall) + '</b><span>整体置信度</span>' +
      '</div>' +
      '<div class="im-conf-rows">' + rows +
        '<div class="im-conf-extra">' + extra + '</div>' +
      '</div>';

    if (els.counts) {
      var order = ['kick', 'snare', 'hihatClosed', 'hihatOpen', 'tomLow', 'tomMid', 'tomHigh', 'crash', 'ride'];
      var chips = order.filter(function (id) { return res.counts[id]; }).map(function (id) {
        return '<span class="im-chip">' + (BS.analysis.DRUM_LABEL[id] || id) +
          ' <b>' + res.counts[id] + '</b></span>';
      });
      // 逐轨音数：一眼看出「一个文件一条轨」（人声独立显示）
      var songTracks = (res.song && res.song.tracks) || [];
      songTracks.slice(1).forEach(function (t) {
        if (!t.notes || !t.notes.length) return;
        chips.push('<span class="im-chip">' + t.name + ' <b>' + t.notes.length + '</b></span>');
      });
      if (res.chords && res.chords.length) {
        chips.push('<span class="im-chip">和弦 <b>' + res.chords.length + '</b></span>');
      }
      els.counts.innerHTML = chips.join('') || '<span class="im-empty">没有识别到内容</span>';
    }
  }

  function confRow(label, v) {
    var pct = Math.round(U.clamp(v, 0, 1) * 100);
    var cls = v >= 0.7 ? 'good' : (v >= 0.45 ? 'ok' : 'bad');
    return '<div class="im-conf-row"><span>' + label + '</span>' +
      '<i class="im-bar ' + cls + '"><em style="width:' + pct + '%"></em></i>' +
      '<b>' + pct + '%</b></div>';
  }

  /* ================= 参数 → 重排网格 ================= */

  function scaleTempo(f) {
    if (!state.result) return;
    var bpm = Math.round(state.result.bpm * f * 10) / 10;
    if (bpm < 20 || bpm > 400) return;
    if (els.bpm) els.bpm.value = String(bpm);
    rebuildFromParams();
  }

  function rebuildFromParams() {
    if (!state.result) return;
    var res = state.result;
    var bpm = parseFloat(els.bpm.value) || res.bpm;
    bpm = U.clamp(bpm, 20, 400);
    var num = parseInt(els.sig.value, 10) || res.meter.num;
    var grid = normalizeGrid(els.grid.value) || res.grid;

    // 起音时刻（秒）是分析出来的真值，改速度/网格只重算拍位，不用重跑 FFT
    var spb = 60 / bpm;
    var bias = res.biasSec || 0, phase = res.phaseBeats || 0;
    var toBeat = function (t) { return Math.max(0, (t - bias) / spb - phase); };
    var hits = res.hits.map(function (h) {
      var beat = toBeat(h.t);
      var q = Math.round(beat / grid) * grid;
      return { t: h.t, beat: beat, gridBeat: q, id: h.id, pitch: h.pitch, vel: h.vel, conf: h.conf };
    });

    // 贝斯 / 人声：同样从秒重算（保住「改 BPM 不丢音」）
    res.bassNotes = requantizeMono(res.bassNotes, toBeat, spb, grid);
    (res.vocalTracks || []).forEach(function (v) {
      v.notes = requantizeMono(v.notes, toBeat, spb, grid);
    });

    // 和弦段：按时间等比缩放（和弦本身不随速度变，变的只是落在第几拍）
    res.chordSegs = requantizeSegs(res.chordSegs, toBeat, grid, res);
    res.chords = BS.analysis.chordsPerBar(res.chordSegs, num);
    res.padNotes = BS.analysis.padNotesFromSegments(res.chordSegs, grid, 1e9);
    // 每个和声分轨各自的和弦段 → 各自一轨的 pad 音符；音符级转写也按秒重算
    (res.harmonicTracks || []).forEach(function (h) {
      h.segs = requantizeSegs(h.segs, toBeat, grid, h);
      h.padNotes = BS.analysis.padNotesFromSegments(h.segs, grid, 1e9);
      if (h.rawNotes) h.notes = requantizePoly(h.rawNotes, toBeat, spb, grid);
    });
    // MIDI 分轨：同样只重算拍位（复音，保留和弦叠放）
    (res.midiTracks || []).forEach(function (m) {
      if (m.rawNotes) m.notes = requantizePoly(m.rawNotes, toBeat, spb, grid);
    });

    var endBeat = hits.reduce(function (a, h) { return Math.max(a, h.gridBeat + grid); }, 0);
    (res.bassNotes || []).forEach(function (n) { endBeat = Math.max(endBeat, n.beat + n.len); });
    (res.vocalTracks || []).forEach(function (v) {
      v.notes.forEach(function (n) { endBeat = Math.max(endBeat, n.beat + n.len); });
    });
    (res.harmonicTracks || []).forEach(function (h) {
      (h.segs || []).forEach(function (s) { endBeat = Math.max(endBeat, s.endBeat); });
      h.notes.forEach(function (n) { endBeat = Math.max(endBeat, n.beat + n.len); });
    });
    (res.midiTracks || []).forEach(function (m) {
      m.notes.forEach(function (n) { endBeat = Math.max(endBeat, n.beat + n.len); });
    });
    (res.chordSegs || []).forEach(function (s) { endBeat = Math.max(endBeat, s.endBeat); });
    var lengthBars = Math.max(1, Math.ceil(endBeat / num));
    var resid = hits.map(function (h) { return Math.abs(h.beat - h.gridBeat) * spb * 1000; });
    var residMed = resid.slice().sort(function (a, b) { return a - b; })[Math.floor(resid.length / 2)] || 0;
    var gridMs = grid * spb * 1000;

    var barScores = [];
    for (var bar = 0; bar < lengthBars; bar++) {
      var b0 = bar * num, b1 = b0 + num;
      var inBar = hits.filter(function (h) { return h.beat >= b0 - 1e-9 && h.beat < b1 - 1e-9; });
      if (!inBar.length) { barScores.push({ bar: bar, score: null, count: 0 }); continue; }
      var r = inBar.map(function (h) { return Math.abs(h.beat - h.gridBeat) * spb * 1000; });
      r.sort(function (a, b) { return a - b; });
      barScores.push({
        bar: bar, count: inBar.length,
        score: U.clamp(1 - r[Math.floor(r.length / 2)] / Math.max(1, gridMs * 0.5), 0, 1)
      });
    }

    res.bpm = bpm;
    res.spb = spb;
    res.meter = { num: num, den: 4, phase: res.meter.phase || 0 };
    res.barBeats = num;
    res.grid = grid;
    res.lengthBars = lengthBars;
    res.hits = hits;
    res.barScores = barScores;
    /* 纯 MIDI 时没有 hits：残差是「音符 onset 相对网格」的值，别被清零 */
    if (hits.length) {
      res.confidence.align = U.clamp(1 - residMed / Math.max(1, gridMs * 0.5), 0, 1);
      res.confidence.residualMs = residMed;
    }
    res.confidence.gridMs = gridMs;
    res.song = buildSong(res);
    if (res.midiAlign) {
      res.midiAlign.gridLabel = gridLabel(grid);
      if (hits.length) res.midiAlign.residualMs = Math.round(residMed);
    }
    renderConfidence(res);
    draw();
    setStatus('已按 ' + bpm + ' BPM · ' + num + '/4 · ' + gridLabel(grid) + ' 重排网格', 'ok');
  }

  /** 秒 → 拍重排（单声部音符：贝斯 / 人声） */
  function requantizeMono(list, toBeat, spb, grid) {
    return (list || []).map(function (n) {
      var beat = toBeat(n.t);
      var len = Math.max(grid, Math.round((n.dur || grid * spb) / spb / grid) * grid);
      return {
        t: n.t, dur: n.dur, pitch: n.pitch, vel: n.vel,
        beat: Math.round(beat / grid) * grid,
        len: len
      };
    }).filter(function (n) { return n.beat >= 0; });
  }

  /** 秒 → 拍重排（复音音符：钢琴/吉他音符级、MIDI 轨）。
   *  和单声部的区别：不去重、不截重叠，同一起点的多个音（和弦）都要保留。 */
  function requantizePoly(list, toBeat, spb, grid) {
    return (list || []).map(function (n) {
      var beat = toBeat(n.t);
      var len = Math.max(grid, Math.round((n.dur || grid * spb) / spb / grid) * grid);
      return {
        t: n.t, dur: n.dur, pitch: n.pitch, vel: n.vel,
        beat: Math.round(beat / grid) * grid,
        len: len
      };
    }).filter(function (n) { return n.beat >= 0; });
  }

  /** 和弦段按新速度重排：第一次调用时把原始「秒」留档到 holder._times */
  function requantizeSegs(segs, toBeat, grid, holder) {
    if (!holder._times) {
      holder._times = (segs || []).map(function (s) {
        return {
          t0: s.t0, t1: s.t1, root: s.root, quality: s.quality,
          rootName: s.rootName, score: s.score, margin: s.margin
        };
      });
    }
    return holder._times.map(function (s) {
      var b0 = toBeat(s.t0), b1 = toBeat(s.t1);
      return {
        startBeat: Math.round(b0 / grid) * grid, endBeat: Math.round(b1 / grid) * grid,
        t0: s.t0, t1: s.t1, root: s.root, quality: s.quality, rootName: s.rootName,
        score: s.score, margin: s.margin
      };
    }).filter(function (s) { return s.endBeat > s.startBeat; });
  }

  /** 音符按最终长度裁一次（beat 落在谱面外就丢） */
  function clipNotes(list, grid, totalBeats) {
    return (list || []).filter(function (n) { return n.beat < totalBeats; }).map(function (n) {
      return {
        beat: n.beat,
        len: Math.max(grid, Math.min(n.len || grid, totalBeats - n.beat)),
        pitch: n.pitch, vel: n.vel
      };
    });
  }

  /**
   * 分析结果 → 琴谱 JSON。
   * 轨结构：鼓组（鼓源） + 每个分轨文件一条轨（贝斯 / 人声 / 钢琴 / 吉他 / 其他），
   * 人声永远独占一轨，不和钢琴/吉他/其他合并。
   */
  function buildSong(res) {
    var barBeats = res.meter.num;
    var totalBeats = res.lengthBars * barBeats;
    var grid = res.grid;
    // 只有音符文件（没音频）时别塞一条空鼓轨进去
    var hasNotes = (res.bassNotes && res.bassNotes.length) ||
      (res.vocalTracks || []).some(function (v) { return v.notes.length; }) ||
      (res.harmonicTracks || []).some(function (h) { return h.notes.length || h.padNotes.length; }) ||
      (res.midiTracks || []).some(function (m) { return m.notes.length; }) ||
      (res.padNotes && res.padNotes.length);
    var tracks = [];
    if (res.hits.length || !hasNotes) {
      tracks.push({
        name: '鼓组', role: 'drum', part: -1, toneId: 'drumkit',
        volume: 0.9, pan: 0,
        notes: res.hits.map(function (h) {
          return { beat: h.gridBeat, len: grid, pitch: h.pitch, vel: h.vel };
        })
      });
    }

    var partSeq = 0;
    if (res.bassNotes && res.bassNotes.length) {
      tracks.push({
        name: '贝斯', role: 'bass', part: partSeq++, toneId: 'bass', volume: 0.85, pan: 0,
        notes: clipNotes(res.bassNotes, grid, totalBeats)
      });
    }

    (res.vocalTracks || []).forEach(function (v) {
      var notes = clipNotes(v.notes, grid, totalBeats);
      if (!notes.length) return;
      tracks.push({
        name: v.name || '人声', role: 'synth', part: partSeq++, toneId: 'vocalAh',
        volume: 0.8, pan: 0, notes: notes
      });
    });

    (res.harmonicTracks || []).forEach(function (h) {
      // 音符级转写优先（P0）；转不出来（<12 个音）才退回和弦 pad
      var list = (h.notes && h.notes.length >= 12)
        ? h.notes
        : ((h.padNotes && h.padNotes.length)
          ? h.padNotes
          : BS.analysis.padNotesFromSegments(h.segs || [], grid, totalBeats));
      var notes = clipNotes(list, grid, totalBeats);
      if (!notes.length) return;
      tracks.push({
        name: h.name || '和声', role: 'synth', part: partSeq++, toneId: h.toneId || 'warmPad',
        volume: 0.7, pan: 0, notes: notes
      });
    });

    // MIDI 分轨（P1）：外部转写工具产物，一个 MIDI 轨一条音轨
    (res.midiTracks || []).forEach(function (m) {
      var notes = clipNotes(m.notes, grid, totalBeats);
      if (!notes.length) return;
      tracks.push({
        name: m.name || 'MIDI', role: m.role || 'synth', part: partSeq++,
        toneId: m.toneId || null, volume: 0.8, pan: 0, notes: notes
      });
    });

    // 兼容旧结果（只有 padNotes、没有分轨信息）→ 仍然给一条和声轨
    if (!(res.harmonicTracks || []).length && res.padNotes && res.padNotes.length) {
      var legacy = clipNotes(res.padNotes, grid, totalBeats);
      if (legacy.length) {
        tracks.push({
          name: '和声', role: 'synth', part: partSeq++, toneId: 'warmPad',
          volume: 0.7, pan: 0, notes: legacy
        });
      }
    }

    return {
      version: 1, type: 'arranger',
      name: res.song && res.song.name ? res.song.name : '导入成谱',
      bpm: res.bpm,
      timeSignature: [res.meter.num, res.meter.den],
      swing: 0,
      lengthBars: res.lengthBars,
      key: res.key ? res.key.root : 'C',
      scale: res.key ? res.key.mode : 'major',
      chords: (res.chords || []).map(function (c) {
        return { bar: c.bar, root: c.root, quality: c.quality };
      }),
      tracks: tracks
    };
  }

  /* ================= 横轴视窗（缩放 / 播放跟随） =================
   * 谱面横轴 = 音频时间。viewSec = 0 表示「适配整首」，
   * 否则 viewStart 是视窗左边缘、viewSec 是可见时长；X(t) 全部走这两个量，
   * 缩放、拖动、播放跟随都只改这两个值再重画，不碰分析结果。 */

  /** 谱面第 0 拍在音频里的时刻（与 draw 的网格同一套坐标） */
  function chartZeroSec(res) {
    res = res || state.result;
    if (!res) return 0;
    return (res.biasSec || 0) + (res.phaseBeats || 0) * (res.spb || 0);
  }

  function totalSec() {
    return state.result ? Math.max(0.001, state.result.durationSec) : 1;
  }

  /** 最窄视窗：约半小节，缩到底也不会糊成一片 */
  function minViewSec() {
    var res = state.result;
    if (!res) return 0.5;
    return Math.max(0.25, res.barBeats * res.spb * 0.5);
  }

  function viewSpanSec() {
    var dur = totalSec();
    if (!(state.viewSec > 0)) return dur;
    return Math.min(dur, Math.max(minViewSec(), state.viewSec));
  }

  function clampView() {
    var dur = totalSec();
    var span = viewSpanSec();
    state.viewStart = U.clamp(state.viewStart, 0, Math.max(0, dur - span));
  }

  /** 像素 x → 音频秒（相对画布左边） */
  function secAtX(x, w) {
    var span = viewSpanSec();
    return state.viewStart + (x / Math.max(1, w || 1)) * span;
  }

  /** 以锚点缩放：锚点下的时刻缩放前后不动（否则谱面会乱跳） */
  function zoomView(f, anchorX, width) {
    if (!state.result) return;
    var w = width || (els.canvas ? els.canvas.clientWidth : 1) || 1;
    var dur = totalSec();
    var span = viewSpanSec();
    var ax = anchorX === undefined ? w / 2 : U.clamp(anchorX, 0, w);
    var tAnchor = state.viewStart + (ax / w) * span;
    var next = U.clamp(span / f, minViewSec(), dur);
    if (next >= dur - 1e-6) {
      state.viewSec = 0;
      state.viewStart = 0;
    } else {
      state.viewSec = next;
      state.viewStart = tAnchor - (ax / w) * next;
      clampView();
    }
    syncZoomLabel();
    draw();
  }

  function syncZoomLabel() {
    if (!els.zoomLabel) return;
    var span = viewSpanSec();
    els.zoomLabel.textContent = Math.round(totalSec() / Math.max(0.001, span) * 100) + '%';
  }

  /** 让某一时刻出现在视窗里（播放起点 / 播放跟随 / 点小节时用） */
  function revealSec(sec, placeRatio) {
    var dur = totalSec();
    var span = viewSpanSec();
    if (span >= dur - 1e-6) { state.viewStart = 0; return; }
    var r = placeRatio === undefined ? 0.15 : placeRatio;
    var x = (sec - state.viewStart) / span;
    if (x < 0.02 || x > 0.82) {
      state.viewStart = U.clamp(sec - span * r, 0, Math.max(0, dur - span));
    }
  }

  /* ---------- 播放头：音频时钟 → 画布像素 ---------- */

  function startPlayhead(clock) {
    state.playClock = clock;
    state.playSec = clock.startSec;
    revealSec(clock.startSec, 0.12);
    if (state.raf) global.cancelAnimationFrame(state.raf);
    var step = function () {
      state.raf = 0;
      if (!state.playClock) return;
      tickPlayhead();
      state.raf = global.requestAnimationFrame(step);
    };
    state.raf = global.requestAnimationFrame(step);
  }

  function tickPlayhead() {
    var clock = state.playClock;
    if (!clock || !App.ctx) return;
    var sec = clock.startSec + Math.max(0, App.ctx.currentTime - clock.ctxStart);
    state.playSec = sec;
    // 播到视窗右侧 82% 就翻页：播放头回到左边 15%，谱面整体左移
    revealSec(sec, 0.15);
    draw();
  }

  function stopPlayhead() {
    if (state.raf) { global.cancelAnimationFrame(state.raf); state.raf = 0; }
    state.playClock = null;
    state.playSec = null;
  }

  /* ================= 画布 ================= */

  var ROWS = ['crash', 'ride', 'hihatOpen', 'tomHigh', 'hihatClosed', 'tomMid', 'tomLow', 'snare', 'kick'];

  function draw() {
    var cv = els.canvas;
    if (!cv) return;
    var host = cv.parentNode;
    var w = host.clientWidth, h = host.clientHeight;
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

    ctx.fillStyle = '#0a0f14';
    ctx.fillRect(0, 0, w, h);

    var res = state.result;
    if (!res) {
      ctx.fillStyle = 'rgba(255,255,255,.28)';
      ctx.font = '12px ui-monospace, monospace';
      ctx.fillText('导入音频后点「开始分析」→ 这里会显示波形、小节网格和识别出的鼓点', 14, 26);
      return;
    }

    var hasBass = !!(res.bassNotes && res.bassNotes.length);
    var hasChord = !!(res.chords && res.chords.length);
    var rulerH = 18;
    var chordH = hasChord ? 15 : 0;
    var waveH = Math.max(36, Math.min(140, (h - rulerH - chordH) * 0.26));
    var bassH = hasBass ? Math.max(34, Math.min(74, h * 0.12)) : 0;
    var laneTop = rulerH + chordH + waveH + 4 + bassH;
    var laneH = Math.max(18, h - laneTop - 4);
    var dur = Math.max(0.001, res.durationSec);
    // 横轴视窗：缩放/跟随都只改 viewStart / viewSec
    var span = viewSpanSec();
    var X = function (t) { return ((t - state.viewStart) / span) * w; };
    var bb = res.barBeats, spb = res.spb;
    var bias = res.biasSec || 0;
    var chartZero = bias + (res.phaseBeats || 0) * spb;   // 谱面第 0 拍在音频里的时刻
    var barPx = (bb * spb / span) * w;                    // 一小节占多少像素（决定线密度）

    // 小节底色 + 置信度
    var scoreByBar = {};
    res.barScores.forEach(function (b) { scoreByBar[b.bar] = b; });
    for (var bar = 0; bar < res.lengthBars; bar++) {
      var x0 = X(chartZero + bar * bb * spb), x1 = X(chartZero + (bar + 1) * bb * spb);
      if (x1 < 0 || x0 > w) continue;
      var sc = scoreByBar[bar] ? scoreByBar[bar].score : null;
      ctx.fillStyle = bar === state.selectedBar
        ? 'rgba(79,209,197,.16)'
        : (sc === null ? 'rgba(255,255,255,.02)'
          : (sc >= 0.75 ? 'rgba(79,209,197,.06)' : (sc >= 0.45 ? 'rgba(246,173,85,.09)' : 'rgba(245,101,101,.10)')));
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h);
      if (x1 - x0 > 16) {
        ctx.fillStyle = 'rgba(255,255,255,.5)';
        ctx.font = '10px ui-monospace, monospace';
        ctx.fillText(String(bar + 1), x0 + 4, rulerH - 5);
      }
    }

    // 和弦条：每小节一个（arranger 的和弦轨模型就是这样）
    if (hasChord) {
      var chordByBar = {};
      res.chords.forEach(function (c) { chordByBar[c.bar] = c; });
      ctx.font = '10px ui-monospace, monospace';
      for (var cb = 0; cb < res.lengthBars; cb++) {
        var cx0 = X(chartZero + cb * bb * spb), cx1 = X(chartZero + (cb + 1) * bb * spb);
        var ch = chordByBar[cb];
        if (!ch) continue;
        if (cx1 - cx0 < 14) continue;
        ctx.fillStyle = 'rgba(183,148,244,.16)';
        ctx.fillRect(cx0 + 1, rulerH, cx1 - cx0 - 2, chordH - 2);
        var sym = ch.root + ((BS.arranger && BS.arranger.CHORD_QUALITIES[ch.quality] || {}).symbol || '');
        ctx.fillStyle = 'rgba(216,192,255,.95)';
        ctx.fillText(sym, cx0 + 4, rulerH + chordH - 6);
      }
    }

    // 波形
    var peaks = res.peaks;
    var waveTop = rulerH + chordH;
    if (peaks && peaks.length) {
      ctx.strokeStyle = 'rgba(120,180,200,.55)';
      ctx.beginPath();
      var midY = waveTop + waveH / 2;
      for (var i = 0; i < w; i++) {
        // 波形也跟着视窗走：像素 → 音频秒 → peaks 索引
        var tv = state.viewStart + (i / w) * span;
        var idx = Math.floor(U.clamp(tv / dur, 0, 0.99999) * peaks.length);
        var v = peaks[idx] || 0;
        var half = Math.min(waveH / 2, v * (waveH / 2) * 1.6);
        ctx.moveTo(i + 0.5, midY - half);
        ctx.lineTo(i + 0.5, midY + half);
      }
      ctx.stroke();
    }

    // 贝斯：按音高画成小钢琴卷（看得出走向就够了）
    if (hasBass) {
      var bTop = rulerH + chordH + waveH + 4;
      var lo = 127, hi = 0;
      res.bassNotes.forEach(function (n) { lo = Math.min(lo, n.pitch); hi = Math.max(hi, n.pitch); });
      lo -= 2; hi += 2;
      var span = Math.max(12, hi - lo);
      var yOf = function (p) { return bTop + bassH - ((p - lo) / span) * bassH; };
      ctx.fillStyle = 'rgba(255,255,255,.025)';
      ctx.fillRect(0, bTop, w, bassH);
      ctx.fillStyle = 'rgba(154,230,180,.75)';
      res.bassNotes.forEach(function (n) {
        var bx = X(n.t);
        var bw = Math.max(2, X(n.t + (n.dur || spb * 0.5)) - bx - 1);
        var by = yOf(n.pitch);
        ctx.fillRect(bx, by - 1.5, bw, 3);
      });
      ctx.fillStyle = 'rgba(255,255,255,.42)';
      ctx.font = '9px ui-monospace, monospace';
      ctx.fillText('贝斯', 3, bTop + 9);
    }

    // 鼓点：按类分行（只画出现的类，保持行高够大）
    var present = ROWS.filter(function (id) { return res.counts[id]; });
    if (!present.length) present = ['kick'];
    var rowH = laneH / present.length;
    present.forEach(function (id, ri) {
      var y = laneTop + ri * rowH;
      ctx.fillStyle = 'rgba(255,255,255,.03)';
      ctx.fillRect(0, y, w, rowH);
      ctx.fillStyle = 'rgba(255,255,255,.42)';
      ctx.font = '9px ui-monospace, monospace';
      ctx.fillText(BS.analysis.DRUM_LABEL[id] || id, 3, y + Math.min(rowH - 2, 10));
    });
    res.hits.forEach(function (hit) {
      var ri = present.indexOf(hit.id);
      if (ri < 0) return;
      var x = X(hit.t);
      var y = laneTop + ri * rowH + rowH / 2;
      var strong = hit.id === 'kick' || hit.id === 'snare';
      ctx.fillStyle = hit.id === 'kick' ? '#f6ad55'
        : (hit.id === 'snare' ? '#f56565' : (hit.id === 'crash' || hit.id === 'ride' ? '#9ae6b4' : '#7dd3fc'));
      ctx.beginPath();
      ctx.arc(x, y, strong ? 2.6 : 1.8, 0, Math.PI * 2);
      ctx.fill();
    });

    // 拍线 / 小节线（按像素密度决定画不画，缩小时才不会糊成一片）
    for (var bi = 0; bi < res.beatTimes.length; bi++) {
      var isBar = bi % bb === 0;
      if (isBar && barPx < 4) continue;
      if (!isBar && barPx < 22) continue;
      var bx = X(res.beatTimes[bi]);
      if (bx < -1 || bx > w + 1) continue;
      ctx.strokeStyle = isBar ? 'rgba(255,255,255,.28)' : 'rgba(255,255,255,.07)';
      ctx.beginPath();
      ctx.moveTo(Math.round(bx) + 0.5, rulerH);
      ctx.lineTo(Math.round(bx) + 0.5, h);
      ctx.stroke();
    }

    // 播放头：跟着音频时钟走（试听谱面 / 试听原音轨都有）
    if (state.playSec !== null && state.playSec !== undefined) {
      var px = X(state.playSec);
      if (px >= -2 && px <= w + 2) {
        ctx.strokeStyle = 'rgba(79,209,197,.9)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(Math.round(px) + 0.5, 0);
        ctx.lineTo(Math.round(px) + 0.5, h);
        ctx.stroke();
        ctx.fillStyle = 'rgba(79,209,197,.95)';
        ctx.beginPath();
        ctx.moveTo(px - 4, 0);
        ctx.lineTo(px + 4, 0);
        ctx.lineTo(px, 7);
        ctx.closePath();
        ctx.fill();
        ctx.lineWidth = 1;
      }
    }
  }

  /* ================= 试听 ================= */

  function ctxOrWarn() {
    if (!App.ctx || !App.engine) { toastWarn('请先点击页面任意处启动音频引擎'); return null; }
    return App.ctx;
  }

  function stopPlayback() {
    try {
      if (state.sourceNode) { state.sourceNode.stop(); state.sourceNode.disconnect(); }
    } catch (e) { /* 已经停过 */ }
    state.sourceNode = null;
    if (state.chartTimer) { clearTimeout(state.chartTimer); state.chartTimer = null; }
    if (App.drumRack && App.drumRack.allNotesOff) App.drumRack.allNotesOff();
    if (App.engine && App.engine.allNotesOff) App.engine.allNotesOff();
    state.playing = null;
    stopPlayhead();
    if (els.playStem) els.playStem.classList.remove('active');
    if (els.playChart) els.playChart.classList.remove('active');
    draw();
  }

  function toggleStem() {
    if (!ctxOrWarn()) return;
    if (state.playing === 'stem') { stopPlayback(); return; }
    stopPlayback();
    var buf = state.drumsBuf || state.mixedBuf;
    if (!buf) { toastWarn('没有可播放的音频'); return; }
    var src = App.ctx.createBufferSource();
    src.buffer = buf;
    var g = App.ctx.createGain();
    g.gain.value = 0.85;
    src.connect(g).connect(App.engine.master);
    var from = state.selectedBar * (state.result ? state.result.barBeats * state.result.spb : 0);
    from = U.clamp(from, 0, Math.max(0, buf.duration - 0.05));
    src.start(0, from);
    src.onended = function () {
      if (state.playing === 'stem') {
        state.playing = null;
        stopPlayhead();
        els.playStem.classList.remove('active');
        draw();
      }
    };
    state.sourceNode = src;
    state.playing = 'stem';
    els.playStem.classList.add('active');
    // 原音轨的播放头：缓冲时间轴上的 offset + 走过的时间
    startPlayhead({ ctxStart: App.ctx.currentTime, startSec: from });
  }

  /** 现成声部里按名字找（预览用；精确播放还是走「写入编曲」） */
  function findPart(re) {
    var parts = (App.engine && App.engine.parts) || [];
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] && parts[i].name && re.test(parts[i].name)) return parts[i];
    }
    return null;
  }

  /** 给某条音轨找个能发声的声部：先按轨名匹配，再退回任一 melodic 声部 */
  function partForTrack(name) {
    var parts = (App.engine && App.engine.parts) || [];
    var i, n;
    for (i = 0; i < parts.length; i++) {
      n = (parts[i] && parts[i].name) || '';
      if (n && (n === name || n.indexOf(name) >= 0 || name.indexOf(n) >= 0)) return parts[i];
    }
    for (i = 0; i < parts.length; i++) {
      if (!/贝斯|bass/i.test((parts[i] && parts[i].name) || '')) return parts[i];
    }
    return null;
  }

  function toggleChart() {
    if (!ctxOrWarn()) return;
    if (state.playing === 'chart') { stopPlayback(); return; }
    stopPlayback();
    var rack = App.ensureDrumRack ? App.ensureDrumRack() : null;
    if (!rack) { toastWarn('鼓组通道未就绪'); return; }
    var res = state.result;
    if (!res) { toastWarn('先分析'); return; }

    var spb = res.spb, t0 = App.ctx.currentTime + 0.08;
    var startBar = state.selectedBar;
    var startBeat = startBar * res.barBeats;
    // 从选中拍起一直播到结尾：谱面会跟着播放进度滚动，不再只播 8 小节
    var spanBars = Math.max(1, res.lengthBars - startBar);
    var endBeat = startBeat + spanBars * res.barBeats;
    var inRange = function (n) { return n.beat >= startBeat - 1e-9 && n.beat < endBeat; };
    var at = function (beat) { return t0 + (beat - startBeat) * spb; };

    // 逐轨试听：第 0 轨鼓组走鼓组通道，其余每轨各自找一个声部（人声轨也照样发声）
    var tracks = (res.song && res.song.tracks) || [];
    // 鼓轨按 role 找（只有 MIDI 时第一条轨不是鼓，不能想当然取 [0]）
    var drumTrack = null;
    tracks.forEach(function (t) { if (!drumTrack && t.role === 'drum') drumTrack = t; });
    var drumNotes = drumTrack ? drumTrack.notes.filter(inRange) : [];
    drumNotes.forEach(function (n) { rack.hitPitch(n.pitch, n.vel, at(n.beat)); });

    var played = 0, silent = [];
    tracks.slice(1).forEach(function (t) {
      var part = partForTrack(t.name);
      if (!part) { silent.push(t.name); return; }
      t.notes.filter(inRange).forEach(function (n) {
        var v = part.noteOn(n.pitch, n.vel * 0.95, at(n.beat));
        if (v && v.release) v.release(at(n.beat) + Math.max(0.12, n.len * spb - 0.02));
        played++;
      });
    });
    if (silent.length) log('提示：这些轨没找到可发声的声部，试听时静音：' + silent.join('/'));

    state.playing = 'chart';
    els.playChart.classList.add('active');
    // 播放头：谱面第 startBeat 拍在音频里的时刻起算，之后按音频时钟推进
    startPlayhead({ ctxStart: t0, startSec: chartZeroSec(res) + startBeat * spb });
    var total = spanBars * res.barBeats * spb;
    state.chartTimer = setTimeout(function () {
      if (state.playing === 'chart') {
        state.playing = null;
        stopPlayhead();
        els.playChart.classList.remove('active');
        draw();
      }
    }, total * 1000 + 300);
    setStatus('试听 ' + spanBars + ' 小节：' + tracks.length + ' 轨 · 鼓 ' + drumNotes.length +
      (played ? ' + 声部 ' + played : '') + ' 个音', 'ok');
  }

  /* ================= 落地：写入编曲 / 导出 ================= */

  function writeToArranger() {
    if (!state.result) { toastWarn('先分析'); return; }
    if (!BS.appArranger || !BS.appArranger.importSong) { toastWarn('编曲模块未加载'); return; }
    state.result.song = buildSong(state.result);
    var song = state.result.song;

    var go = function () {
      stopPlayback();
      try {
        BS.appArranger.importSong(song, '导入成谱');
      } catch (e) {
        toastWarn('写入失败：' + (e && e.message ? e.message : e));
        return;
      }
      var tab = document.querySelector('.stage-tab[data-stage="arrange"]');
      if (tab) tab.click();
      var toast = App.toast || function () {};
      var detail = song.tracks.map(function (t) {
        return t.name + ' ' + t.notes.length;
      }).join(' · ');
      toast('已写入编曲：' + song.tracks.length + ' 轨（' + detail +
        '）· ' + song.chords.length + ' 个和弦 · ' + song.lengthBars + ' 小节 · Ctrl+Z 可撤销', 5200);
    };

    var arr = BS.appArranger.ensure ? BS.appArranger.ensure() : null;
    var hasContent = !!(arr && arr.contentBars && arr.contentBars() > 0);
    if (hasContent && BS.modal) {
      BS.modal.confirm('写入编曲',
        '当前编曲里已有内容，写入会<b>整段替换</b>（可用 Ctrl+Z 撤销）。继续？',
        go);
    } else {
      go();
    }
  }

  function exportJSON() {
    if (!state.result) { toastWarn('先分析'); return; }
    var song = buildSong(state.result);
    var text = JSON.stringify(song, null, 2);
    var blob = new Blob([text], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = (song.name || 'imported') + '.drum.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1000);
  }

  /* ================= 杂项 ================= */

  function toastWarn(msg) {
    if (App.toast) App.toast(msg, 3600);
  }

  function stripExt(n) {
    return String(n || '').replace(/\.[a-z0-9]+$/i, '');
  }

  BS.on('stage:change', function (stage) {
    if (stage === 'import') {
      if (!init()) return;
      // 面板尺寸变化后再画一次（切页前 clientWidth 为 0）
      requestAnimationFrame(function () { draw(); });
    } else {
      stopPlayback();
    }
  });

  BS.importSong = {
    init: init,
    addFiles: addFiles,
    analyzeNow: analyzeNow,
    rebuildFromParams: rebuildFromParams,
    buildSong: buildSong,
    writeToArranger: writeToArranger,
    stop: stopPlayback,
    state: state,
    /* 测试用：直接喂 AudioBuffer */
    analyzeBuffers: function (drums, mixed, params) {
      state.files = [{ name: 'test', role: drums ? 'drums' : 'mixed', buffer: drums || mixed, duration: (drums || mixed).duration }];
      state.drumsBuf = drums || null;
      state.mixedBuf = mixed || null;
      init();
      return BS.analysis.analyze({ name: 'test', drums: drums, mixed: mixed }, params || {}, function () {})
        .then(function (res) { state.result = res; applyResultToUI(res); return res; });
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);

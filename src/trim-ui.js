/* BandSynth · trim-ui.js
 * 采样裁剪 + 试听面板（可嵌入声部编辑器）
 *
 * 功能：
 *  · 波形显示（含选区高亮、起止手柄、播放头）
 *  · 拖拽手柄裁剪、拖动选区平移、双击全选
 *  · 播放/停止试听、循环试听选区、原速/半速/升八度
 *  · 试听音量旋钮（dB 显示）
 *  · 选区数值显示（起/止/长度）
 *  · 「物理裁剪」把选区真正切出来、「重置」恢复全段
 *  · 一键静音试听起点吸附：把选区起点对齐到最近的零交叉点
 */
(function (global) {
  'use strict';
  var BS = global.BS;
  var U = BS.util, W = BS.widgets;

  function createPanel(host, opts) {
    opts = opts || {};
    var getPart = opts.getPart;
    var audition = opts.audition;         // BS.trim.SampleAudition（可选，优先用 getAudition）
    var ctxOpt = opts.ctx;                // AudioContext 或返回它的函数
    function getCtx() {
      var c = (typeof ctxOpt === 'function') ? ctxOpt() : ctxOpt;
      return c || (global.BS.app && BS.app.ctx);
    }
    var onRefresh = opts.onRefresh || function () {};
    var toast = opts.toast || function () {};

    var part = getPart();
    if (!part) return null;

    /* ---------- 容器 ---------- */
    var root = document.createElement('div');
    root.className = 'trim-panel';

    /* 波形画布 */
    var waveWrap = document.createElement('div');
    waveWrap.className = 'trim-wave-wrap';
    var canvas = document.createElement('canvas');
    canvas.className = 'trim-canvas';
    waveWrap.appendChild(canvas);

    // 时间刻度
    var ruler = document.createElement('div');
    ruler.className = 'trim-ruler';
    waveWrap.appendChild(ruler);

    /* ---------- 缩放工具栏 ---------- */
    var zoomBar = document.createElement('div');
    zoomBar.className = 'trim-zoom';

    function mkZoomBtn(label, title, fn) {
      var b = document.createElement('button');
      b.className = 'trim-zbtn';
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', fn);
      zoomBar.appendChild(b);
      return b;
    }
    mkZoomBtn('−', '缩小（滚轮向下）', function () { view.zoomOut(); });
    mkZoomBtn('＋', '放大（滚轮向上，以光标为锚点）', function () { view.zoomIn(); });

    var zoomLabel = document.createElement('span');
    zoomLabel.className = 'trim-zoom-label';
    zoomBar.appendChild(zoomLabel);

    mkZoomBtn('全览', '显示完整采样（双击波形）', function () { view.zoomToFit(); });
    mkZoomBtn('贴合选区', '缩放到刚好包含当前选区（双击波形）', function () { view.zoomToRange(); });
    waveWrap.appendChild(zoomBar);

    // 视口导航条（显示当前视口在全段中的位置）
    var navBar = document.createElement('div');
    navBar.className = 'trim-nav';
    var navTrack = document.createElement('div');
    navTrack.className = 'trim-nav-track';
    var navSel = document.createElement('div');
    navSel.className = 'trim-nav-sel';
    var navView = document.createElement('div');
    navView.className = 'trim-nav-view';
    navTrack.appendChild(navSel);
    navTrack.appendChild(navView);
    navBar.appendChild(navTrack);
    waveWrap.appendChild(navBar);

    function updateNav() {
      var dur = part.bufferDuration || 1;
      var vs = U.clamp(view.start / dur, 0, 1);
      var ve = U.clamp(view.end / dur, 0, 1);
      navView.style.left = (vs * 100) + '%';
      navView.style.width = Math.max(0.8, (ve - vs) * 100) + '%';
      var ss = U.clamp(view.start / dur, 0, 1);
      var se = U.clamp(view.end / dur, 0, 1);
      navSel.style.left = (ss * 100) + '%';
      navSel.style.width = Math.max(0.5, (se - ss) * 100) + '%';
    }

    // 导航条拖动 → 平移视口
    var navDrag = null;
    navTrack.addEventListener('pointerdown', function (e) {
      var dur = part.bufferDuration || 1;
      var r = navTrack.getBoundingClientRect();
      navDrag = { x0: e.clientX, vs: view.start, ve: view.end, w: r.width || 1, dur: dur };
      navTrack.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    navTrack.addEventListener('pointermove', function (e) {
      if (!navDrag) return;
      var dt = (e.clientX - navDrag.x0) / navDrag.w * navDrag.dur;
      view.setView(navDrag.vs + dt, navDrag.ve + dt);
    });
    function navEnd(e) {
      if (!navDrag) return;
      navDrag = null;
      try { navTrack.releasePointerCapture(e.pointerId); } catch (err) { /* noop */ }
    }
    navTrack.addEventListener('pointerup', navEnd);
    navTrack.addEventListener('pointercancel', navEnd);

    // 选区信息
    var info = document.createElement('div');
    info.className = 'trim-info';
    waveWrap.appendChild(info);
    root.appendChild(waveWrap);

    /* ---------- 传输控制 ---------- */
    var ctrl = document.createElement('div');
    ctrl.className = 'trim-ctrl';

    var playBtn = document.createElement('button');
    playBtn.className = 'btn small trim-play';
    playBtn.textContent = '▶ 试听';

    var stopBtn = document.createElement('button');
    stopBtn.className = 'btn small';
    stopBtn.textContent = '■';

    var loopBtn = document.createElement('button');
    loopBtn.className = 'btn small';
    loopBtn.textContent = '循环';

    var selBtn = document.createElement('button');
    selBtn.className = 'btn small';
    selBtn.textContent = '试听选区';
    selBtn.title = '只播放当前选中的区间';

    ctrl.appendChild(playBtn);
    ctrl.appendChild(stopBtn);
    ctrl.appendChild(loopBtn);
    ctrl.appendChild(selBtn);
    root.appendChild(ctrl);

    /* ---------- 参数行 ---------- */
    var rowA = document.createElement('div');
    rowA.className = 'trim-knobs';

    // 试听音量
    var volK = W.knob({
      label: '试听音量', min: -60, max: 12, value: 0, default: 0, unit: 'dB',
      onChange: function (db) {
        var a0 = getAudition();
        if (a0) a0.setVolume(BS.util.dbToGain(db));
      }
    });
    rowA.appendChild(volK.el);

    // 采样音量（真正作用于声部）
    var gainK = W.knob({
      label: '采样音量', min: -40, max: 12, value: U.gainToDb(part.sampleGain),
      default: 0, unit: 'dB',
      onChange: function (db) {
        part.sampleGain = U.dbToGain(db);
        BS.pitchAlgo.cache.clear();
      }
    });
    rowA.appendChild(gainK.el);

    // 试听速度
    var rateSeg = W.segment({
      label: '试听速度',
      options: [
        { value: 0.5, label: '½×' },
        { value: 1, label: '原速' },
        { value: 2, label: '2×' }
      ],
      value: 1,
      onChange: function (v) { state.rate = v; }
    });
    rowA.appendChild(rateSeg.el);

    root.appendChild(rowA);

    /* ---------- 裁剪操作 ---------- */
    var rowB = document.createElement('div');
    rowB.className = 'trim-actions';

    function mkBtn(label, title, fn, cls) {
      var b = document.createElement('button');
      b.className = 'btn small' + (cls ? ' ' + cls : '');
      b.textContent = label;
      if (title) b.title = title;
      b.addEventListener('click', fn);
      rowB.appendChild(b);
      return b;
    }

    mkBtn('物理裁剪', '把选区真正切出来（不可撤销，将丢失区间外的声音）', function () {
      if (!part.buffer) return;
      var s = view.start, e = view.end;
      var len = e - s;
      if (len <= 0.001) { toast('选区太短'); return; }
      if (Math.abs(s) < 0.0005 && Math.abs(e - part.buffer.duration) < 0.0005) {
        toast('选区已是全段，无需裁剪');
        return;
      }
      var nb = BS.trim.sliceBuffer(getCtx(), part.buffer, s, e);
      var name = part.bufferName || '采样';
      part.setBuffer(nb, name + ' [裁剪]');
      part.startSec = 0;
      part.endSec = 0;
      toast('已裁剪：' + len.toFixed(3) + 's → ' + nb.duration.toFixed(3) + 's');
      onRefresh();
    }, 'primary');

    mkBtn('全览', '恢复完整采样', function () {
      if (!part.buffer) return;
      part.startSec = 0;
      part.endSec = part.buffer.duration;
      view.setRange(0, part.buffer.duration);
      view.zoomToFit();
      updateInfo();
      toast('已恢复全段');
      onRefresh();
    });

    mkBtn('裁当前视图', '只保留当前放大后可见的区间', function () {
      if (!part.buffer) return;
      var vs = view.view.start, ve = view.view.end;
      var span = ve - vs;
      if (span >= part.buffer.duration - 0.001) { toast('当前已是全段视图'); return; }
      view.setRange(vs, ve);
      part.startSec = vs;
      part.endSec = ve;
      updateInfo();
      toast('选区已设为当前视图：' + vs.toFixed(3) + 's ~ ' + ve.toFixed(3) + 's');
    });

    mkBtn('对齐零交叉', '把选区起点吸附到最近的零交叉点，消除起始爆音', function () {
      if (!part.buffer) return;
      var d = part.buffer.getChannelData(0);
      var sr = part.buffer.sampleRate;
      var i = Math.floor(view.start * sr);
      var limit = Math.min(d.length, i + Math.floor(sr * 0.05));
      var found = -1;
      for (var k = i; k < limit; k++) {
        if ((d[k - 1] || 0) <= 0 && d[k] > 0) { found = k; break; }
        if ((d[k - 1] || 0) >= 0 && d[k] < 0) { found = k; break; }
      }
      if (found < 0) { toast('附近找不到零交叉点'); return; }
      var t = found / sr;
      view.setRange(t, view.end);
      part.startSec = t;
      updateInfo();
      toast('起点对齐到 ' + t.toFixed(4) + 's');
    });

    mkBtn('淡入淡出', '给选区加 5ms 淡入淡出，消除边界咔哒声', function () {
      if (!part.buffer) return;
      var sr = part.buffer.sampleRate;
      var n = Math.min(Math.floor(sr * 0.005), Math.floor((view.end - view.start) * sr / 4));
      if (n < 2) { toast('选区太短，无法加淡入淡出'); return; }
      var ch = part.buffer.numberOfChannels;
      for (var c = 0; c < ch; c++) {
        var d = part.buffer.getChannelData(c);
        var s = Math.floor(view.start * sr), e = Math.floor(view.end * sr);
        for (var j = 0; j < n; j++) {
          var gIn = j / n, gOut = (n - j) / n;
          if (s + j < d.length) d[s + j] *= gIn;
          if (e - 1 - j >= 0 && e - 1 - j < d.length) d[e - 1 - j] *= gOut;
        }
      }
      part._revBuffer = null;
      BS.pitchAlgo.cache.clear();
      loadPeaks();
      toast('已加 ' + (n / sr * 1000).toFixed(1) + 'ms 淡入淡出');
    });

    root.appendChild(rowB);

    /* ---------- 状态 ---------- */
    var state = { rate: 1, selOnly: false, loop: false };

    var view = new BS.trim.TrimView(canvas, {
      duration: part.bufferDuration || 1,
      start: part.startSec,
      end: part.endSec || part.bufferDuration,
      onChange: function (s, e) {
        part.startSec = s;
        part.endSec = e;
        updateInfo();
      },
      onPreview: function (s, e, isDrag, head, isEnd) {
        if (isEnd && head !== undefined) {
          // 点击波形任意位置 → 从该点试听
          auditionFrom(head);
        }
      },
      // 视口变化 → 刷新刻度/缩放标签/导航条，并更新「选区在视野外」提示
      onViewChange: function () {
        renderRuler();
        var vs = view.view.start, ve = view.view.end;
        var offscreen = (view.end < vs - 0.001 || view.start > ve + 0.001);
        if (offscreen && !info.dataset.warned) {
          info.dataset.warned = '1';
          updateInfo();
          info.dataset.warned = '';
        } else if (!offscreen) {
          updateInfo();
        }
      }
    });

    function loadPeaks() {
      if (!part.buffer) {
        view.setPeaks(null, 1);
        return;
      }
      var buckets = Math.max(200, Math.min(1600, canvas.clientWidth * 2 || 600));
      var peaks = BS.loader.peaks(part.buffer, buckets);
      view.setPeaks(peaks, part.buffer.duration);
      view.setRange(part.startSec, part.endSec || part.buffer.duration);
      view.render();
    }

    function fmtSec(s) {
      return s.toFixed(3) + 's';
    }

    function updateInfo() {
      var s = view.start, e = view.end;
      var len = e - s;
      // 提示选区是否在当前视图之外
      var vs = view.view ? view.view.start : 0;
      var ve = view.view ? view.view.end : 0;
      var offscreen = (e < vs - 0.001 || s > ve + 0.001);
      var tips = '拖动边缘裁剪 · 滚轮缩放 · 拖动空白平移 · 双击适配选区';
      if (offscreen) {
        tips = '选区在可视范围外 → 点「贴合选区」回到它，或用导航条平移视图';
      }
      info.innerHTML =
        '<span>起点 <b>' + fmtSec(s) + '</b></span>' +
        '<span>终点 <b>' + fmtSec(e) + '</b></span>' +
        '<span>长度 <b>' + fmtSec(len) + '</b></span>' +
        '<span class="trim-tip' + (offscreen ? ' warn' : '') + '">' + tips + '</span>';
      renderRuler();
    }

    function renderRuler() {
      // 刻度跟随视口，而非全段
      var vs = view.view ? view.view.start : 0;
      var ve = view.view ? view.view.end : (part.bufferDuration || 1);
      var span = ve - vs;
      var ticks = 5;
      var html = '';
      for (var i = 0; i <= ticks; i++) {
        var t = vs + span * i / ticks;
        var pos = i / ticks * 100;
        html += '<span style="left:' + pos + '%">' + t.toFixed(t < 1 ? 3 : 2) + 's</span>';
      }
      ruler.innerHTML = html;
      var z = Math.round(view.zoom ? view.zoom() * 100 : 100);
      zoomLabel.textContent = z + '%';
      updateNav();
    }

    /* ---------- 试听 ---------- */
    // audition 可能在面板创建之后才就绪（音频引擎需用户手势启动），
    // 故每次调用时动态取，而不是在闭包里固化 undefined。
    function getAudition() {
      return opts.getAudition ? opts.getAudition() : audition;
    }

    function auditionFrom(posSec) {
      var a = getAudition();
      if (!part.buffer || !a) {
        toast('音频引擎未启动，请先点击页面任意处');
        return;
      }
      var s = state.selOnly ? view.start : 0;
      var e = state.selOnly ? view.end : part.buffer.duration;
      if (posSec !== undefined && !state.selOnly) {
        s = Math.min(posSec, Math.max(0, e - 0.05));
      }
      a.play(part.buffer, s, e, {
        rate: state.rate,
        loop: state.loop,
        onTick: function (t) {
          var pos = s + t * state.rate;
          view.setPlayhead(pos);
          // 播放头跑出视口时自动跟随（否则用户看不到自己在听哪里）
          if (pos > view.view.end - (view.view.end - view.view.start) * 0.08 ||
              pos < view.view.start) {
            var span = view.view.end - view.view.start;
            view.setView(pos - span * 0.1, pos + span * 0.9);
            renderRuler();
          }
        }
      });
      view.setPlayhead(s);
      playBtn.textContent = '■ 停止';
      playBtn.classList.add('active');
    }

    function stopAudition() {
      var a = getAudition();
      if (a) a.stop();
      playBtn.textContent = '▶ 试听';
      playBtn.classList.remove('active');
      view.setPlayhead(0);
    }

    playBtn.addEventListener('click', function () {
      if (audition && audition.playing) { stopAudition(); return; }
      auditionFrom(state.selOnly ? view.start : undefined);
    });

    stopBtn.addEventListener('click', stopAudition);

    loopBtn.addEventListener('click', function () {
      state.loop = !state.loop;
      loopBtn.classList.toggle('active', state.loop);
      var a1 = getAudition();
      if (a1) a1.loop = state.loop;
    });

    selBtn.addEventListener('click', function () {
      state.selOnly = !state.selOnly;
      selBtn.classList.toggle('active', state.selOnly);
      if (state.selOnly) auditionFrom(view.start);
      else stopAudition();
    });

    /* 键盘快捷：空格切换试听（输入框内不响应） */
    function onKey(e) {
      var tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
      if (e.code === 'Space' && root.contains(document.activeElement)) {
        e.preventDefault();
        if (audition && audition.playing) stopAudition();
        else auditionFrom(state.selOnly ? view.start : undefined);
      }
    }
    root.addEventListener('keyup', onKey);
    root.tabIndex = 0;

    /* ---------- 对外接口 ---------- */
    var api = {
      el: root,
      refresh: function () {
        part = getPart();
        if (!part) return;
        gainK.set(U.gainToDb(part.sampleGain));
        view.setPeaks(null, 1);
        loadPeaks();
        updateInfo();
      },
      /* 音频引擎就绪后调用：把试听音量同步到新建的引擎 */
      syncAudition: function () {
        var a = getAudition();
        if (a) a.setVolume(U.dbToGain(volK.value));
      },
      stop: stopAudition,
      getRange: function () { return { start: view.start, end: view.end }; },
      destroy: function () {
        stopAudition();
        root.removeEventListener('keyup', onKey);
        global.removeEventListener('resize', root._resizeHandler);
      }
    };

    // 首次加载
    loadPeaks();
    updateInfo();
    // 窗口尺寸变化时重绘（画布是 CSS 尺寸 × dpr）
    root._resizeHandler = function () { view.render(); };
    global.addEventListener('resize', root._resizeHandler);

    host.appendChild(root);
    return api;
  }

  BS.createTrimPanel = createPanel;

})(window);

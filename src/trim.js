/* BandSynth · trim.js
 * 采样裁剪与试听引擎
 *
 * 1) TrimView —— 波形选区编辑器（可缩放）
 *    · 拖拽起止手柄、拖动选区平移、点击设置播放头
 *    · 滚轮缩放（以光标位置为锚点）、拖动空白处平移视图
 *    · 起点/终点可以缩出可视范围，此时在边缘显示方向指示器
 *    · 缩放级别范围 0.25x ~ 400x，最小可视窗口 5ms
 *
 * 2) SampleAudition —— 试听引擎：从 buffer 任意区间播放，支持变调/循环
 *
 * 设计要点：
 *  · 试听走独立通路（不经过声部 ADSR/滤波），否则包络会把采样包得面目全非，
 *    听不出素材本身的好坏。
 *  · 裁剪采用「区间裁剪」而非「物理切 buffer」：startSec/endSec 是轻量参数，
 *    可反复调整、零拷贝；只有用户点「物理裁剪」时才真正切数据。
 *  · 视口(view) 与选区(range) 分离：缩放只改视口，不动选区。
 *    这样可以把波形放大到细节、也能缩到全段，而裁剪点始终保持不变。
 */
(function (global) {
  'use strict';
  var BS = global.BS;
  var U = BS.util;

  var MIN_SPAN = 0.005;      // 最小可视窗口 5ms
  var MAX_ZOOM = 400;        // 最大放大倍数（相对全段）
  var MIN_ZOOM = 0.25;       // 最小缩小倍数（可略超全段，便于留白）

  /* ================= 波形选区编辑器 ================= */
  function TrimView(canvas, opts) {
    opts = opts || {};
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.duration = opts.duration || 1;
    this.start = opts.start || 0;
    this.end = opts.end === undefined ? this.duration : opts.end;
    this.playhead = 0;
    this.onChange = opts.onChange || function () {};
    this.onPreview = opts.onPreview || function () {};
    this.onViewChange = opts.onViewChange || function () {};
    this.dragging = null;
    this.dpr = global.devicePixelRatio || 1;

    // 视口：可见的时间范围
    this.view = { start: 0, end: this.duration };
    this.peaks = null;
    this._peaksFor = 0;
    this.hoverX = undefined;

    this._bind();
    this.render();
  }

  /* ---------- 视口运算 ---------- */
  TrimView.prototype.viewSpan = function () { return this.view.end - this.view.start; };
  TrimView.prototype.fullSpan = function () { return this.duration; };
  TrimView.prototype.zoom = function () { return this.fullSpan() / this.viewSpan(); };

  TrimView.prototype.setView = function (s, e) {
    var span = Math.max(MIN_SPAN, e - s);
    if (span > this.fullSpan() * (1 / MIN_ZOOM)) {
      span = this.fullSpan() * (1 / MIN_ZOOM);
    }
    s = U.clamp(s, 0, Math.max(0, this.fullSpan() - span));
    this.view.start = s;
    this.view.end = s + span;
    this.render();
    this.onViewChange(this.view);
  };

  TrimView.prototype.zoomAt = function (factor, anchorT) {
    // factor > 1 放大；anchorT 为锚点时间（保持该点在屏幕上的位置不变）
    var cur = this.viewSpan();
    var target = cur / factor;
    target = U.clamp(target,
      Math.max(MIN_SPAN, this.fullSpan() / MAX_ZOOM),
      Math.min(this.fullSpan() * (1 / MIN_ZOOM), this.fullSpan()));
    var t = anchorT === undefined ? (this.view.start + cur / 2) : anchorT;
    var ratio = (t - this.view.start) / cur;      // 锚点在视口内的相对位置
    var ns = t - target * ratio;
    this.setView(ns, ns + target);
  };

  TrimView.prototype.zoomIn = function () { this.zoomAt(1.5); };
  TrimView.prototype.zoomOut = function () { this.zoomAt(1 / 1.5); };
  TrimView.prototype.zoomToFit = function () { this.setView(0, this.fullSpan()); };

  /* 缩放到刚好包含选区（留 5% 余量） */
  TrimView.prototype.zoomToRange = function () {
    var pad = (this.end - this.start) * 0.06 + 0.001;
    this.setView(this.start - pad, this.end + pad);
  };

  TrimView.prototype.panByPx = function (dxPx, width) {
    var span = this.viewSpan();
    var dxT = dxPx / width * span;
    this.setView(this.view.start + dxT, this.view.end + dxT);
  };

  /* ---------- 坐标转换 ---------- */
  TrimView.prototype.timeToX = function (t) {
    var span = this.viewSpan();
    return (t - this.view.start) / span * (this.canvas.clientWidth || 1);
  };
  TrimView.prototype.xToTime = function (x) {
    var w = this.canvas.clientWidth || 1;
    return this.view.start + (x / w) * this.viewSpan();
  };

  /* ---------- 数据 ---------- */
  TrimView.prototype.setBuffer = function (duration) {
    this.duration = Math.max(0.001, duration || 1);
    this.start = 0;
    this.end = this.duration;
    this.playhead = 0;
    this.peaks = null;
    this.view = { start: 0, end: this.duration };
    this.render();
  };

  TrimView.prototype.setPeaks = function (peaks, duration) {
    this.peaks = peaks;
    if (duration) this.duration = Math.max(0.001, duration);
    this._peaksFor = duration;
    if (this.viewSpan() > this.fullSpan() * 1.001) this.view = { start: 0, end: this.duration };
    this.render();
  };

  TrimView.prototype.setRange = function (s, e) {
    this.start = U.clamp(s, 0, this.duration);
    this.end = U.clamp(e, 0, this.duration);
    if (this.end < this.start) { var t = this.start; this.start = this.end; this.end = t; }
    this.render();
  };

  TrimView.prototype.setPlayhead = function (t) {
    this.playhead = U.clamp(t, 0, this.duration);
    this.render();
  };

  /* ---------- 命中测试 ---------- */
  TrimView.prototype._hit = function (px) {
    var w = this.canvas.clientWidth || 1;
    var handleW = 9;
    var x0 = this.timeToX(this.start);
    var x1 = this.timeToX(this.end);

    // 视野外的手柄不算命中（用户需要先平移过来）
    if (x0 >= -handleW && x0 <= w + handleW && Math.abs(px - x0) <= handleW) return 'start';
    if (x1 >= -handleW && x1 <= w + handleW && Math.abs(px - x1) <= handleW) return 'end';
    if (px > x0 && px < x1) return 'move';
    // 视野内的边缘（手柄在界外时，让边缘可点击以拉回来）
    if (this.start < this.view.start && px < 0) return 'start';
    if (this.end > this.view.end && px > w) return 'end';
    return 'pan';
  };

  /* ---------- 事件绑定 ---------- */
  TrimView.prototype._bind = function () {
    var self = this;
    var c = this.canvas;

    function localX(e) {
      var r = c.getBoundingClientRect();
      return e.clientX - r.left;
    }

    c.addEventListener('pointerdown', function (e) {
      if (e.button !== undefined && e.button !== 0) return;
      c.setPointerCapture(e.pointerId);
      var px = localX(e);
      self.dragging = self._hit(px);
      self._dragStart = {
        px: px,
        start: self.start, end: self.end,
        viewStart: self.view.start, viewEnd: self.view.end,
        grabT: (self.xToTime(px) - self.start) / Math.max(1e-9, self.end - self.start)
      };
      if (self.dragging === 'pan') c.style.cursor = 'grabbing';
      self.onPreview(self.start, self.end, true);
      e.preventDefault();
    });

    c.addEventListener('pointermove', function (e) {
      var px = localX(e);
      if (!self.dragging) {
        var m = self._hit(px);
        c.style.cursor = m === 'move' ? 'grab'
          : (m === 'pan' ? 'grab' : 'col-resize');
        self.hoverX = self.xToTime(px);
        self.render();
        return;
      }

      var w = c.clientWidth || 1;
      var d = self._dragStart;

      if (self.dragging === 'pan') {
        var span = d.viewEnd - d.viewStart;
        var dt = (px - d.px) / w * span;
        self.setView(d.viewStart + dt, d.viewEnd + dt);
        return;
      }

      var t = self.xToTime(px);
      if (self.dragging === 'start') {
        self.start = Math.min(t, self.end - MIN_SPAN);
      } else if (self.dragging === 'end') {
        self.end = Math.max(t, self.start + MIN_SPAN);
      } else if (self.dragging === 'move') {
        var len = d.end - d.start;
        var ns = U.clamp(d.start + (t - d.viewStart) - (d.viewStart - d.viewStart), 0, self.duration - len);
        ns = U.clamp(ns + (t - self.xToTime(d.px)), 0, self.duration - len);
        self.start = ns;
        self.end = ns + len;
      }
      self.start = U.clamp(self.start, 0, self.duration);
      self.end = U.clamp(self.end, 0, self.duration);
      if (self.end - self.start < MIN_SPAN) self.end = Math.min(self.duration, self.start + MIN_SPAN);
      self.render();
      self.onChange(self.start, self.end);
    });

    function endDrag(e) {
      if (!self.dragging) return;
      var wasPlayhead = self.dragging === 'playhead';
      self.dragging = null;
      try { c.releasePointerCapture(e.pointerId); } catch (err) { /* noop */ }
      if (!wasPlayhead) self.onPreview(self.start, self.end, false, undefined, true);
    }
    c.addEventListener('pointerup', endDrag);
    c.addEventListener('pointercancel', endDrag);

    /* 双击 → 缩放到选区 */
    c.addEventListener('dblclick', function () {
      if (self.end - self.start > self.duration * 0.98) {
        self.zoomToFit();
      } else {
        self.zoomToRange();
      }
    });

    /* 滚轮缩放：以光标位置为锚点
       向上滚（deltaY<0）放大；Ctrl+滚轮横向平移（触控板手势） */
    c.addEventListener('wheel', function (e) {
      e.preventDefault();
      var px = localX(e);
      if (e.ctrlKey && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        // 触控板横向手势 → 平移
        var w = c.clientWidth || 1;
        self.setView(self.view.start + (e.deltaX / w) * self.viewSpan(),
                     self.view.end + (e.deltaX / w) * self.viewSpan());
        return;
      }
      var anchor = self.xToTime(px);
      var factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
      // Shift + 滚轮 = 粗调
      if (e.shiftKey) factor = e.deltaY < 0 ? 1.6 : 1 / 1.6;
      self.zoomAt(factor, anchor);
    }, { passive: false });
  };

  /* ---------- 绘制 ---------- */
  TrimView.prototype.render = function () {
    var c = this.canvas;
    var dpr = this.dpr;
    var cssW = c.clientWidth || c.width;
    var cssH = c.clientHeight || c.height;
    if (c.width !== Math.round(cssW * dpr) || c.height !== Math.round(cssH * dpr)) {
      c.width = Math.round(cssW * dpr);
      c.height = Math.round(cssH * dpr);
    }
    var ctx = this.ctx;
    var w = c.width, h = c.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#070b0f';
    ctx.fillRect(0, 0, w, h);

    var vS = this.view.start, vE = this.view.end;
    var mid = h / 2;

    // 时间网格
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    var gridStep = this._gridStep();
    for (var g = Math.ceil(vS / gridStep) * gridStep; g < vE; g += gridStep) {
      var gx = Math.round(this.timeToX(g) * dpr) + 0.5;
      if (gx < 0 || gx > w) continue;
      ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke();
    }

    if (!this.peaks) {
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.font = (11 * dpr) + 'px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('未装载采样', w / 2, mid);
      ctx.textAlign = 'left';
      return;
    }

    var peaks = this.peaks;
    var n = peaks.length;
    var totalDur = this.fullSpan();

    // 视口外的部分压暗（让用户知道还有内容）
    var x0 = this.timeToX(this.start) * dpr;
    var x1 = this.timeToX(this.end) * dpr;
    ctx.fillStyle = 'rgba(7,11,15,0.62)';
    ctx.fillRect(0, 0, x0, h);
    ctx.fillRect(x1, 0, w - x1, h);
    ctx.fillStyle = 'rgba(79,209,197,0.06)';
    ctx.fillRect(Math.max(0, x0), 0, Math.min(w, x1) - Math.max(0, x0), h);

    // 中线
    ctx.strokeStyle = 'rgba(255,255,255,0.13)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();

    // 波形：把视口映射到屏幕
    function drawWave(tFrom, tTo, color, alpha) {
      ctx.strokeStyle = color;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = Math.max(1, dpr);
      ctx.beginPath();
      var iFrom = Math.floor((tFrom / totalDur) * n);
      var iTo = Math.ceil((tTo / totalDur) * n);
      if (iTo <= iFrom) iTo = iFrom + 1;
      for (var i = iFrom; i < iTo; i++) {
        var t = (i / n) * totalDur;
        var x = Math.round(this.timeToX(t) * dpr) + 0.5;
        if (x < -2 || x > w + 2) continue;
        var v = peaks[U.clamp(i, 0, n - 1)];
        var y = mid - v * (mid - 2 * dpr);
        ctx.moveTo(x, y);
        ctx.lineTo(x, mid + v * (mid - 2 * dpr));
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    var self = this;
    ctx.save();
    drawWave.call(self, vS, this.start, '#5a6675', 0.85);
    drawWave.call(self, this.start, this.end, '#4fd1c5', 1);
    drawWave.call(self, this.end, vE, '#5a6675', 0.85);
    ctx.restore();

    // 悬停线
    if (this.hoverX !== undefined && !this.dragging) {
      var hx = Math.round(this.timeToX(this.hoverX) * dpr) + 0.5;
      if (hx >= 0 && hx <= w) {
        ctx.strokeStyle = 'rgba(255,255,255,0.2)';
        ctx.beginPath(); ctx.moveTo(hx, 0); ctx.lineTo(hx, h); ctx.stroke();
      }
    }

    // 视口边界（当前不是全段时显示）
    if (vS > 0.001 || vE < totalDur - 0.001) {
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4 * dpr, 4 * dpr]);
      ctx.beginPath(); ctx.moveTo(0, h - 1); ctx.lineTo(w, h - 1); ctx.stroke();
      ctx.setLineDash([]);
    }

    // 起止手柄（视野内才画）
    var hs = this.timeToX(this.start) * dpr;
    var he = this.timeToX(this.end) * dpr;
    [[hs, 'start'], [he, 'end']].forEach(function (pair) {
      var x = pair[0];
      if (x < -6 * dpr || x > w + 6 * dpr) return;
      ctx.strokeStyle = '#4fd1c5';
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      ctx.fillStyle = '#4fd1c5';
      ctx.fillRect(x - 3 * dpr, 0, 6 * dpr, 10 * dpr);
      ctx.fillRect(x - 3 * dpr, h - 10 * dpr, 6 * dpr, 10 * dpr);
    });

    // 视野外的手柄：边缘箭头指示
    var self2 = this;
    [['start', x0, -1], ['end', x1, 1]].forEach(function (info) {
      var x = info[1], dir = info[2];
      if (x >= -1 && x <= w + 1) return;
      var ex = dir < 0 ? 0 : w - 18 * dpr;
      ctx.fillStyle = 'rgba(79,209,197,0.75)';
      ctx.beginPath();
      ctx.moveTo(ex + 18 * dpr, mid);
      ctx.lineTo(ex, mid - 8 * dpr);
      ctx.lineTo(ex, mid + 8 * dpr);
      ctx.closePath();
      ctx.fill();
      void self2;
    });

    // 播放头
    if (this.playhead > 0) {
      var px2 = Math.round(this.timeToX(this.playhead) * dpr) + 0.5;
      if (px2 >= -2 && px2 <= w + 2) {
        ctx.strokeStyle = '#f6c667';
        ctx.lineWidth = 1.5 * dpr;
        ctx.beginPath(); ctx.moveTo(px2, 0); ctx.lineTo(px2, h); ctx.stroke();
        ctx.fillStyle = '#f6c667';
        ctx.beginPath();
        ctx.moveTo(px2 - 4 * dpr, 0); ctx.lineTo(px2 + 4 * dpr, 0); ctx.lineTo(px2, 6 * dpr);
        ctx.closePath(); ctx.fill();
      }
    }
  };

  /* 网格步长：按当前缩放选 1/2/5 × 10^n */
  TrimView.prototype._gridStep = function () {
    var span = this.viewSpan();
    var target = span / 8;
    var exp = Math.pow(10, Math.floor(Math.log10(target)));
    var n = target / exp;
    var m = n < 1.5 ? 1 : (n < 3.5 ? 2 : (n < 7.5 ? 5 : 10));
    return m * exp;
  };

  /* ================= 试听引擎 ================= */
  /* 独立通路：source → gain → destination
     不经过声部 ADSR 与滤波，保证听到的是素材原貌。 */
  function SampleAudition(ctx, destination) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 0.9;
    this.out.connect(destination || ctx.destination);

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.out.connect(this.analyser);
    this._meter = new Float32Array(this.analyser.fftSize);

    this.source = null;
    this.gainNode = null;
    this.buffer = null;
    this.playing = false;
    this.loop = false;
    this.startedAt = 0;
    this.offset = 0;
    this.duration = 0;
    this.rangeStart = 0;
    this.rangeEnd = 0;
    this.onEnd = null;
    this.onTick = null;
    this._raf = null;
  }

  SampleAudition.prototype.setVolume = function (v) {
    var g = U.clamp(v, 0, 2);
    try { this.out.gain.setTargetAtTime(g, this.ctx.currentTime, 0.01); }
    catch (e) { this.out.gain.value = g; }
  };

  /* 从 buffer 播放 [startSec, endSec) */
  SampleAudition.prototype.play = function (buffer, startSec, endSec, opts) {
    opts = opts || {};
    this.stop();
    if (!buffer) return false;

    var s = U.clamp(startSec || 0, 0, buffer.duration);
    var e = endSec > s ? U.clamp(endSec, 0, buffer.duration) : buffer.duration;
    var len = Math.max(0.005, e - s);

    var src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = U.clamp(opts.rate || 1, 0.0625, 16);

    var g = this.ctx.createGain();
    g.gain.value = 1;
    src.connect(g);
    g.connect(this.out);

    // 统一用当前时刻启动，避免 start(0, offset) 立即触发 onended
    var when = this.ctx.currentTime;

    src.loop = !!opts.loop;
    if (opts.loop) {
      src.loopStart = s;
      src.loopEnd = e;
      src.start(when, s);
    } else {
      src.start(when, s);
      // 停止点留 5ms 余量，避免与 onended 的边界竞争
      try { src.stop(when + len / src.playbackRate.value + 0.005); } catch (err) { /* noop */ }
    }

    var self = this;
    src.onended = function () {
      // 只处理当前活跃的 source，避免旧 source 的 onended 误伤新播放
      if (self.source !== src) return;
      self.playing = false;
      self.source = null;
      if (self._raf) { cancelAnimationFrame(self._raf); self._raf = null; }
      if (self.onEnd) self.onEnd();
    };

    this.source = src;
    this.gainNode = g;
    this.buffer = buffer;
    this.rangeStart = s;
    this.rangeEnd = e;
    this.playing = true;
    this.startedAt = this.ctx.currentTime;
    this.duration = len / src.playbackRate.value;

    if (opts.onTick) { this.onTick = opts.onTick; this._loop(); }
    return true;
  };

  SampleAudition.prototype._loop = function () {
    var self = this;
    function step() {
      if (!self.playing) return;
      var pos = self.ctx.currentTime - self.startedAt;
      if (self.onTick) self.onTick(Math.min(pos, self.duration));
      if (pos >= self.duration && !self.loop) {
        self.playing = false;
        if (self.onEnd) self.onEnd();
        return;
      }
      self._raf = requestAnimationFrame(step);
    }
    this._raf = requestAnimationFrame(step);
  };

  SampleAudition.prototype.stop = function () {
    if (this.source) {
      try { this.source.onended = null; this.source.stop(); } catch (e) { /* noop */ }
      try { this.source.disconnect(); } catch (e) { /* noop */ }
      this.source = null;
    }
    if (this.gainNode) {
      try { this.gainNode.disconnect(); } catch (e) { /* noop */ }
      this.gainNode = null;
    }
    this.playing = false;
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
  };

  SampleAudition.prototype.getLevel = function () {
    this.analyser.getFloatTimeDomainData(this._meter);
    var peak = 0;
    for (var i = 0; i < this._meter.length; i++) {
      var a = this._meter[i] < 0 ? -this._meter[i] : this._meter[i];
      if (a > peak) peak = a;
    }
    return peak;
  };

  /* ================= 物理裁剪 ================= */
  function sliceBuffer(ctx, buffer, startSec, endSec) {
    var sr = buffer.sampleRate;
    var s = U.clamp(Math.floor(startSec * sr), 0, buffer.length);
    var e = U.clamp(Math.ceil(endSec * sr), s + 1, buffer.length);
    var len = e - s;
    var ch = buffer.numberOfChannels;
    var out = ctx.createBuffer(ch, len, sr);
    for (var c = 0; c < ch; c++) {
      var src = buffer.getChannelData(c);
      out.copyToChannel(src.subarray(s, e), c);
    }
    return out;
  }

  /* 加增益（用于采样音量调整） */
  function applyGain(ctx, buffer, gain) {
    var out = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
    for (var c = 0; c < buffer.numberOfChannels; c++) {
      var src = buffer.getChannelData(c);
      var dst = new Float32Array(src.length);
      for (var i = 0; i < src.length; i++) dst[i] = U.clamp(src[i] * gain, -1, 1);
      out.copyToChannel(dst, c);
    }
    return out;
  }

  BS.trim = {
    TrimView: TrimView,
    SampleAudition: SampleAudition,
    sliceBuffer: sliceBuffer,
    applyGain: applyGain,
    MIN_SPAN: MIN_SPAN,
    MAX_ZOOM: MAX_ZOOM
  };

})(window);

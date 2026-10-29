/* BandSynth · widgets.js
 * 可复用手势控件：旋钮 / 推子 / 开关 / 滑条 / 下拉 / 数字输入
 * 全部支持鼠标 + 触摸 + 键盘微调，行为参照硬件面板。
 */
(function (global) {
  'use strict';
  var BS = global.BS;
  var U = BS.util;

  var W = BS.widgets = {};

  /* ---------------- 旋钮 ---------------- */
  /* opts: {min,max,value,default,step,curve:'lin'|'log',label,unit,onChange,bipolar} */
  W.knob = function (opts) {
    opts = opts || {};
    var min = opts.min === undefined ? 0 : opts.min;
    var max = opts.max === undefined ? 1 : opts.max;
    var value = opts.value === undefined ? (opts.default === undefined ? min : opts.default) : opts.value;
    var def = opts.default === undefined ? min : opts.default;
    var curve = opts.curve || 'lin';
    var unit = opts.unit || '';
    var bipolar = !!opts.bipolar;
    var onChange = opts.onChange || function () {};

    var root = document.createElement('div');
    root.className = 'knob-wrap';
    var knob = document.createElement('div');
    knob.className = 'knob' + (bipolar ? ' bipolar' : '');
    knob.tabIndex = 0;
    knob.setAttribute('role', 'slider');
    var arc = document.createElement('div');
    arc.className = 'knob-arc';
    var fill = document.createElement('div');
    fill.className = 'knob-fill';
    var pointer = document.createElement('div');
    pointer.className = 'knob-pointer';
    var readout = document.createElement('div');
    readout.className = 'knob-value';
    knob.appendChild(arc); knob.appendChild(fill); knob.appendChild(pointer);
    var label = document.createElement('div');
    label.className = 'knob-label';
    label.textContent = opts.label || '';
    root.appendChild(knob); root.appendChild(readout); root.appendChild(label);

    var A0 = -135, A1 = 135; // 角度范围

    function toNorm(v) {
      if (curve === 'log' && min > 0) {
        return Math.log(v / min) / Math.log(max / min);
      }
      return (v - min) / (max - min);
    }
    function fromNorm(t) {
      t = U.clamp(t, 0, 1);
      var v;
      if (curve === 'log' && min > 0) v = min * Math.pow(max / min, t);
      else v = min + (max - min) * t;
      if (opts.step) v = Math.round(v / opts.step) * opts.step;
      return U.clamp(v, min, max);
    }

    function fmt(v) {
      if (opts.format) return opts.format(v);
      if (unit === 'Hz') return v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 1 : 2) + 'k' : Math.round(v) + '';
      if (unit === 'ms') return v >= 1 ? v.toFixed(2) + 's' : Math.round(v * 1000) + 'ms';
      if (unit === 's') return v < 1 ? Math.round(v * 1000) + 'ms' : v.toFixed(2) + 's';
      if (unit === '%') return Math.round(v * 100) + '%';
      if (unit === 'dB') return (v <= 0.001 ? '-∞' : (20 * Math.log10(v)).toFixed(1));
      if (unit === 'ct') return Math.round(v) + 'ct';
      if (unit === 'st') return (v > 0 ? '+' : '') + v;
      if (Math.abs(v) >= 100) return Math.round(v).toString();
      if (Math.abs(v) >= 10) return v.toFixed(1);
      return v.toFixed(2);
    }

    function render() {
      var t = toNorm(value);
      var deg = A0 + (A1 - A0) * t;
      pointer.style.transform = 'rotate(' + deg + 'deg)';
      var pct = t * 100;
      if (bipolar) {
        var mid = 50;
        var a = Math.min(mid, pct), b = Math.max(mid, pct);
        fill.style.left = a + '%';
        fill.style.width = (b - a) + '%';
      } else {
        fill.style.left = '0%';
        fill.style.width = pct + '%';
      }
      readout.textContent = fmt(value);
      knob.setAttribute('aria-valuenow', String(value));
      knob.setAttribute('aria-valuetext', fmt(value));
    }

    function setValue(v, silent) {
      v = U.clamp(v, min, max);
      if (v === value) { render(); return; }
      value = v;
      render();
      if (!silent) onChange(value);
    }

    /* 拖拽 */
    var dragging = false, startY = 0, startVal = 0, moved = false;
    knob.addEventListener('pointerdown', function (e) {
      dragging = true; moved = false;
      startY = e.clientY; startVal = value;
      knob.setPointerCapture(e.pointerId);
      knob.classList.add('active');
      e.preventDefault();
    });
    knob.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dy = startY - e.clientY;
      if (Math.abs(dy) > 2) moved = true;
      var sens = e.shiftKey ? 0.0015 : 0.006; // Shift 微调
      var range = (max - min);
      var delta;
      if (curve === 'log' && min > 0) {
        var t0 = toNorm(startVal);
        delta = dy * sens;
        setValue(fromNorm(t0 + delta));
      } else {
        delta = (dy * range * sens);
        setValue(startVal + delta);
      }
    });
    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      knob.classList.remove('active');
      try { knob.releasePointerCapture(e.pointerId); } catch (err) { /* noop */ }
      if (!moved) { /* 点击复位到默认值 */ }
    }
    knob.addEventListener('pointerup', endDrag);
    knob.addEventListener('pointercancel', endDrag);

    knob.addEventListener('dblclick', function () { setValue(def); });

    knob.addEventListener('wheel', function (e) {
      e.preventDefault();
      var dir = e.deltaY > 0 ? -1 : 1;
      var t = toNorm(value) + dir * (e.shiftKey ? 0.005 : 0.025);
      setValue(fromNorm(t));
    }, { passive: false });

    knob.addEventListener('keydown', function (e) {
      var stepT = e.shiftKey ? 0.005 : 0.02;
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { setValue(fromNorm(toNorm(value) + stepT)); e.preventDefault(); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { setValue(fromNorm(toNorm(value) - stepT)); e.preventDefault(); }
      if (e.key === 'Home') { setValue(def); e.preventDefault(); }
    });

    render();
    return {
      el: root, knob: knob,
      get value() { return value; },
      set: function (v) { setValue(v, true); },
      setLabel: function (s) { label.textContent = s; },
      setUnit: function (u) { unit = u; render(); }
    };
  };

  /* ---------------- 水平滑条（推子） ---------------- */
  W.slider = function (opts) {
    opts = opts || {};
    var min = opts.min === undefined ? 0 : opts.min;
    var max = opts.max === undefined ? 1 : opts.max;
    var value = opts.value === undefined ? (opts.default || 0) : opts.value;
    var def = opts.default === undefined ? min : opts.default;
    var onChange = opts.onChange || function () {};

    var root = document.createElement('div');
    root.className = 'slider-wrap';
    if (opts.label) {
      var lb = document.createElement('div');
      lb.className = 'slider-label';
      lb.textContent = opts.label;
      root.appendChild(lb);
    }
    var input = document.createElement('input');
    input.type = 'range';
    input.className = 'slider';
    input.min = min; input.max = max;
    input.step = opts.step || (max - min) / 200;
    input.value = value;
    var val = document.createElement('div');
    val.className = 'slider-value';
    root.appendChild(input); root.appendChild(val);

    function fmt(v) {
      if (opts.format) return opts.format(v);
      if (opts.unit === 'dB') return v <= 0.001 ? '-∞' : (20 * Math.log10(v)).toFixed(1) + 'dB';
      if (opts.unit === '%') return Math.round(v * 100) + '%';
      return opts.unit === 'pan'
        ? (v === 0 ? 'C' : (v < 0 ? 'L' + Math.round(-v * 100) : 'R' + Math.round(v * 100)))
        : v.toFixed(2);
    }
    function render() { val.textContent = fmt(value); }
    input.addEventListener('input', function () {
      value = parseFloat(input.value);
      render();
      onChange(value);
    });
    input.addEventListener('dblclick', function () { value = def; input.value = def; render(); onChange(value); });
    render();

    return {
      el: root, input: input,
      get value() { return value; },
      set: function (v) { value = v; input.value = v; render(); }
    };
  };

  /* ---------------- 按钮组（分段选择） ---------------- */
  W.segment = function (opts) {
    opts = opts || {};
    var options = opts.options || [];
    var value = opts.value !== undefined ? opts.value : options[0];
    var onChange = opts.onChange || function () {};

    var root = document.createElement('div');
    root.className = 'segment';
    if (opts.label) {
      var lb = document.createElement('div');
      lb.className = 'segment-label';
      lb.textContent = opts.label;
      root.appendChild(lb);
    }
    var box = document.createElement('div');
    box.className = 'segment-box';
    root.appendChild(box);

    var btns = [];
    options.forEach(function (o) {
      var val = (o.value !== undefined) ? o.value : o;
      var txt = (o.label !== undefined) ? o.label : o;
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'seg-btn';
      b.textContent = txt;
      b.title = o.title || txt;
      b.addEventListener('click', function () { set(val); onChange(val); });
      box.appendChild(b);
      btns.push({ b: b, v: val });
    });

    function set(v) {
      value = v;
      btns.forEach(function (x) { x.b.classList.toggle('active', x.v === v); });
    }
    set(value);

    return {
      el: root,
      get value() { return value; },
      set: set
    };
  };

  /* ---------------- 开关 ---------------- */
  W.toggle = function (opts) {
    opts = opts || {};
    var on = !!opts.value;
    var root = document.createElement('button');
    root.type = 'button';
    root.className = 'toggle' + (on ? ' on' : '');
    root.textContent = opts.label || '';
    root.addEventListener('click', function () {
      on = !on;
      root.classList.toggle('on', on);
      (opts.onChange || function () {})(on);
    });
    return {
      el: root,
      get value() { return on; },
      set: function (v) { on = !!v; root.classList.toggle('on', on); }
    };
  };

  /* ---------------- 下拉 ---------------- */
  W.select = function (opts) {
    opts = opts || {};
    var sel = document.createElement('select');
    sel.className = 'select' + (opts.className ? ' ' + opts.className : '');
    (opts.options || []).forEach(function (o) {
      var v = (o.value !== undefined) ? o.value : o;
      var t = (o.label !== undefined) ? o.label : o;
      var op = document.createElement('option');
      op.value = v; op.textContent = t;
      sel.appendChild(op);
    });
    if (opts.value !== undefined) sel.value = opts.value;
    sel.addEventListener('change', function () {
      var v = sel.value;
      (opts.onChange || function () {})(v);
    });
    return {
      el: sel,
      get value() { return sel.value; },
      set: function (v) { sel.value = v; },
      setOptions: function (list) {
        sel.innerHTML = '';
        list.forEach(function (o) {
          var v = (o.value !== undefined) ? o.value : o;
          var t = (o.label !== undefined) ? o.label : o;
          var op = document.createElement('option');
          op.value = v; op.textContent = t;
          sel.appendChild(op);
        });
      }
    };
  };

  /* ---------------- 数字输入 ---------------- */
  W.number = function (opts) {
    opts = opts || {};
    var input = document.createElement('input');
    input.type = 'number';
    input.className = 'num';
    if (opts.min !== undefined) input.min = opts.min;
    if (opts.max !== undefined) input.max = opts.max;
    if (opts.step !== undefined) input.step = opts.step;
    input.value = opts.value === undefined ? 0 : opts.value;
    var onChange = opts.onChange || function () {};
    function commit() {
      var v = parseFloat(input.value);
      if (isNaN(v)) v = opts.default || 0;
      if (opts.min !== undefined) v = Math.max(opts.min, v);
      if (opts.max !== undefined) v = Math.min(opts.max, v);
      input.value = v;
      onChange(v);
    }
    input.addEventListener('change', commit);
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { commit(); input.blur(); } });
    return {
      el: input,
      get value() { return parseFloat(input.value) || 0; },
      set: function (v) { input.value = v; }
    };
  };

  /* ---------------- 简易折叠面板 ---------------- */
  W.panel = function (title, opts) {
    opts = opts || {};
    var root = document.createElement('div');
    root.className = 'panel' + (opts.collapsed ? ' collapsed' : '');
    var head = document.createElement('div');
    head.className = 'panel-head';
    var h = document.createElement('span');
    h.className = 'panel-title';
    h.textContent = title;
    var chev = document.createElement('span');
    chev.className = 'panel-chevron';
    chev.textContent = '▾';
    head.appendChild(h); head.appendChild(chev);
    var body = document.createElement('div');
    body.className = 'panel-body';
    root.appendChild(head); root.appendChild(body);
    head.addEventListener('click', function () { root.classList.toggle('collapsed'); });
    return {
      el: root, body: body,
      add: function (child) { body.appendChild(child); return child; }
    };
  };

  /* ---------------- 参数行（旋钮 + 标签） ---------------- */
  W.row = function () {
    var row = document.createElement('div');
    row.className = 'knob-row';
    for (var i = 0; i < arguments.length; i++) {
      if (arguments[i]) row.appendChild(arguments[i]);
    }
    return row;
  };

  W.field = function (label, control) {
    var f = document.createElement('label');
    f.className = 'field';
    var l = document.createElement('span');
    l.className = 'field-label';
    l.textContent = label;
    f.appendChild(l);
    f.appendChild(control.el || control);
    return f;
  };

})(window);

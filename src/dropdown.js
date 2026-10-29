/* ============================================================
 * 深色下拉框（替代原生 <select> 的弹层）
 * ------------------------------------------------------------
 * 原生 <select> 有两个绕不过去的问题：
 *   1. 展开的选项列表由操作系统绘制，配色跟界面不统一（Windows 上是白底），
 *      CSS 只能改到「收起时的样子」，改不动那张下拉面板；
 *   2. 一旦把焦点交给它，空格/方向键就被它吃掉（按空格是展开下拉而不是播放），
 *      而如果在 change 时 blur 掉，用方向键浏览选项时会「还没选完就被关掉」。
 *
 * 这里的做法：原生 select 原地保留当**数据与事件载体**（value / options /
 * selectedIndex / change 全部照旧，业务代码一行都不用改），只把它变成不可见；
 * 旁边放一个同样式的按钮 + 自绘深色弹层。选择时写回 select 并派发 change，
 * 关闭后立刻把焦点还给页面。
 * ============================================================ */
(function (global) {
  'use strict';

  var BS = global.BS = global.BS || {};
  var DD = BS.dropdown = {};

  var uid = 0;
  var openState = null;      // { sel, btn, menu, rows, hover }

  function isSelect(el) {
    return !!el && el.tagName === 'SELECT';
  }

  /** 当前选中项的文字 */
  function labelOf(sel) {
    var op = sel.options[sel.selectedIndex];
    if (!op) return '';
    return (op.textContent || op.value || '').trim();
  }

  /** 把 options/optgroup 摊平成菜单项（分组头用 group 字段标记） */
  function itemsOf(sel) {
    var out = [];
    Array.prototype.forEach.call(sel.children, function (node) {
      if (node.tagName === 'OPTGROUP') {
        out.push({ group: node.label || '' });
        Array.prototype.forEach.call(node.children, function (op) {
          if (op.tagName !== 'OPTION') return;
          out.push({ value: op.value, label: (op.textContent || op.value).trim(), disabled: !!op.disabled });
        });
      } else if (node.tagName === 'OPTION') {
        out.push({ value: node.value, label: (node.textContent || node.value).trim(), disabled: !!node.disabled });
      }
    });
    return out;
  }

  /** 关掉当前弹层（不移除焦点之外的其它状态） */
  function close() {
    if (!openState) return;
    var st = openState;
    openState = null;
    document.removeEventListener('pointerdown', onDocDown, true);
    document.removeEventListener('keydown', onDocKey, true);
    global.removeEventListener('resize', close);
    if (st.menu && st.menu.parentNode) st.menu.parentNode.removeChild(st.menu);
  }

  /** 关闭并把焦点还给页面：这样接着按快捷键/弹琴都不会被按钮吃掉 */
  function closeAndRelease() {
    var btn = openState && openState.btn;
    close();
    if (btn && btn.blur) { try { btn.blur(); } catch (e) { /* noop */ } }
  }

  function onDocDown(e) {
    if (!openState) return;
    var t = e.target;
    if (openState.menu && openState.menu.contains(t)) return;
    if (openState.btn && openState.btn.contains(t)) return;
    closeAndRelease();
  }

  /* 弹层打开期间的键盘操作。挂在 document 上而不是按钮上：
     即使焦点被别处（例如全局焦点回收）移走，方向键依然能用来选。 */
  function onDocKey(e) {
    if (!openState) return;
    var k = e.key;
    if (k === 'Escape' || e.keyCode === 27) {
      e.preventDefault(); e.stopPropagation();
      closeAndRelease();
      return;
    }
    if (k === 'Tab') { close(); return; }               // 让焦点正常走开
    if (k === 'ArrowDown' || k === 'Down') {
      e.preventDefault(); e.stopPropagation(); move(1); return;
    }
    if (k === 'ArrowUp' || k === 'Up') {
      e.preventDefault(); e.stopPropagation(); move(-1); return;
    }
    if (k === 'Home') {
      e.preventDefault(); e.stopPropagation(); openState.hover = openState.rows[0];
      highlight(openState.menu, openState.hover); return;
    }
    if (k === 'End') {
      e.preventDefault(); e.stopPropagation();
      openState.hover = openState.rows[openState.rows.length - 1];
      highlight(openState.menu, openState.hover); return;
    }
    if (k === 'Enter' || k === ' ' || k === 'Spacebar') {
      e.preventDefault(); e.stopPropagation();
      if (openState.hover) commit(openState.hover.dataset.value);
    }
  }

  function highlight(menu, row) {
    Array.prototype.forEach.call(menu.querySelectorAll('.dd-item.hover'), function (r) {
      r.classList.remove('hover');
    });
    if (!row) return;
    row.classList.add('hover');
    if (row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
  }

  function move(rowDelta) {
    if (!openState) return;
    var rows = openState.rows;
    if (!rows || !rows.length) return;
    var cur = rows.indexOf(openState.hover);
    var next;
    if (cur < 0) next = rowDelta > 0 ? 0 : rows.length - 1;
    else next = (cur + rowDelta + rows.length) % rows.length;
    openState.hover = rows[next];
    highlight(openState.menu, rows[next]);
  }

  function commit(value) {
    if (!openState) return;
    var sel = openState.sel;
    closeAndRelease();
    // 和原生 select 一致：重复选同一项不派发 change（避免重复加载采样等副作用）
    if (sel.value === value) return;
    sel.value = value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** 打开某条 select 的弹层 */
  function open(btn, sel) {
    if (openState && openState.btn === btn) { closeAndRelease(); return; }
    close();
    var items = itemsOf(sel);
    if (!items.length) return;

    var menu = document.createElement('div');
    menu.className = 'dd-menu';
    menu.setAttribute('role', 'listbox');

    var rows = [];
    var hoverRow = null;
    items.forEach(function (it) {
      if (it.group !== undefined) {
        var gh = document.createElement('div');
        gh.className = 'dd-group';
        gh.textContent = it.group;
        menu.appendChild(gh);
        return;
      }
      var row = document.createElement('div');
      row.className = 'dd-item' + (it.disabled ? ' is-disabled' : '') +
        (it.value === sel.value ? ' is-on' : '');
      row.textContent = it.label;
      row.dataset.value = it.value;
      row.setAttribute('role', 'option');
      menu.appendChild(row);
      if (!it.disabled) {
        rows.push(row);
        if (it.value === sel.value) hoverRow = row;
      }
    });
    if (!rows.length) return;
    document.body.appendChild(menu);

    // 定位：默认往下弹，下面放不下且上面更宽裕时往上翻
    var r = btn.getBoundingClientRect();
    var mw = Math.max(120, Math.round(r.width));
    menu.style.minWidth = mw + 'px';
    var mh = menu.offsetHeight;
    var spaceBelow = global.innerHeight - r.bottom - 8;
    var spaceAbove = r.top - 8;
    var top;
    if (mh <= spaceBelow || spaceBelow >= spaceAbove) top = r.bottom + 4;
    else top = Math.max(8, r.top - mh - 4);
    var left = Math.min(r.left, global.innerWidth - menu.offsetWidth - 8);
    menu.style.left = Math.max(8, Math.round(left)) + 'px';
    menu.style.top = Math.max(8, Math.round(top)) + 'px';

    openState = { sel: sel, btn: btn, menu: menu, rows: rows, hover: hoverRow || rows[0] };
    highlight(menu, openState.hover);

    menu.addEventListener('click', function (e) {
      var row = e.target.closest ? e.target.closest('.dd-item') : null;
      if (!row || row.classList.contains('is-disabled')) return;
      commit(row.dataset.value);
    });
    menu.addEventListener('mousemove', function (e) {
      var row = e.target.closest ? e.target.closest('.dd-item') : null;
      if (!row || row.classList.contains('is-disabled')) return;
      openState.hover = row;
      highlight(menu, row);
    });
    // 弹层里按下鼠标不要把焦点从按钮抢走（否则方向键导航会断）
    menu.addEventListener('pointerdown', function (e) { e.preventDefault(); });

    document.addEventListener('pointerdown', onDocDown, true);
    document.addEventListener('keydown', onDocKey, true);
    global.addEventListener('resize', close);
    btn.focus();
  }

  /** 增强一个原生 select；重复调用安全 */
  function enhance(sel) {
    if (!isSelect(sel) || sel._dd) return sel && sel._dd;
    var baseClass = sel.className || '';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dd-btn' + (baseClass ? ' ' + baseClass : '');
    btn.setAttribute('aria-haspopup', 'listbox');
    var lab = document.createElement('span');
    lab.className = 'dd-label';
    var car = document.createElement('span');
    car.className = 'dd-caret';
    btn.appendChild(lab);
    btn.appendChild(car);

    // 原生 select 退居幕后：保留语义/事件，视觉与交互都交给按钮
    if (!sel.id) sel.id = 'ddsel' + (++uid);
    sel.classList.add('dd-native');
    sel.setAttribute('tabindex', '-1');
    sel.parentNode.insertBefore(btn, sel);
    if (sel.style.width) btn.style.width = sel.style.width;

    function syncLabel() {
      var t = labelOf(sel);
      lab.textContent = t;
      btn.title = t;
      btn.disabled = !!sel.disabled;
    }
    syncLabel();

    // 业务代码可能直接写 sel.value / selectedIndex（初始化、外部状态同步）：
    // 包一层 setter，保证按钮文字跟着变，不需要调用方额外派发 change。
    var proto = global.HTMLSelectElement && global.HTMLSelectElement.prototype;
    if (proto) {
      ['value', 'selectedIndex'].forEach(function (prop) {
        var desc = Object.getOwnPropertyDescriptor(proto, prop);
        if (!desc || !desc.set) return;
        Object.defineProperty(sel, prop, {
          configurable: true,
          get: function () { return desc.get.call(sel); },
          set: function (v) { desc.set.call(sel, v); syncLabel(); }
        });
      });
    }

    sel.addEventListener('change', syncLabel);
    // options 被重建（TonePicker.fillSelect 之类）时刷新显示
    var mo = new MutationObserver(syncLabel);
    mo.observe(sel, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['label', 'disabled'] });

    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      open(btn, sel);
    });
    btn.addEventListener('keydown', function (e) {
      if (btn.disabled) return;
      var k = e.key;
      if (k === 'ArrowDown' || k === 'Down') {
        e.preventDefault(); e.stopPropagation();
        if (!openState || openState.btn !== btn) open(btn, sel);
        else move(1);
      } else if (k === 'ArrowUp' || k === 'Up') {
        e.preventDefault(); e.stopPropagation();
        if (!openState || openState.btn !== btn) open(btn, sel);
        else move(-1);
      } else if (k === 'Enter' || k === ' ' || k === 'Spacebar') {
        e.preventDefault(); e.stopPropagation();
        if (!openState || openState.btn !== btn) open(btn, sel);
        else if (openState.hover) commit(openState.hover.dataset.value);
      } else if (k === 'Escape') {
        if (openState && openState.btn === btn) { e.preventDefault(); closeAndRelease(); }
      }
    });
    // 打开时点按钮不希望在菜单外被当成「点击外部」直接关掉（onDocDown 已排除 btn）

    sel._dd = { btn: btn, syncLabel: syncLabel, mo: mo };
    return sel._dd;
  }

  /** 批量增强（含后续动态插入的 select） */
  DD.enhanceAll = function (root) {
    root = root || document;
    var list = root.querySelectorAll ? root.querySelectorAll('select') : [];
    Array.prototype.forEach.call(list, enhance);
    return list.length;
  };

  DD.enhance = enhance;
  DD.close = closeAndRelease;

  /** 自动增强：页面上任何时刻出现的 select 都会变成深色下拉 */
  DD.auto = function () {
    if (DD._auto) return;
    DD._auto = true;
    DD.enhanceAll(document);
    /* 动态插入的 select（弹窗、声部选择器、音色列表……）。
       编曲页会频繁重建大量节点，这里按帧合并成一次全量扫描，
       已经增强过的元素在 enhance() 里直接返回，成本很低。 */
    var pending = false;
    var raf = global.requestAnimationFrame || function (fn) { return setTimeout(fn, 16); };
    var mo = new MutationObserver(function (records) {
      if (pending) return;
      var hasAdd = records.some(function (r) { return r.addedNodes && r.addedNodes.length; });
      if (!hasAdd) return;
      pending = true;
      raf(function () { pending = false; DD.enhanceAll(document); });
    });
    mo.observe(document.body, { childList: true, subtree: true });
    DD._mo = mo;
  };

})(typeof window !== 'undefined' ? window : this);

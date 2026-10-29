/* BandSynth · keyboard-arbiter.js
 * 键盘仲裁器：整个应用**只有一个** keydown/keyup 入口。
 *
 * ── 为什么需要它 ──
 * 之前鼓组、合成器键盘、播放控制、编曲录制各自在 window 上监听 keydown，
 * 后果：
 *   · 在演奏页按 S → 鼓组军鼓响 + 键盘也响（同时发声）
 *   · 空格既是底鼓又是播放/暂停 → 两边都触发
 *   · 各监听器互相抢 preventDefault，行为不可预测
 *
 * 仲裁器把按键**分发**给唯一消费者：
 *   1. 按键先过「拦截表」（全局快捷键：Esc、←→、[] 等）
 *   2. 再按当前「上下文」决定谁能处理（演奏页 / 鼓组页 / 编曲页…）
 *   3. 同一时刻同一把键**只交给一个**消费者
 *
 * 上下文由页面切换时调用 Arbiter.setContext() 设定。
 */
(function (global) {
  'use strict';
  var BS = global.BS;

  var Arbiter = BS.keyArb = {
    /* 当前上下文：'perform' | 'drums' | 'arrange' | 'other' */
    context: 'perform',
    /* 消费者：实时读取，不做快照（见 setContext 注释） */
    _synthHandler: null,
    _drumsHandler: null,
    _recHandler: null,
    _synthEnabled: true,
    _drumsEnabled: true,
    _bound: false,
    _held: new Set()
  };

  /* ================= 上下文 ================= */

  /**
   * 设定当前键盘上下文。
   * @param ctx    'perform' | 'drums' | 'arrange' | 'other'
   * @param opts   { synth: bool, drums: bool }  该上下文下哪些消费者可用
   */
  /* 切换键盘上下文。
   * ⚠️ 这里**只记录上下文，不快照 handler**。
   * 早期实现把 handler 快照进 _handlers，结果：
   *   boot 时 setContext('perform') → 键盘还没建立 → _handlers.synth = null
   *   之后键盘注册 setSynthHandler(fn) → 只更新 _synthHandler，_handlers.synth 仍是 null
   *   → 演奏页永远无声（而切到鼓组页会重新组装，反而正常）
   * 现在改为分发时**实时读取** handler，注册时机不再影响可用性。 */
  Arbiter.setContext = function (ctx, opts) {
    opts = opts || {};
    Arbiter.context = ctx;
    if (opts.synth !== undefined) Arbiter._synthEnabled = opts.synth !== false;
    if (opts.drums !== undefined) Arbiter._drumsEnabled = opts.drums !== false;
    // 切换上下文时释放所有按住的键，避免残留
    Arbiter.releaseAll();
  };

  /** 注册录制处理函数 */
  Arbiter.setRecHandler = function (fn) {
    Arbiter._recHandler = fn;
    if (Arbiter.context === 'arrange') Arbiter._recHandler = fn;
  };

  /* 取当前上下文对应的 handler（实时读取，不缓存） */
  Arbiter.handlerFor = function (ctx) {
    if (ctx === 'perform') {
      // 演奏页：**只有合成器**，鼓不参与（避免与键盘同时发声）
      return Arbiter._synthEnabled === false ? null : (Arbiter._synthHandler || null);
    }
    if (ctx === 'drums') {
      return Arbiter._drumsEnabled === false ? null : (Arbiter._drumsHandler || null);
    }
    if (ctx === 'arrange') {
      return Arbiter._recHandler || null;
    }
    return null;
  };

  /** 注册处理函数 */
  Arbiter.setHandler = function (name, fn) {
    if (name === 'rec') Arbiter._recHandler = fn;
    else if (name === 'synth') Arbiter._synthHandler = fn;
    else if (name === 'drums') Arbiter._drumsHandler = fn;
  };

  /* 注册处理函数。
   * ⚠️ 自动 bind：调用方常直接传方法引用（如 kb._handleKey），
   * 那样 this 会丢失 → 内部访问 this.xxx 报错 → 键盘整个失效。
   * 这里统一 bind 到归属对象上，杜绝这类事故。 */
  Arbiter.setSynthHandler = function (fn, owner) {
    Arbiter._synthOwner = owner || null;
    Arbiter._synthHandler = fn ? fn.bind(owner) : null;
  };
  Arbiter.setDrumsHandler = function (fn, owner) {
    Arbiter._drumsOwner = owner || null;
    Arbiter._drumsHandler = fn ? fn.bind(owner) : null;
  };
  Arbiter.setRecHandler = function (fn, owner) {
    Arbiter._recOwner = owner || null;
    Arbiter._recHandler = fn ? fn.bind(owner) : null;
  };

  /* ================= 全局快捷键（优先级最高） ================= */
  /* 这些键不属于任何「乐器」，由应用层直接处理 */
  /* 全局快捷键。
   * ⚠️ '[' / ']' **不是**快捷键 —— 它们是 2 号区的演奏键
   *    （[ = 2 区第 9 键，] = 第 11 键）。音域切换只由方向键负责。 */
  var GLOBAL = {
    'Escape': 'stop',
    'ArrowLeft': 'octaveDown',
    'ArrowRight': 'octaveUp'
  };

  Arbiter.GLOBAL = GLOBAL;

  /* ================= 分发 ================= */

  function isTypingTarget(e) {
    var t = e.target;
    if (!t) return false;
    var tag = (t.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    return !!t.isContentEditable;
  }

  Arbiter._onKeyDown = function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTypingTarget(e)) return;
    if (e.repeat) return;

    var k = e.key;
    /* 部分输入法/远程桌面场景下 e.key 可能是 'Unidentified'，
     * 这时用 e.code（物理按键）兜底：'KeyQ' → 'q'。 */
    if (!k || k === 'Unidentified') {
      if (e.code && /^Key[A-Z]$/.test(e.code)) k = e.code.slice(3).toLowerCase();
      else if (e.code === 'Space') k = ' ';
    }

    // 1) 全局快捷键
    if (GLOBAL[k]) {
      if (Arbiter._globalHandler) {
        e.preventDefault();
        Arbiter._globalHandler(GLOBAL[k], e);
      }
      return;
    }

    // 2) 空格：全局（播放/暂停）优先，鼓组页/录制中让给底鼓
    if (k === ' ') {
      if (Arbiter.context === 'drums' || Arbiter.context === 'arrange') {
        /* 鼓组页：空格 = 底鼓；
           编曲录制中：空格同样是底鼓（否则按空格会停掉正在录的走带）。 */
        var dh = Arbiter.handlerFor(Arbiter.context);
        if (dh) { e.preventDefault(); dh(' ', e); return; }
      }
      // 其它页面：空格 = 播放/暂停
      if (Arbiter._globalHandler) {
        e.preventDefault();
        Arbiter._globalHandler('playPause', e);
      }
      return;
    }

    // 3) 乐器分发：按上下文只交给一个消费者（实时读取 handler）
    var handler = Arbiter.handlerFor(Arbiter.context);
    if (!handler) return;

    var key = k.length === 1 ? k.toLowerCase() : k;
    if (Arbiter._held.has(key)) return;
    Arbiter._held.add(key);
    e.preventDefault();
    handler(key, e);
  };

  Arbiter._onKeyUp = function (e) {
    if (isTypingTarget(e)) return;
    var k = e.key;
    if (!k || k === 'Unidentified') {
      if (e.code && /^Key[A-Z]$/.test(e.code)) k = e.code.slice(3).toLowerCase();
      else if (e.code === 'Space') k = ' ';
    }
    var key = k.length === 1 ? k.toLowerCase() : k;
    Arbiter._held.delete(key);

    if (GLOBAL[k]) {
      if (Arbiter._globalHandler) Arbiter._globalHandler(GLOBAL[k] + 'Up', e);
      return;
    }
    if (k === ' ') {
      if (Arbiter.context === 'drums' || Arbiter.context === 'arrange') {
        var dh = Arbiter.handlerFor(Arbiter.context);
        if (dh) { dh(' ', e, true); return; }
      }
      if (Arbiter._globalHandler) Arbiter._globalHandler('playPauseUp', e);
      return;
    }

    var handler = Arbiter.handlerFor(Arbiter.context);
    if (handler) handler(key, e, true);
  };

  /** 释放所有按住的键（切上下文时用） */
  Arbiter.releaseAll = function () {
    var keys = Array.from(Arbiter._held);
    Arbiter._held.clear();
    var ctx = Arbiter.context;
    keys.forEach(function (k) {
      var handler = Arbiter.handlerFor(ctx);
      if (handler) {
        try { handler(k, null, true); } catch (e) { /* noop */ }
      }
    });
  };

  /** 绑定（只绑一次） */
  Arbiter.bind = function () {
    if (Arbiter._bound) return;
    Arbiter._bound = true;
    // 用**捕获阶段**监听：即使事件不冒泡也能收到（合成事件、
    // 某些嵌入式 iframe 场景下冒泡不可靠）
    global.addEventListener('keydown', Arbiter._onKeyDown, true);
    global.addEventListener('keyup', Arbiter._onKeyUp, true);
    // 失焦时释放所有键
    global.addEventListener('blur', function () { Arbiter.releaseAll(); });
  };

  /* ================= 冲突自检 ================= */
  /* 列出所有键位占用，标出「同上下文内」的冲突。
   * ⚠️ 演奏页的键位表**从 BS.keymodes 实时生成**，不能写死。
   *    写死的表会和真实键位脱节 —— 之前 '[' ']' 还留在全局表里，
   *    而它们其实是 2 号区的演奏键。 */

  function zoneKeysOf(zoneId) {
    if (!global.BS || !global.BS.keymodes) return [];
    return global.BS.keymodes.zoneKeys(zoneId).slice();
  }

  function buildOccupancy() {
    var z1 = zoneKeysOf(1), z2 = zoneKeysOf(2), z3 = zoneKeysOf(3), z4 = zoneKeysOf(4);
    return {
      perform: {
        'z1': '合成器音高（1号区）',
        'z2': '合成器音高（2号区）',
        'z3': '合成器音高（3号区）',
        'z4': '合成器音高（4号区）'
      },
      performZones: { 1: z1, 2: z2, 3: z3, 4: z4 },
      drums: {
        'space s d f j k q w e r t g': '鼓组触发'
      },
      global: {
        'space': '播放/暂停（鼓组页为底鼓）',
        'Escape': '全部停止',
        'ArrowLeft ArrowRight': '音域切换'
      }
    };
  }
  var OCCUPANCY = buildOccupancy();
  Arbiter.OCCUPANCY = OCCUPANCY;
  /** 键位表变更后刷新（音区定义改了要调用） */
  Arbiter.refreshOccupancy = function () {
    OCCUPANCY = buildOccupancy();
    Arbiter.OCCUPANCY = OCCUPANCY;
    return OCCUPANCY;
  };

  /**
   * 冲突检查：同上下文内的键位重叠 + 全局键被乐器占用。
   * 返回 { errors: [], notes: [] }
   */
  Arbiter.checkConflicts = function () {
    var errors = [], notes = [];
    var ctxKeys = {};

    function parse(list) { return list.trim().split(/\s+/); }

  /* 列出所有键位占用，标出「同上下文内」的冲突。
   * ⚠️ 演奏页的键位表**从 BS.keymodes 实时生成**，不能写死。
   *    写死的表会和真实键位脱节 —— 之前 '[' ']' 还留在全局表里，
   *    而它们其实是 2 号区的演奏键。 */

  function zoneKeysOf(zoneId) {
    if (!global.BS || !global.BS.keymodes) return [];
    return global.BS.keymodes.zoneKeys(zoneId).slice();
  }

  function buildOccupancy() {
    var z1 = zoneKeysOf(1), z2 = zoneKeysOf(2), z3 = zoneKeysOf(3), z4 = zoneKeysOf(4);
    return {
      perform: {
        'z1': '合成器音高（1号区）',
        'z2': '合成器音高（2号区）',
        'z3': '合成器音高（3号区）',
        'z4': '合成器音高（4号区）'
      },
      performZones: { 1: z1, 2: z2, 3: z3, 4: z4 },
      drums: {
        'space s d f j k q w e r t g': '鼓组触发'
      },
      global: {
        'space': '播放/暂停（鼓组页为底鼓）',
        'Escape': '全部停止',
        'ArrowLeft ArrowRight': '音域切换'
      }
    };
  }
  var OCCUPANCY = buildOccupancy();
  Arbiter.OCCUPANCY = OCCUPANCY;
  /** 键位表变更后刷新（音区定义改了要调用） */
  Arbiter.refreshOccupancy = function () {
    OCCUPANCY = buildOccupancy();
    Arbiter.OCCUPANCY = OCCUPANCY;
    return OCCUPANCY;
  };
    // 2) 鼓组页内部：与全局键重叠
    var drumKeys = parse(OCCUPANCY.drums['space s d f j k q w e r t g']);
    var globalKeys = [];
    Object.keys(OCCUPANCY.global).forEach(function (k) {
      globalKeys = globalKeys.concat(parse(OCCUPANCY.global[k]));
    });
    var dgOverlap = drumKeys.filter(function (k) { return globalKeys.indexOf(k) >= 0; });
    if (dgOverlap.length) {
      // 空格是特例：鼓组页由底鼓接管，其它页面是播放 —— 已在分发器里裁决
      var realConflict = dgOverlap.filter(function (k) { return k !== 'space'; });
      if (realConflict.length) {
        errors.push('鼓组键与全局键冲突：' + realConflict.join(','));
      } else {
        notes.push('空格在鼓组页为底鼓、其它页为播放（已由仲裁器按页签裁决）');
      }
    }

    // 3) 演奏页：鼓键不得生效（已在分发器里保证）
    notes.push('演奏页只分发给合成器，鼓键不生效（避免与键盘同时发声）');
    notes.push('鼓组页只分发给鼓组，合成器键不生效');

    return { errors: errors, notes: notes, ok: errors.length === 0 };
  };

})(typeof window !== 'undefined' ? window : globalThis);

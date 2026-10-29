/* BandSynth · keymodes.js
 * 键盘映射体系：四个「音区」+ 动态音域适配。
 *
 * ── 音区设计 ──
 * 一个八度 = 12 个半音。每个音区横跨一个八度，用一组键表示：
 *
 *   1 号区   q 1 w 2 e 3 r 4 t 5 y 6 u     → C .. B（12 个半音 = 1 个八度）
 *   2 号区   7 i 8 o 9 p 0 [ - ] =         → 紧接 1 号区
 *   3 号区   z a x s c d v f b g n h     → 独立一个八度
 *   4 号区   m j , k . l / ; '            → 再一个八度
 *
 * ── 音区与音高的对应（随当前音域自适应）──
 * 老板给的规则：当前范围 c3-c7 时，1号区=c3、2号区=c5、3号区=c4、4号区=c6。
 * 注意这不是简单顺序 —— 2 号区比 3 号区高。
 *
 * 归纳成「八度偏移表」：以当前范围最低的八度为基准（记为 base），
 *   1 号区 → base + 0
 *   2 号区 → base + 2
 *   3 号区 → base + 1
 *   4 号区 → base + 3
 * 正好对上 c3-c7：base=c3 → 1号=c3、2号=c5、3号=c4、4号=c6 ✓
 *
 * 音域变化时（换八度、改音区数）自动重算，不用改代码。
 *
 * ── 双手模式 ──
 * 1 号区 / 3 号区 = 根音（左手）
 * 2 号区 / 4 号区 = 级数（右手），4 号区高一个八度
 * 右手可同时按住多个级数键 → 弹和弦。
 */
(function (global) {
  'use strict';
  var BS = global.BS;
  var U = BS.util;

    /* ================= 键位表（物理位 · 贴合钢琴键位） =================
   *
   * 设计原则：**键的物理位置决定音高**，像真钢琴一样左右递增。
   * 电脑键盘三排的错位关系被保留下来：
   *
   *   底排  z x c v b n m , . /
   *   中排  a s d f g h j k l ;
   *   顶排  q w e r t y u i o p [ ]
   *
   * 例如 `a`=F#3 位于 `z`=G3 的左下方 —— 与真钢琴 F# 在 G 左侧一致。
   *
   * 键位按音高排成 8 个「键组」（老板定义）：
   *   底排左   z x c            → g3  a3   b3
   *   中排左   a s d            → f#3 g#3  a#3
   *   顶排     q w e r t y u    → c4  d4  e4  f4  g4  a4   b4
   *   顶排数字 2 3 5 6 7        → c#4 d#4 f#4 g#4 a#4
   *   底排右   v b n m , . /    → c5  d5  e5  f5  g5  a5   b5
   *   中排右   g h k l ;        → c#5 d#5 f#5 g#5 a#5
   *   顶排右   i o p [ ]        → c6  d6  e6  f6  g6
   *   顶排数字 9 0 =            → c#6 d#6 f#6
   *
   * 合计 38 键，覆盖 f#3…g6 **连续无缺口、零碰撞**（auditKeyMap 可自检）。
   * 音域（八度切换）改变时整表随之平移。
   */

  /* 键组：按音高从低到高。offsets = 相对音域最低音的半音偏移 */
  var GROUPS = [
    { id: 'low-bottom', keys: ['z', 'x', 'c'],                          semis: [7, 9, 11] },
    { id: 'low-mid',    keys: ['a', 's', 'd'],                          semis: [6, 8, 10] },
    { id: 'mid-top',    keys: ['q', 'w', 'e', 'r', 't', 'y', 'u'],    semis: [12, 14, 16, 17, 19, 21, 23] },
    { id: 'mid-num',    keys: ['2', '3', '5', '6', '7'],              semis: [13, 15, 18, 20, 22] },
    { id: 'hi-bottom',  keys: ['v', 'b', 'n', 'm', ',', '.', '/'],    semis: [24, 26, 28, 29, 31, 33, 35] },
    { id: 'hi-mid',     keys: ['g', 'h', 'k', 'l', ';'],              semis: [25, 27, 30, 32, 34] },
    { id: 'top-right',  keys: ['i', 'o', 'p', '[', ']'],              semis: [36, 38, 40, 41, 43] },
    { id: 'top-num',    keys: ['9', '0', '='],                          semis: [37, 39, 42] }
  ];

  /* 兼容旧接口：把键组包装成「音区」形态，供 UI / 自检复用 */
  var ZONES = GROUPS.map(function (g, i) {
    return { id: i + 1, name: g.id, keys: g.keys.slice(), semis: g.semis.slice() };
  });

  /* 键 → 半音偏移（显式表，一个键只属于一个组） */
  var KEY_SEMI = {};
  var KEY_GROUP = {};
  GROUPS.forEach(function (g) {
    g.keys.forEach(function (k, i) {
      if (KEY_SEMI[k] === undefined) {
        KEY_SEMI[k] = g.semis[i];
        KEY_GROUP[k] = g.id;
      }
    });
  });

  /* 双手模式分工：
   *   根音键 = 键组的**左半**（低八度）：zxc asd qwertyu 23567
   *   级数键 = 键组的**右半**（高八度）：vbnm./ ghkl; iop[] 90=
   * 与真实钢琴的双手位置一致。 */
  var ROOT_GROUPS = ['low-bottom', 'low-mid', 'mid-top', 'mid-num'];
  var DEGREE_GROUPS = ['hi-bottom', 'hi-mid', 'top-right', 'top-num'];

  /* ================= 一字排开（模式 C） =================
   *
   * 一整排白键 + 一整排黑键，**不做物理键盘仿真**，只求好按、音域宽：
   *
   *   白键  q  w  e  r  t  y  u  i  o  p  [  ]  z  x  c  v  b  n  m  ,  .  /
   *         C  D  E  F  G  A  B  C  D  E  F  G  A  B  C  D  E  F  G  A  B  C
   *   （22 个白键从「当前音域最低的 C」起，一路向右升高，正好三个八度整）
   *
   *   黑键  2 3 5 6 7 9 0 = a s f g j k l
   *         C# D# F# G# A# | C# D# F# G# A# | C# D# F# G# A#
   *   （15 个黑键，位置夹在相邻白键之间，与真钢琴一致）
   *
   * 合计 37 键，覆盖 C…C（三个八度整，跨度 36 个半音），音域变化时整表平移。
   * 黑键的音程偏移不是随手写的：每个都必须是「白键序列里缺掉的那个音」，
   * auditLineMap() 会校验这一点。
   */
  var LINE_WHITES = 'qwertyuiop[]zxcvbnm,./'.split('');
  var LINE_BLACKS = '2356790=asfgjkl'.split('');

  /* 白键半音偏移：白键音阶 0 2 4 5 7 9 11 循环 */
  var WHITE_STEPS = [0, 2, 4, 5, 7, 9, 11];
  var LINE_WHITE_SEMIS = LINE_WHITES.map(function (_, i) {
    return Math.floor(i / 7) * 12 + WHITE_STEPS[i % 7];
  });
  /* 黑键半音偏移：C# D# F# G# A# ×3（与白键缺口一一对应） */
  var LINE_BLACK_SEMIS = [1, 3, 6, 8, 10, 13, 15, 18, 20, 22, 25, 27, 30, 32, 34];

  var LINE_KEY_SEMI = {};
  LINE_WHITES.forEach(function (k, i) { LINE_KEY_SEMI[k] = LINE_WHITE_SEMIS[i]; });
  LINE_BLACKS.forEach(function (k, i) { LINE_KEY_SEMI[k] = LINE_BLACK_SEMIS[i]; });

/* ================= 音阶 ================= */
  var SCALE_STEPS = [0, 2, 4, 5, 7, 9, 11, 12];
  var NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  /* ================= 调性 ================= */
  var SCALES = {
    major:      { name: '大调',       iv: [0, 2, 4, 5, 7, 9, 11] },
    minor:      { name: '自然小调',   iv: [0, 2, 3, 5, 7, 8, 10] },
    harmonic:   { name: '和声小调',   iv: [0, 2, 3, 5, 7, 8, 11] },
    dorian:     { name: '多利亚',     iv: [0, 2, 3, 5, 7, 9, 10] },
    mixolydian: { name: '混合利底亚', iv: [0, 2, 4, 5, 7, 9, 10] },
    phrygian:   { name: '弗里几亚',   iv: [0, 1, 3, 5, 7, 8, 10] },
    lydian:     { name: '利底亚',     iv: [0, 2, 4, 6, 7, 9, 11] },
    pentatonic: { name: '五声',       iv: [0, 2, 4, 7, 9] },
    minorPent:  { name: '小五声',     iv: [0, 3, 5, 7, 10] },
    blues:      { name: '布鲁斯',     iv: [0, 3, 5, 6, 7, 10] }
  };

  var KeyModes = BS.keymodes = {
    GROUPS: GROUPS,
    ZONES: ZONES,
    KEY_SEMI: KEY_SEMI,
    KEY_GROUP: KEY_GROUP,
    ROOT_GROUPS: ROOT_GROUPS,
    DEGREE_GROUPS: DEGREE_GROUPS,
    LINE_WHITES: LINE_WHITES,
    LINE_BLACKS: LINE_BLACKS,
    LINE_KEY_SEMI: LINE_KEY_SEMI,
    SCALE_STEPS: SCALE_STEPS,
    SCALES: SCALES,
    NOTE_NAMES: NOTE_NAMES,
    /* 全应用只用一种键位：C 一字排开（白键 qwertyuiop[]zxcvbnm,./ + 黑键 2356790=asfgjkl） */
    current: 'C'
  };

  /* ================= 键 → 音高 ================= */

/**
 * 某键的音高（模式 A：音高直通）。
 * 键的半音偏移是固定的，音域（八度）平移整表。
 * @param key      键名（小写）
 * @param lowNote  当前音域最低音（MIDI）
 */
KeyModes.pitchOfKey = function (key, lowNote) {
  var semi = KEY_SEMI[key];
  if (semi === undefined) return null;
  // 基准 = 音域里 >= lowNote 的第一个 C
  var baseC = Math.ceil(lowNote / 12) * 12;
  return baseC + semi;
  };

  /** 兼容旧接口（音区 → 音高） */
  KeyModes.pitchInZoneA = function (key, lowNote) {
    return KeyModes.pitchOfKey(key, lowNote);
  };

/**
 * 模式 C（一字排开）某键的音高。
 * 基准同上：音域里 >= lowNote 的第一个 C。超出 MIDI 上限返回 null。
 */
KeyModes.pitchOfLineKey = function (key, lowNote) {
  var semi = LINE_KEY_SEMI[key];
  if (semi === undefined) return null;
  var p = KeyModes.basePitch(lowNote) + semi;
  return p > 127 ? null : p;
};

/** 一字排开覆盖的半音跨度（从最低 C 到最高 C = 36） */
KeyModes.lineSpan = function () {
  return LINE_WHITE_SEMIS[LINE_WHITE_SEMIS.length - 1];
};

/** 某个半音偏移对应的键（标注/自检用，黑白键分开） */
KeyModes.lineKeyAt = function (semi) {
  for (var i = 0; i < LINE_WHITES.length; i++) {
    if (LINE_WHITE_SEMIS[i] === semi) return { key: LINE_WHITES[i], black: false };
  }
  for (var j = 0; j < LINE_BLACKS.length; j++) {
    if (LINE_BLACK_SEMIS[j] === semi) return { key: LINE_BLACKS[j], black: true };
  }
  return null;
};

/**
 * 一字排开键位自检：键位不得重复、白键必须递增、
 * 每个黑键必须正好落在两个相邻白键之间的半音上。
 */
KeyModes.auditLineMap = function () {
  var errors = [];
  var seen = {};
  LINE_WHITES.concat(LINE_BLACKS).forEach(function (k) {
    if (seen[k]) errors.push('键位重复：' + k);
    seen[k] = true;
  });
  for (var i = 1; i < LINE_WHITE_SEMIS.length; i++) {
    if (LINE_WHITE_SEMIS[i] <= LINE_WHITE_SEMIS[i - 1]) {
      errors.push('白键未递增：' + LINE_WHITES[i - 1] + '→' + LINE_WHITES[i]);
      break;
    }
  }
  LINE_BLACK_SEMIS.forEach(function (s, idx) {
    var left = LINE_WHITE_SEMIS.filter(function (w) { return w < s; }).pop();
    var right = LINE_WHITE_SEMIS.filter(function (w) { return w > s; })[0];
    if (left === undefined || right === undefined || right - left !== 2) {
      errors.push('黑键 ' + LINE_BLACKS[idx] + ' 不在两个相邻白键之间（半音 ' + s + '）');
    }
  });
  return {
    errors: errors,
    table: LINE_WHITES.concat(LINE_BLACKS).map(function (k) {
      return { key: k, semi: LINE_KEY_SEMI[k], black: LINE_BLACKS.indexOf(k) >= 0 };
    }),
    summary: {
      whiteKeys: LINE_WHITES.length,
      blackKeys: LINE_BLACKS.length,
      totalKeys: LINE_WHITES.length + LINE_BLACKS.length,
      span: KeyModes.lineSpan()
    }
  };
};

  /** 当前音域的基准 C（>= lowNote 的第一个 C） */
  KeyModes.basePitch = function (lowNote) {
    return Math.ceil(lowNote / 12) * 12;
  };

  /** 兼容旧接口：当前音域的最低八度（C3 → 3） */
  KeyModes.baseOctave = function (lowNote) {
    return Math.floor(KeyModes.basePitch(lowNote) / 12) - 1;
  };

  /** 某键属于哪个键组（返回 GROUPS 里的对象或 null） */
  KeyModes.groupOfKey = function (key) {
    var gid = KEY_GROUP[key];
    if (!gid) return null;
    for (var i = 0; i < GROUPS.length; i++) {
      if (GROUPS[i].id === gid) return GROUPS[i];
    }
    return null;
  };

  /** 兼容旧接口：某键属于哪个音区（ZONES 包装） */
  KeyModes.zoneOfKey = function (key) {
    var g = KeyModes.groupOfKey(key);
    if (!g) return null;
    var idx = GROUPS.indexOf(g);
    return idx >= 0 ? ZONES[idx] : null;
  };

  /** 兼容旧接口：音区号（0 = 不属于任何区） */
  KeyModes.zoneIdOfKey = function (key) {
    var g = KeyModes.groupOfKey(key);
    if (!g) return 0;
    return GROUPS.indexOf(g) + 1;
  };

  /** 某键组的最低半音偏移（用于 UI 提示） */
  KeyModes.groupBaseSemi = function (groupId) {
    for (var i = 0; i < GROUPS.length; i++) {
      if (GROUPS[i].id === groupId) return GROUPS[i].semis[0];
    }
    return null;
  };

  /** 兼容旧接口：某键组的键列表 */
  KeyModes.zoneKeys = function (zoneId) {
    var g = GROUPS[zoneId - 1];
    return g ? g.keys.slice() : [];
  };

  /** 兼容旧接口：各键组在当前音域下的起始音高（UI 提示用） */
  KeyModes.zoneMap = function (lowNote) {
    var baseC = KeyModes.basePitch(lowNote);
    return GROUPS.map(function (g) {
      return { zone: GROUPS.indexOf(g) + 1, group: g.id,
               base: baseC + g.semis[0], keys: g.keys.length };
    });
  };

/* ================= 双手模式 =================
 * 分工按**键盘物理左右**（与真实钢琴一致）：
 *   左手根音 = 左半区低八度：z x c / a s d / q w e r t y u / 2 3 5 6 7
 *   右手级数 = 右半区高八度：v b n m , . / / g h k l ; / i o p [ ] / 9 0 =
 */

  /** 该键在双手模式下是「根音键」还是「级数键」 */
  KeyModes.handRole = function (key) {
    var gid = KEY_GROUP[key];
    if (!gid) return null;
    if (ROOT_GROUPS.indexOf(gid) >= 0) return 'root';
    if (DEGREE_GROUPS.indexOf(gid) >= 0) return 'degree';
    return null;
  };

  /**
   * 根音键 → 根音的 MIDI 音高。
   * 根音就是该键在音域里的**实际音高**（与模式 A 一致），
   * 所以按 q 得 C4、按 v 得 C5 —— 每个键都是不同的根音。
   */
  KeyModes.rootPitchOf = function (key, lowNote) {
    if (KeyModes.handRole(key) !== 'root') return null;
    return KeyModes.pitchOfKey(key, lowNote);
  };

  /** 根音的音名（UI 提示用） */
  KeyModes.rootNameOf = function (key, lowNote) {
    var p = KeyModes.rootPitchOf(key, lowNote);
    if (p === null) return '';
    var nm = NOTE_NAMES[((p % 12) + 12) % 12];
    return nm + (Math.floor(p / 12) - 1);
  };

  /**
   * 级数键 → 级数（1 起）与八度偏移。
   *
   * 级数按**级数键组内部的位置**排：
   *   右半区从左到右 21 个键（v b n m , . / g h k l ; i o p [ ] 9 0 =）
   *   第 1~7 个 = 级 1~7（根音同八度的大调音阶）
   *   之后每 7 个进一个八度，第 15 个起再高八度。
   */
  var DEGREE_KEYS = [];
  DEGREE_GROUPS.forEach(function (gid) {
    GROUPS.forEach(function (g) { if (g.id === gid) DEGREE_KEYS = DEGREE_KEYS.concat(g.keys); });
  });

  KeyModes.degreeOf = function (key) {
    if (KeyModes.handRole(key) !== 'degree') return null;
    var idx = DEGREE_KEYS.indexOf(key);
    if (idx < 0) return null;
    return { index: idx, degree: (idx % 7) + 1, octOffset: Math.floor(idx / 7) };
  };

  /** 级数键总数（UI 提示用） */
  KeyModes.degreeKeyCount = function () { return DEGREE_KEYS.length; };

/* ================= 键位表自检 ================= */

  /**
   * 键位表自检：检查「键位重复」「音高碰撞」「音高缺口」「组内递增」。
   * 任何键位表改动后都应跑一遍。
   * @param lowNote 当前音域最低音（默认 C3=48）
   */
  KeyModes.auditKeyMap = function (lowNote) {
    lowNote = lowNote === undefined ? 48 : lowNote;
    var errors = [], warns = [];
    var table = [];
    var base = KeyModes.basePitch(lowNote);

    // 1) 键位不得重复
    var owner = {};
    GROUPS.forEach(function (g) {
      g.keys.forEach(function (k) { (owner[k] = owner[k] || []).push(g.id); });
    });
    var dup = Object.keys(owner).filter(function (k) { return owner[k].length > 1; });
    if (dup.length) {
      errors.push('键位重复：' + dup.map(function (k) {
        return k + ' → ' + owner[k].join('&');
      }).join('; '));
    }

    // 2) 音高不得碰撞 + 收集映射表
    var pitchOwner = {};
    GROUPS.forEach(function (g) {
      g.keys.forEach(function (k, i) {
        var p = base + g.semis[i];
        table.push({ key: k, group: g.id, semi: g.semis[i], midi: p });
        (pitchOwner[p] = pitchOwner[p] || []).push(k + '(' + g.id + ')');
      });
    });
    var collide = Object.keys(pitchOwner).filter(function (p) { return pitchOwner[p].length > 1; });
    if (collide.length) {
      errors.push('音高碰撞：' + collide.map(function (p) {
        return 'MIDI ' + p + ' ← ' + pitchOwner[p].join(',');
      }).join('; '));
    }

    // 3) 音高必须连续（无缺口）—— 这是键位表的设计前提
    var ms = Object.keys(pitchOwner).map(Number).sort(function (a, b) { return a - b; });
    for (var i = 1; i < ms.length; i++) {
      if (ms[i] - ms[i - 1] > 1) {
        errors.push('音高有缺口：MIDI ' + ms[i - 1] + ' → ' + ms[i] +
                    '（缺 ' + (ms[i] - ms[i - 1] - 1) + ' 个半音）');
        break;
      }
    }

    // 4) 同一键组内半音必须递增
    GROUPS.forEach(function (g) {
      for (var i2 = 1; i2 < g.semis.length; i2++) {
        if (g.semis[i2] <= g.semis[i2 - 1]) {
          errors.push(g.id + ' 组内半音未递增：' + g.keys[i2 - 1] + '→' + g.keys[i2]);
          break;
        }
      }
    });

    // 5) 提示：音高越出当前音域
    table.forEach(function (t) {
      if (t.midi < lowNote || t.midi > lowNote + 60) {
        warns.push(t.key + ' (' + t.group + ') MIDI ' + t.midi + ' 超出当前音域');
      }
    });

    return {
      errors: errors,
      warns: warns,
      table: table,
      summary: {
        groupCount: GROUPS.length,
        totalKeys: table.length,
        uniqueKeys: Object.keys(owner).length,
        range: ms.length ? (ms[0] + '~' + ms[ms.length - 1]) : '',
        rootKeys: DEGREE_GROUPS.length ? (function () {
          var n = 0; ROOT_GROUPS.forEach(function (gid) {
            GROUPS.forEach(function (g) { if (g.id === gid) n += g.keys.length; });
          }); return n;
        })() : 0,
        degreeKeys: DEGREE_KEYS.length
      }
    };
  };

  /** 兼容旧名 */
  KeyModes.auditZones = KeyModes.auditKeyMap;

/* ================= 音高换算 ================= */

  /**
   * 由根音 + 级数算出 MIDI 音高。
   * @param rootMidi  根音的 MIDI 音高
   * @param degree    级数 1-7
   * @param octOffset 八度偏移（4 号区 = +1）
   */
  KeyModes.pitchFromRoot = function (rootMidi, degree, octOffset) {
    var d = U.clamp(Math.round(degree || 1), 1, 8);
    var oct = Math.floor((d - 1) / 7);
    var idx = (d - 1) % 7;
    return rootMidi + oct * 12 + SCALE_STEPS[idx] + (octOffset || 0) * 12;
  };

  /** 兼容旧接口：以音名 + 级数算音高 */
  KeyModes.pitchOf = function (rootName, degree, baseOct, highOct) {
    var pc = NOTE_NAMES.indexOf(rootName);
    if (pc < 0) pc = 0;
    baseOct = baseOct === undefined ? 4 : baseOct;
    var rootMidi = pc + (baseOct + 1) * 12;
    return KeyModes.pitchFromRoot(rootMidi, degree, highOct ? 1 : 0);
  };

  /* ================= 调内和弦 ================= */

  KeyModes.scaleNotes = function (key, scaleName, octave) {
    var sc = SCALES[scaleName] || SCALES.major;
    var root = (key || 'C').charCodeAt(0) - 65;
    var base = root + (octave || 4) * 12 + 1;
    return sc.iv.map(function (iv) { return base + iv; });
  };

  KeyModes.chordPitches = function (rootName, quality, octave) {
    var qualities = {
      'maj': [0, 4, 7], 'min': [0, 3, 7], 'dim': [0, 3, 6], 'aug': [0, 4, 8],
      'maj7': [0, 4, 7, 11], 'min7': [0, 3, 7, 10], 'dom7': [0, 4, 7, 10],
      'sus2': [0, 2, 7], 'sus4': [0, 5, 7], 'maj9': [0, 4, 7, 11, 14],
      'min9': [0, 3, 7, 10, 14], 'add9': [0, 4, 7, 14], '6': [0, 4, 7, 9],
      'min6': [0, 3, 7, 9]
    };
    var q = qualities[quality] || qualities.maj;
    var m = /^([A-G])([#b]?)$/.exec(rootName || 'C');
    var pc = m ? (({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 })[m[1]] +
                  (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0)) : 0;
    var base = pc + (octave === undefined ? 4 : octave) * 12 + 1;
    return q.map(function (iv) { return base + iv; });
  };

  KeyModes.chordsInKey = function (key, scaleName) {
    var sc = SCALES[scaleName] || SCALES.major;
    var root = (key || 'C').charCodeAt(0) - 65;
    var out = [];
    for (var i = 0; i < sc.iv.length; i++) {
      var pc = (root + sc.iv[i]) % 12;
      var name = NOTE_NAMES[pc];
      var isMinorish = /minor|harmonic|dorian|phrygian|blues/i.test(scaleName);
      var quality;
      if (isMinorish) quality = (i === 2 || i === 5) ? 'maj' : (i === 6 ? 'dim' : 'min');
      else quality = (i === 5) ? 'min' : (i === 6 ? 'dim' : 'maj');
      out.push({ root: name, quality: quality, degree: i });
    }
    return out;
  };

  /* ================= 音域信息 ================= */

  /** 模式 A 覆盖的半音总数 */
  KeyModes.spanOf = function () {
    var n = 0;
    ZONES.forEach(function (z) { n += z.keys.length; });
    return n;
  };

  /** 可演奏的八度数 */
  KeyModes.octaveReach = function (numOctaves) {
    return numOctaves || 4;
  };

})(typeof window !== 'undefined' ? window : globalThis);

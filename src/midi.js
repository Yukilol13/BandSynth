/* BandSynth · midi.js
 * Standard MIDI File 解析（P1 的外部转写入口）。
 *
 * 用途：用户在外部用 Basic Pitch / Melodyne / Transkun / 任意 DAW 把单个分轨
 * 转成 MIDI 再拖进「导入成谱」页 —— 我们只负责「对齐本曲已识别的 BPM/拍号网格」，
 * 不重新分析音频，也不需要任何第三方库。
 *
 * 轨结构约定：
 *   · format 1（多轨）→ 每个 MTrk 块一条音轨（文件本身就这么分的）
 *   · format 0（单块多通道）→ 按通道拆成多条（否则一整块混着没法用）
 *   · 第 10 通道（index 9）→ 鼓轨，音高按 GM 鼓映射到本项目鼓位
 */
(function (global) {
  'use strict';

  var BS = global.BS;

  /* GM 音色组 → 本项目 toneId / role */
  var GM_GROUPS = [
    { to: 7, tone: 'piano', role: 'synth', label: '钢琴' },
    { to: 15, tone: 'bell', role: 'synth', label: '色彩打击' },
    { to: 23, tone: 'organ', role: 'synth', label: '风琴' },
    { to: 31, tone: 'acousticGuitar', role: 'synth', label: '吉他' },
    { to: 39, tone: 'bass', role: 'bass', label: '贝斯' },
    { to: 47, tone: 'bass', role: 'bass', label: '贝斯' },
    { to: 55, tone: 'strings', role: 'synth', label: '弦乐' },
    { to: 63, tone: 'lead', role: 'synth', label: '铜管' },
    { to: 71, tone: 'acousticGuitar', role: 'synth', label: '簧管' },
    { to: 79, tone: 'pluck', role: 'synth', label: '笛管' },
    { to: 87, tone: 'lead', role: 'synth', label: '合成主音' },
    { to: 95, tone: 'warmPad', role: 'synth', label: '合成铺底' },
    { to: 103, tone: 'warmPad', role: 'synth', label: '民族音色' },
    { to: 111, tone: 'warmPad', role: 'synth', label: '打击乐' },
    { to: 119, tone: 'bell', role: 'synth', label: '音效' },
    { to: 127, tone: 'acousticGuitar', role: 'synth', label: '吉他' }
  ];

  function toneForProgram(program) {
    for (var i = 0; i < GM_GROUPS.length; i++) {
      if (program <= GM_GROUPS[i].to) return GM_GROUPS[i];
    }
    return GM_GROUPS[0];
  }

  /* GM 鼓音高 → 本项目鼓位（analysis.DRUM_PITCH 那一套） */
  var DRUM_MAP = {
    35: 'kick', 36: 'kick',
    37: 'snare', 38: 'snare', 40: 'snare',
    39: 'tomMid', 41: 'tomLow', 43: 'tomLow', 45: 'tomLow', 47: 'tomMid',
    48: 'tomMid', 50: 'tomHigh', 44: 'hihatClosed', 42: 'hihatClosed',
    46: 'hihatOpen', 49: 'crash', 57: 'crash', 51: 'ride', 59: 'ride',
    54: 'tomMid', 56: 'tomLow', 82: 'snare'
  };
  var DRUM_PITCH = {
    kick: 36, snare: 38, hihatClosed: 42, hihatOpen: 46,
    crash: 49, ride: 51, tomLow: 45, tomMid: 48, tomHigh: 50
  };

  /* ---------- 字节读取 ---------- */

  function Reader(buf) {
    this.d = new DataView(buf);
    this.p = 0;
  }
  Reader.prototype.u8 = function () {
    // 越界返回 0：让上层状态机自然收尾，别把整个导入搞崩
    if (this.p >= this.d.byteLength) return 0;
    return this.d.getUint8(this.p++);
  };
  Reader.prototype.u16 = function () { var v = this.d.getUint16(this.p); this.p += 2; return v; };
  Reader.prototype.u32 = function () { var v = this.d.getUint32(this.p); this.p += 4; return v; };
  Reader.prototype.str = function (n) {
    var s = '';
    for (var i = 0; i < n; i++) s += String.fromCharCode(this.u8());
    return s;
  };
  Reader.prototype.skip = function (n) { this.p += n; };
  /** 变长量（VLQ，每字节 7 位，最高位置 1 表示还有） */
  Reader.prototype.vlq = function () {
    var v = 0, b;
    do {
      b = this.u8();
      v = (v << 7) | (b & 0x7f);
    } while (b & 0x80);
    return v;
  };

  /* ---------- 主解析 ---------- */

  /**
   * @param {ArrayBuffer} buf
   * @param {object} [opts] 合并成单轨时用的角色/音色/轨名（来自文件名，如「人声」→ vocalAh）
   * @returns {{ppq:number, bpm:number, tracks:Array} | null}
   * tracks[i] = { name, role, toneId, label, program, channel, notes:[{t,dur,pitch,vel}] }
   */
  function parse(buf, opts) {
    opts = opts || {};
    if (!buf || buf.byteLength < 14) return null;
    var r = new Reader(buf);
    if (r.str(4) !== 'MThd') return null;
    var headerLen = r.u32();
    var format = r.u16(), ntrks = r.u16(), division = r.u16();
    if (headerLen > 6) r.skip(headerLen - 6);
    if (!division) return null;

    var smpte = false;
    if (division & 0x8000) {
      // SMPTE 时基：帧率 = -(高位有符号)，每帧 tick = 低位 —— 少见，尽力支持
      smpte = true;
    }

    var chunks = [];
    for (var t = 0; t < ntrks; t++) {
      if (r.p + 8 > buf.byteLength) break;
      var id = r.str(4);
      var len = r.u32();
      var end = Math.min(buf.byteLength, r.p + len);
      if (id !== 'MTrk') { r.p = end; continue; }
      // 每块单独切一份，Reader 用块内相对偏移，别把绝对偏移混进来
      var sub = buf.slice ? buf.slice(r.p, end) : buf;
      chunks.push(parseTrack(new Reader(sub), 0, sub.byteLength));
      r.p = end;
    }
    if (!chunks.length) return null;

    /* ---- 全局 tempo 图（取第一条 tempo 事件的轨，通常是第 0 条） ---- */
    var tempos = [];
    chunks.forEach(function (c) {
      c.tempoEvents.forEach(function (e) { tempos.push(e); });
    });
    if (!tempos.length) tempos.push({ tick: 0, us: 500000 });
    tempos.sort(function (a, b) { return a.tick - b.tick; });

    /* ---- 拍号图 ---- */
    var sigs = [];
    chunks.forEach(function (c) {
      (c.sigEvents || []).forEach(function (e) { sigs.push(e); });
    });
    sigs.sort(function (a, b) { return a.tick - b.tick; });

    var secOf = function (tick) {
      if (smpte) {
        var fps = 256 - (division >> 8);
        var tpf = division & 0xff;
        return tick / (fps * tpf);
      }
      var sec = 0, lastTick = 0, lastUs = tempos[0].us;
      for (var i = 0; i < tempos.length; i++) {
        if (tempos[i].tick >= tick) break;
        sec += (tempos[i].tick - lastTick) * lastUs / 1e6 / division;
        lastTick = tempos[i].tick;
        lastUs = tempos[i].us;
      }
      sec += (tick - lastTick) * lastUs / 1e6 / division;
      return sec;
    };

    /* ---- 汇总：format 0 按通道拆，format 1 每块一轨 ---- */
    var out = [];
    var idx = 0;
    chunks.forEach(function (c, ci) {
      var byChannel = {};
      c.notes.forEach(function (n) {
        var key = n.ch;
        if (!byChannel[key]) byChannel[key] = [];
        byChannel[key].push(n);
      });
      var keys = Object.keys(byChannel);
      // 一块里出现多个通道（format 0 的常态，或 format 1 有人把多乐器塞一块）→ 按通道拆
      var split = keys.length > 1;
      keys.forEach(function (ch) {
        var list = byChannel[ch];
        var program = c.programs[ch] !== undefined ? c.programs[ch] : c.programs[-1];
        var isDrum = parseInt(ch, 10) === 9;
        var grp = isDrum ? null : toneForProgram(program === undefined ? 0 : program);
        var notes = list.map(function (n) {
          return {
            t: secOf(n.tick),
            dur: Math.max(0.02, secOf(n.tick + Math.max(1, n.durTicks)) - secOf(n.tick)),
            pitch: isDrum ? drumPitch(n.pitch) : n.pitch,
            vel: Math.round(Math.min(1, n.vel / 127) * 100) / 100
          };
        }).sort(function (a, b) { return a.t - b.t; });
        if (!notes.length) return;
        idx++;
        out.push({
          name: trackName(c.name, split ? ch : null, idx, isDrum),
          role: isDrum ? 'drum' : (grp ? grp.role : 'synth'),
          toneId: isDrum ? 'drumkit' : (grp ? grp.tone : null),
          label: isDrum ? '鼓组' : (grp ? grp.label : '音色'),
          program: program === undefined ? null : program,
          channel: parseInt(ch, 10),
          notes: notes
        });
      });
      // 块有名字但没音符 → 也保留一条空轨信息（导入页会跳过空轨）
      if (!keys.length && c.name) out.push({ name: c.name, role: 'synth', toneId: null, label: '音色', program: null, channel: null, notes: [] });
    });

    if (!out.length) return null;

    /* ---------- Basic Pitch 之类「一个通道只放同一个音高」的导出 ----------
     * 实测 basic-pitch 的 .mid：38~60 个轨/通道，每个轨只有一个音高
     * （人声 38 轨、钢琴 60 轨）。这种结构对编曲没用 —— 一个分轨文件就该是
     * 一条轨。特征：单音高轨占比 ≥ 60% 且轨数 > 3 → 全部合并成一条。 */
    var singlePitch = out.filter(function (t) {
      var seen = {};
      t.notes.forEach(function (n) { seen[n.pitch] = 1; });
      return Object.keys(seen).length <= 1;
    }).length;
    if (out.length > 3 && singlePitch / out.length >= 0.6) {
      var all = [], program = null;
      out.forEach(function (t) {
        all = all.concat(t.notes);
        if (t.program !== null && t.program !== undefined) program = t.program;
      });
      all.sort(function (a, b) { return a.t - b.t; });
      out = [{
        name: opts.name || out[0].name || 'MIDI',
        role: opts.role || 'synth',
        toneId: opts.toneId || null,
        label: opts.label || '合并 ' + all.length + ' 音',
        program: program,
        channel: null,
        mergedFrom: out.length,
        notes: all
      }];
    }

    var end = 0;
    out.forEach(function (t) {
      t.notes.forEach(function (n) { end = Math.max(end, n.t + n.dur); });
    });

    /* ---- 主导速度 ----
     * 不能取「第一条 tempo」：变速文件里第一条常常只覆盖开头一小节，
     * 后面 100 多小节全是另一个速度，取第一条会把整首谱按错速度画。
     * 按「该 tempo 覆盖的 tick 跨度」加权，取覆盖最长的那条。 */
    var endTick = 0;
    chunks.forEach(function (c) {
      c.notes.forEach(function (n) { endTick = Math.max(endTick, n.tick + (n.durTicks || 0)); });
    });
    var domUs = tempos[0].us;
    if (tempos.length > 1) {
      var bestSpan = -1;
      for (var ti = 0; ti < tempos.length; ti++) {
        var nextTick = ti + 1 < tempos.length ? tempos[ti + 1].tick : Math.max(endTick, tempos[ti].tick + 1);
        var span = nextTick - tempos[ti].tick;
        if (span > bestSpan) { bestSpan = span; domUs = tempos[ti].us; }
      }
    }

    /* ---- 主导拍号（同样按覆盖长度取；没有就默认 4/4） ---- */
    var meter = { num: 4, den: 4 };
    if (sigs.length) {
      var bestSigSpan = -1;
      for (var si = 0; si < sigs.length; si++) {
        var nxt = si + 1 < sigs.length ? sigs[si + 1].tick : Math.max(endTick, sigs[si].tick + 1);
        var sspan = nxt - sigs[si].tick;
        if (sspan > bestSigSpan) {
          bestSigSpan = sspan;
          meter = { num: sigs[si].num, den: sigs[si].den };
        }
      }
    }

    return {
      ppq: division,
      bpm: 60e6 / tempos[0].us,              // 起始速度（note 的秒换算用它）
      bpmDominant: 60e6 / domUs,             // 主导速度（建网格/显示用这个）
      tempoCount: tempos.length,
      tempos: tempos,
      meter: meter,                          // {num, den}
      timeSignatures: sigs,
      durationSec: end,
      tracks: out
    };
  }

  function drumPitch(midi) {
    var id = DRUM_MAP[midi] || DRUM_MAP[midi + 1] || DRUM_MAP[midi - 1];
    return id ? DRUM_PITCH[id] : 38;
  }

  function trackName(blockName, channel, idx, isDrum) {
    var base = (blockName && blockName.trim()) || (isDrum ? '鼓组' : ('MIDI 轨 ' + idx));
    if (channel === null || channel === undefined) return base;
    return base + ' · ch' + (channel + 1);
  }

  function parseTrack(r, start, end) {
    var name = '', notes = [], tempoEvents = [], sigEvents = [], programs = {};
    var status = 0, tick = 0;
    while (r.p < end - 0) {
      if (r.p >= end) break;
      tick += r.vlq();
      var b = r.u8();
      if (b === 0xff) {
        var type = r.u8(), len = r.vlq();
        if (type === 0x03) name = r.str(len);
        else if (type === 0x58 && len >= 2) {
          /* 拍号 meta：分子 + 分母(以 2 为底的对数) + 每拍时钟数 + 32 分音符数。
             以前完全没解析 → 3/4、6/8 的 MIDI 全被当成 4/4，网格整体错位。 */
          var num = r.u8(), den = Math.pow(2, r.u8());
          sigEvents.push({ tick: tick, num: num, den: den });
          r.skip(len - 2);
        }
        else if (type === 0x51 && len >= 3) {
          var us = (r.u8() << 16) | (r.u8() << 8) | r.u8();
          tempoEvents.push({ tick: tick, us: us });
          r.skip(len - 3);
        } else r.skip(len);
        status = 0;                 // meta 之后 running status 失效
        continue;
      }
      if (b === 0xf0 || b === 0xf7) { var l = r.vlq(); r.skip(l); continue; }
      if (b & 0x80) status = b; else r.p--;    // running status：b 是数据
      var cmd = status & 0xf0, ch = status & 0x0f;
      if (cmd === 0x90 || cmd === 0x80) {
        var pitch = r.u8(), vel = r.u8();
        if (cmd === 0x90 && vel > 0) openNote(notes, tick, ch, pitch, vel);
        else closeNote(notes, tick, ch, pitch);
      } else if (cmd === 0xa0 || cmd === 0xb0 || cmd === 0xe0) {
        r.skip(2);
      } else if (cmd === 0xc0) {
        programs[ch] = r.u8();
      } else if (cmd === 0xd0) {
        r.skip(1);
      } else {
        // 不认识的状态字节：放弃这条轨，别把整个导入搞崩
        break;
      }
    }
    return {
      name: name, notes: notes, tempoEvents: tempoEvents,
      sigEvents: sigEvents, programs: programs
    };
  }

  /* 音符开合：同通道同音高 FIFO（重叠时先开的先关） */
  function openNote(list, tick, ch, pitch, vel) {
    list.push({ tick: tick, ch: ch, pitch: pitch, vel: vel, open: true });
  }
  function closeNote(list, tick, ch, pitch) {
    for (var i = list.length - 1; i >= 0; i--) {
      var n = list[i];
      if (n.open && n.ch === ch && n.pitch === pitch) {
        n.open = false;
        n.durTicks = Math.max(1, tick - n.tick);
        return;
      }
    }
  }

  /* ================= 音符对齐：网格估计 + 全局偏移 =================
   * 外部转写工具（Basic Pitch / Melodyne / Transkun…）给出的 onset 有两类
   * 系统性误差，直接「各自就近取整」会把节奏搞坏：
   *   ① 和弦里的几个音不同时落地（差几毫秒到几十毫秒）
   *      → 各自取整可能被拆到相邻两格，和弦听起来变成琶音；
   *   ② 整体平移（导出时前导空白、转写算法延迟）
   *      → 所有音符稳定偏移半格，取整后整体错位，且开头几个音会被当成负拍丢掉。
   * 所以顺序是：先按「同时性」聚类 → 再用全体 onset 估全局偏移 → 最后量化。
   */

  var GRID_CANDS = [
    { g: 0.5, label: '1/8' },
    { g: 1 / 3, label: '1/8T' },
    { g: 0.25, label: '1/16' },
    { g: 1 / 6, label: '1/16T' },
    { g: 0.125, label: '1/32' }
  ];

  function gridLabel(g) {
    for (var i = 0; i < GRID_CANDS.length; i++) {
      if (Math.abs(GRID_CANDS[i].g - g) < 1e-6) return GRID_CANDS[i].label;
    }
    return '1/' + Math.round(4 / g);
  }

  function median(arr) {
    if (!arr.length) return 0;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  /** 把几乎同时的 onset 并成一个和弦簇（簇内统一取中位时刻） */
  function clusterNotes(list, winSec) {
    var a = (list || []).slice().sort(function (x, y) { return x.t - y.t; });
    if (!a.length) return [];
    var groups = [], cur = null;
    a.forEach(function (n) {
      if (cur && n.t - cur.lastT <= winSec) { cur.items.push(n); cur.lastT = n.t; }
      else { cur = { items: [n], lastT: n.t }; groups.push(cur); }
    });
    var out = [];
    groups.forEach(function (grp) {
      var ts = grp.items.map(function (n) { return n.t; });
      var mid = median(ts);
      grp.items.forEach(function (n) {
        out.push({ pitch: n.pitch, dur: n.dur, vel: n.vel, t: mid });
      });
    });
    return out;
  }

  /**
   * 估计网格与全局偏移。
   * @param {number[]} onsets 音符起点（秒）
   * @param {number} spb 每拍秒数
   * @returns {{grid,label,biasBeats,biasSec,residualMs,hit,confident,all}}
   */
  function fitGrid(onsets, spb, opts) {
    opts = opts || {};
    var ts = (onsets || []).filter(function (t) { return isFinite(t) && t >= 0; });
    var fallback = {
      grid: 0.25, label: '1/16', biasBeats: 0, biasSec: 0,
      residualMs: 0, hit: 1, confident: false, all: []
    };
    if (ts.length < 3 || !(spb > 0)) return fallback;

    /* 自动判定不往 1/8 以上粗走：编曲页要靠网格吸附音符，
       1/8 网格会把 16 分音符吸没，编辑手感直接变差。
       1/8 仍在下拉里，用户想粗可以手动选。 */
    var measured = GRID_CANDS.filter(function (c) { return c.g <= 0.25 + 1e-9; }).map(function (c) {
      var g = c.g;
      var res = [];                    // 每个 onset 相对最近网格点的偏差（格为单位）
      ts.forEach(function (t) {
        var q = t / spb / g;
        var r = q - Math.round(q);     // [-0.5, 0.5)
        res.push(r);
      });
      var offset = median(res);        // 全局偏移（格为单位）
      var devs = res.map(function (r) { return Math.abs(r - offset); });
      var stepMs = g * spb * 1000;
      var tol = Math.max(5, Math.min(20, stepMs * 0.06));
      var hits = devs.filter(function (d) { return d * stepMs <= tol; }).length;
      return {
        grid: g, label: c.label, offset: offset,
        residualMs: median(devs) * stepMs,
        hit: hits / devs.length,
        stepMs: stepMs, tol: tol
      };
    });

    /* 选择规则（顺序很重要）：
     *   1) 从粗到细，取第一个「几乎所有 onset 都贴格」的候选
     *      —— 粗网格能对上的话，绝不用更细的（否则 16 分音符会被拆成 32 分）；
     *   2) 都对不上（真人演奏抖动大）：默认仍用 1/16；
     *      只有当更细的网格残差比 1/16 好 40% 以上（说明真的是 32 分音符）才降级。 */
    var strict = null;
    for (var i = 0; i < measured.length; i++) {
      var m = measured[i];
      if (m.hit >= 0.85 && m.residualMs <= Math.max(8, m.stepMs * 0.08)) { strict = m; break; }
    }
    var chosen = strict;
    if (!chosen) {
      var ref = measured[0];               // measured[0] = 1/16
      chosen = ref;
      for (var j = 1; j < measured.length; j++) {
        var fm = measured[j];
        // 只有更细的网格残差好 40% 以上（真是 32 分 / 三连）才降级，否则 1/16 兜底
        if (fm.residualMs < chosen.residualMs * 0.6) { chosen = fm; break; }
      }
    }

    var biasBeats = chosen.offset * chosen.grid;
    // 偏移小于 5ms 就当没有：微小抖动靠量化吸收，不整体平移（避免首音被推到负拍）
    if (Math.abs(biasBeats * spb) < 0.005) biasBeats = 0;

    return {
      grid: chosen.grid,
      label: chosen.label,
      biasBeats: biasBeats,
      biasSec: biasBeats * spb,
      residualMs: chosen.residualMs,
      hit: chosen.hit,
      confident: !!strict,
      all: measured
    };
  }

  /**
   * 音符对齐总入口：聚类 + 估网格 + 全局偏移。
   * @param {Array<Array>} stemLists 每个 MIDI 轨的音符数组 [{t,dur,pitch,vel}]
   * @param {number} spb 每拍秒数
   * @returns {{notes:Array<Array>, grid, gridLabel, biasSec, biasBeats, residualMs, hit, confident}}
   */
  function alignNotes(stemLists, spb, opts) {
    opts = opts || {};
    var clusterSec = opts.clusterSec === undefined ? 0.02 : opts.clusterSec;
    var clustered = (stemLists || []).map(function (l) { return clusterNotes(l || [], clusterSec); });
    var onsets = [];
    clustered.forEach(function (l) { l.forEach(function (n) { onsets.push(n.t); }); });

    var fit = fitGrid(onsets, spb, opts);
    if (fit.biasSec > 0) {
      clustered.forEach(function (l) {
        l.forEach(function (n) { n.t = Math.max(0, n.t - fit.biasSec); });
      });
    } else {
      fit.biasSec = 0;
      fit.biasBeats = 0;
    }
    return {
      notes: clustered,
      grid: fit.grid,
      gridLabel: fit.label,
      biasSec: fit.biasSec,
      biasBeats: fit.biasBeats,
      residualMs: fit.residualMs,
      hit: fit.hit,
      confident: fit.confident
    };
  }

  BS.midi = {
    parse: parse,
    toneForProgram: toneForProgram,
    GM_GROUPS: GM_GROUPS,
    DRUM_MAP: DRUM_MAP,
    GRID_CANDS: GRID_CANDS,
    gridLabel: gridLabel,
    clusterNotes: clusterNotes,
    fitGrid: fitGrid,
    alignNotes: alignNotes
  };
})(typeof window !== 'undefined' ? window : globalThis);

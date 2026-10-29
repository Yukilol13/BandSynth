/* BandSynth · score.js
 * 琴谱（Song）数据格式定义、解析、校验、时间轴展开
 *
 * —— 设计原则：人类可读、可手写、易于程序生成 ——
 * 所有时间以「拍（beat）」为单位，小节线由 bpm + 拍号推导，避免冗余的绝对秒数。
 *
 * 示例：
 * {
 *   "name": "示例节奏",
 *   "bpm": 92,
 *   "timeSignature": [4, 4],
 *   "swing": 0,
 *   "loopBars": 8,
 *   "tracks": [
 *     {
 *       "name": "底鼓",
 *       "part": 0,                 // 绑定到第几个声部（0 起）
 *       "volume": 0.9, "pan": 0,
 *       "notes": [
 *         { "beat": 0,   "len": 1,   "pitch": 36, "vel": 1.0 },
 *         { "beat": 2.5, "len": 0.5, "pitch": 36, "vel": 0.8 }
 *       ]
 *     }
 *   ]
 * }
 *
 * 字段说明：
 *   beat  : 起始拍（0 = 曲首），支持小数
 *   len   : 时值（拍）
 *   pitch : MIDI 音高；也支持 "C4" 字符串或 "C4:E4:G4" 和弦（自动展开）
 *   vel   : 力度 0~1，缺省 1
 *   tie   : true = 与下一个同音高音符连奏（延音，不重新触发）
 *   micro : 微移（秒），用于人性化/抢拍补偿
 *   mute  : true = 该音符不发声（休止）
 */
(function (global) {
  'use strict';
  var BS = global.BS;
  var U = BS.util, P = BS.pitch;

  var NOTE = /^([A-Ga-g][#b]?)(-?\d+)$/;

  /* 把一个 pitch 字段展开为 MIDI 音高数组 */
  function expandPitch(field, defaultOctave) {
    if (field === undefined || field === null) return [60];
    if (typeof field === 'number') return [Math.round(field)];
    var s = String(field).trim();
    // 和弦：C4:E4:G4 或 C4+E4+G4
    if (/[:+|,]/.test(s) && !NOTE.test(s)) {
      var parts = s.split(/[:+|,]/);
      var out = [];
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i].trim();
        if (!p) continue;
        if (NOTE.test(p)) {
          out.push(P.nameToMidi(p));
        } else if (/^-?\d+$/.test(p)) {
          out.push(parseInt(p, 10));
        } else if (NOTE.test(p + (defaultOctave || 3))) {
          out.push(P.nameToMidi(p + (defaultOctave || 3)));
        }
      }
      return out.length ? out : [60];
    }
    // 单音：允许省略八度，如 "C" → 默认八度
    var m = /^([A-Ga-g][#b]?)$/.exec(s);
    if (m) return [P.nameToMidi(s + (defaultOctave || 3))];
    if (NOTE.test(s)) return [P.nameToMidi(s)];
    var n = parseInt(s, 10);
    return isNaN(n) ? [60] : [n];
  }

  /* ---------------- 构造 ---------------- */
  function makeNote(beat, len, pitch, vel, extra) {
    var n = { beat: beat, len: len, pitch: pitch };
    if (vel !== undefined && vel !== null) n.vel = vel;
    if (extra) Object.assign(n, extra);
    return n;
  }

  function makeTrack(name, partIndex, notes, extra) {
    var t = { name: name, part: partIndex === undefined ? 0 : partIndex, notes: notes || [] };
    if (extra) Object.assign(t, extra);
    return t;
  }

  function makeSong(opts) {
    opts = opts || {};
    return {
      version: 1,
      name: opts.name || '未命名',
      bpm: opts.bpm || 120,
      timeSignature: opts.timeSignature || [4, 4],
      swing: opts.swing || 0,
      loopBars: opts.loopBars || 0,
      tracks: opts.tracks || []
    };
  }

  /* ---------------- 解析 / 校验 ---------------- */
  function parse(input) {
    var data = input;
    if (typeof input === 'string') {
      try { data = JSON.parse(input); }
      catch (e) { throw new Error('JSON 解析失败：' + e.message); }
    }
    if (!data || typeof data !== 'object') throw new Error('谱面必须是一个对象');
    if (!Array.isArray(data.tracks)) throw new Error('缺少 tracks 数组');

    var song = makeSong({
      name: data.name || '未命名',
      bpm: U.clamp(parseFloat(data.bpm) || 120, 20, 400),
      timeSignature: parseSig(data.timeSignature),
      swing: U.clamp(parseFloat(data.swing) || 0, 0, 0.9),
      loopBars: parseInt(data.loopBars, 10) || 0
    });

    // 编曲长度（可选）：让「内容只有 2 小节、时间轴 16 小节」的谱也能播满
    var lb = parseInt(data.lengthBars, 10);
    if (lb > 0) song.lengthBars = lb;

    var warnings = [];
    data.tracks.forEach(function (t, ti) {
      if (!t || typeof t !== 'object') { warnings.push('第 ' + (ti + 1) + ' 条轨道不是对象，已跳过'); return; }
      var notesRaw = Array.isArray(t.notes) ? t.notes : (Array.isArray(t) ? t : []);
      if (!Array.isArray(t.notes) && Array.isArray(t)) {
        warnings.push('轨道「' + (t.name || ti + 1) + '」用了简写数组格式（仅 notes），已兼容');
      }
      var track = makeTrack(
        String(t.name || ('轨道 ' + (ti + 1))),
        t.part === undefined ? ti : (parseInt(t.part, 10) || 0),
        [],
        {
          volume: t.volume === undefined ? 1 : U.clamp(parseFloat(t.volume), 0, 2),
          pan: t.pan === undefined ? 0 : U.clamp(parseFloat(t.pan), -1, 1),
          muted: !!t.muted,
          solo: !!t.solo,
          channel: t.channel || 0
        }
      );
      // 鼓轨标记：role='drum' 或 drum 字段 → 走独立鼓组通道，不占 part 索引
      if (t.role) track.role = t.role;
      if (t.drum !== undefined) track.drum = t.drum;
      if (t.role === 'drum' || t.drum !== undefined) {
        track.role = 'drum';
        track.part = -1;      // -1 = 鼓组通道
      }
      if (t.sendReverb !== undefined) track.sendReverb = U.clamp(parseFloat(t.sendReverb), 0, 1);
      if (t.sendDelay !== undefined) track.sendDelay = U.clamp(parseFloat(t.sendDelay), 0, 1);

      notesRaw.forEach(function (n, ni) {
        if (!n) return;
        var beat = parseFloat(n.beat !== undefined ? n.beat : (n.b !== undefined ? n.b : 0));
        if (isNaN(beat)) beat = 0;
        var lenRaw = n.len !== undefined ? n.len : (n.d !== undefined ? n.d : 1);
        var len = parseFloat(lenRaw);
        if (isNaN(len) || len <= 0) len = 0.25;
        var pitches = expandPitch(n.pitch !== undefined ? n.pitch : (n.n !== undefined ? n.n : 60), t.octave);
        var vel = n.vel !== undefined ? n.vel : (n.v !== undefined ? n.v : 1);
        vel = U.clamp(parseFloat(vel) || 0, 0, 1);
        if (vel === 0) vel = 1;

        if (n.mute || n.rest) {
          track.notes.push({ beat: beat, len: len, pitch: 0, vel: 0, mute: true });
          return;
        }
        for (var k = 0; k < pitches.length; k++) {
          track.notes.push({
            beat: beat, len: len, pitch: pitches[k], vel: vel,
            tie: !!n.tie, micro: parseFloat(n.micro) || 0,
            chord: pitches.length > 1 ? k : undefined,
            index: ni
          });
        }
      });

      track.notes.sort(function (a, b) { return a.beat - b.beat; });
      song.tracks.push(track);
    });

    return { song: song, warnings: warnings };
  }

  function parseSig(sig) {
    if (Array.isArray(sig) && sig.length >= 2) {
      return [Math.max(1, parseInt(sig[0], 10) || 4), Math.max(1, parseInt(sig[1], 10) || 4)];
    }
    if (typeof sig === 'string') {
      var m = /^(\d+)\s*\/\s*(\d+)$/.exec(sig.trim());
      if (m) return [parseInt(m[1], 10), parseInt(m[2], 10)];
    }
    return [4, 4];
  }

  /* ---------------- 时间换算 ---------------- */
  function beatToSec(song, beat) {
    var sec = beat * 60 / song.bpm;
    if (song.swing) {
      var len = song.timeSignature[0];
      var b = ((beat % len) + len) % len;
      var frac = b - Math.floor(b);
      if (Math.abs(frac - 0.5) < 1e-6) sec += song.swing * (60 / song.bpm) * 0.5;
    }
    return sec;
  }

  function totalBeats(song) {
    var max = 0;
    song.tracks.forEach(function (t) {
      t.notes.forEach(function (n) { var e = n.beat + n.len; if (e > max) max = e; });
    });
    // 向上取整到整小节
    var barLen = song.timeSignature[0];
    var beats = Math.ceil(max / barLen) * barLen;
    /* 编曲长度：内容只有 2 小节也要能播到第 16 小节（尾段不缩短）。
       没有这个字段时行为与旧版完全一致。 */
    if (song.lengthBars > 0) {
      beats = Math.max(beats, song.lengthBars * barLen);
    }
    return beats;
  }

  function totalSec(song) {
    return beatToSec(song, totalBeats(song));
  }

  function barsOf(song) { return totalBeats(song) / song.timeSignature[0]; }

  /* 拍 → "小节.拍" 文本 */
  function beatLabel(song, beat) {
    var barLen = song.timeSignature[0];
    var bar = Math.floor(beat / barLen) + 1;
    var b = (beat - (bar - 1) * barLen) + 1;
    var whole = Math.floor(b);
    var frac = b - whole;
    var names = ['1', '1&', '2', '2&', '3', '3&', '4', '4&', '5', '5&', '6', '6&', '7', '7&'];
    var idx = (whole - 1) * 2 + (frac >= 0.25 ? 1 : 0);
    return bar + '.' + (names[idx] || b.toFixed(2));
  }

  /* 把谱面展开为绝对时间事件列表（渲染与播放共用） */
  function buildEvents(song, opts) {
    opts = opts || {};
    var events = [];
    var t0 = opts.startTime || 0;
    song.tracks.forEach(function (track, ti) {
      var trVol = track.volume === undefined ? 1 : track.volume;
      // 鼓轨：role='drum' 时不占用 part 索引，走独立的鼓组通道
      var isDrum = track.role === 'drum' || track.drum !== undefined;
      /* 滑音要「同轨上一个音」，而 notes 不保证按拍排好 —— 先排一份再遍历。
         排序只影响 push 顺序，最后统一按 time 再排一次，结果不变。 */
      var order = track.notes.slice().sort(function (a, b) {
        return (a && a.beat ? a.beat : 0) - (b && b.beat ? b.beat : 0);
      });
      var prevPitch = null, prevBeat = -Infinity;
      order.forEach(function (n) {
        if (!n || n.mute || n.pitch === 0) return;
        var start = beatToSec(song, n.beat) + (n.micro || 0);
        var dur = n.len * 60 / song.bpm;
        var ev = {
          time: t0 + start,
          duration: dur,
          pitch: n.pitch,
          vel: U.clamp(n.vel, 0, 1) * trVol,
          trackIndex: ti,
          partIndex: isDrum ? -1 : track.part,
          isDrum: isDrum,
          tie: !!n.tie,
          beat: n.beat,
          track: track
        };
        // 音符修饰：鼓轨没有持续音高，直接忽略
        if (!isDrum) {
          /* 滑音有两种来源：
             1) 音块上显式写了 glideFrom（谱面里「切成两块」的那种）——
                此时滑音发生在音块内部第 glide 秒处，前一段用 glideFrom 的音高，
                后一段才滑到本音高。为了和视觉/交互一致，这里拆成两个事件：
                  前事件：音高 glideFrom，时长 glide 秒（ sustains 住）
                  后事件：音高 pitch，带 glide/glideFrom，从 glide 秒处起音
             2) 只写了 glide（老数据）—— 从同轨上一个音滑入本音，
                仍是单个事件，滑音从起音开始。 */
          var glideSec = n.glide > 0 ? Math.min(n.glide, Math.max(0.02, dur)) : 0;
          var fromPitch = null;
          var rawFrom = parseFloat(n.glideFrom);
          if (isFinite(rawFrom)) fromPitch = Math.round(U.clamp(rawFrom, 0, 127));

          if (glideSec > 0 && fromPitch !== null && fromPitch !== n.pitch && glideSec < dur) {
            var head = {
              time: t0 + start,
              duration: glideSec,
              pitch: fromPitch,
              vel: ev.vel,
              trackIndex: ti,
              partIndex: track.part,
              isDrum: isDrum,
              tie: false,
              beat: n.beat,
              track: track
            };
            if (n.vib > 0) { head.vib = U.clamp(n.vib, 0, 1); head.vibRate = n.vibRate > 0 ? U.clamp(n.vibRate, 0.5, 14) : 5.5; }
            events.push(head);
            ev.time = t0 + start + glideSec;
            ev.duration = dur - glideSec;
            ev.glide = glideSec;
            ev.glideFrom = fromPitch;
          } else if (glideSec > 0 && prevPitch !== null && prevPitch !== n.pitch &&
            n.beat > prevBeat + 1e-6) {
            // 老数据：从上一个音滑入（和弦/同拍不滑）
            ev.glide = glideSec;
            ev.glideFrom = prevPitch;
          }
          if (n.vib > 0) {
            ev.vib = U.clamp(n.vib, 0, 1);
            ev.vibRate = n.vibRate > 0 ? U.clamp(n.vibRate, 0.5, 14) : 5.5;
          }
        }
        events.push(ev);
        prevPitch = n.pitch;
        prevBeat = n.beat;
      });
    });
    events.sort(function (a, b) { return a.time - b.time; });
    return events;
  }

  /* ---------------- 序列化 ---------------- */
  function serialize(song, pretty) {
    var out = {
      version: song.version || 1,
      name: song.name,
      bpm: song.bpm,
      timeSignature: song.timeSignature,
      swing: song.swing || 0
    };
    if (song.loopBars) out.loopBars = song.loopBars;
    if (song.lengthBars > 0) out.lengthBars = song.lengthBars;
    out.tracks = song.tracks.map(function (t) {
      var o = { name: t.name, part: t.part, notes: t.notes.map(function (n) {
        var x = { beat: round(n.beat, 4), len: round(n.len, 4), pitch: n.pitch };
        if (n.vel !== undefined && n.vel !== 1) x.vel = round(n.vel, 3);
        if (n.tie) x.tie = true;
        if (n.micro) x.micro = round(n.micro, 4);
        if (n.mute) x.mute = true;
        return x;
      })};
      if (t.volume !== undefined && t.volume !== 1) o.volume = t.volume;
      if (t.pan) o.pan = t.pan;
      if (t.muted) o.muted = true;
      if (t.solo) o.solo = true;
      if (t.sendReverb) o.sendReverb = t.sendReverb;
      if (t.sendDelay) o.sendDelay = t.sendDelay;
      if (t.role) o.role = t.role;
      if (t.drum !== undefined) o.drum = t.drum;
      return o;
    });
    return JSON.stringify(out, null, pretty === false ? 0 : 2);
  }

  function round(v, d) {
    var m = Math.pow(10, d === undefined ? 2 : d);
    return Math.round(v * m) / m;
  }

  /* ---------------- 乐理辅助：和弦 ---------------- */
  var CHORD_INTERVALS = {
    'maj': [0, 4, 7], 'min': [0, 3, 7], 'dim': [0, 3, 6], 'aug': [0, 4, 8],
    'maj7': [0, 4, 7, 11], 'min7': [0, 3, 7, 10], 'dom7': [0, 4, 7, 10],
    'min7b5': [0, 3, 6, 10], 'dim7': [0, 3, 6, 9], 'maj9': [0, 4, 7, 11, 14],
    'min9': [0, 3, 7, 10, 14], 'sus2': [0, 2, 7], 'sus4': [0, 5, 7],
    'add9': [0, 4, 7, 14], '6': [0, 4, 7, 9], 'min6': [0, 3, 7, 9],
    '5': [0, 7]
  };

  var QUALITY_ALIAS = {
    '': 'maj', 'M': 'maj', 'maj': 'maj', 'major': 'maj',
    'm': 'min', 'min': 'min', 'minor': 'min', '-': 'min',
    'dim': 'dim', 'o': 'dim', 'aug': 'aug', '+': 'aug',
    '7': 'dom7', 'maj7': 'maj7', 'M7': 'maj7', 'min7': 'min7', 'm7': 'min7',
    'min7b5': 'min7b5', 'ø': 'min7b5', 'h7': 'min7b5',
    'dim7': 'dim7', '°7': 'dim7', 'sus2': 'sus2', 'sus4': 'sus4', 'sus': 'sus4',
    'maj9': 'maj9', 'min9': 'min9', 'add9': 'add9', '6': '6', 'm6': 'min6', '5': '5'
  };

  /* "Am7" / "C" / "F#maj9" → {root:'A', quality:'min7', midis:[57,60,64,67]} */
  function parseChord(str, baseOctave) {
    var s = String(str || '').trim();
    var m = /^([A-Ga-g][#b]?)(.*)$/.exec(s);
    if (!m) return null;
    var rootLetter = m[1][0].toUpperCase();
    var accidental = m[1].length > 1 ? m[1][1] : '';
    var rest = m[2].replace('#', '').replace('b', '');
    var q = QUALITY_ALIAS[rest] || QUALITY_ALIAS[rest.toLowerCase()] || 'maj';
    var iv = CHORD_INTERVALS[q] || CHORD_INTERVALS.maj;
    var rootPc = P.nameToMidi(rootLetter + accidental + (baseOctave || 3)) % 12;
    var midis = iv.map(function (i) { return rootPc + i; });
    return { root: rootLetter + accidental, quality: q, intervals: iv, midis: midis, rootPc: rootPc };
  }

  /* ---------------- 内置示例谱 ---------------- */
  var BUILTIN = {};

  /* 示例 1：四踩底鼓 + 军鼓 + 贝斯 + 和弦垫（8 小节） */
  BUILTIN.dance = (function () {
    var s = makeSong({ name: '示例 · 四踩舞曲', bpm: 128, timeSignature: [4, 4], loopBars: 4 });
    var kick = [], snare = [], hat = [], bass = [], chord = [];
    for (var bar = 0; bar < 4; bar++) {
      var b0 = bar * 4;
      [0, 1, 2, 3].forEach(function (k) {
        kick.push(makeNote(b0 + k, 0.25, 36, k === 0 ? 1 : 0.85));
      });
      snare.push(makeNote(b0 + 1, 0.25, 38, 0.9));
      snare.push(makeNote(b0 + 3, 0.25, 38, 0.95));
      [0.5, 1.5, 2.5, 3.5].forEach(function (h) {
        hat.push(makeNote(b0 + h, 0.125, 42, h === 0.5 ? 0.5 : 0.38));
      });
    }
    // 简单 i - VI - III - VII 进行（Am）
    var prog = [
      { beat: 0,  pitches: 'A2:A3' },
      { beat: 4,  pitches: 'F2:F3' },
      { beat: 8,  pitches: 'C3:C4' },
      { beat: 12, pitches: 'G2:G3' }
    ];
    prog.forEach(function (c) {
      bass.push(makeNote(c.beat, 1.5, c.pitches.split(':')[0], 0.9));
      bass.push(makeNote(c.beat + 2, 1.5, c.pitches.split(':')[0], 0.75));
      chord.push(makeNote(c.beat, 3.5, c.pitches + ':' + chordTone(c.pitches.split(':')[0], 0) + ':' + chordTone(c.pitches.split(':')[0], 1), 0.5));
      chord.push(makeNote(c.beat + 2, 1.5, c.pitches + ':' + chordTone(c.pitches.split(':')[0], 0) + ':' + chordTone(c.pitches.split(':')[0], 1), 0.42));
    });

    s.tracks.push(makeTrack('底鼓', 0, kick));
    s.tracks.push(makeTrack('军鼓', 1, snare));
    s.tracks.push(makeTrack('踩镲', 2, hat, { volume: 0.5 }));
    s.tracks.push(makeTrack('贝斯', 3, bass, { volume: 0.85 }));
    s.tracks.push(makeTrack('和弦垫', 4, chord, { volume: 0.5, sendReverb: 0.4 }));
    return s;
  })();

  function chordTone(rootName, idx) {
    var base = P.nameToMidi(rootName);
    var third = base + (rootName[0] === 'A' || rootName[0] === 'D' || rootName[0] === 'G' ? 4 : 3);
    var fifth = base + 7;
    return P.midiToName(idx === 0 ? third : fifth);
  }

  /* 示例 2：慢速抒情，演示锁时长变调（pad） */
  BUILTIN.ballad = (function () {
    var s = makeSong({ name: '示例 · 慢速抒情', bpm: 72, timeSignature: [4, 4], loopBars: 4 });
    var pad = [], bass = [], lead = [];
    var chords = [
      { beat: 0,  root: 'C3' },
      { beat: 4,  root: 'A2' },
      { beat: 8,  root: 'F2' },
      { beat: 12, root: 'G2' }
    ];
    chords.forEach(function (c) {
      var b = P.nameToMidi(c.root);
      pad.push(makeNote(c.beat, 3.8, c.root + ':' + P.midiToName(b + 4) + ':' + P.midiToName(b + 7), 0.45));
      bass.push(makeNote(c.beat, 3.8, P.midiToName(b - 12), 0.8));
      bass.push(makeNote(c.beat + 2, 1.8, P.midiToName(b - 12), 0.6));
    });
    // 简单旋律
    var mel = [[0, 'C4', 1], [1, 'E4', 0.7], [2, 'G4', 0.8], [3.5, 'E4', 0.6],
               [4, 'A3', 0.7], [5, 'C4', 0.75], [6, 'E4', 0.85], [7.5, 'D4', 0.6],
               [8, 'F3', 0.7], [9, 'A3', 0.75], [10, 'C4', 0.85], [11.5, 'A3', 0.6],
               [12, 'B3', 0.7], [13, 'D4', 0.75], [14, 'G4', 0.9], [15, 'F4', 0.7]];
    mel.forEach(function (m) { lead.push(makeNote(m[0], 1, m[1], m[2])); });

    s.tracks.push(makeTrack('Pad 和弦', 0, pad, { volume: 0.55, sendReverb: 0.5 }));
    s.tracks.push(makeTrack('贝斯', 1, bass, { volume: 0.8 }));
    s.tracks.push(makeTrack('主旋律', 2, lead, { volume: 0.7, sendDelay: 0.3 }));
    return s;
  })();

  /* 示例 3：空模板 */
  BUILTIN.empty = makeSong({ name: '新建乐谱', bpm: 120, timeSignature: [4, 4], tracks: [] });

  BS.score = {
    makeSong: makeSong,
    makeTrack: makeTrack,
    makeNote: makeNote,
    parse: parse,
    parseSig: parseSig,
    parseChord: parseChord,
    CHORD_INTERVALS: CHORD_INTERVALS,
    expandPitch: expandPitch,
    beatToSec: beatToSec,
    totalBeats: totalBeats,
    totalSec: totalSec,
    barsOf: barsOf,
    beatLabel: beatLabel,
    buildEvents: buildEvents,
    serialize: serialize,
    round: round,
    BUILTIN: BUILTIN,
    round2: round
  };

})(window);

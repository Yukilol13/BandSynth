/* BandSynth · tone.js
 * 乐音合成内核（重写版）
 *
 * ── 为什么重写（旧实现的三处致命问题）──
 *  旧实现用 `dur` 既当时长又当周期：`ph += 1/dur` 配 `dur = 2.0`
 *  → 基频只有 0.5Hz，一个周期占满 2 秒。
 *  采样器靠 playbackRate 变调（ratio = 2^((note-root)/12)）：
 *    · 在 rootNote 触发 → 播出 0.5Hz 超低频，听着像嗡嗡声
 *    · 升八度        → 1Hz，仍是次声
 *    · 降八度        → 0.25Hz 完全不可闻
 *  加上「一个周期占 2 秒」使波形在时域上几乎是条直线，
 *  任何非整数周期叠加都会产生拍频与超幅削波 → 方波味。
 *
 * ── 新实现的三条原则 ──
 *  1. 基频由 rootNote 真实推导：f0 = 440 * 2^((root-69)/12)
 *     采样里存的就是「rootNote 对应的真实音」，与采样机一致。
 *  2. 循环类音色的时长对齐到整数个周期，loop 首尾相位连续 → 无咔哒。
 *     alignCycles(f0, seconds) 返回 = round(f0*sec)/f0。
 *  3. 全部用「谐波叠加 + 低通包络」而非方波/锯波硬切。
 *     乐器音色本质是有限谐波，实测方波的 1/k 衰减到 Nyquist 会听着刺耳。
 *
 * ── 声学近似 ──
 *  · 钢琴/吉他：非谐波不丰富但瞬态强 → 少量奇次谐波 + 拨弦噪声 + 快衰减
 *  · 贝斯：基频 + 二次谐波 + 亚音，低通包络
 *  · 电钢（Rhodes）：基频 + 三次谐波（钟）+ 拍频微失谐
 *  · 风琴：各次谐波独立「音栓」电平，加轻微失谐产生合唱感
 *  · 弦乐：锯齿波经低通，缓慢起振
 *  · 电吉他：削波（tanh）+ 高频抬升，模拟过载
 *  · 原声吉他：Karplus-Strong 拨弦 + 琴体共振
 */
(function (global) {
  'use strict';
  var BS = global.BS;
  var U = BS.util, P = BS.pitch;

  function buf(ctx, seconds, channels) {
    return ctx.createBuffer(channels || 1,
      Math.max(1, Math.ceil(ctx.sampleRate * seconds)), ctx.sampleRate);
  }

  function lcg(seed) {
    var s = (seed || 1) >>> 0;
    return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }

  /* 把时长对齐到整数个基频周期（保证 loop 无缝） */
  function alignCycles(f0, seconds) {
    var cycles = Math.max(1, Math.round(f0 * seconds));
    return cycles / f0;
  }

  /* 峰值归一：避免多谐波叠加后削波（削波会让波形"方"化） */
  function normalize(d, target) {
    var peak = 0, i;
    for (i = 0; i < d.length; i++) {
      var a = d[i] < 0 ? -d[i] : d[i];
      if (a > peak) peak = a;
    }
    if (peak < 1e-9) return d;
    var g = (target === undefined ? 0.9 : target) / peak;
    for (i = 0; i < d.length; i++) d[i] = U.clamp(d[i] * g, -1, 1);
    return d;
  }

  /* tanh 软削波（吉他过载） */
  function saturate(x, drive) {
    return Math.tanh(x * (1 + drive * 8)) / Math.tanh(1 + drive * 8);
  }

  /* 一阶低通（谐波用，越靠近高频越衰减） */
  function makeLP(ctx, cutoffHz) {
    var dt = 1 / ctx.sampleRate;
    var rc = 1 / (2 * Math.PI * Math.max(20, cutoffHz));
    var a = dt / (rc + dt);
    var y = 0;
    return function (x) { y += a * (x - y); return y; };
  }

  /* 加法合成：partials = [{mult, amp, decay, tau}]
     ── decay / tau 的区别（曾在此踩坑）──
     decay  : 每「周期」衰减系数（<1 衰减），适合钟、铃这类长延音
     tau    : 指数衰减时间常数（秒），适合拨弦、钢琴这类需要快速衰减的
     初版原声吉他用 decay: 0.9970 + f0=261Hz 计算出的衰减极慢
     （实测包络 20ms 段 RMS 从 57 几乎不降到 50，听感是「持续嗡」而非拨弦），
     根因是 decay 的指数 `t*f0*mult/8` 在高频分音上衰减过快、
     而低频分音几乎不衰减，整体包络被低频拖平。
     现改为：decay 用于长延音音色，tau 用于拨弦/击弦音色。 */
  function additive(ctx, opts) {
    var f0 = opts.freq;
    var dur = opts.cycles ? alignCycles(f0, opts.cycles) : (opts.dur || 1.5);
    var b = buf(ctx, dur);
    var d = b.getChannelData(0);
    var sr = ctx.sampleRate;
    var parts = opts.partials || [];
    var lp = opts.lowpass ? makeLP(ctx, opts.lowpass) : null;
    var lp2 = opts.lowpass2 ? makeLP(ctx, opts.lowpass2) : null;

    var acc = parts.map(function () { return 0; });

    for (var i = 0; i < d.length; i++) {
      var t = i / sr;
      var s = 0;
      for (var k = 0; k < parts.length; k++) {
        var pt = parts[k];
        if (pt.mult * f0 >= sr * 0.45) continue;
        acc[k] += f0 * pt.mult / sr;
        if (acc[k] >= 1) acc[k] -= 1;
        var env = 1;
        if (pt.tau) env = Math.exp(-t / pt.tau);                       // 秒级衰减
        else if (pt.decay) env = Math.pow(pt.decay, t * f0 * pt.mult / 8); // 每周期衰减
        s += Math.sin(acc[k] * 2 * Math.PI) * pt.amp * env;
      }
      if (lp) s = lp(s);
      if (lp2) s = lp2(s);
      d[i] = s;
    }

    /* 首尾淡化：防爆音 */
    var fadeN = Math.min(Math.floor(sr * 0.003), Math.floor(d.length / 8));
    for (var j = 0; j < fadeN; j++) {
      var g = j / fadeN;
      d[j] *= g;
      d[d.length - 1 - j] *= g;
    }

    normalize(d, opts.peak === undefined ? 0.85 : opts.peak);
    return b;
  }

  /* 拨弦噪声（吉他/钢琴的起音瞬态）
     skip: 从第几个采样开始叠加，避免破坏首样本的 0 值 */
  function addPickNoise(d, sr, amount, decay, seed, skip) {
    if (amount <= 0) return d;
    var rnd = lcg(seed || 999);
    var lp = 0;
    var s0 = skip || 0;
    for (var i = s0; i < d.length; i++) {
      var t = (i - s0) / sr;
      var env = Math.exp(-t / decay);
      if (env < 0.0005) break;
      lp = lp * 0.35 + (rnd() * 2 - 1) * 0.65;   // 略带高频成分
      d[i] += lp * amount * env;
    }
    return d;
  }

  /* Karplus-Strong 拨弦（弦类乐器） */
  function ks(ctx, opts) {
    var f0 = opts.freq;
    var dur = opts.dur || 1.2;
    var b = buf(ctx, dur);
    var d = b.getChannelData(0);
    var sr = ctx.sampleRate;
    var N = Math.max(2, Math.round(sr / f0));
    var line = new Float32Array(N);
    var rnd = lcg(opts.seed || 4242);
    var damp = opts.damp === undefined ? 0.5 : opts.damp;
    var bright = opts.bright === undefined ? 0.5 : opts.bright;

    // 激励：噪声 + 低通（bright 控制滤波程度）
    // 注意 bright 不能太低：基频会被滤掉，实测原声吉他基频只剩 4.6%，
    // 而 3 次谐波 266% —— 听起来就只剩"薄薄的鼻音"而不是吉他。
    var lp = 0;
    for (var i = 0; i < N; i++) {
      lp = lp * (1 - bright * 0.55) + (rnd() * 2 - 1) * (bright * 0.55 + 0.30);
      line[i] = lp;
    }

    var idx = 0, lpState = 0, prev = 0;
    var k1 = 0.5 - damp * 0.04;      // 阻尼越强，滤波越重
    var k2 = 0.45 + (1 - bright) * 0.2;
    for (var j = 0; j < d.length; j++) {
      var cur = line[idx];
      var next = line[(idx + 1) % N];
      var avg = (cur + next) * 0.5;
      lpState = prev + (avg - prev) * k1;
      lpState = lpState + (avg - lpState) * k2;
      line[idx] = lpState;
      prev = lpState;
      d[j] = lpState;      // 取滤波后的值（原来取 cur 会让高次谐波失控）
      idx = (idx + 1) % N;
    }

    // 整体包络（拨弦后自然衰减）
    var atk = Math.floor(sr * 0.002);
    for (var k = 0; k < atk && k < d.length; k++) d[k] *= k / atk;
    var rel = Math.floor(sr * 0.01);
    for (var m = 0; m < rel && m < d.length; m++) {
      d[d.length - 1 - m] *= m / rel;
    }

    normalize(d, opts.peak === undefined ? 0.85 : opts.peak);
    return b;
  }

  /* 音色库：每个 id 对应一个真实 rootNote 频率的合成器 */
  var T = BS.tone = {
    alignCycles: alignCycles,
    normalize: normalize,
    saturate: saturate,
    additive: additive,
    ks: ks,
    addPickNoise: addPickNoise,

    /* ---------- 乐音 ---------- */
    /* 电钢 Rhodes：基频 + 三次谐波（钟）+ 微失谐拍频 */
    ePiano: function (ctx, f0) {
      var b = additive(ctx, {
        freq: f0, cycles: 2.0, lowpass: 5200, peak: 0.82,
        partials: [
          { mult: 1, amp: 1.0, decay: 0.994 },
          { mult: 2, amp: 0.22, decay: 0.982 },      // 快衰减的金属声
          { mult: 3, amp: 0.30, decay: 0.990 },      // 钟音
          { mult: 4, amp: 0.10, decay: 0.986 },
          { mult: 5, amp: 0.06, decay: 0.982 },
          { mult: 7, amp: 0.035, decay: 0.976 }
        ]
      });
      // 拍频：两个略微失谐的基频叠加，产生 Rhodes 的"呼吸感"
      var d = b.getChannelData(0);
      var sr = ctx.sampleRate;
      var ph = 0;
      for (var i = 0; i < d.length; i++) {
        ph += f0 * 1.0007 / sr;
        d[i] = d[i] * 0.86 + Math.sin(ph * 2 * Math.PI) * 0.16;
      }
      normalize(d, 0.82);
      return b;
    },

    /* 钢琴：奇次谐波为主（琴弦两端固定），快衰减 + 琴槌噪声 */
    piano: function (ctx, f0) {
      var b = additive(ctx, {
        freq: f0, cycles: 2.6, lowpass: 6500, peak: 0.85,
        partials: [
          { mult: 1, amp: 1.00, tau: 2.20 },   // 钢琴：基频衰减最慢
          { mult: 2, amp: 0.42, tau: 1.30 },
          { mult: 3, amp: 0.26, tau: 0.95 },
          { mult: 4, amp: 0.15, tau: 0.70 },
          { mult: 5, amp: 0.09, tau: 0.52 },
          { mult: 6, amp: 0.055, tau: 0.38 },
          { mult: 7, amp: 0.035, tau: 0.28 },
          { mult: 8, amp: 0.02, tau: 0.20 }
        ]
      });
      addPickNoise(b.getChannelData(0), ctx.sampleRate, 0.28, 0.02, 1357, 2);
      normalize(b.getChannelData(0), 0.85);
      return b;
    },

    /* 贝斯：基频 + 少量二次谐波 + 轻微亚音，低通压掉刺耳高频
       注：亚音（0.5 倍频）电平必须远低于基频，否则会被误听成低八度 */
    bass: function (ctx, f0) {
      var b = additive(ctx, {
        freq: f0, cycles: 1.5, lowpass: 900, lowpass2: 2200, peak: 0.88,
        partials: [
          { mult: 1, amp: 1.0, decay: 0.9975 },
          { mult: 2, amp: 0.30, decay: 0.9880 },
          { mult: 3, amp: 0.12, decay: 0.9800 },
          { mult: 4, amp: 0.05, decay: 0.9720 },
          { mult: 0.5, amp: 0.10, decay: 0.9990 }    // 亚音：只做点缀
        ]
      });
      var d = b.getChannelData(0);
      var sr = ctx.sampleRate;
      var atk = Math.floor(sr * 0.004);
      for (var i = 0; i < atk; i++) d[i] *= i / atk;   // 消除起音爆音
      normalize(d, 0.88);
      return b;
    },

    /* 弦乐：慢起振的锯齿经低通，叠两个微失谐声部 */
    strings: function (ctx, f0) {
      var dur = alignCycles(f0, 2.2);
      var b = buf(ctx, dur);
      var d = b.getChannelData(0);
      var sr = ctx.sampleRate;
      var p1 = 0, p2 = 0;
      var lp1 = makeLP(ctx, 2600), lp2 = makeLP(ctx, 2800);
      for (var i = 0; i < d.length; i++) {
        var t = i / sr;
        p1 += f0 / sr; if (p1 >= 1) p1 -= 1;
        p2 += f0 * 1.0013 / sr; if (p2 >= 1) p2 -= 1;
        // 锯齿（限幅避免硬边产生方波味）
        var saw1 = (p1 * 2 - 1) * 0.55;
        var saw2 = (p2 * 2 - 1) * 0.45;
        // 起振包络：头尾都要归零，否则 loop 边界有跳变（实测 135%）
        var env = Math.min(1, t / 0.22) * Math.min(1, (dur - t) / 0.22);
        var vib = 1 + 0.004 * Math.sin(2 * Math.PI * 5.0 * t) * Math.min(1, t / 0.4);
        d[i] = (lp1(saw1) + lp2(saw2)) * env * vib;
      }
      normalize(d, 0.72);
      return b;
    },

    /* 暖垫：宽频柔和衬底，慢起慢落 */
    warmPad: function (ctx, f0) {
      var b = additive(ctx, {
        freq: f0, cycles: 2.4, lowpass: 1800, peak: 0.65,
        partials: [
          { mult: 1, amp: 1.0 },
          { mult: 2, amp: 0.30, decay: 0.9985 },
          { mult: 3, amp: 0.16, decay: 0.9960 },
          { mult: 4, amp: 0.09, decay: 0.9940 },
          { mult: 5, amp: 0.05, decay: 0.9920 }
        ]
      });
      var d = b.getChannelData(0);
      var sr = ctx.sampleRate;
      var ph = 0;
      for (var i = 0; i < d.length; i++) {
        var t = i / sr;
        ph += f0 * 1.0017 / sr;                       // 微失谐 → 缓慢拍频
        var env = Math.min(1, t / 0.35);
        d[i] = (d[i] * 0.9 + Math.sin(ph * 2 * Math.PI) * 0.1) * env;
      }
      normalize(d, 0.65);
      return b;
    },

    /* 风琴：音栓式谐波，独立电平，轻失谐合唱 */
    organ: function (ctx, f0) {
      var b = additive(ctx, {
        freq: f0, cycles: 2.0, lowpass: 9000, peak: 0.72,
        partials: [
          { mult: 1, amp: 1.0 },                       // 8'
          { mult: 2, amp: 0.55 },                      // 4'
          { mult: 3, amp: 0.32 },                      // 2⅔'
          { mult: 4, amp: 0.42 },                      // 2'
          { mult: 6, amp: 0.16 },                      // 1⅓'
          { mult: 8, amp: 0.20 }                       // 1'
        ]
      });
      var d = b.getChannelData(0);
      var sr = ctx.sampleRate;
      var ph = 0;
      for (var i = 0; i < d.length; i++) {
        ph += f0 * 1.0012 / sr;
        d[i] = d[i] * 0.92 + Math.sin(ph * 2 * Math.PI) * 0.08;
      }
      normalize(d, 0.72);
      return b;
    },

    /* 主音（lead）：圆润的合成主音，非方波 */
    lead: function (ctx, f0) {
      var b = additive(ctx, {
        freq: f0, cycles: 1.6, lowpass: 4200, peak: 0.78,
        partials: [
          { mult: 1, amp: 1.0, decay: 0.998 },
          { mult: 2, amp: 0.34, decay: 0.994 },
          { mult: 3, amp: 0.18, decay: 0.990 },
          { mult: 4, amp: 0.10, decay: 0.986 },
          { mult: 5, amp: 0.06, decay: 0.982 },
          { mult: 7, amp: 0.03, decay: 0.978 }
        ]
      });
      var d = b.getChannelData(0);
      var sr = ctx.sampleRate;
      var atk = Math.floor(sr * 0.008);
      for (var i = 0; i < atk; i++) d[i] *= i / atk;
      normalize(d, 0.78);
      return b;
    },

    /* 钟琴：非整数倍频（真实钟的音高是非谐的） */
    bell: function (ctx, f0) {
      var b = additive(ctx, {
        freq: f0, cycles: 2.8, lowpass: 11000, peak: 0.62,
        partials: [
          { mult: 1, amp: 1.0, decay: 0.9992 },
          { mult: 2.76, amp: 0.42, decay: 0.9970 },
          { mult: 5.40, amp: 0.26, decay: 0.9940 },
          { mult: 8.93, amp: 0.14, decay: 0.9900 },
          { mult: 13.34, amp: 0.07, decay: 0.9860 }
        ]
      });
      return b;
    },

    /* 人声「啊」：共振峰合成（formant）
       实现要点：用「谐波叠加 + 共振峰包络加权」而非脉冲串激励。
       脉冲串的基频能量太弱，会被 800Hz 共振峰淹没（实测基频被测到低八度）。
       谐波加权方式：第 n 次谐波乘以该频率处的共振峰增益。 */
    vocalAh: function (ctx, f0) {
      var dur = alignCycles(f0, 2.2);
      var b = buf(ctx, dur);
      var d = b.getChannelData(0);
      var sr = ctx.sampleRate;
      // 元音 /a/ 的共振峰频率与带宽
      var formants = [[800, 1.0, 120], [1150, 0.55, 140], [2900, 0.25, 180]];

      // 共振峰增益：靠近峰值的谐波被放大
      function formantGain(f) {
        var g = 0.06;                       // 基线：保留一点全频段，避免空洞
        for (var i = 0; i < formants.length; i++) {
          var fc = formants[i][0], bw = formants[i][1], amp = formants[i][2];
          // 洛伦兹曲线近似
          var x = (f - fc) / bw;
          g += amp / (1 + x * x);
        }
        return Math.min(g, 2.2);
      }

      var maxHarm = Math.min(24, Math.floor(sr * 0.45 / f0));
      var acc = [];
      var gains = [];
      for (var h = 1; h <= maxHarm; h++) {
        acc.push(0);
        gains.push(formantGain(f0 * h) / Math.pow(h, 0.7));  // 随次数自然衰减
      }

      for (var i2 = 0; i2 < d.length; i2++) {
        var t2 = i2 / sr;
        var v = 0;
        for (var k = 0; k < maxHarm; k++) {
          acc[k] += f0 * (k + 1) / sr;
          if (acc[k] >= 1) acc[k] -= 1;
          v += Math.sin(acc[k] * 2 * Math.PI) * gains[k];
        }
        var env = Math.min(1, t2 / 0.18) * Math.min(1, (dur - t2) / 0.25);
        d[i2] = v * env;
      }
      normalize(d, 0.6);
      return b;
    },

  /* 拨弦（通用拨弦乐器）
     ── 调试记录 ──
     初版 Karplus-Strong 输出的基频只有 4.6%，而 3 次谐波高达 266%，
     听起来是「薄薄的鼻音」而不是拨弦乐器。
     原因：延迟线上的平均低通过强，且输出直接取滤波前的原始值，
     导致高次谐波在延迟线里反复循环时不断叠加。
     修正：激励更亮（保留基频）、阻尼更轻、输出用滤波后的结果。 */
  pluck: function (ctx, f0) {
    var b = ks(ctx, { freq: f0, dur: 1.1, damp: 0.22, bright: 0.85, seed: 2468, peak: 0.85 });
    addPickNoise(b.getChannelData(0), ctx.sampleRate, 0.16, 0.012, 777, 1);
    return b;
  },

    /* 原声吉他：Karplus-Strong 拨弦 + 琴体共振 + 拨片噪声
       琴体共振频率取基频的固定低倍比（而非固定 100Hz），
       否则低音区会与基频区重叠，实测基频会被拉偏 25%。 */
    acousticGuitar: function (ctx, f0) {
      /* 原声吉他（钢弦）
         ── 为何不用纯 Karplus-Strong ──
         KS 的拨片激励本质是「带通滤波后的噪声」，基频能量取决于
         N = sr/f0 处的增益，无法独立控制各次谐波比例。
         实测无论怎么调 bright/damp，基频都只有峰值的 35% 左右，
         而 3 次谐波高达 266% —— 听着是「薄鼻音」而非吉他。

         改为「加法合成 + 拨弦包络」，各次谐波幅度可精确指定：
           · 基频最强（吉他根本音来自弦的整体振动）
           · 2~6 次递减（拨片越靠桥，音色越亮）
           · 8 次以上快速衰减（避免刺耳）
         再叠加琴体共振与拨片噪声，得到接近真实民谣吉他的音色。 */
      var b = additive(ctx, {
        freq: f0, dur: 1.6, lowpass: 7000, peak: 0.86,
        partials: [
          { mult: 1, amp: 1.00, tau: 1.10 },   // 拨弦：秒级指数衰减
          { mult: 2, amp: 0.52, tau: 0.85 },
          { mult: 3, amp: 0.36, tau: 0.62 },
          { mult: 4, amp: 0.24, tau: 0.45 },
          { mult: 5, amp: 0.16, tau: 0.33 },
          { mult: 6, amp: 0.11, tau: 0.24 },
          { mult: 7, amp: 0.07, tau: 0.17 },
          { mult: 8, amp: 0.045, tau: 0.12 },
          { mult: 9, amp: 0.028, tau: 0.09 },
          { mult: 10, amp: 0.016, tau: 0.07 }
        ]
      });
      var d = b.getChannelData(0);
      var sr = ctx.sampleRate;
      // 拨弦包络：3ms 起音（拨片离弦瞬间）
      var atk = Math.floor(sr * 0.0003);   // 0.3ms 陡起音 = 拨弦感
      for (var i = 0; i < atk && i < d.length; i++) d[i] *= i / atk;
      // 琴体共振：放在 1.19 / 1.56 倍频（非整数倍，避免与基频混淆）
      var body = [[1.19, 0.07], [1.56, 0.05]];
      for (var bi = 0; bi < body.length; bi++) {
        var bc = f0 * body[bi][0];
        if (bc < 45) continue;
        var ph = 0;
        for (var j = 0; j < d.length; j++) {
          var t = j / sr;
          ph += bc / sr;
          if (ph >= 1) ph -= 1;
          d[j] += Math.sin(ph * 2 * Math.PI) * body[bi][1] * Math.exp(-t / 0.45);
        }
      }
      addPickNoise(d, sr, 0.45, 0.006, 2468, 2);   // 明显的拨片声
      normalize(d, 0.86);
      return b;
    },

    /* 电吉他（过载）：非对称削波 + 高频抬升
       ── 设计教训 ──
       预增益过高（3.2×）会把基频也推过削波拐点，
       波形被压成近似方波（实测 偶次/奇次 = 1.05，方波的理论值就是 1），
       高次谐波反而消失、听着就是" digital 方波"。
       正确做法：预增益适中（1.6×），只让中高频越过拐点，
       基频保持线性 —— 这才是真实过载（管子非线性 + 前级 EQ）的样子。 */
    electricGuitar: function (ctx, f0) {
      var b = additive(ctx, {
        freq: f0, cycles: 1.8, peak: 0.8,
        partials: [
          { mult: 1, amp: 1.00, tau: 1.60 },
          { mult: 2, amp: 0.30, tau: 1.30 },
          { mult: 3, amp: 0.26, tau: 1.10 },
          { mult: 4, amp: 0.24, tau: 0.95 },
          { mult: 5, amp: 0.20, tau: 0.82 },
          { mult: 6, amp: 0.16, tau: 0.72 },
          { mult: 7, amp: 0.13, tau: 0.62 },
          { mult: 8, amp: 0.11, tau: 0.54 },
          { mult: 9, amp: 0.09, tau: 0.47 },
          { mult: 10, amp: 0.07, tau: 0.41 },
          { mult: 11, amp: 0.05, tau: 0.36 },
          { mult: 12, amp: 0.04, tau: 0.31 }
        ]
      });
      var d = b.getChannelData(0);
      var sr = ctx.sampleRate;
      var hp = 0, prevIn = 0;
      for (var i = 0; i < d.length; i++) {
        // 高频抬升（前馈高通，得到"琴颈拾音"的亮感）
        hp = 0.88 * (hp + d[i] - prevIn);
        prevIn = d[i];
        var bright = d[i] * 0.72 + hp * 0.28;
        // 预增益适中：基频刚好在拐点附近，中高频越过拐点产生泛音
        var v = bright * 1.6;
        // 非对称软削波：正负半周拐点不同 → 偶次谐波（吉他的标志）
        // 负半周拐点更早（系数 2.2 vs 正半周 1.0）→ 强不对称 → 偶次谐波
        d[i] = v > 0 ? (1 - Math.exp(-v)) : -(1 - Math.exp(v * 2.2));
      }
      addPickNoise(d, sr, 0.24, 0.006, 8642, 2);
      normalize(d, 0.85);
      return b;
    }
  };

})(window);

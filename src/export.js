/* BandSynth · export.js
 * 采样导出服务
 *
 * 关键点：导出「实际听到的声音」，而不是 buffer 原始数据。
 * 依次应用：
 *   1. 选区裁剪（startSec / endSec）
 *   2. 反向（若开启）
 *   3. 采样音量 sampleGain
 *   4. 归一化（可选）
 *   5. 淡入淡出（可选，默认 5ms，消除边界咔哒）
 *   6. 削波保护
 */
(function (global) {
  'use strict';
  var BS = global.BS;
  var U = BS.util;

  var Exporter = BS.exporter = {};

  /* 从声部生成导出用的浮点通道数组
     opts: {applyRange=true, applyReverse=true, applyGain=true, normalize=false, fadeMs=5, maxSec=0} */
  Exporter.buildChannels = function (ctx, part, opts) {
    opts = opts || {};
    if (!part || !part.buffer) return null;

    var sr = part.buffer.sampleRate;
    var src = part.sourceBuffer();          // 已含反向变体
    if (!src) return null;

    // 1. 选区
    var s = 0, e = src.duration;
    if (opts.applyRange !== false) {
      s = U.clamp(part.startSec || 0, 0, src.duration);
      e = part.endSec > s ? U.clamp(part.endSec, 0, src.duration) : src.duration;
      if (e <= s) e = src.duration;
    }
    var i0 = Math.floor(s * sr);
    var i1 = Math.ceil(e * sr);
    i1 = U.clamp(i1, i0 + 1, src.length);
    var len = i1 - i0;
    if (len <= 0) return null;

    // 可选时长上限（防止误导出超长文件）
    if (opts.maxSec > 0) {
      var maxLen = Math.floor(opts.maxSec * sr);
      if (len > maxLen) len = maxLen;
    }

    // 2~3. 拷贝 + 增益
    var gain = opts.applyGain === false ? 1 : (part.sampleGain === undefined ? 1 : part.sampleGain);
    var nCh = src.numberOfChannels;
    var chans = [];
    for (var c = 0; c < nCh; c++) {
      var sd = src.getChannelData(c);
      var out = new Float32Array(len);
      var gi = i0;
      for (var i = 0; i < len; i++, gi++) {
        out[i] = (sd[gi] || 0) * gain;
      }
      chans.push(out);
    }

    // 4. 归一化
    if (opts.normalize) {
      var peak = 0;
      chans.forEach(function (d) {
        for (var i = 0; i < d.length; i++) {
          var a = d[i] < 0 ? -d[i] : d[i];
          if (a > peak) peak = a;
        }
      });
      if (peak > 1e-6) {
        var g = 0.98 / peak;
        if (g > 1 || g < 1) {
          chans.forEach(function (d) { for (var i = 0; i < d.length; i++) d[i] *= g; });
        }
      }
    }

    // 5. 淡入淡出
    var fadeMs = opts.fadeMs === undefined ? 5 : opts.fadeMs;
    if (fadeMs > 0) {
      var nf = Math.min(Math.floor(sr * fadeMs / 1000), Math.floor(len / 4));
      if (nf >= 2) {
        chans.forEach(function (d) {
          for (var j = 0; j < nf; j++) {
            var gIn = j / nf;
            var gOut = (nf - j) / nf;
            d[j] *= gIn;
            d[len - 1 - j] *= gOut;
          }
        });
      }
    }

    // 6. 削波保护
    var needsClip = false;
    chans.forEach(function (d) {
      for (var i = 0; i < d.length; i++) {
        if (d[i] > 1 || d[i] < -1) { needsClip = true; break; }
      }
    });
    if (needsClip) {
      chans.forEach(function (d) {
        for (var i = 0; i < d.length; i++) d[i] = U.clamp(d[i], -1, 1);
      });
    }

    return { channels: chans, sampleRate: sr, length: len, duration: len / sr, clipped: needsClip };
  };

  /* 导出为 WAV Blob */
  Exporter.toWavBlob = function (ctx, part, opts) {
    opts = opts || {};
    var built = Exporter.buildChannels(ctx, part, opts);
    if (!built) return Promise.reject(new Error('没有可导出的采样'));
    var ab = BS.wav.encodeChannels(built.channels, built.sampleRate, {
      bitDepth: opts.bitDepth || 16
    });
    return Promise.resolve({
      blob: new Blob([ab], { type: 'audio/wav' }),
      duration: built.duration,
      sampleRate: built.sampleRate,
      channels: built.channels.length,
      clipped: built.clipped,
      frames: built.length
    });
  };

  /* 导出并触发下载 */
  Exporter.download = function (ctx, part, opts) {
    opts = opts || {};
    return Exporter.toWavBlob(ctx, part, opts).then(function (r) {
      var name = Exporter.suggestName(part, opts);
      U.download(r.blob, name);
      return { name: name, duration: r.duration, clipped: r.clipped };
    });
  };

  /* 生成文件名：采样名 + 标记，非法字符替换 */
  Exporter.suggestName = function (part, opts) {
    opts = opts || {};
    var base = (opts.fileName || part.bufferName || part.name || 'sample').replace(/\.[a-z0-9]+$/i, '');
    base = base.replace(/[\\/:*?"<>|]/g, '_').trim() || 'sample';
    var tags = [];
    if (opts.applyRange !== false && part.startSec > 0.001) tags.push('trim');
    if (part.reverse) tags.push('rev');
    if (part.sampleGain !== undefined && Math.abs(part.sampleGain - 1) > 0.01) {
      tags.push('gain' + (part.sampleGain > 1 ? '+' : '') + U.gainToDb(part.sampleGain).toFixed(1));
    }
    var suffix = tags.length ? '_' + tags.join('_') : '';
    return base + suffix + '.wav';
  };

  /* ================= 采样入库 ================= */
  /* 把声部当前采样存进采样库，返回记录 */
  Exporter.saveToLibrary = function (ctx, part, opts) {
    opts = opts || {};
    return BS.library.init().then(function () {
      var built = Exporter.buildChannels(ctx, part, {
        applyRange: true, applyGain: false, normalize: false, fadeMs: 0
      });
      if (!built) throw new Error('没有可保存的采样');

      // 保存原始音频（不含音量/淡化），这样日后加载仍可自由调音量
      var rec = BS.library.bufferToRecord(
        sliceBuffer(ctx, part, built.sampleRate),
        opts.name || (part.bufferName || part.name || '采样'),
        part.bufferName || ''
      );
      return BS.library.putSample(rec).then(function (r) {
        if (part._librarySampleId && part._librarySampleId !== r.id) {
          // 同一声部重复保存：删掉旧的，避免库里堆垃圾
          BS.library.deleteSample(part._librarySampleId);
        }
        part._librarySampleId = r.id;
        return r;
      });
    });
  };

  /* 从声部切出选区（不应用音量，便于库内保持原始电平） */
  function sliceBuffer(ctx, part, sr) {
    var src = part.sourceBuffer();
    var s = U.clamp(part.startSec || 0, 0, src.duration);
    var e = part.endSec > s ? U.clamp(part.endSec, 0, src.duration) : src.duration;
    return BS.trim.sliceBuffer(ctx, src, s, e);
  }

  /* ================= 乐谱分轨导出 ================= */
  Exporter.renderSongWav = function (opts) {
    opts = opts || {};
    var bitDepth = opts.bitDepth || 16;
    return BS.renderer.renderToWav({
      song: opts.song,
      parts: opts.parts,
      sampleRate: opts.sampleRate || 44100,
      tail: opts.tail === undefined ? 2 : opts.tail,
      bitDepth: bitDepth,
      channels: opts.channels || 2
    });
  };

  /* 导出分轨（逐轨），返回多个 Blob 供批量下载 */
  Exporter.renderStems = function (opts) {
    var song = opts.song;
    var parts = opts.parts;
    // 找出所有用到的 part 索引
    var used = {};
    song.tracks.forEach(function (t) { used[t.part] = true; });
    var indices = Object.keys(used).map(Number).sort(function (a, b) { return a - b; });

    var jobs = indices.map(function (idx) {
      var sub = U.clone(song);
      sub.tracks = sub.tracks.filter(function (t) { return t.part === idx; });
      sub.tracks.forEach(function (t) { t.part = 0; });
      if (!sub.tracks.length) return null;
      var one = [parts[idx]];
      if (!one[0] || !one[0].buffer) return null;
      return BS.renderer.renderToWav({
        song: sub, parts: one,
        sampleRate: opts.sampleRate || 44100,
        tail: opts.tail === undefined ? 2 : opts.tail,
        bitDepth: opts.bitDepth || 16,
        channels: opts.channels || 2
      }).then(function (blob) {
        return { blob: blob, index: idx, name: (parts[idx].name || ('轨' + (idx + 1))) };
      });
    }).filter(Boolean);

    return Promise.all(jobs);
  };

  /* 批量触发下载（浏览器会拦截连续多文件下载，故间隔触发） */
  Exporter.downloadAll = function (items, prefix) {
    var base = (prefix || 'band-synth').replace(/[\\/:*?"<>|]/g, '_');
    var chain = Promise.resolve();
    items.forEach(function (it, i) {
      chain = chain.then(function () {
        return new Promise(function (resolve) {
          setTimeout(function () {
            var nm = base + '_' + String(i + 1).padStart(2, '0') + '_' +
              String(it.name).replace(/[\\/:*?"<>|]/g, '_') + '.wav';
            U.download(it.blob, nm);
            resolve();
          }, 220 * i);
        });
      });
    });
    return chain;
  };

})(window);

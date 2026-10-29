/* BandSynth · project.js
 * 工程保存 / 加载：一键存取「一套完整的制作现场」。
 *
 * 工程包含：
 *   · 主控设置（主音量、驱动、混响类型）
 *   · 每个声部的完整参数（复用 library.capturePreset，含采样库引用）
 *   · 当前乐谱（可直接内嵌或引用已导入的 JSON）
 *   · 演奏设置（八度、力度、当前选中声部、跟随模式）
 *   · 鼓组布局映射（哪个鼓位用哪个声部）
 *
 * 设计：采样不存进工程文件（体积太大），只存 sampleId 引用。
 * 加载时从采样库按 id 取回；若采样已删除则保留原采样并提示。
 */
(function (global) {
  'use strict';
  var BS = global.BS;
  var U = BS.util;

  var Project = BS.project = {};

  Project.VERSION = 1;

  /* ================= 导出 ================= */

  /**
   * 采集当前工程状态为纯数据。
   * @param {object} app   BS.app（提供 engine / song / keyboard 等）
   * @param {object} extra { drumMap } 鼓组声部映射
   */
  Project.capture = function (app, extra) {
    extra = extra || {};
    var engine = app.engine;
    if (!engine) throw new Error('音频引擎未启动');

    var parts = engine.parts.map(function (p, i) {
      var preset = BS.library.capturePreset(p, p._librarySampleId || null);
      return {
        index: i,
        name: p.name,
        // 标记这是鼓还是乐音（鼓不参与音高）
        role: p._isDrum ? 'drum' : 'synth',
        drumId: p._drumId || null,
        preset: {
          id: preset.id,
          name: preset.name,
          sampleId: preset.sampleId,
          bufferName: preset.bufferName,
          rootNote: preset.rootNote,
          params: preset.params,
          amp: preset.amp,
          filter: preset.filter,
          filter2: preset.filter2,
          sampleInfo: preset.sampleInfo
        }
      };
    });

    return {
      app: 'band-synth',
      version: Project.VERSION,
      savedAt: Date.now(),
      name: (app.projectName && app.projectName.value) || app.song && app.song.name || '未命名工程',
      // 鼓组通道（独立于 engine.parts，单独存档）
      drumRack: app.drumRack ? app.drumRack.toSpec() : null,
      master: {
        // 读引擎记录的目标值，而不是 gain.value（后者是渐变中的插值）
        volume: engine.masterValue,
        drive: app._masterDrive,
        reverbType: app._reverbType
      },
      perform: {
        octave: app.keyboard ? app.keyboard.octave : 3,
        numOctaves: app.keyboard ? app.keyboard.numOctaves : 4,
        velocity: app.keyboard ? app.keyboard.velocity : 0.85,
        currentPartIndex: app.currentPartIndex,
        followMode: !!app.followMode
      },
      drumMap: extra.drumMap || app.drumMap || null,
      parts: parts,
      /* 编曲（含 lengthBars / key / scale / 轨 role+toneId）。
         以前只存 song，编曲页的长度与调性一重启就丢光。 */
      arranger: (BS.appArranger && BS.appArranger.toJSON) ? BS.appArranger.toJSON() : null,
      song: app.song ? BS.score.serialize(app.song, false) : null,
      songMeta: app.song ? {
        name: app.song.name, bpm: app.song.bpm,
        timeSignature: app.song.timeSignature.slice()
      } : null
    };
  };

  /* ================= 序列化 ================= */

  Project.toJSON = function (data, pretty) {
    return JSON.stringify(data, null, pretty === false ? 0 : 2);
  };

  Project.download = function (data, fileName) {
    var name = (fileName || data.name || 'project') + '.bsproj.json';
    U.download(new Blob([Project.toJSON(data)], { type: 'application/json' }), name);
    return name;
  };

  /* ================= 解析 ================= */

  Project.parse = function (input) {
    var data = input;
    if (typeof input === 'string') {
      try { data = JSON.parse(input); }
      catch (e) { throw new Error('工程 JSON 解析失败：' + e.message); }
    }
    if (!data || typeof data !== 'object') throw new Error('工程文件格式不正确');
    if (data.app !== 'band-synth') throw new Error('这不是 BandSynth 工程文件');
    if (!Array.isArray(data.parts)) throw new Error('工程缺少 parts 数组');
    return data;
  };

  /**
   * 把工程数据恢复到 app。
   *
   * 恢复策略：
   *   · 声部数量不同时先清空再重建（避免残留）
   *   · 采样按 sampleId 从库中取；缺失则留空并记录（不中断）
   *   · 曲谱直接 parse
   *
   * @returns {Promise} { parts, song, missingSamples, warnings }
   */
  Project.restore = function (app, data) {
    var warnings = [];
    var missingSamples = [];
    var engine = app.engine;
    var ctx = app.ctx;
    if (!engine || !ctx) return Promise.reject(new Error('音频引擎未启动，无法加载工程'));

    // 1) 清空现有声部
    while (engine.parts.length) engine.removePart(engine.parts[0].id);

    // 2) 重建声部
    var chain = Promise.resolve();
    var restored = [];

    data.parts.forEach(function (spec, i) {
      chain = chain.then(function () {
        var preset = spec.preset || {};
        var opts = {
          name: spec.name || preset.name || ('声部 ' + (i + 1)),
          rootNote: preset.rootNote === undefined ? 60 : preset.rootNote,
          mode: (preset.params && preset.params.mode) || 'oneshot',
          pitchMode: (preset.params && preset.params.pitchMode) || 'varispeed',
          transpose: (preset.params && preset.params.transpose) || 0,
          fine: (preset.params && preset.params.fine) || 0,
          volume: preset.params && preset.params.volume !== undefined ? preset.params.volume : 0.8,
          pan: (preset.params && preset.params.pan) || 0,
          keyTrack: preset.params && preset.params.keyTrack !== undefined ? preset.params.keyTrack : true,
          sendReverb: (preset.params && preset.params.sendReverb) || 0,
          sendDelay: (preset.params && preset.params.sendDelay) || 0
        };
        var part = engine.addPart(opts);
        part._isDrum = spec.role === 'drum';
        part._drumId = spec.drumId || null;

        // 应用完整参数
        BS.library.applyPreset(part, preset);

        // 取回采样
        if (preset.sampleId) {
          return BS.library.getSample(preset.sampleId).then(function (rec) {
            if (rec) {
              var buf = BS.library.recordToBuffer(ctx, rec);
              part.setBuffer(buf, rec.name);
              part._librarySampleId = rec.id;
              part.endSec = buf.duration;
            } else {
              // 采样已删除：声部保留但无采样，提示用户
              missingSamples.push({ part: opts.name, sampleName: preset.bufferName || preset.sampleId });
              part._missingSample = true;
            }
          });
        }
        // 内置音色（无sampleId，但有 bufferName）：重建内置 buffer
        if (!preset.sampleId && preset.bufferName) {
          var toneId = extractToneId(preset.bufferName);
          if (toneId) {
            var buf2 = BS.factory.buffer(ctx, toneId);
            if (buf2) {
              part.setBuffer(buf2, preset.bufferName);
              part.endSec = buf2.duration;
            }
          }
        }
        restored.push(part);
      });
    });

    // 3) 鼓组通道（独立恢复，不进 engine.parts）
    return chain.then(function () {
      if (data.drumRack && app.ensureDrumRack) {
        var rack = app.ensureDrumRack();
        if (rack) rack.fromSpec(data.drumRack);
      }

      if (data.master) {
        if (typeof data.master.volume === 'number') {
          engine.setMaster(U.clamp(data.master.volume, 0, 1.5));
        }
        if (data.master.reverbType) {
          engine.setReverbType(data.master.reverbType);
          app._reverbType = data.master.reverbType;
        }
        if (typeof data.master.drive === 'number') {
          engine.setMasterDrive(data.master.drive);
          app._masterDrive = data.master.drive;
        }
      }
      if (data.perform && app.keyboard) {
        if (typeof data.perform.octave === 'number') {
          // 重建声部后 rootNote 可能变化，先按工程值设八度
          // setOctave 内部会把起始八度夹到键盘的 [minOctave, maxOctave]（C1…C4）
          app.keyboard.setOctave(Math.round(data.perform.octave));
        }
        if (typeof data.perform.velocity === 'number') {
          app.keyboard.setVelocity(data.perform.velocity);
        }
        if (typeof data.perform.currentPartIndex === 'number') {
          app.currentPartIndex = U.clamp(data.perform.currentPartIndex, 0,
            Math.max(0, engine.parts.length - 1));
        }
        app.followMode = !!data.perform.followMode;
      }

      // 4) 曲谱
      var song = null;
      if (data.song) {
        try {
          var res = BS.score.parse(data.song);
          song = res.song;
          res.warnings.forEach(function (w) { warnings.push('曲谱：' + w); });
        } catch (e) {
          warnings.push('工程内曲谱加载失败：' + e.message);
        }
      }

      // 鼓组映射
      if (data.drumMap) app.drumMap = data.drumMap;

      /* 编曲数据：声部已就位后再恢复，这样轨的连接件（toneId/part）能对上 */
      if (data.arranger && BS.appArranger && BS.appArranger.loadJSON) {
        try { BS.appArranger.loadJSON(data.arranger); }
        catch (e) { warnings.push('编曲数据加载失败：' + e.message); }
      }

      if (missingSamples.length) {
        warnings.push('有 ' + missingSamples.length +
          ' 个声部的采样在库中已不存在：' +
          missingSamples.map(function (m) { return m.part; }).join('、') +
          '。已保留参数，请重新装载采样。');
      }

      return {
        parts: restored,
        song: song,
        missingSamples: missingSamples,
        warnings: warnings
      };
    });
  };

  /* 从 bufferName 提取内置音色 id。
   * bufferName 形如「内置:piano」或「piano」。 */
  function extractToneId(bufferName) {
    if (!bufferName) return null;
    var s = String(bufferName);
    if (s.indexOf('内置:') === 0) s = s.slice(3);
    // 确认是合法的内置音色
    if (BS.factory && BS.factory.preset && BS.factory.preset(s)) return s;
    return null;
  }
  Project.extractToneId = extractToneId;

  /* ================= 文件读取 ================= */

  Project.readFile = function (file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () {
        try { resolve(Project.parse(fr.result)); }
        catch (e) { reject(e); }
      };
      fr.onerror = function () { reject(new Error('文件读取失败')); };
      fr.readAsText(file);
    });
  };

})(typeof window !== 'undefined' ? window : globalThis);

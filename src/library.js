/* BandSynth · library.js
 * 采样库 / 预设持久化
 *
 * 存储策略（三级降级，file:// 环境也能用）：
 *  1) IndexedDB —— 首选。容量大（数百 MB），可存 Float32Array 原始音频（无损）
 *  2) localStorage —— 降级。约 5MB，音频以 WAV 16bit 存（有损但可用）
 *  3) 内存 —— 最后的兜底，刷新即失，但当次会话可用，并提示用户导出
 *
 * 设计要点：
 *  · 采样与预设分离：采样是音频数据，预设是「用哪个采样 + 什么参数」。
 *    预设只存 sampleId 引用，音频本体在采样库里，避免重复存储。
 *  · 预设与声部解耦：保存时快照当前参数，加载时写回，便于「导出/分享音色」。
 *  · 所有写入都是异步的，UI 层需处理 loading 状态。
 */
(function (global) {
  'use strict';
  var BS = global.BS;
  var U = BS.util;

  var DB_NAME = 'bandsynth-library';
  var DB_VERSION = 1;
  var STORE_SAMPLES = 'samples';
  var STORE_PRESETS = 'presets';
  var LS_PREFIX = 'bandsynth.';

  var Library = BS.library = {
    ready: false,
    backend: 'unknown',     // 'idb' | 'local' | 'memory'
    quotaBytes: 0,
    usedBytes: 0,
    reason: ''
  };

  var db = null;
  var memStore = { samples: {}, presets: {} };

  /* ================= 后端初始化 ================= */
  Library.init = function () {
    if (Library.ready) return Promise.resolve(Library.backend);
    return openIdb()
      .then(function (d) {
        db = d;
        Library.backend = 'idb';
        Library.ready = true;
        Library.reason = 'IndexedDB';
        BS.emit('library:ready', Library.backend);
        return Library.backend;
      })
      .catch(function (err) {
        // file:// 或隐私模式等场景下 IndexedDB 可能不可用
        Library.reason = err && err.message ? err.message : String(err);
        if (testLocalStorage()) {
          Library.backend = 'local';
        } else {
          Library.backend = 'memory';
        }
        Library.ready = true;
        BS.emit('library:ready', Library.backend);
        return Library.backend;
      });
  };

  function openIdb() {
    return new Promise(function (resolve, reject) {
      if (!global.indexedDB) { reject(new Error('浏览器不支持 IndexedDB')); return; }
      var req;
      try {
        req = global.indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) { reject(e); return; }

      req.onupgradeneeded = function (e) {
        var d = e.target.result;
        if (!d.objectStoreNames.contains(STORE_SAMPLES)) d.createObjectStore(STORE_SAMPLES, { keyPath: 'id' });
        if (!d.objectStoreNames.contains(STORE_PRESETS)) d.createObjectStore(STORE_PRESETS, { keyPath: 'id' });
      };
      req.onsuccess = function () {
        var d = req.result;
        // 某些环境下 open 成功但事务立即失败（如 file:// 配额为 0），做一次探针
        try {
          var tx = d.transaction([STORE_SAMPLES, STORE_PRESETS], 'readonly');
          tx.objectStore(STORE_SAMPLES).count();
          tx.oncomplete = function () { resolve(d); };
          tx.onerror = function () { reject(tx.error || new Error('IndexedDB 事务失败')); };
          tx.onabort = function () { reject(tx.error || new Error('IndexedDB 事务中止')); };
        } catch (e2) { reject(e2); }
      };
      req.onerror = function () { reject(req.error || new Error('IndexedDB 打开失败')); };
      req.onblocked = function () { reject(new Error('IndexedDB 被其他标签页占用')); };
      // file:// 下可能既不 success 也不 error，加超时兜底
      setTimeout(function () { if (!db) reject(new Error('IndexedDB 打开超时')); }, 3000);
    });
  }

  function testLocalStorage() {
    try {
      var k = LS_PREFIX + '__probe';
      global.localStorage.setItem(k, '1');
      global.localStorage.removeItem(k);
      return true;
    } catch (e) { return false; }
  }

  /* ================= 通用读写 ================= */
  function idbOp(store, mode, fn) {
    return new Promise(function (resolve, reject) {
      if (!db) { reject(new Error('IndexedDB 未就绪')); return; }
      var tx = db.transaction(store, mode);
      var os = tx.objectStore(store);
      var result;
      try { result = fn(os); } catch (e) { reject(e); return; }
      tx.oncomplete = function () { resolve(result && result.result !== undefined ? result.result : result); };
      tx.onerror = function () { reject(tx.error || new Error('IndexedDB 操作失败')); };
      tx.onabort = function () { reject(tx.error || new Error('IndexedDB 操作中止')); };
    });
  }

  function lsKey(store, id) { return LS_PREFIX + store + '.' + id; }
  function lsList(store) {
    var pre = LS_PREFIX + store + '.';
    var out = [];
    try {
      for (var i = 0; i < global.localStorage.length; i++) {
        var k = global.localStorage.key(i);
        if (k && k.indexOf(pre) === 0) out.push(k.slice(pre.length));
      }
    } catch (e) { /* noop */ }
    return out;
  }
  function lsGet(store, id) {
    try {
      var s = global.localStorage.getItem(lsKey(store, id));
      return s ? JSON.parse(s) : null;
    } catch (e) { return null; }
  }
  function lsPut(store, rec) {
    global.localStorage.setItem(lsKey(store, rec.id), JSON.stringify(rec));
    return rec;
  }

  /* ================= 采样 ================= */
  /* record: { id, name, sampleRate, length, channels:[Float32Array], createdAt, source } */
  Library.putSample = function (record) {
    record.id = record.id || U.uid('smp');
    record.createdAt = record.createdAt || Date.now();
    Library.ready ? null : Library.init();

    if (Library.backend === 'idb') {
      return idbOp(STORE_SAMPLES, 'readwrite', function (os) { return os.put(record); })
        .then(function () { return record; })
        .catch(function (err) { return fallbackPutSample(record, err); });
    }
    if (Library.backend === 'local') return fallbackPutSample(record, null);
    memStore.samples[record.id] = record;
    return Promise.resolve(record);
  };

  /* localStorage 降级：音频转 WAV 16bit 的 base64（元数据另存） */
  function fallbackPutSample(record, cause) {
    if (cause) {
      BS.emit('library:warn', 'IndexedDB 写入失败，已降级到 localStorage：' + (cause.message || cause));
      Library.backend = 'local';
    }
    try {
      var wav = BS.wav.encodeChannels(record.channels, record.sampleRate, { bitDepth: 16 });
      var meta = {
        id: record.id, name: record.name, sampleRate: record.sampleRate,
        length: record.length, chCount: record.channels.length,
        createdAt: record.createdAt, source: record.source || '',
        b64: arrayBufferToBase64(wav)
      };
      lsPut('samples', meta);
      // 缓存原始数据供本次会话使用（避免重复解码）
      record._mem = record;
      memStore.samples[record.id] = record;
      updateUsage();
      return record;
    } catch (e) {
      // 配额超限 → 退到内存
      BS.emit('library:warn', 'localStorage 空间不足，本次会话仅保存在内存中：' + (e.message || e));
      Library.backend = 'memory';
      memStore.samples[record.id] = record;
      return record;
    }
  }

  Library.getSample = function (id) {
    // 优先返回内存副本（保留原始浮点精度）
    if (memStore.samples[id]) return Promise.resolve(memStore.samples[id]);
    if (Library.backend === 'idb') {
      return idbOp(STORE_SAMPLES, 'readonly', function (os) { return os.get(id); });
    }
    var meta = lsGet('samples', id);
    if (!meta) return Promise.resolve(null);
    return Promise.resolve(decodeStoredSample(meta));
  };

  function decodeStoredSample(meta) {
    var raw = BS.wav.decode(base64ToArrayBuffer(meta.b64));
    var rec = {
      id: meta.id, name: meta.name, sampleRate: meta.sampleRate,
      length: meta.length, channels: raw.channels,
      createdAt: meta.createdAt, source: meta.source
    };
    memStore.samples[meta.id] = rec;
    return rec;
  }

  /* 只取元数据（列表用，避免加载全部音频） */
  Library.listSamples = function () {
    if (Library.backend === 'idb') {
      return idbOp(STORE_SAMPLES, 'readonly', function (os) { return os.getAll(); })
        .then(function (rows) {
          return (rows || []).map(function (r) {
            return {
              id: r.id, name: r.name, sampleRate: r.sampleRate, length: r.length,
              chCount: r.channels ? r.channels.length : 1,
              createdAt: r.createdAt, source: r.source || ''
            };
          }).sort(byNewest);
        })
        .catch(function () { return listFromMemory(); });
    }
    return Promise.resolve(listFromMemory());
  };

  function listFromMemory() {
    var out = [];
    var seen = {};
    // 内存副本优先（精度更高）
    Object.keys(memStore.samples).forEach(function (id) {
      var r = memStore.samples[id];
      seen[id] = 1;
      out.push({
        id: r.id, name: r.name, sampleRate: r.sampleRate, length: r.length,
        chCount: r.channels.length, createdAt: r.createdAt, source: r.source || ''
      });
    });
    // localStorage 里的其他条目
    lsList('samples').forEach(function (id) {
      if (seen[id]) return;
      var m = lsGet('samples', id);
      if (m) {
        out.push({
          id: m.id, name: m.name, sampleRate: m.sampleRate, length: m.length,
          chCount: m.chCount, createdAt: m.createdAt, source: m.source || ''
        });
      }
    });
    return out.sort(byNewest);
  }

  Library.deleteSample = function (id) {
    delete memStore.samples[id];
    var jobs = [];
    if (Library.backend === 'idb') {
      jobs.push(idbOp(STORE_SAMPLES, 'readwrite', function (os) { return os.delete(id); }).catch(function () {}));
    }
    try { global.localStorage.removeItem(lsKey('samples', id)); } catch (e) { /* noop */ }
    return Promise.all(jobs).then(function () { updateUsage(); BS.emit('library:changed'); });
  };

  Library.renameSample = function (id, name) {
    var n = String(name || '').trim();
    if (!n) return Promise.resolve(false);
    return Library.getSample(id).then(function (rec) {
      if (!rec) return false;
      rec.name = n;
      memStore.samples[id] = rec;
      var jobs = [];
      if (Library.backend === 'idb') {
        var store = { id: id, name: n, sampleRate: rec.sampleRate, length: rec.length,
                      channels: rec.channels, createdAt: rec.createdAt, source: rec.source };
        jobs.push(idbOp(STORE_SAMPLES, 'readwrite', function (os) { return os.put(store); }).catch(function () {}));
      }
      var meta = lsGet('samples', id);
      if (meta) { meta.name = n; try { lsPut('samples', meta); } catch (e) { /* noop */ } }
      BS.emit('library:changed');
      return Promise.all(jobs).then(function () { return true; });
    });
  };

  /* ================= 预设 ================= */
  /* 预设只存参数 + 采样引用，体积小，一律走 localStorage */
  Library.putPreset = function (preset) {
    preset.id = preset.id || U.uid('pre');
    preset.createdAt = preset.createdAt || Date.now();
    try {
      lsPut('presets', preset);
      memStore.presets[preset.id] = preset;
      BS.emit('library:changed');
      return Promise.resolve(preset);
    } catch (e) {
      BS.emit('library:warn', '预设保存失败（存储空间不足）：' + (e.message || e));
      return Promise.reject(e);
    }
  };

  Library.getPreset = function (id) {
    var p = memStore.presets[id] || lsGet('presets', id);
    return Promise.resolve(p || null);
  };

  Library.listPresets = function () {
    var out = [];
    var seen = {};
    Object.keys(memStore.presets).forEach(function (id) {
      seen[id] = 1;
      out.push(memStore.presets[id]);
    });
    lsList('presets').forEach(function (id) {
      if (seen[id]) return;
      var p = lsGet('presets', id);
      if (p) out.push(p);
    });
    return Promise.resolve(out.sort(byNewest));
  };

  Library.deletePreset = function (id) {
    delete memStore.presets[id];
    try { global.localStorage.removeItem(lsKey('presets', id)); } catch (e) { /* noop */ }
    BS.emit('library:changed');
    return Promise.resolve(true);
  };

  Library.renamePreset = function (id, name) {
    var n = String(name || '').trim();
    if (!n) return Promise.resolve(false);
    return Library.getPreset(id).then(function (p) {
      if (!p) return false;
      p.name = n;
      try { lsPut('presets', p); } catch (e) { /* noop */ }
      BS.emit('library:changed');
      return true;
    });
  };

  /* ================= 从声部生成预设 ================= */
  var PRESET_FIELDS = [
    'mode', 'startSec', 'endSec', 'reverse', 'rootNote', 'transpose', 'fine',
    'keyTrack', 'pitchMode', 'stretchQuality', 'drive', 'unison', 'detune',
    'sampleGain', 'volume', 'pan', 'sendReverb', 'sendDelay',
    'maxVoices', 'velocityToGain', 'portamento'
  ];

  Library.capturePreset = function (part, sampleId) {
    var p = {
      id: U.uid('pre'),
      name: part.name || part.bufferName || '未命名音色',
      createdAt: Date.now(),
      sampleId: sampleId || null,
      bufferName: part.bufferName || '',
      rootNote: part.rootNote,
      params: {}
    };
    PRESET_FIELDS.forEach(function (k) { p.params[k] = part[k]; });
    p.amp = U.clone(part.amp);
    p.filter = U.clone(part.filter);
    p.filter2 = U.clone(part.filter2);
    // 记录采样元信息，便于列表展示与缺失提示
    if (part.buffer) {
      p.sampleInfo = {
        sampleRate: part.buffer.sampleRate,
        length: part.buffer.length,
        chCount: part.buffer.numberOfChannels
      };
    }
    return p;
  };

  Library.applyPreset = function (part, preset) {
    if (!preset) return false;
    var params = preset.params || {};
    PRESET_FIELDS.forEach(function (k) {
      if (params[k] !== undefined) part[k] = U.clone(params[k]);
    });
    if (preset.amp) part.amp = Object.assign({}, part.amp, U.clone(preset.amp));
    if (preset.filter) part.filter = Object.assign({}, part.filter, U.clone(preset.filter));
    if (preset.filter2) part.filter2 = Object.assign({}, part.filter2, U.clone(preset.filter2));
    if (preset.rootNote !== undefined) part.rootNote = preset.rootNote;
    if (preset.name) part.name = preset.name;
    // 采样引用失效时保留原采样，但提示用户
    part._presetSampleMissing = !!(preset.sampleId && part._librarySampleId !== preset.sampleId);
    return true;
  };

  /* ================= 容量 ================= */
  function updateUsage() {
    if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(function (est) {
        Library.quotaBytes = est.quota || 0;
        Library.usedBytes = est.usage || 0;
        BS.emit('library:usage', { quota: Library.quotaBytes, used: Library.usedBytes });
      }).catch(function () { /* noop */ });
    }
  }
  Library.refreshUsage = updateUsage;

  Library.describeBackend = function () {
    switch (Library.backend) {
      case 'idb': return 'IndexedDB（容量充足，可长期保存）';
      case 'local': return '浏览器本地存储（约 5MB，音频经有损压缩）';
      case 'memory': return '仅本次会话（浏览器禁用了持久化存储）';
      default: return '未初始化';
    }
  };

  Library.formatBytes = function (b) {
    if (!b) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB'];
    var i = Math.floor(Math.log(b) / Math.log(1024));
    i = U.clamp(i, 0, units.length - 1);
    return (b / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
  };

  function byNewest(a, b) { return (b.createdAt || 0) - (a.createdAt || 0); }

  /* ================= base64 互转（localStorage 降级用） ================= */
  function arrayBufferToBase64(ab) {
    var bytes = new Uint8Array(ab);
    var bin = '';
    var chunk = 0x8000;   // 分块避免 apply 参数过多爆栈
    for (var i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return global.btoa(bin);
  }
  function base64ToArrayBuffer(b64) {
    var bin = global.atob(b64);
    var len = bin.length;
    var bytes = new Uint8Array(len);
    var chunk = 0x8000;
    for (var i = 0; i < len; i += chunk) {
      var end = Math.min(i + chunk, len);
      for (var j = i; j < end; j++) bytes[j] = bin.charCodeAt(j);
    }
    return bytes.buffer;
  }

  /* ================= AudioBuffer 互转 ================= */
  Library.bufferToRecord = function (buffer, name, source) {
    var chans = [];
    for (var c = 0; c < buffer.numberOfChannels; c++) {
      // 复制一份，避免后续处理污染库中数据
      chans.push(new Float32Array(buffer.getChannelData(c)));
    }
    return {
      name: name || '采样',
      sampleRate: buffer.sampleRate,
      length: buffer.length,
      channels: chans,
      source: source || ''
    };
  };

  Library.recordToBuffer = function (ctx, record) {
    if (!record || !record.channels) return null;
    var buf = ctx.createBuffer(record.channels.length, record.length, record.sampleRate);
    for (var c = 0; c < record.channels.length; c++) {
      buf.copyToChannel(record.channels[c], c);
    }
    return buf;
  };

  /* 估算体积（用于保存前提示） */
  Library.estimateSize = function (buffer) {
    return buffer.length * buffer.numberOfChannels * 4;   // Float32 = 4 字节
  };

})(window);

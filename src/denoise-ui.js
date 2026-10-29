/* BandSynth · denoise-ui.js
 * 声部编辑器里的「采样处理」面板：降噪 / 信噪比
 *
 * 处理直接作用在**当前声部的采样**上（破坏性），所以：
 *   · 每一步都能撤销（保留一份原采样）
 *   · 面板实时显示 峰值 / 噪声基底 / 信噪比，处理前后一目了然
 *
 * 各算法的取舍见 src/denoise.js 顶部注释。
 */
(function (global) {
  'use strict';
  var BS = global.BS;
  var U = BS.util, W = BS.widgets;

  function createPanel(opts) {
    opts = opts || {};
    var getPart = opts.getPart;
    var toast = opts.toast || function () {};
    var onChange = opts.onChange || function () {};

    var part = getPart && getPart();
    if (!part) return null;

    var root = document.createElement('div');
    root.className = 'denoise-panel';

    /* ---------- 状态（存在声部上，重建面板后不丢） ---------- */
    var state = part._dnState || (part._dnState = {
      strength: 1,        // 谱减强度
      thresholdDb: -35,   // 噪声门门限（相对峰值，dB）
      humFreq: 50,        // 工频（50 / 60）
      rmsTargetDb: -20    // 归一化目标（RMS 模式）
    });

    /* ---------- 读数 ---------- */
    var readout = document.createElement('div');
    readout.className = 'lib-hint';
    readout.style.margin = '0 0 6px';
    root.appendChild(readout);

    function describe(a) {
      if (!a || !isFinite(a.peakDb)) return '（无采样）';
      return '峰值 ' + BS.denoise.fmtDb(a.peakDb) + ' dBFS · 噪声基底 ' +
        BS.denoise.fmtDb(a.noiseDb) + ' dBFS · 信噪比 ' + a.snrDb.toFixed(1) + ' dB';
    }

    function refresh(before, after) {
      var cur = after || (part.buffer ? BS.denoise.analyze(part.buffer) : null);
      var txt = describe(cur);
      if (before && after && isFinite(before.snrDb) && isFinite(after.snrDb)) {
        var d = after.snrDb - before.snrDb;
        txt += '　（信噪比 ' + (d >= 0 ? '+' : '') + d.toFixed(1) + ' dB）';
      }
      readout.textContent = txt;
    }

    /* ---------- 应用到声部（可撤销） ---------- */
    function applyToPart(fn, label) {
      if (!part.buffer) { toast('当前声部没有采样', 2500); return null; }
      if (!part._dnOrig) {
        part._dnOrig = part.buffer;
        part._dnOrigStart = part.startSec;
        part._dnOrigEnd = part.endSec;
      }
      var before = BS.denoise.analyze(part.buffer);
      var res;
      try {
        res = fn(part.buffer);
      } catch (e) {
        toast('处理失败：' + e.message, 4000);
        console.error(e);
        return null;
      }
      var out = res && res.buffer ? res.buffer : res;
      var s = part.startSec, e2 = part.endSec;
      part.setBuffer(out, part.bufferName);
      // 处理不改变长度，裁剪区间照旧（越界则收窄）
      part.startSec = Math.min(s, out.duration);
      part.endSec = Math.min(e2, out.duration);
      var after = BS.denoise.analyze(out);
      refresh(before, after);
      undoBtn.disabled = false;
      if (onChange) onChange();
      return after;
    }

    function undo() {
      if (!part._dnOrig) return;
      var buf = part._dnOrig;
      part._dnOrig = null;
      var s = part._dnOrigStart, e = part._dnOrigEnd;
      part.setBuffer(buf, part.bufferName);
      part.startSec = Math.min(s, buf.duration);
      part.endSec = Math.min(e, buf.duration);
      undoBtn.disabled = true;
      refresh();
      if (onChange) onChange();
      toast('已还原处理前的采样', 2000);
    }

    /* ---------- 旋钮 ---------- */
    var knobs = W.row();
    knobs.appendChild(W.knob({
      label: '降噪强度', min: 0, max: 3, value: state.strength, default: 1, step: 0.1,
      onChange: function (v) { state.strength = v; }
    }).el);
    knobs.appendChild(W.knob({
      label: '门限', min: -60, max: -10, value: state.thresholdDb, default: -35, unit: 'dB',
      onChange: function (v) { state.thresholdDb = v; }
    }).el);
    knobs.appendChild(W.knob({
      label: '归一化目标', min: -40, max: -6, value: state.rmsTargetDb, default: -20, unit: 'dB',
      onChange: function (v) { state.rmsTargetDb = v; }
    }).el);
    root.appendChild(knobs);

    /* ---------- 按钮 ---------- */
    function mkBtn(label, title, fn, cls) {
      var b = document.createElement('button');
      b.className = 'btn small' + (cls ? ' ' + cls : '');
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', fn);
      return b;
    }

    var btns1 = document.createElement('div');
    btns1.className = 'save-btns';
    btns1.appendChild(mkBtn('去直流', '去掉直流偏置（直流会让滤波工作点偏移）', function () {
      var r = applyToPart(function (buf) { return BS.denoise.removeDC(buf); });
      if (r) toast('已去直流（偏移 ' + (r.dcOffset * 100).toFixed(2) + '%）', 2500);
    }));
    btns1.appendChild(mkBtn('去工频', '50/60Hz 陷波（含谐波），去空调/电流嗡声', function () {
      applyToPart(function (buf) { return BS.denoise.deHum(buf, { freq: state.humFreq, harmonics: 3, q: 12 }); });
      toast('已去 ' + state.humFreq + 'Hz 工频', 2000);
    }));
    btns1.appendChild(mkBtn('去咔哒', '修掉削波/插值造成的爆音尖峰', function () {
      var r = applyToPart(function (buf) { return BS.denoise.declick(buf); });
      if (r) toast('已去咔哒', 2000);
    }));
    btns1.appendChild(mkBtn('去隆隆', '高通滤波，去低频隆隆声（手风琴/风声）', function () {
      applyToPart(function (buf) { return BS.denoise.highpass(buf, { freq: 80, q: 0.707 }); });
      toast('已去低频隆隆（80Hz 高通）', 2000);
    }));
    root.appendChild(btns1);

    var btns2 = document.createElement('div');
    btns2.className = 'save-btns';
    btns2.appendChild(mkBtn('噪声门', '低于门限的部分压掉：音符之间的底噪直接消失', function () {
      var r = applyToPart(function (buf) {
        return BS.denoise.noiseGate(buf, { thresholdDb: state.thresholdDb });
      });
      if (r) toast('已加噪声门（门限 ' + state.thresholdDb + 'dB）', 2500);
    }, 'primary'));
    btns2.appendChild(mkBtn('谱减降噪', 'STFT 谱减：最有效的降噪，强度越大越干净也越容易发闷', function () {
      applyToPart(function (buf) {
        return BS.denoise.spectralDenoise(buf, { strength: state.strength });
      });
      toast('已谱减降噪（强度 ' + state.strength.toFixed(1) + '）', 2500);
    }, 'primary'));
    btns2.appendChild(mkBtn('归一化', '把有效电平提上去：峰值或 RMS 目标', function () {
      var r = applyToPart(function (buf) {
        return BS.denoise.normalize(buf, { mode: 'rms', targetDb: state.rmsTargetDb });
      });
      if (r) toast('已归一化', 2000);
    }));
    root.appendChild(btns2);

    var btns3 = document.createElement('div');
    btns3.className = 'save-btns';
    btns3.appendChild(mkBtn('一键降噪', '去直流 → 去咔哒 → 去工频 → 谱减 → 噪声门 → 归一化', function () {
      var rep = applyToPart(function (buf) {
        return BS.denoise.chain(buf, {
          hum: true,
          humOpts: { freq: state.humFreq, harmonics: 3, q: 12 },
          spectralOpts: { strength: state.strength },
          gate: true,
          gateOpts: { thresholdDb: state.thresholdDb },
          normalizeOpts: { mode: 'rms', targetDb: state.rmsTargetDb }
        });
      });
      if (rep) toast('一键降噪完成', 2500);
    }));
    var undoBtn = mkBtn('撤销', '还原到处理前的采样', undo);
    undoBtn.disabled = !part._dnOrig;
    btns3.appendChild(undoBtn);
    root.appendChild(btns3);

    /* ---------- 说明 ---------- */
    var hint = document.createElement('div');
    hint.className = 'mini-hint';
    hint.textContent = '处理直接改写当前声部的采样（可撤销一次）。降噪是把「噪声基底」压下去来提高信噪比，'
      + '强度过大连素材本身的泛音也会被削掉；先试听再决定。工频干扰选 50Hz（国内）或 60Hz（北美）。';
    root.appendChild(hint);

    refresh();
    return root;
  }

  BS.createDenoisePanel = createPanel;

})(window);

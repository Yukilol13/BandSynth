/* BandSynth · modal.js
 * 轻量模态框：用于音色选择、确认等。
 * API：BS.modal.show(title, htmlContent, onMount) / BS.modal.close()
 */
(function (global) {
  'use strict';
  var BS = global.BS;

  var Modal = BS.modal = {
    el: null,
    _onClose: null
  };

  function ensureRoot() {
    if (Modal.el) return Modal.el;
    var root = document.createElement('div');
    root.className = 'modal-mask hide';
    root.innerHTML =
      '<div class="modal-box">' +
      '  <div class="modal-head"><h3></h3><button class="modal-x">✕</button></div>' +
      '  <div class="modal-body"></div>' +
      '</div>';
    document.body.appendChild(root);
    root.addEventListener('pointerdown', function (e) {
      if (e.target === root) Modal.close();
    });
    root.querySelector('.modal-x').addEventListener('click', function () { Modal.close(); });
    Modal.el = root;
    return root;
  }

  /**
   * @param title  标题
   * @param html   内容 HTML
   * @param onMount (box) => void  内容挂载后回调（用于绑定事件）
   */
  Modal.show = function (title, html, onMount) {
    var root = ensureRoot();
    root.querySelector('.modal-head h3').textContent = title;
    var body = root.querySelector('.modal-body');
    body.innerHTML = html;
    root.classList.remove('hide');
    if (onMount) onMount(body);
    return body;
  };

  Modal.close = function () {
    if (Modal.el) Modal.el.classList.add('hide');
  };

  Modal.isOpen = function () {
    return !!(Modal.el && !Modal.el.classList.contains('hide'));
  };

  /* 便捷：确认框 */
  Modal.confirm = function (title, message, onYes) {
    Modal.show(title, '<p class="modal-msg">' + message + '</p>' +
      '<div class="modal-actions">' +
      '  <button class="btn" data-act="no">取消</button>' +
      '  <button class="btn primary" data-act="yes">确定</button>' +
      '</div>', function (box) {
      box.querySelector('[data-act="no"]').addEventListener('click', Modal.close);
      box.querySelector('[data-act="yes"]').addEventListener('click', function () {
        Modal.close();
        onYes && onYes();
      });
    });
  };

  /* 便捷：输入框 */
  Modal.prompt = function (title, def, onOk) {
    Modal.show(title,
      '<input class="text-input" id="__mp" value="' + (def || '') + '">' +
      '<div class="modal-actions">' +
      '  <button class="btn" data-act="no">取消</button>' +
      '  <button class="btn primary" data-act="yes">确定</button>' +
      '</div>', function (box) {
      var input = box.querySelector('#__mp');
      input.focus();
      input.select();
      function ok() { var v = input.value; Modal.close(); onOk && onOk(v); }
      box.querySelector('[data-act="no"]').addEventListener('click', Modal.close);
      box.querySelector('[data-act="yes"]').addEventListener('click', ok);
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); ok(); }
      });
    });
  };

})(typeof window !== 'undefined' ? window : globalThis);

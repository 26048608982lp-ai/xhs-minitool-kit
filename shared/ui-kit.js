// ui-kit.js — 小程序 UI 反馈组件的 Web 实现（toast/modal/loading/actionSheet）
// 零依赖、ES2017/Chrome 61 兼容；供 wx-api-shim.js 调用，也可直接使用。
// 所有 API 返回 Promise（回调适配在 wx-api-shim 层做，本层不管回调风格）。
// 样式挂载：首次调用时向 <head> 注入 <style>（样式内联合规——容器允许 <style>）。
var UiKit = (function (global) {
  'use strict';

  var Z = { toast: 9000, modal: 9100, sheet: 9100, loading: 9200 };

  function el(tag, cls, text) {
    var e = global.document.createElement(tag);
    if (cls) { e.className = cls; }
    if (text !== undefined) { e.textContent = text; }
    return e;
  }

  function injectStyles() {
    if (global.document.getElementById('uikit-styles')) { return; }
    var css = ''
      + '.uk-toast{position:fixed;left:50%;bottom:20%;transform:translateX(-50%);max-width:80vw;'
      + 'padding:12px 20px;border-radius:10px;background:rgba(0,0,0,.75);color:#fff;font-size:14px;'
      + 'line-height:1.5;text-align:center;z-index:' + Z.toast + ';transition:opacity .2s;}'
      + '.uk-toast-icon{display:flex;align-items:center;justify-content:center;width:44px;height:44px;'
      + 'margin:0 auto 8px;border-radius:50%;background:#fff;}'
      // 对勾/叉用纯 CSS 绘制（内嵌 SVG 的 xmlns URL 会被合规扫描判为外部地址）
      + '.uk-toast-icon .uk-tick{display:block;width:18px;height:9px;border-left:4px solid #10a64a;'
      + 'border-bottom:4px solid #10a64a;transform:rotate(-45deg) translate(1px,-2px);}'
      + '.uk-toast-err .uk-tick{width:20px;height:20px;border:0;transform:none;position:relative;}'
      + '.uk-toast-err .uk-tick::before,.uk-toast-err .uk-tick::after{content:"";position:absolute;'
      + 'left:50%;top:50%;width:4px;height:24px;border-radius:2px;background:#e64340;'
      + 'transform:translate(-50%,-50%) rotate(45deg);}'
      + '.uk-toast-err .uk-tick::after{transform:translate(-50%,-50%) rotate(-45deg);}'
      + '.uk-mask{position:fixed;left:0;top:0;right:0;bottom:0;background:rgba(0,0,0,.5);z-index:' + Z.modal + ';}'
      + '.uk-modal{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:78vw;max-width:320px;'
      + 'border-radius:14px;background:#fff;z-index:' + (Z.modal + 1) + ';overflow:hidden;}'
      + '.uk-modal-title{padding:22px 24px 0;text-align:center;font-size:17px;font-weight:600;color:#111;}'
      + '.uk-modal-body{padding:12px 24px 22px;text-align:center;font-size:14px;line-height:1.6;color:#666;white-space:pre-wrap;}'
      + '.uk-modal-btns{display:flex;border-top:1px solid #eee;}'
      + '.uk-modal-btns button{flex:1;height:48px;border:0;background:#fff;font-size:16px;cursor:pointer;}'
      + '.uk-modal-btns .uk-cancel{color:#666;border-right:1px solid #eee;}'
      + '.uk-modal-btns .uk-confirm{color:#576b95;font-weight:600;}'
      + '.uk-sheet{position:fixed;left:0;right:0;bottom:0;background:#fff;border-radius:14px 14px 0 0;'
      + 'z-index:' + (Z.sheet + 1) + ';padding-bottom:env(safe-area-inset-bottom);}'
      + '.uk-sheet-item{height:52px;line-height:52px;text-align:center;font-size:16px;color:#333;'
      + 'border-bottom:1px solid #f2f2f2;cursor:pointer;}'
      + '.uk-sheet-item:active{background:#f7f7f7;}'
      + '.uk-sheet-cancel{height:52px;line-height:52px;text-align:center;font-size:16px;color:#666;cursor:pointer;margin-top:8px;background:#f7f7f7;}'
      + '.uk-loading{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:' + Z.loading + ';'
      + 'width:110px;padding:18px 0;border-radius:12px;background:rgba(0,0,0,.75);text-align:center;}'
      + '.uk-loading-spin{width:32px;height:32px;margin:0 auto 8px;border-radius:50%;'
      + 'border:3px solid rgba(255,255,255,.3);border-top-color:#fff;animation:uk-rot .8s linear infinite;}'
      + '@keyframes uk-rot{to{transform:rotate(360deg)}}'
      + '.uk-loading-txt{font-size:13px;color:#fff;line-height:1.4;padding:0 8px;}'
      + '.uk-fade-out{opacity:0;}';
    var style = el('style');
    style.id = 'uikit-styles';
    style.textContent = css;
    global.document.head.appendChild(style);
  }

  var toastTimer = null;
  var toastEl = null;

  // toast({ title, icon: 'success'|'error'|'none', duration=1500, mask })
  function toast(opts) {
    injectStyles();
    var o = opts || {};
    if (toastEl && toastEl.parentNode) { toastEl.parentNode.removeChild(toastEl); }
    if (toastTimer) { global.clearTimeout(toastTimer); }
    toastEl = el('div', 'uk-toast' + (o.icon === 'error' ? ' uk-toast-err' : ''));
    if (o.icon === 'success' || o.icon === 'error') {
      var icon = el('span', 'uk-toast-icon');
      icon.appendChild(el('i', 'uk-tick'));
      toastEl.appendChild(icon);
    }
    toastEl.appendChild(el('span', null, o.title || ''));
    global.document.body.appendChild(toastEl);
    return new Promise(function (resolve) {
      toastTimer = global.setTimeout(function () {
        if (toastEl && toastEl.parentNode) { toastEl.parentNode.removeChild(toastEl); }
        resolve();
      }, o.duration || 1500);
    });
  }

  // modal({ title, content, showCancel=true, confirmText='确定', cancelText='取消' })
  // resolve({ confirm: bool, cancel: bool })
  function modal(opts) {
    injectStyles();
    var o = opts || {};
    var mask = el('div', 'uk-mask');
    var box = el('div', 'uk-modal');
    if (o.title) { box.appendChild(el('div', 'uk-modal-title', o.title)); }
    box.appendChild(el('div', 'uk-modal-body', o.content || ''));
    var btns = el('div', 'uk-modal-btns');
    var done = false;
    var settle = null;
    function close(res) {
      if (done) { return; }
      done = true;
      global.document.body.removeChild(mask);
      global.document.body.removeChild(box);
      if (settle) { settle(res); }
    }
    var p = new Promise(function (resolve) {
      settle = resolve;
      if (o.showCancel !== false) {
        var cancel = el('button', 'uk-cancel', o.cancelText || '取消');
        cancel.addEventListener('click', function () { close({ confirm: false, cancel: true }); });
        btns.appendChild(cancel);
      }
      var confirm = el('button', 'uk-confirm', o.confirmText || '确定');
      confirm.addEventListener('click', function () { close({ confirm: true, cancel: false }); });
      btns.appendChild(confirm);
    });
    box.appendChild(btns);
    global.document.body.appendChild(mask);
    global.document.body.appendChild(box);
    // 微信 showModal 点击蒙层不关闭（区别于 actionSheet 可点蒙层取消），此处对齐
    return p;
  }

  // actionSheet({ itemList: [..6], itemColor }) resolve({ tapIndex }) / cancel reject
  function actionSheet(opts) {
    injectStyles();
    var o = opts || {};
    var mask = el('div', 'uk-mask');
    var sheet = el('div', 'uk-sheet');
    var done = false;
    var onOk = null;
    var onFail = null;
    function close(ok, arg) {
      if (done) { return; }
      done = true;
      global.document.body.removeChild(mask);
      global.document.body.removeChild(sheet);
      if (ok && onOk) { onOk(arg); }
      if (!ok && onFail) { onFail(arg); }
    }
    var p = new Promise(function (resolve, reject) {
      onOk = resolve;
      onFail = reject;
      (o.itemList || []).slice(0, 6).forEach(function (item, i) {
        var row = el('div', 'uk-sheet-item', item);
        if (o.itemColor) { row.style.color = o.itemColor; }
        row.addEventListener('click', function () { close(true, { tapIndex: i }); });
        sheet.appendChild(row);
      });
      var cancel = el('div', 'uk-sheet-cancel', '取消');
      cancel.addEventListener('click', function () {
        close(false, { errMsg: 'actionSheet:fail cancel' });
      });
      sheet.appendChild(cancel);
    });
    global.document.body.appendChild(mask);
    global.document.body.appendChild(sheet);
    mask.addEventListener('click', function () { close(false, { errMsg: 'actionSheet:fail cancel' }); });
    return p;
  }

  // loading({ title, mask }) —— 单例：重复调用覆盖文案，hideLoading 关闭
  var loadingEl = null;
  function loading(opts) {
    injectStyles();
    var o = opts || {};
    if (!loadingEl) {
      loadingEl = el('div', 'uk-loading');
      loadingEl.appendChild(el('div', 'uk-loading-spin'));
      loadingEl.appendChild(el('div', 'uk-loading-txt'));
      global.document.body.appendChild(loadingEl);
    }
    loadingEl.lastChild.textContent = o.title || '加载中';
  }

  function hideLoading() {
    if (loadingEl && loadingEl.parentNode) {
      loadingEl.parentNode.removeChild(loadingEl);
      loadingEl = null;
    }
  }

  var kit = {
    toast: toast,
    modal: modal,
    actionSheet: actionSheet,
    loading: loading,
    hideLoading: hideLoading
  };

  global.UiKit = kit;
  return kit;
})(typeof window !== 'undefined' ? window : this);

export default UiKit;

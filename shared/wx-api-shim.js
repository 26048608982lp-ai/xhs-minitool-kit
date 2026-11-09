// wx-api-shim.js — 微信小程序 wx.* 全局对象模拟层（小程序转化核心差异层）
// 零依赖、ES2017/Chrome 61 兼容。依赖（懒查找，无 import 顺序强耦合）：
//   XhsBridge（_shared/xhs-bridge.js）— 存储等平台能力
//   UiKit（_shared/ui-kit.js）— toast/modal 等 DOM 弹层
//   PageRouter（_shared/page-router.js）— 页面导航
//
// 覆盖策略（依据 hamAssitant 实测使用面分层，其他项目按需扩展）：
//   ① 可用能力映射：存储/UI 反馈/导航/振动/系统信息/节点查询/页面滚动
//   ② 离线降级：wx.cloud.callFunction / wx.request 走 mock 注入表（WxApiShim.mockCloud），
//      无 mock 数据时显式 fail——云逻辑离线化的统一落点
//   ③ 平台无对应（静默/失败）：订阅消息、虚拟支付、激励视频、addToDesktop、剪贴板（容器禁用）等
//   ④ 未知 API：Proxy 兜底 warn + no-op，防转化期崩溃；canIUse 查覆盖表返回 false
//
// 微信端能力 → 小红书容器等价物速查：
//   存储 wx.setStorageSync → XhsBridge.storageSet（平台 Storage 9.46+ / localStorage 兜底）
//   振动 wx.vibrateShort → miniTool.vibrateShort（9.50+）  系统信息 → 合成 + getWindowInfo（9.49+）
//   剪贴板 🔴 容器禁 navigator.clipboard/execCommand——setClipboardData 降级为弹层展示文本
var WxApiShim = (function (global) {
  'use strict';

  var warned = {};
  function warnOnce(msg) {
    if (!warned[msg]) { warned[msg] = true; }
  }

  // ---- 小程序回调风格适配：传 success/fail/complete 任一回调时返回 undefined，否则返回 Promise ----
  function dispatch(promise, opts) {
    promise.then(
      function (res) {
        if (typeof opts.success === 'function') { opts.success(res); }
        if (typeof opts.complete === 'function') { opts.complete(res); }
      },
      function (err) {
        if (typeof opts.fail === 'function') { opts.fail(err); }
        if (typeof opts.complete === 'function') { opts.complete(err); }
      }
    );
  }

  function withCallbacks(promiseFactory, opts) {
    var hasCb = opts && (typeof opts.success === 'function' ||
      typeof opts.fail === 'function' || typeof opts.complete === 'function');
    if (!hasCb) { return promiseFactory(); }
    dispatch(promiseFactory(), opts);
    return undefined;
  }

  // 反馈类 API 专用（振动等）：无回调时失败静默降级为 warn（微信端同为尽力而为，避免 unhandled rejection）
  function withCallbacksQuiet(promiseFactory, opts) {
    var hasCb = opts && (typeof opts.success === 'function' ||
      typeof opts.fail === 'function' || typeof opts.complete === 'function');
    if (!hasCb) {
      return promiseFactory().catch(function (err) {
        if (global.console && global.console.warn) {
          global.console.warn((err && err.errMsg) || 'quiet fail');
        }
        return undefined;
      });
    }
    dispatch(promiseFactory(), opts);
    return undefined;
  }

  function failObj(api, reason) {
    return { errMsg: api + ':fail ' + reason };
  }

  function miniTool() {
    var xhs = global.xhs;
    return (xhs && xhs.miniTool) || null;
  }

  // ---- 键盘高度探测（wx.onKeyboardHeightChange 的引擎，见 shim 内 API 注释）----
  var kbListeners = [];
  var kbHeight = 0;
  var kbPrevLayout = 0;
  var kbPrevVv = 0;
  var kbStarted = false;
  function kbEmit(h) {
    if (h === kbHeight) { return; }
    kbHeight = h;
    // ① 页面实例回调（keyboardBehavior.setData 链 → 页面 padding-bottom 绑定）
    try {
      var pages = global.getCurrentPages ? global.getCurrentPages() : [];
      var cur = pages[pages.length - 1];
      if (cur && typeof cur.onKeyboardHeightChange === 'function') {
        cur.onKeyboardHeightChange({ detail: { height: h } });
      }
    } catch (e1) { /* 页面回调异常不阻断 */ }
    // ② 可见弹窗蒙层挂 keyboard-visible（entity-shared 既有键盘适配样式，源 app 死绑定未生效）
    try {
      var els = global.document.querySelectorAll('.dialog-overlay');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        var shown = el.style.display !== 'none' &&
          (!el.style.display || global.getComputedStyle(el).display !== 'none');
        if (shown) { el.classList.toggle('keyboard-visible', h > 0); }
      }
    } catch (e2) { /* DOM 异常不阻断 */ }
    // ③ wx 侧业务监听者
    for (var j = 0; j < kbListeners.length; j++) {
      try { kbListeners[j]({ height: h }); } catch (e3) { /* 监听者异常不阻断 */ }
    }
  }
  function kbCompute() {
    var vv = global.visualViewport;
    var layoutH = global.innerHeight;
    var vvH = vv ? Math.round(vv.height) : 0;
    // 双通道（visualViewport + window）对同一次键盘变化各发一次 resize——
    // 状态无变化的事件直接忽略，否则第二次会把刚算出的键盘高度重置回 0
    if (layoutH === kbPrevLayout && vvH === kbPrevVv) { return; }
    var h = 0;
    if (vv && layoutH - vvH > 150) {
      h = layoutH - vvH; // 可视视口被键盘压缩（pan 型容器的主流信号）
    } else if (kbPrevLayout - layoutH > 150) {
      h = kbPrevLayout - layoutH; // 布局视口自身缩小（adjustResize 型容器）
    }
    kbPrevLayout = layoutH;
    kbPrevVv = vvH;
    kbEmit(h);
  }
  function kbStart() {
    if (kbStarted) { return; }
    kbStarted = true;
    kbPrevLayout = global.innerHeight;
    kbPrevVv = global.visualViewport ? Math.round(global.visualViewport.height) : 0;
    var vv = global.visualViewport;
    if (vv && vv.addEventListener) { vv.addEventListener('resize', kbCompute); }
    global.addEventListener('resize', kbCompute);
  }
  // 无条件自启：框架（弹窗 keyboard-visible 类 + 页面实例回调）依赖键盘事件，业务不一定注册
  kbStart();

  // ---- mock 注入表：云函数 / 网络请求离线化的统一落点 ----
  var cloudMock = {};
  var requestMock = {};

  function resolveMock(table, key, payload) {
    var m = table[key];
    if (typeof m === 'function') { return m(payload); }
    return m === undefined ? null : m;
  }

  var shim = {
    // ======== ① 存储（XhsBridge 同步语义直通）========
    setStorageSync: function (key, value) { global.XhsBridge.storageSet(key, value); },
    getStorageSync: function (key) {
      var v = global.XhsBridge.storageGet(key);
      return v === '' ? '' : v;
    },
    removeStorageSync: function (key) { global.XhsBridge.storageRemove(key); },
    clearStorageSync: function () { global.XhsBridge.storageClear(); },
    getStorageInfoSync: function () {
      var info = global.XhsBridge.storageInfo();
      return { keys: info.keys, currentSize: info.currentSize, limitSize: 10240 };
    },
    setStorage: function (o) {
      return withCallbacks(function () {
        shim.setStorageSync(o.key, o.data);
        return Promise.resolve({ errMsg: 'setStorage:ok' });
      }, o);
    },
    getStorage: function (o) {
      return withCallbacks(function () {
        var v = shim.getStorageSync(o.key);
        // 对齐微信语义：key 不存在走 fail（业务 StorageManager 有 catch/默认值兜底）；
        // 存了空串的场景与此不可区分，属可接受损失（空串业务值用 Sync 接口读写）
        if (v === '' || v == null) { return Promise.reject(failObj('getStorage', 'data not found')); }
        return Promise.resolve({ data: v, errMsg: 'getStorage:ok' });
      }, o);
    },
    removeStorage: function (o) {
      return withCallbacks(function () {
        shim.removeStorageSync(o.key);
        return Promise.resolve({ errMsg: 'removeStorage:ok' });
      }, o);
    },
    getStorageInfo: function (o) {
      return withCallbacks(function () {
        return Promise.resolve(shim.getStorageInfoSync());
      }, o);
    },

    // ======== ① UI 反馈（UiKit DOM 实现）========
    showToast: function (o) {
      return withCallbacks(function () {
        return global.UiKit.toast(o).then(function () {
          return { errMsg: 'showToast:ok' };
        });
      }, o);
    },
    hideToast: function () { /* UiKit toast 自限时，无需手动关 */ },
    showModal: function (o) {
      return withCallbacks(function () {
        return global.UiKit.modal(o).then(function (res) {
          res.errMsg = 'showModal:ok';
          return res;
        });
      }, o);
    },
    showLoading: function (o) {
      return withCallbacks(function () {
        global.UiKit.loading(o);
        return Promise.resolve({ errMsg: 'showLoading:ok' });
      }, o);
    },
    hideLoading: function () { global.UiKit.hideLoading(); },
    showActionSheet: function (o) {
      return withCallbacks(function () {
        return global.UiKit.actionSheet(o);
      }, o);
    },

    // ======== ① 导航（PageRouter）========
    navigateTo: function (o) {
      return withCallbacks(function () {
        return global.PageRouter.navigateTo(o.url).then(function () {
          return { errMsg: 'navigateTo:ok' };
        });
      }, o);
    },
    navigateBack: function (o) {
      var delta = o && o.delta;
      return withCallbacks(function () {
        return global.PageRouter.navigateBack(delta).then(function () {
          return { errMsg: 'navigateBack:ok' };
        });
      }, o);
    },
    redirectTo: function (o) {
      return withCallbacks(function () {
        return global.PageRouter.redirectTo(o.url).then(function () {
          return { errMsg: 'redirectTo:ok' };
        });
      }, o);
    },
    reLaunch: function (o) {
      return withCallbacks(function () {
        return global.PageRouter.reLaunch(o.url).then(function () {
          return { errMsg: 'reLaunch:ok' };
        });
      }, o);
    },
    switchTab: function (o) {
      return withCallbacks(function () {
        return global.PageRouter.switchTab(parseTabUrl(o.url)).then(function () {
          return { errMsg: 'switchTab:ok' };
        });
      }, o);
    },

    // ======== ① 振动（平台 9.50+，尽力而为语义：失败仅走 fail 回调，无回调时静默——同微信端行为）========
    vibrateShort: function (o) {
      return withCallbacksQuiet(function () {
        var ok = global.XhsBridge.vibrate((o && o.type) || 'light');
        return ok ? Promise.resolve({ errMsg: 'vibrateShort:ok' })
                  : Promise.reject(failObj('vibrateShort', 'unsupported'));
      }, o);
    },
    vibrateLong: function (o) {
      return withCallbacksQuiet(function () {
        var mt = miniTool();
        if (!mt || typeof mt.vibrateLong !== 'function') {
          return Promise.reject(failObj('vibrateLong', 'unsupported'));
        }
        return mt.vibrateLong().catch(function () { throw failObj('vibrateLong', 'vibrate'); });
      }, o);
    },

    // ======== ① 系统信息（合成 + XhsBridge.layout）========
    getSystemInfoSync: function () {
      var ua = global.navigator.userAgent;
      var layout = (global.XhsBridge && global.XhsBridge.layout) || {};
      // 微信语义：tab 页的 windowHeight 不含 tabBar（自绘 tabBar 是覆盖层，需扣除实测高；
      // 非 tab 页/无 tabBar 全高）。业务按 windowHeight 定高的滚动容器/底部按钮才不会被 tabBar 盖住
      var winH = layout.windowHeight || global.innerHeight;
      if (global.__prTabActive && global.__prTabH) { winH -= global.__prTabH; }
      return {
        pixelRatio: global.devicePixelRatio || 2,
        windowWidth: layout.windowWidth || global.innerWidth,
        windowHeight: winH,
        screenWidth: layout.windowWidth || global.screen.width,
        screenHeight: layout.windowHeight || global.screen.height,
        statusBarHeight: layout.safeTop || 44,
        safeArea: { top: layout.safeTop || 44, bottom: layout.windowHeight || global.innerHeight },
        language: (global.navigator.language || 'zh_CN').replace('-', '_'),
        platform: /iphone|ipad|ipod/i.test(ua) ? 'ios' : (/android/i.test(ua) ? 'android' : 'devtools'),
        SDKVersion: '0.0.0',
        model: 'xhs-minitool'
      };
    },
    getSystemInfo: function (o) {
      return withCallbacks(function () {
        return Promise.resolve(shim.getSystemInfoSync());
      }, o);
    },
    getWindowInfo: function (o) {
      return withCallbacks(function () {
        var s = shim.getSystemInfoSync();
        return Promise.resolve({
          pixelRatio: s.pixelRatio, windowWidth: s.windowWidth, windowHeight: s.windowHeight,
          screenWidth: s.screenWidth, screenHeight: s.screenHeight,
          statusBarHeight: s.statusBarHeight, safeArea: s.safeArea
        });
      }, o);
    },
    getDeviceInfo: function (o) {
      return withCallbacks(function () {
        var s = shim.getSystemInfoSync();
        return Promise.resolve({ platform: s.platform, model: s.model, pixelRatio: s.pixelRatio });
      }, o);
    },
    getAppBaseInfo: function (o) {
      return withCallbacks(function () {
        return Promise.resolve({ SDKVersion: '0.0.0', language: shim.getSystemInfoSync().language });
      }, o);
    },

    // ======== ① 能力探测 / 杂项 ========
    canIUse: function (schema) {
      var name = String(schema || '').split('.')[0];
      return typeof shim[name] === 'function' && name !== '__noop';
    },
    // 页面自绘导航栏（page-router .pr-navbar + 转化约定 .nav-title），同时更新 document.title
    setNavigationBarTitle: function (o) {
      return withCallbacks(function () {
        global.document.title = (o && o.title) || '';
        var pr = global.PageRouter;
        if (pr && typeof pr.setNavTitle === 'function') { pr.setNavTitle((o && o.title) || ''); }
        var pages = global.getCurrentPages();
        var cur = pages && pages[pages.length - 1];
        var nav = cur && cur.__el && cur.__el.querySelector('.nav-title');
        if (nav) { nav.textContent = (o && o.title) || ''; }
        return Promise.resolve({ errMsg: 'setNavigationBarTitle:ok' });
      }, o);
    },
    setNavigationBarColor: function (o) {
      // 自绘导航栏（page-router .pr-navbar）：背景/前景真值联动（主题切换/圣诞皮肤走此通道）
      return withCallbacks(function () {
        var pr = global.PageRouter;
        if (pr && typeof pr.setNavColor === 'function') { pr.setNavColor(o || {}); }
        return Promise.resolve({ errMsg: 'setNavigationBarColor:ok' });
      }, o);
    },
    setPageStyle: function (o) {
      var pages = global.getCurrentPages();
      var cur = pages && pages[pages.length - 1];
      if (cur && cur.__el && o && o.style) {
        // 小程序 setPageStyle 传 CSS 文本（如 backgroundTextStyle）；仅透传 background 类属性
        if (o.style.background) { cur.__el.style.background = o.style.background; }
      }
      return withCallbacks(function () { return Promise.resolve({ errMsg: 'setPageStyle:ok' }); }, o);
    },
    // ======== 键盘（wx.onKeyboardHeightChange）========
    // 容器 webview 无微信原生键盘事件：visualViewport 压缩 / 布局视口 resize 双通道探测
    // （Android WebView 键盘弹起的标准信号；150px 阈值过滤滚动/缩放噪声）。
    // 事件分发三路：① 页面实例 onKeyboardHeightChange（keyboardBehavior 的 setData 链：
    //   isKeyboardVisible/keyboardHeight → 页面 padding-bottom 绑定）
    //   ② 可见 .dialog-overlay 挂 keyboard-visible 类（entity-shared 既有样式：
    //   dialog max-height 60vh + body 内滚——源 app 的键盘适配 CSS 因 bind 死绑定从未生效，此处接活）
    //   ③ wx 侧业务监听者
    onKeyboardHeightChange: function (cb) {
      kbStart();
      if (typeof cb === 'function') { kbListeners.push(cb); }
    },
    offKeyboardHeightChange: function (cb) {
      var i = kbListeners.indexOf(cb);
      if (i >= 0) { kbListeners.splice(i, 1); }
    },
    pageScrollTo: function (o) {
      return withCallbacks(function () {
        var pages = global.getCurrentPages();
        var cur = pages && pages[pages.length - 1];
        var scroller = cur && cur.__el;
        if (scroller) {
          if (o && o.selector) {
            var target = scroller.querySelector(o.selector);
            if (target) { target.scrollIntoView({ behavior: 'smooth' }); }
          } else if (typeof (o && o.scrollTop) === 'number') {
            scroller.scrollTo({ top: o.scrollTop, behavior: (o.duration || 0) > 0 ? 'smooth' : 'auto' });
          }
        }
        return Promise.resolve({ errMsg: 'pageScrollTo:ok' });
      }, o);
    },
    stopPullDownRefresh: function (o) {
      return withCallbacks(function () { return Promise.resolve({ errMsg: 'stopPullDownRefresh:ok' }); }, o);
    },

    // ======== ① 启动参数 / tabBar / 观察器（hamAssitant 启动路径面）========
    getLaunchOptionsSync: function () {
      // 离线容器无分享卡/二维码进入场景：恒返回冷启动默认值（业务按无 query 分支处理）
      return { path: 'pages/index/index', scene: 1001, query: {}, referrerInfo: {} };
    },
    getEnterOptionsSync: function () {
      return { path: 'pages/index/index', scene: 1001, query: {}, referrerInfo: {} };
    },
    setTabBarBadge: function (o) {
      return withCallbacks(function () {
        if (global.PageRouter && global.PageRouter.setTabBarBadge) { global.PageRouter.setTabBarBadge(o); }
        return Promise.resolve({ errMsg: 'setTabBarBadge:ok' });
      }, o);
    },
    removeTabBarBadge: function (o) {
      return withCallbacks(function () {
        if (global.PageRouter && global.PageRouter.removeTabBarBadge) { global.PageRouter.removeTabBarBadge(o); }
        return Promise.resolve({ errMsg: 'removeTabBarBadge:ok' });
      }, o);
    },
    setTabBarStyle: function (o) {
      return withCallbacks(function () {
        if (global.PageRouter && global.PageRouter.setTabBarStyle) { global.PageRouter.setTabBarStyle(o); }
        return Promise.resolve({ errMsg: 'setTabBarStyle:ok' });
      }, o);
    },
    setTabBarItem: function (o) {
      return withCallbacks(function () {
        if (global.PageRouter && global.PageRouter.setTabBarItem) { global.PageRouter.setTabBarItem(o); }
        return Promise.resolve({ errMsg: 'setTabBarItem:ok' });
      }, o);
    },
    nextTick: function (cb) { global.setTimeout(cb, 0); },
    // 微信传统 Canvas API → HTML5 2D 即时渲染适配器（业务 setCanvasSize 存数字不清屏，
    // draw(reserve=false) 的清屏语义交由业务 clearRect / 重设 canvas 尺寸完成）
    createCanvasContext: function (canvasId, scope) {
      function resolveRoot(s) {
        if (s && s.__el && s.__el.querySelectorAll) return s.__el;
        if (s && s.__hostEl && s.__hostEl.querySelectorAll) return s.__hostEl;
        if (s && s.querySelectorAll) return s;
        return global.document;
      }
      var root = resolveRoot(scope);
      var canvas = null;
      try {
        canvas = root.querySelector('[canvas-id="' + canvasId + '"]') || root.querySelector('#' + canvasId);
      } catch (e) { /* 选择器异常按无画布处理 */ }
      var ctx2d = canvas && canvas.getContext && canvas.getContext('2d');
      if (!ctx2d) { warnOnce('createCanvasContext: 未找到 canvas ' + canvasId); }
      var adopt = {
        setFillStyle: function (c) { if (ctx2d) ctx2d.fillStyle = c; return adopt; },
        setStrokeStyle: function (c) { if (ctx2d) ctx2d.strokeStyle = c; return adopt; },
        setGlobalAlpha: function (a) { if (ctx2d) ctx2d.globalAlpha = a; return adopt; },
        setLineWidth: function (w) { if (ctx2d) ctx2d.lineWidth = w; return adopt; },
        setLineCap: function (v) { if (ctx2d) ctx2d.lineCap = v; return adopt; },
        setLineJoin: function (v) { if (ctx2d) ctx2d.lineJoin = v; return adopt; },
        setMiterLimit: function (m) { if (ctx2d) ctx2d.miterLimit = m; return adopt; },
        setFontSize: function (n) { if (ctx2d) ctx2d.font = n + 'px sans-serif'; return adopt; },
        setTextAlign: function (v) { if (ctx2d) ctx2d.textAlign = v; return adopt; },
        setTextBaseline: function (v) { if (ctx2d) ctx2d.textBaseline = v; return adopt; },
        setShadow: function (ox, oy, blur, color) {
          if (ctx2d) { ctx2d.shadowOffsetX = ox; ctx2d.shadowOffsetY = oy; ctx2d.shadowBlur = blur; ctx2d.shadowColor = color; }
          return adopt;
        },
        beginPath: function () { if (ctx2d) ctx2d.beginPath(); return adopt; },
        closePath: function () { if (ctx2d) ctx2d.closePath(); return adopt; },
        moveTo: function (x, y) { if (ctx2d) ctx2d.moveTo(x, y); return adopt; },
        lineTo: function (x, y) { if (ctx2d) ctx2d.lineTo(x, y); return adopt; },
        quadraticCurveTo: function (cx, cy, x, y) { if (ctx2d) ctx2d.quadraticCurveTo(cx, cy, x, y); return adopt; },
        bezierCurveTo: function (c1x, c1y, c2x, c2y, x, y) { if (ctx2d) ctx2d.bezierCurveTo(c1x, c1y, c2x, c2y, x, y); return adopt; },
        arc: function (x, y, r, s, e, ccw) { if (ctx2d) ctx2d.arc(x, y, r, s, e, !!ccw); return adopt; },
        rect: function (x, y, w, h) { if (ctx2d) ctx2d.rect(x, y, w, h); return adopt; },
        fill: function () { if (ctx2d) ctx2d.fill(); return adopt; },
        stroke: function () { if (ctx2d) ctx2d.stroke(); return adopt; },
        fillRect: function (x, y, w, h) { if (ctx2d) ctx2d.fillRect(x, y, w, h); return adopt; },
        strokeRect: function (x, y, w, h) { if (ctx2d) ctx2d.strokeRect(x, y, w, h); return adopt; },
        clearRect: function (x, y, w, h) { if (ctx2d) ctx2d.clearRect(x, y, w, h); return adopt; },
        fillText: function (t, x, y) { if (ctx2d) ctx2d.fillText(t, x, y); return adopt; },
        strokeText: function (t, x, y) { if (ctx2d) ctx2d.strokeText(t, x, y); return adopt; },
        measureText: function (t) { return ctx2d ? ctx2d.measureText(t) : { width: 0 }; },
        save: function () { if (ctx2d) ctx2d.save(); return adopt; },
        restore: function () { if (ctx2d) ctx2d.restore(); return adopt; },
        translate: function (x, y) { if (ctx2d) ctx2d.translate(x, y); return adopt; },
        rotate: function (a) { if (ctx2d) ctx2d.rotate(a); return adopt; },
        scale: function (x, y) { if (ctx2d) ctx2d.scale(x, y); return adopt; },
        draw: function () { return adopt; },
        createLinearGradient: function (x0, y0, x1, y1) { return ctx2d ? ctx2d.createLinearGradient(x0, y0, x1, y1) : null; },
        createCircularGradient: function (x, y, r) { return ctx2d ? ctx2d.createRadialGradient(x, y, 0, x, y, r) : null; }
      };
      return adopt;
    },
    createIntersectionObserver: function () {
      // 交叉观察器：离线容器降级 no-op（observe 永不回调；业务有兜底分支）
      return { relativeTo: function () { return this; }, observe: function () {}, disconnect: function () {} };
    },

    // ======== ① 节点查询（缩减版：boundingClientRect / size / scrollOffset；scope 可传页面/组件根元素）========
    createSelectorQuery: function (scopeEl) {
      var pending = [];
      var scopeRoot = scopeEl || null; // .in() 设置；exec 时未设置则全 document
      function makeTask(sel) { return { sel: sel, fields: null, cb: null }; }
      var q = {
        // 小程序语义：限定查询作用域。scope 可传页面实例(__el)/组件实例(__hostEl)/DOM 元素
        in: function (scope) {
          if (scope && scope.__el && scope.__el.querySelectorAll) { scopeRoot = scope.__el; }
          else if (scope && scope.__hostEl && scope.__hostEl.querySelectorAll) { scopeRoot = scope.__hostEl; }
          else if (scope && scope.querySelectorAll) { scopeRoot = scope; }
          return q;
        },
        select: function (sel) { var t = makeTask(sel); pending.push(t); q.__last = t; return q; },
        selectAll: function (sel) { var t = makeTask(sel); t.all = true; pending.push(t); q.__last = t; return q; },
        boundingClientRect: function (cb) { if (q.__last) { q.__last.rect = true; q.__last.cb = cb; } return q; },
        fields: function (f, cb) {
          if (q.__last) { q.__last.fields = f || {}; q.__last.cb = cb || (typeof f === 'function' ? f : null); }
          return q;
        },
        exec: function (cb) {
          var results = pending.map(function (t) {
            var scope = scopeRoot || global.document;
            var els = t.all ? scope.querySelectorAll(t.sel) : [scope.querySelector(t.sel)];
            var list = [];
            Array.prototype.forEach.call(els, function (el) {
              if (!el) { list.push(null); return; }
              var r = el.getBoundingClientRect();
              var out = {};
              if (t.rect || !t.fields) {
                out.id = el.id; out.dataset = el.dataset || {};
                out.left = r.left; out.top = r.top; out.right = r.right; out.bottom = r.bottom;
                out.width = r.width; out.height = r.height;
              }
              if (t.fields) {
                if (t.fields.size) { out.width = r.width; out.height = r.height; }
                if (t.fields.scrollOffset) { out.scrollTop = el.scrollTop; out.scrollLeft = el.scrollLeft; }
                if (t.fields.dataset) { out.dataset = el.dataset || {}; }
                if (t.fields.id) { out.id = el.id; }
                if (t.fields.rect) {
                  out.left = r.left; out.top = r.top; out.right = r.right; out.bottom = r.bottom;
                }
              }
              list.push(out);
            });
            var res = t.all ? list : list[0];
            if (t.cb) { t.cb(res); }
            return res;
          });
          pending = [];
          if (typeof cb === 'function') { cb(results); }
        }
      };
      return q;
    },

    // ======== ② 云函数 / 网络请求（离线降级 + mock 注入）========
    cloud: {
      init: function () { /* 离线容器无云环境，仅吞掉初始化 */ },
      // 转化项目在入口注入：WxApiShim.mockCloud('fnName', data 或 function(payload))
      // mock 函数可返回值或 Promise（异步 mock 走 Promise 链展开后再包 {result}）
      callFunction: function (o) {
        return withCallbacks(function () {
          var key = o && o.name;
          if (key in cloudMock) {
            return Promise.resolve().then(function () {
              return resolveMock(cloudMock, key, o && o.data);
            }).then(function (result) {
              return { result: result, errMsg: 'cloud.callFunction:ok' };
            });
          }
          return Promise.reject(failObj('cloud.callFunction',
            'offline（无 mock 数据，用 WxApiShim.mockCloud("' + key + '", ...) 注入）'));
        }, o);
      },
      database: function () {
        // 离线容器无云数据库：链式空集合 mock——读到 data:[] 业务按"无记录"干净降级
        // （premiumManager 空用户→判非 Pro；syncTransport 空集合→无云端数据）。写操作返回 0 影响。
        warnOnce('cloud.database: 离线容器无云数据库，返回空集合 mock');
        function makeQuery() {
          function ret() { return makeQuery(); }
          ret.collection = ret; ret.where = ret; ret.field = ret; ret.limit = ret;
          ret.orderBy = ret; ret.skip = ret; ret.doc = ret;
          ret.get = function () { return Promise.resolve({ data: [] }); };
          ret.count = function () { return Promise.resolve({ total: 0 }); };
          ret.update = function () { return Promise.resolve({ stats: { updated: 0 } }); };
          ret.set = function () { return Promise.resolve({ _id: '' }); };
          ret.add = function () { return Promise.resolve({ _id: 'local-' + Date.now() }); };
          ret.remove = function () { return Promise.resolve({ stats: { removed: 0 } }); };
          return ret;
        }
        return makeQuery();
      }
    },
    request: function (o) {
      return withCallbacks(function () {
        var key = o && o.url;
        if (key in requestMock) {
          return Promise.resolve().then(function () {
            return resolveMock(requestMock, key, o);
          });
        }
        return Promise.reject(failObj('request', 'offline（容器禁网络请求，用 WxApiShim.mockRequest 注入静态数据）'));
      }, o);
    },

    // ======== ③ 平台无对应能力 ========
    // 剪贴板：容器禁 navigator.clipboard / execCommand('copy')，降级弹层展示文本供手动处理
    setClipboardData: function (o) {
      return withCallbacks(function () {
        return global.UiKit.modal({
          title: '请手动复制',
          content: (o && o.data) || '',
          showCancel: false,
          confirmText: '知道了'
        }).then(function () { return { errMsg: 'setClipboardData:ok(降级展示)' }; });
      }, o);
    },
    // 存图到相册：canvas 海报（dataURL）→ XhsBridge.saveImage → 平台 saveImageToPhotosAlbum（9.42+）
    saveImageToPhotosAlbum: function (o) {
      return withCallbacks(function () {
        var filePath = o && o.filePath;
        if (!filePath || filePath.indexOf('data:') !== 0) {
          // 非 dataURL（本地临时路径语义）：容器无文件系统直通，引导走 dataURL（海报生成器天然输出 base64）
          return Promise.reject(failObj('saveImageToPhotosAlbum', '仅支持 dataURL（canvas.toDataURL 输出）'));
        }
        return global.XhsBridge.saveImage(filePath).then(function () {
          return { errMsg: 'saveImageToPhotosAlbum:ok' };
        }).catch(function (e) {
          throw failObj('saveImageToPhotosAlbum', (e && (e.errMsg || e.message)) || 'unsupported');
        });
      }, o);
    },

    // 以下均为微信生态专属（订阅消息/支付/广告/桌面/数据上报），小红书容器无对应：
    //   report 类静默成功（避免业务流程中断），交互变现类显式 fail（业务应有降级分支）
    reportEvent: function (o) {
      return withCallbacks(function () { return Promise.resolve({ errMsg: 'reportEvent:ok(noop)' }); }, o);
    },
    reportAnalytics: function (o) {
      return withCallbacks(function () { return Promise.resolve({ errMsg: 'reportAnalytics:ok(noop)' }); }, o);
    },
    requestSubscribeMessage: function (o) {
      return withCallbacks(function () {
        return Promise.resolve({ errMsg: 'requestSubscribeMessage:ok(noop)' });
      }, o);
    },
    requestVirtualPayment: function (o) {
      return withCallbacks(function () {
        return Promise.reject(failObj('requestVirtualPayment', '平台无支付能力'));
      }, o);
    },
    addToDesktop: function (o) {
      return withCallbacks(function () {
        return Promise.reject(failObj('addToDesktop', '平台无对应能力'));
      }, o);
    },
    shareFileMessage: function (o) {
      return withCallbacks(function () {
        return Promise.reject(failObj('shareFileMessage', '平台无对应能力'));
      }, o);
    },
    createRewardedVideoAd: function () {
      warnOnce('createRewardedVideoAd: 平台无广告能力，返回 no-op 实例');
      return {
        load: function () { return Promise.reject(failObj('ad.load', '平台无广告能力')); },
        show: function () { return Promise.reject(failObj('ad.show', '平台无广告能力')); },
        onClose: function () {}, offClose: function () {},
        onError: function () {}, offError: function () {}
      };
    },
    login: function (o) {
      return withCallbacks(function () {
        // 离线无账号体系：resolve 本地匿名 id（转化指南：需要身份的功能改用本地身份）
        var bridge = global.XhsBridge;
        var uid = bridge.storageGet('wxshim_uid');
        if (!uid) {
          uid = 'local_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
          bridge.storageSet('wxshim_uid', uid);
        }
        return Promise.resolve({ code: uid, errMsg: 'login:ok(local)' });
      }, o);
    },
    getUserProfile: function (o) {
      // 平台无账号体系：返回本地匿名档案（配合 mockCloud('login') 本地 openid 组成完整降级链，
      // 业务 getUserProfile→login→setUserInfo 主链成功，无降级噪音）
      return withCallbacks(function () {
        var nick = '仓鼠用户' + String(Math.floor(Math.random() * 900) + 100);
        return Promise.resolve({
          userInfo: { nickName: nick, avatarUrl: '', gender: 0, city: '', province: '', country: '' },
          errMsg: 'getUserProfile:ok'
        });
      }, o);
    },

    // ======== ③ 生命周期事件桥接 ========
    onAppShow: function (cb) { global.addEventListener('visibilitychange', function () { if (!global.document.hidden && typeof cb === 'function') { cb({}); } }); },
    onAppHide: function (cb) { global.addEventListener('visibilitychange', function () { if (global.document.hidden && typeof cb === 'function') { cb({}); } }); },
    onError: function (cb) { global.addEventListener('error', function (e) { if (typeof cb === 'function') { cb((e && e.message) || 'error'); } }); },
    onMemoryWarning: function () {},

    // ======== ③ createAnimation：无视图绑定机制，返回 no-op 链式对象 ========
    // 小程序动画依赖 WXML animation 绑定，转化后应改用 CSS class 切换 / transition
    createAnimation: function () {
      warnOnce('createAnimation: 已 no-op，请改用 CSS transition/class 切换（见转化指南）');
      function noop() { return anim; }
      var anim = {
        export: function () { return { actions: [] }; },
        step: noop
      };
      ['translate', 'translateX', 'translateY', 'rotate', 'rotateX', 'rotateY', 'scale', 'scaleX',
       'scaleY', 'opacity', 'width', 'height', 'backgroundColor', 'skew', 'top', 'left', 'right', 'bottom'
      ].forEach(function (m) { anim[m] = noop; });
      return anim;
    },

    // ======== mock 注入 API（转化项目入口调用）========
    mockCloud: function (name, dataOrFn) { cloudMock[name] = dataOrFn; },
    mockRequest: function (url, dataOrFn) { requestMock[url] = dataOrFn; }
  };

  function parseTabUrl(url) {
    return String(url || '').split('?')[0];
  }

  // ---- Proxy 兜底：未覆盖 API 调用时 warn + 返回 no-op（防转化期崩溃）----
  var proxied = new Proxy(shim, {
    get: function (target, prop) {
      if (prop in target) { return target[prop]; }
      warnOnce('wx.' + String(prop) + ': wx-api-shim 未覆盖（已 no-op）——需实现时见 _shared/README.md 扩展说明');
      if (prop === 'then') { return undefined; } // 避免被当作 thenable
      return target.__noop;
    }
  });
  shim.__noop = function (o) {
    return withCallbacks(function () {
      return Promise.resolve({ errMsg: 'noop' });
    }, o);
  };

  global.wx = proxied;
  global.WxApiShim = shim;
  return shim;
})(typeof window !== 'undefined' ? window : this);

export default WxApiShim;

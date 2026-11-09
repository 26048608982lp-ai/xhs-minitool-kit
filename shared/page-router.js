// page-router.js — 小程序多页面模型在单 HTML 内的路由栈（小程序转化核心层）
// 零依赖、ES2017/Chrome 61 兼容。
//
// 职责：App/Behavior/Page 全局构造器 + behaviors 合成 + navigateTo/navigateBack/
//       redirectTo/reLaunch/switchTab 页面栈语义 + onLoad/onShow/onHide/onUnload 生命周期
//       + setData 数据合并触发重渲染（接入 WxmlRuntime，手写 render() 仍兼容）+ 自绘 tabBar。
// 页面视图：WXML 由 _tools/wxml2html.mjs 构建期转成 section[data-page] 静态 HTML，
//       {{}}/wx:if/wx:for/事件绑定由 _shared/wxml-runtime.js 运行时渲染。
// 约定：一个包内所有页面共用一个路由器；tab 页常驻缓存，普通页压栈/弹栈带滑动动画。
var PageRouter = (function (global) {
  'use strict';

  var container = null;
  var pages = {};        // path -> config（Page() 注册）
  var stack = [];        // 普通页栈：[instance]
  var tabPool = {};      // path -> instance（tab 页常驻）
  var activeTab = null;  // 当前 tab path
  var tabBarCfg = null;  // { list: [{pagePath, text, iconPath?, selectedIconPath?}] }
  var tabBarEl = null;
  var navCfg = null;     // { title, backgroundColor?, color? }（自绘导航栏，对齐微信原生栏形态）
  var navEl = null;
  var appInstance = null;

  function doc() { return global.document; }
  function Runtime() { return global.WxmlRuntime; }

  // ---- App / Behavior 构造器 ----
  global.Behavior = function (config) {
    config = config || {};
    config.__isBehavior = true;
    return config;
  };
  global.App = function (config) {
    // 小程序 App：globalData + 生命周期 + 自定义方法挂实例；getApp() 取回
    appInstance = config || {};
    return appInstance;
  };
  global.getApp = function (allowDefault) {
    if (!appInstance && !allowDefault) {
      console.warn('PageRouter: getApp() 在 App() 之前调用');
    }
    return appInstance;
  };

  // ---- behaviors 合成（Page/Component 共用；小程序语义）----
  // data 深合并（自身覆盖）、对象型字段（methods/properties/observers）逐键合并（自身优先）、
  // 生命周期钩子全部保留依次执行（behaviors 先）、methods 平铺到顶层（this.fn 可直调）
  var LIFE_HOOKS = ['onLoad', 'onShow', 'onHide', 'onUnload', 'onReady',
    'onPullDownRefresh', 'onReachBottom', 'onShareAppMessage', 'created', 'attached', 'ready', 'detached'];
  var MERGE_KEYS = ['methods', 'properties', 'observers'];
  function flattenBehaviors(config) {
    config = config || {};
    var list = config.behaviors || [];
    // 递归展开嵌套 behaviors
    var flat = [];
    (function pushAll(arr) {
      arr.forEach(function (b) {
        if (b.behaviors && b.behaviors.length) { pushAll(b.behaviors); }
        flat.push(b);
      });
    })(list);
    var merged = {};
    Object.keys(config).forEach(function (k) { merged[k] = config[k]; });
    flat.forEach(function (b) {
      Object.keys(b).forEach(function (k) {
        if (k === 'behaviors' || k === '__isBehavior') { return; }
        if (LIFE_HOOKS.indexOf(k) >= 0) {
          // 生命周期：合并成链（behaviors 先于自身；多重 behavior 按声明序）
          var self = merged[k];
          var bh = typeof b[k] === 'function' ? b[k] : null;
          merged[k] = (function (prev, hook) {
            return function (arg) {
              if (hook) { hook.call(this, arg); }
              if (prev) { prev.call(this, arg); }
            };
          })(self, bh);
          return;
        }
        if (k === 'data') {
          merged.data = deepMerge(cloneData(b.data || {}), merged.data || {});
          return;
        }
        if (MERGE_KEYS.indexOf(k) >= 0) {
          // 对象型字段：逐键合并，自身优先（后展开的 behavior 覆盖先前的）
          merged[k] = Object.assign({}, b[k], merged[k]);
          return;
        }
        if (merged[k] === undefined) { merged[k] = b[k]; }
      });
    });
    // Page 语义：methods 平铺到顶层（页面 this.initTheme() 直调；同名顶层函数优先）
    if (merged.methods) {
      Object.keys(merged.methods).forEach(function (mn) {
        if (typeof merged[mn] !== 'function') { merged[mn] = merged.methods[mn]; }
      });
    }
    return merged;
  }
  function deepMerge(base, overlay) {
    Object.keys(overlay || {}).forEach(function (k) {
      if (base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) &&
          overlay[k] && typeof overlay[k] === 'object' && !Array.isArray(overlay[k])) {
        deepMerge(base[k], overlay[k]);
      } else {
        base[k] = overlay[k];
      }
    });
    return base;
  }
  function cloneData(d) { return d ? JSON.parse(JSON.stringify(d)) : {}; }

  function parseUrl(url) {
    // '/pages/detail/index?id=5&from=share' → { path: '/pages/detail/index', query: {id:'5', from:'share'} }
    var u = (url || '').split('?');
    var path = u[0].replace(/\/$/, '') || '/';
    var query = {};
    (u[1] || '').split('&').forEach(function (kv) {
      if (!kv) { return; }
      var pair = kv.split('=');
      try { query[decodeURIComponent(pair[0])] = decodeURIComponent(pair[1] || ''); }
      catch (e) { query[pair[0]] = pair[1] || ''; }
    });
    return { path: path, query: query };
  }

  function findSection(path) {
    return container.querySelector('section[data-page="' + path + '"]');
  }

  function createInstance(path, query) {
    var config = pages[path];
    if (!config) {
      throw new Error('PageRouter: 未注册页面 ' + path + '（需 Page({ path: "' + path + '", ... })）');
    }
    var section = findSection(path);
    if (!section) {
      section = doc().createElement('section');
      section.setAttribute('data-page', path);
      container.appendChild(section);
    }
    // tab 页标记：CSS 据此预留自绘 tabBar 空间（微信原生 tabBar 会排除页面可用高度，
    // 自绘 tabBar 是覆盖层——不预留则页面底部内容被 tabBar 挡住点不了，真机拒审实锤）
    if (isTab(path)) { section.classList.add('pr-tabpage'); }
    var inst = Object.create(config);
    inst.route = path;
    inst.options = query || {};
    inst.data = JSON.parse(JSON.stringify(config.data || {}));
    inst.__el = section;
    inst.setData = function (patch, cb) {
      if (patch) {
        for (var k in patch) {
          if (Object.prototype.hasOwnProperty.call(patch, k)) {
            if (k.indexOf('.') > 0 && Runtime() && Runtime().setPath) {
              Runtime().setPath(inst.data, k, patch[k]); // 'a.b.c' 路径键（小程序语义）
            } else {
              inst.data[k] = patch[k];
            }
          }
        }
      }
      rerender(inst);
      if (typeof cb === 'function') { cb(); }
    };
    inst.selectComponent = function (sel) {
      return Runtime() ? Runtime().selectComponentIn(section, sel) : null;
    };
    inst.createSelectorQuery = function () {
      return (global.WxApiShim && global.WxApiShim.createSelectorQuery)
        ? global.WxApiShim.createSelectorQuery(section) : null;
    };
    return inst;
  }

  // 统一重渲染入口：WxmlRuntime（模板渲染）+ 手写 render()（兼容渐进迁移）
  function rerender(inst) {
    if (Runtime() && inst.__wr) { Runtime().renderPage(inst); }
    if (typeof inst.render === 'function') { inst.render(); }
  }

  function callIf(inst, name, arg) {
    if (inst && typeof inst[name] === 'function') { inst[name](arg); }
  }

  function injectStyles() {
    if (doc().getElementById('pr-styles')) { return; }
    var style = doc().createElement('style');
    style.id = 'pr-styles';
    style.textContent = ''
      + '.pr-root{position:relative;width:100%;height:100%;overflow:hidden;}'
      + '.pr-page{position:absolute;left:0;top:0;width:100%;height:100%;overflow-y:auto;'
      + '-webkit-overflow-scrolling:touch;background:#f6f6f6;transition:transform .28s ease;'
      + 'box-sizing:border-box;}'
      + '.pr-enter{transform:translateX(100%);transition:none;}'
      + '.pr-leave{transform:translateX(100%);}'
      + '.pr-under{transform:translateX(-24%);}'
      + '.pr-page *{box-sizing:border-box;}'
      + '.pr-tabbar{position:fixed;left:0;right:0;bottom:0;display:flex;z-index:100;'
      + 'background:#fff;border-top:1px solid #eee;padding-bottom:env(safe-area-inset-bottom);}'
      + '.pr-tab{position:relative;flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;'
      + 'height:50px;font-size:10px;color:#999;cursor:pointer;-webkit-user-select:none;user-select:none;}'
      + '.pr-tab img{width:24px;height:24px;margin-bottom:2px;}'
      + '.pr-tab.on{color:#ff2442;}'
      + '.pr-badge{position:absolute;top:2px;right:50%;margin-right:-26px;min-width:16px;height:16px;'
      + 'line-height:16px;padding:0 4px;border-radius:8px;background:#ff2442;color:#fff;font-size:10px;'
      + 'font-style:normal;text-align:center;}'
      // 自绘导航栏：高度 = 安全区 safeTop（容器 HUD/状态栏避让）+ 44 标题行，真值由 applyNavInset 覆写。
      // fixed 钉视口（文档可程序滚动时 absolute 会跟着滚走）；z-index 8999 低于覆盖层梯队（--z-overlay 10000）
      + '.pr-navbar{position:fixed;left:0;right:0;top:0;height:var(--nav-h,88px);z-index:8999;'
      + 'background:#FF8C42;display:flex;align-items:flex-end;justify-content:center;box-sizing:border-box;}'
      + '.pr-navbar-title{width:100%;height:44px;line-height:44px;text-align:center;color:#fff;'
      + 'font-size:17px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}';
    doc().head.appendChild(style);
  }

  // ---- 自绘导航栏（对齐微信原生栏：安全区避让 + 每页标题；标题源 = section data-title / wx.setNavigationBarTitle）----
  function ensureNav() {
    if (!navCfg || navEl) { return; }
    navEl = doc().createElement('header');
    navEl.className = 'pr-navbar';
    if (navCfg.backgroundColor) { navEl.style.background = navCfg.backgroundColor; }
    var t = doc().createElement('div');
    t.className = 'pr-navbar-title';
    if (navCfg.color) { t.style.color = navCfg.color; }
    navEl.appendChild(t);
    container.appendChild(navEl);
  }
  function updateNav(inst) {
    if (!navCfg) { return; }
    ensureNav();
    // 标题优先级：页面实例运行时标题（wx.setNavigationBarTitle，粘在实例上）> section data-title > nav.title
    var title = (inst && inst.__navTitle)
      || (inst && inst.__el && inst.__el.getAttribute('data-title'))
      || navCfg.title || '';
    navEl.firstChild.textContent = title;
  }
  // 安全区真值注入：XhsBridge.layout.safeTop（= max(状态栏, 原生按钮 bottom+8)）就绪后覆写 --nav-h；
  // 无 SDK/本地环境走 bridge fallback 44 → 88px，与 cssBase 默认一致
  function applyNavInset(tries) {
    var xb = global.XhsBridge;
    var st = xb && xb.layout && Number(xb.layout.safeTop);
    if (st > 0) {
      doc().documentElement.style.setProperty('--nav-h', (st + 44) + 'px');
      return;
    }
    if (tries < 25) { global.setTimeout(function () { applyNavInset(tries + 1); }, 200); }
  }
  function setNavTitle(title) {
    if (!navCfg) { return; }
    ensureNav();
    var cur = stack[stack.length - 1] || tabPool[activeTab] || null;
    if (cur) { cur.__navTitle = title || ''; } // 标题粘在页面实例（微信语义：页面切换后各自恢复）
    navEl.firstChild.textContent = title || '';
  }
  function setNavColor(o) {
    if (!navCfg) { return; }
    ensureNav();
    if (o && o.backgroundColor) { navEl.style.background = o.backgroundColor; }
    if (o && o.frontColor) { navEl.firstChild.style.color = o.frontColor; }
  }

  // ---- tabBar ----
  function renderTabBar() {
    if (!tabBarCfg || !tabBarCfg.list || !tabBarCfg.list.length) { return; }
    if (!tabBarEl) {
      tabBarEl = doc().createElement('nav');
      tabBarEl.className = 'pr-tabbar';
      container.appendChild(tabBarEl);
    }
    tabBarEl.innerHTML = '';
    tabBarCfg.list.forEach(function (item) {
      var tab = doc().createElement('div');
      tab.className = 'pr-tab' + (item.pagePath === activeTab ? ' on' : '');
      if (item.iconPath) {
        var img = doc().createElement('img');
        var on = item.pagePath === activeTab;
        img.src = (on && item.selectedIconPath) || item.iconPath;
        tab.appendChild(img);
      }
      tab.appendChild(doc().createElement('span'));
      tab.lastChild.textContent = item.text || '';
      if (item.__badge) {
        var badge = doc().createElement('i');
        badge.className = 'pr-badge';
        badge.textContent = item.__badge;
        tab.appendChild(badge);
      }
      if (tabBarCfg.__style) {
        tab.style.color = tabBarCfg.__style.color || '';
        if (item.pagePath === activeTab) { tab.style.color = tabBarCfg.__style.selectedColor || ''; }
      }
      tab.addEventListener('click', function () { goTab(item.pagePath); });
      tabBarEl.appendChild(tab);
    });
    // 供 wx-api-shim 的 windowHeight 语义使用（tab 页可用高度需扣除 tabBar 实测高，
    // 含 padding-bottom 的 env 安全区——须在 tab 项渲染完后测）
    global.__prTabH = tabBarEl.offsetHeight || global.__prTabH || 0;
  }

  // tab 页激活状态（供 shim windowHeight 语义；栈空且有 tab = 当前显示 tab 页）
  function updateTabState() {
    global.__prTabActive = stack.length === 0 && !!activeTab;
  }

  function isTab(path) {
    if (!tabBarCfg || !tabBarCfg.list) { return false; }
    return tabBarCfg.list.some(function (i) { return i.pagePath === path; });
  }

  // ---- tabBar API（wx.setTabBarBadge 等的落点；角标以 list[i].__badge 暂存，renderTabBar 重绘）----
  function setTabBarBadge(o) {
    if (!tabBarCfg || !tabBarCfg.list || !tabBarCfg.list[o.index]) { return; }
    tabBarCfg.list[o.index].__badge = String(o.text || '');
    renderTabBar();
  }
  function removeTabBarBadge(o) {
    if (!tabBarCfg || !tabBarCfg.list || !tabBarCfg.list[o.index]) { return; }
    tabBarCfg.list[o.index].__badge = null;
    renderTabBar();
  }
  function setTabBarStyle(o) {
    if (!tabBarEl || !o) { return; }
    if (o.backgroundColor) { tabBarEl.style.background = o.backgroundColor; }
    if (o.borderStyle === 'white') { tabBarEl.style.borderTopColor = 'transparent'; }
    if (o.color || o.selectedColor) {
      tabBarCfg.__style = { color: o.color, selectedColor: o.selectedColor };
      renderTabBar();
    }
  }
  function setTabBarItem(o) {
    if (!tabBarCfg || !tabBarCfg.list || !tabBarCfg.list[o.index]) { return; }
    var item = tabBarCfg.list[o.index];
    if (o.text) { item.text = o.text; }
    if (o.iconPath) { item.iconPath = o.iconPath; }
    if (o.selectedIconPath) { item.selectedIconPath = o.selectedIconPath; }
    renderTabBar();
  }

  // ---- 核心路由动作（均返回 Promise，回调适配在 wx-api-shim 层）----
  function navigateTo(url) {
    var parsed = parseUrl(url);
    return new Promise(function (resolve, reject) {
      if (!pages[parsed.path]) { reject({ errMsg: 'navigateTo:fail page "' + parsed.path + '" is not found' }); return; }
      if (isTab(parsed.path)) { reject({ errMsg: 'navigateTo:fail can not navigateTo a tabbar page' }); return; }
      // 隐藏当前普通页（tab 页切走）
      var cur = stack[stack.length - 1] || tabPool[activeTab];
      callIf(cur, 'onHide');
      if (cur && cur.__el && !isTab(cur.route)) { cur.__el.classList.add('pr-under'); }
      if (cur && cur.__el && isTab(cur.route)) { cur.__el.style.display = 'none'; }

      var inst = createInstance(parsed.path, parsed.query);
      inst.__el.classList.add('pr-enter');
      inst.__el.style.display = '';
      if (Runtime()) { Runtime().mountPage(inst, inst.__el); }
      // 先入栈再 onLoad（对齐微信：onLoad 时页面已在栈中，getCurrentPages 含自身；
      // 壳页在 onLoad 同步 redirectTo 时 pop 才能弹到本页）
      stack.push(inst);
      callIf(inst, 'onLoad', parsed.query);
      if (stack[stack.length - 1] !== inst) {
        // onLoad 内被 redirectTo/reLaunch 移出栈（重定向壳页模式）：显示权已移交，中止后续
        resolve(); return;
      }
      // 强制 reflow 后移除 pr-enter，让 transition 生效
      void inst.__el.offsetWidth;
      inst.__el.classList.remove('pr-enter');
      rerender(inst);
      updateNav(inst);
      updateTabState();
      callIf(inst, 'onShow');
      resolve();
    });
  }

  function navigateBack(delta) {
    return new Promise(function (resolve) {
      var d = Math.max(1, delta || 1);
      if (stack.length <= 1 && !activeTab) { resolve(); return; }
      var top = stack.pop();
      if (top) {
        top.__el.classList.add('pr-leave');
        callIf(top, 'onUnload');
        var el = top.__el;
        global.setTimeout(function () {
          el.style.display = 'none';
          el.classList.remove('pr-leave');
          // 普通页 section 复用：回栈时重新 onLoad，先清空动态内容由页面自己重建
        }, 300);
      }
      // 多级回退时直接丢弃中间页
      while (d > 1 && stack.length > 0) {
        var mid = stack.pop();
        callIf(mid, 'onUnload');
        mid.__el.style.display = 'none';
        d--;
      }
      var prev = stack[stack.length - 1];
      if (prev) {
        prev.__el.style.display = '';
        prev.__el.classList.remove('pr-under');
        updateNav(prev);
        updateTabState();
        callIf(prev, 'onShow');
      } else {
        // 栈空回 tab
        goTab(activeTab || (tabBarCfg && tabBarCfg.list[0] && tabBarCfg.list[0].pagePath));
      }
      resolve();
    });
  }

  function redirectTo(url) {
    var parsed = parseUrl(url);
    return new Promise(function (resolve, reject) {
      if (!pages[parsed.path]) { reject({ errMsg: 'redirectTo:fail page "' + parsed.path + '" is not found' }); return; }
      var top = stack.pop();
      if (top) {
        callIf(top, 'onUnload');
        top.__el.style.display = 'none';
      }
      navigateTo(url).then(resolve, reject);
    });
  }

  function reLaunch(url) {
    var parsed = parseUrl(url);
    return new Promise(function (resolve, reject) {
      // 清全部普通页
      stack.forEach(function (p) { callIf(p, 'onUnload'); p.__el.style.display = 'none'; });
      stack = [];
      if (isTab(parsed.path)) {
        goTab(parsed.path);
        // tab 页 onLoad 需要带 query：tab 常驻池只建一次，reLaunch 视为重新进入
        resolve();
        return;
      }
      navigateTo(url).then(resolve, reject);
    });
  }

  function goTab(path) {
    if (!isTab(path)) { return Promise.reject({ errMsg: 'switchTab:fail ' + path + ' is not tabbar page' }); }
    return new Promise(function (resolve) {
      // 清空普通页栈
      stack.forEach(function (p) {
        callIf(p, 'onHide');
        callIf(p, 'onUnload');
        p.__el.style.display = 'none';
      });
      stack = [];
      // 隐藏其他 tab 页
      Object.keys(tabPool).forEach(function (k) {
        if (k !== path) {
          callIf(tabPool[k], 'onHide');
          tabPool[k].__el.style.display = 'none';
        }
      });
      var isNew = !tabPool[path];
      var inst = tabPool[path] || createInstance(path, {});
      tabPool[path] = inst;
      if (isNew) {
        if (Runtime()) { Runtime().mountPage(inst, inst.__el); }
        callIf(inst, 'onLoad', {});
      } else {
        rerender(inst); // tab 常驻切回：刷新数据绑定
      }
      inst.__el.style.display = '';
      callIf(inst, 'onShow');
      activeTab = path;
      renderTabBar();
      updateNav(inst);
      updateTabState();
      resolve();
    });
  }

  // ---- 初始化与注册 ----
  function init(opts) {
    opts = opts || {};
    injectStyles();
    var root = opts.container
      ? (typeof opts.container === 'string' ? doc().querySelector(opts.container) : opts.container)
      : doc().getElementById('app') || doc().body;
    root.classList.add('pr-root');
    container = root;
    tabBarCfg = opts.tabBar || null;
    navCfg = opts.nav || null;
    if (navCfg) {
      updateNav(null); // 初始标题用 nav.title 兜底；首个页面显示时被 data-title 覆写
      applyNavInset(0);
    }
    var entry = opts.entry || (tabBarCfg && tabBarCfg.list[0] && tabBarCfg.list[0].pagePath);
    if (tabBarCfg && entry) {
      return goTab(entry);
    }
    if (entry) { return navigateTo(entry); }
    return Promise.resolve();
  }

  // Page() 全局：转化时页面 js 的 Page({...}) 保留；behaviors 自动合成（无需源码改动）
  function register(config) {
    if (!config || !config.path) {
      throw new Error('PageRouter.Page: config.path 必填（小程序页面路径，如 "/pages/index/index"）');
    }
    pages[config.path] = flattenBehaviors(config);
  }

  global.Page = register;
  global.getCurrentPages = function () {
    var list = stack.slice();
    if (activeTab && tabPool[activeTab]) { list.push(tabPool[activeTab]); }
    return list;
  };

  var router = {
    init: init,
    Page: register,
    flattenBehaviors: flattenBehaviors,
    navigateTo: navigateTo,
    navigateBack: navigateBack,
    redirectTo: redirectTo,
    reLaunch: reLaunch,
    switchTab: goTab,
    setTabBarBadge: setTabBarBadge,
    removeTabBarBadge: removeTabBarBadge,
    setTabBarStyle: setTabBarStyle,
    setTabBarItem: setTabBarItem,
    setNavTitle: setNavTitle,
    setNavColor: setNavColor,
    current: function () { return stack[stack.length - 1] || tabPool[activeTab] || null; }
  };

  global.PageRouter = router;
  return router;
})(typeof window !== 'undefined' ? window : this);

export default PageRouter;

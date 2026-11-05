// xhs-bridge.js — 小红书小工具平台能力公共桥接层（零依赖，ES2017/Chrome 61）
// 新小工具接入：本文件拷入 src/ → 入口处 await XhsBridge.init(storagePrefix) → 使用各 API
// 官方能力清单 2026-10-19 版：https://miniapp-sandbox.xiaohongshu.com/minitool/doc
// 版本门槛：Storage 9.46+ / getWindowInfo·文件系统·评论区 9.49+ / 振动·陀螺仪 9.50+ / 关注 9.51+ / 存图 9.42+
//
// 架构：三个子系统（版本探测 / Storage / 窗口信息）为闭包私有，bridge 门面对象只暴露公共 API；
// 兼容双轨：window.XhsBridge 挂载（老接入，esbuild 副作用导入即可用）+ ESM export default（新接入显式依赖）。
// 注意：IIFE 内部变量不可直接 export（esbuild 作用域提升会改名），一律经 return 传出。
var XhsBridge = (function (global) {
  'use strict';

  var VERSION_STORAGE = 9460;
  var VERSION_WINDOW = 9490;
  var VERSION_VIBRATE = 9500;
  var VERSION_COMMENT = 9490;
  var VERSION_FOLLOW = 9510;

  function miniTool() {
    var xhs = global.xhs;
    return (xhs && xhs.miniTool) || null;
  }

  function readBuildVersion(launchOptions) {
    var env = launchOptions && launchOptions.miniToolEnv;
    var bv = Number(env && env.buildVersion) || 0;
    // 末 3 位是编译序号，判断版本必须忽略（官方 §3.6）
    return bv;
  }

  function isAtLeast(buildVersion, minClientVersion) {
    return Math.floor(buildVersion / 1000) >= minClientVersion;
  }

  var bridge = {
    // ---- 状态 ----
    ready: false,
    buildVersion: 0,      // 0 = 取不到（按最低能力处理）
    useXhsStorage: false, // true = 平台 Storage 可用
    layout: { safeTop: 0, safeBottom: 0, windowWidth: 0, windowHeight: 0 },

    // ---- 初始化（入口 await 一次）----
    init: function (storagePrefix) {
      var self = this;
      return version.detect(self)
        .then(function () { return storageLoad(self, storagePrefix || 'mt_'); })
        .then(function () { return loadWindowInfo(self); })
        .then(function () { self.ready = true; return self; });
    },

    // ---- Storage 公共 API（9.46+ 平台持久化，否则 localStorage 兜底；同步语义）----
    storageSet: function (key, value) {
      mem[key] = value;
      persist(key, value);
    },
    storageGet: function (key) {
      if (key in mem) { return mem[key]; }
      // init 未完成的窗口期：直读 localStorage（与 ready 后的预载来源一致）
      try {
        var raw = global.localStorage.getItem(prefix + key);
        if (raw !== null) { return decode(raw); }
      } catch (e) {}
      return '';
    },
    storageRemove: function (key) {
      delete mem[key];
      try { global.localStorage.removeItem(prefix + key); } catch (e) {}
      if (bridge.useXhsStorage) {
        callQuiet('removeStorage', { key: key });
      }
    },
    storageInfo: function () {
      var keys = Object.keys(mem);
      return { keys: keys, currentSize: keys.length };
    },
    storageClear: function () {
      Object.keys(mem).forEach(function (k) {
        try { global.localStorage.removeItem(prefix + k); } catch (e) {}
      });
      mem = {};
      if (bridge.useXhsStorage) {
        callQuiet('clearStorage', {});
      }
    },

    // ---- 振动（9.50+；正确签名 vibrateShort({type})）----
    vibrate: function (type) {
      var mt = miniTool();
      if (!isAtLeast(this.buildVersion, VERSION_VIBRATE) || !mt || typeof mt.vibrateShort !== 'function') {
        return false; // 无能力静默降级（老客户端无感）
      }
      var t = type === 'medium' || type === 'heavy' ? type : 'light';
      try {
        var p = mt.vibrateShort({ type: t });
        if (p && p.catch) { p.catch(function () {}); }
        return true;
      } catch (e) { return false; }
    },

    // ---- 存图到相册（9.42+；dataURL 直传，大图建议先 writeTempFile）----
    saveImage: function (dataUrl) {
      var mt = miniTool();
      if (!mt || typeof mt.saveImageToPhotosAlbum !== 'function') {
        return Promise.reject({ errMsg: 'saveImageToPhotosAlbum:fail unsupported' });
      }
      return mt.saveImageToPhotosAlbum({ filePath: dataUrl });
    },

    // ---- base64 → 临时文件（媒体类 API 需要本地路径时）----
    writeTempFile: function (dataUrl) {
      var mt = miniTool();
      if (!mt || typeof mt.writeTempFile !== 'function') {
        return Promise.reject({ errMsg: 'writeTempFile:fail unsupported' });
      }
      return mt.writeTempFile({ data: dataUrl });
    },

    // ---- 发笔记（官方未标版本门槛，按方法存在性判断；唤起发布页，成功≠审核通过）----
    canPostNote: function () {
      var mt = miniTool();
      return !!(mt && typeof mt.postNote === 'function');
    },
    // opts: { title(<=20字), content(<=1000字), images: [dataUrl,...](1–18张，海报必传) }
    // 大 base64 先 writeTempFile 落盘再传（官方建议），落盘失败回退 dataUrl 直传
    postNote: function (opts) {
      var mt = miniTool();
      if (!mt || typeof mt.postNote !== 'function') {
        return Promise.reject({ errMsg: 'postNote:fail unsupported' });
      }
      var images = ((opts && opts.images) || []).slice(0, 18);
      if (!images.length) {
        return Promise.reject({ errMsg: 'postNote:fail no media' });
      }
      return Promise.all(images.map(function (d) {
        return bridge.writeTempFile(d).then(function (res) {
          return (res && res.filePath) || d;
        }).catch(function () { return d; });
      })).then(function (urls) {
        return mt.postNote({
          title: (opts && opts.title) || '',
          content: (opts && opts.content) || '',
          pageType: 'photo_publish',
          mediaInfo: { image_resources: urls.map(function (u) { return { url: u }; }) }
        });
      });
    },

    // ---- 评论区（9.49+；须由用户点击触发，容器会先关闭小工具再拉起评论区）----
    canComment: function () {
      var mt = miniTool();
      return !!(isAtLeast(this.buildVersion, VERSION_COMMENT) &&
        mt && typeof mt.interactionOpenApi === 'function');
    },
    // opts: { content, imageDataUrl }——图片必须是本地文件句柄（data: URI 不可用），
    // 落盘失败自动降级为纯文本评论
    openComment: function (opts) {
      var mt = miniTool();
      if (!this.canComment()) {
        return Promise.reject({ errMsg: 'interactionOpenApi:fail unsupported' });
      }
      var payload = { action: 'post_comment', content: (opts && opts.content) || '' };
      var prep = (opts && opts.imageDataUrl)
        ? this.writeTempFile(opts.imageDataUrl).then(function (res) {
            if (res && res.filePath) {
              payload.media_bean = [{ media_type: 'image', cover_image_url: res.filePath }];
            }
          }).catch(function () { /* 落盘失败：降级纯文本 */ })
        : Promise.resolve();
      return prep.then(function () {
        return mt.interactionOpenApi({ payload: payload, saveToAlbum: true });
      });
    },

    // ---- 关注作者（9.51+；关注对象=平台绑定的当前小工具作者，不能指定他人）----
    canFollow: function () {
      var mt = miniTool();
      return !!(isAtLeast(this.buildVersion, VERSION_FOLLOW) &&
        mt && typeof mt.followAuthor === 'function');
    },
    // resolve follow_status：-1 查询失败 / 0 未关注 / 1 已关注（含互关）/ 2 作者本人（官方：失败不走 reject）
    getFollowStatus: function () {
      var mt = miniTool();
      if (!(isAtLeast(this.buildVersion, VERSION_FOLLOW) &&
        mt && typeof mt.getFollowStatus === 'function')) {
        return Promise.resolve(-1);
      }
      return mt.getFollowStatus().then(function (res) {
        return (res && typeof res.follow_status === 'number') ? res.follow_status : -1;
      }).catch(function () { return -1; });
    },
    // 拉起关注确认流程；resolve({follow_status})；reject 透传 errCode：
    // 20002 用户关闭确认框 / 15404 关注引导日频控（10 次/日，自然日重置）/ 10003 确认流程进行中
    followAuthor: function () {
      var mt = miniTool();
      if (!this.canFollow()) {
        return Promise.reject({ errCode: -1, errMsg: 'followAuthor:fail unsupported' });
      }
      return mt.followAuthor();
    }
  };

  // ==================== 子系统：版本探测（私有）====================
  var version = {
    // 返回 Promise（同步路径 resolve；异步 getLaunchOptions 路径等结果——init 链依赖 buildVersion 先就位）
    detect: function (target) {
      var mt = miniTool();
      // ① 同步值（可能缺失，官方要求逐级判空）
      var sync = readBuildVersion(global.xhs && global.xhs.launchOptions);
      if (sync) {
        target.buildVersion = sync;
        return Promise.resolve();
      }
      // ② 异步 getLaunchOptions
      if (mt && typeof mt.getLaunchOptions === 'function') {
        return mt.getLaunchOptions()
          .then(function (lo) { target.buildVersion = readBuildVersion(lo); })
          .catch(function () { target.buildVersion = 0; });
      }
      target.buildVersion = 0;
      return Promise.resolve();
    }
  };

  // ==================== 子系统：Storage（私有；内存主存 + localStorage 永远双写 + 9.46+ 平台持久化）====================
  var prefix = 'mt_';
  var mem = {};
  var localBackup = null;

  function encode(v) { return JSON.stringify(v === undefined ? '' : v); }
  function decode(raw) {
    if (raw === null || raw === undefined) { return ''; }
    try { return JSON.parse(raw); } catch (e) { return raw; }
  }

  // 平台调用统一静默失败（fire-and-forget 持久化，读路径永远走内存）
  function callQuiet(method, args) {
    var mt = miniTool();
    try {
      var p = mt[method](args);
      if (p && p.catch) { p.catch(function () {}); }
    } catch (e) {}
  }

  function persist(key, value) {
    // localStorage 永远写一份（xhs 失效时的兜底数据源）
    try { global.localStorage.setItem(prefix + key, encode(value)); } catch (e) {}
    if (bridge.useXhsStorage) {
      callQuiet('setStorage', { key: key, data: encode(value) });
    }
  }

  function loadFromLocalStorage() {
    localBackup = {};
    try {
      for (var i = 0; i < global.localStorage.length; i++) {
        var fullKey = global.localStorage.key(i);
        if (fullKey && fullKey.indexOf(prefix) === 0) {
          var k = fullKey.slice(prefix.length);
          var raw = global.localStorage.getItem(fullKey);
          localBackup[k] = decode(raw);
          if (!(k in mem)) { mem[k] = localBackup[k]; }
        }
      }
    } catch (e) { /* 容器可能禁 localStorage，容忍 */ }
  }

  function storageLoad(target, storagePrefix) {
    prefix = storagePrefix;
    var mt = miniTool();
    target.useXhsStorage = !!(isAtLeast(target.buildVersion, VERSION_STORAGE) &&
      mt && typeof mt.setStorage === 'function');
    if (!target.useXhsStorage) {
      loadFromLocalStorage();
      return Promise.resolve();
    }
    // 预载：keys → 逐 key 读入内存（存档为 KB 级、key 数 < 50）
    return mt.getStorageInfo().then(function (info) {
      var keys = (info && info.keys) || [];
      return Promise.all(keys.map(function (k) {
        return mt.getStorage({ key: k }).then(function (res) {
          mem[k] = decode(res && res.data);
        }).catch(function () {});
      }));
    }).then(function () {
      // localStorage 旧数据迁移：内存没有的 key 补入并上行
      loadFromLocalStorage();
      var dirty = false;
      Object.keys(localBackup || {}).forEach(function (k) {
        if (!(k in mem)) { dirty = true; }
      });
      if (dirty) {
        Object.keys(mem).forEach(function (k) { persist(k, mem[k]); });
      }
    }).catch(function () {
      target.useXhsStorage = false;
      loadFromLocalStorage();
    });
  }

  // ==================== 子系统：窗口信息（私有，9.49+；HUD 避让原生按钮/状态栏）====================
  function loadWindowInfo(target) {
    var mt = miniTool();
    target.layout.windowWidth = global.innerWidth;
    target.layout.windowHeight = global.innerHeight;
    var fallbackTop = 44; // 无 API 时的保守状态栏高度
    if (isAtLeast(target.buildVersion, VERSION_WINDOW) && mt && typeof mt.getWindowInfo === 'function') {
      return mt.getWindowInfo().then(function (info) {
        if (!info) { target.layout.safeTop = fallbackTop; return; }
        target.layout.windowWidth = info.windowWidth || target.layout.windowWidth;
        target.layout.windowHeight = info.windowHeight || target.layout.windowHeight;
        var top = 0;
        if (info.safeArea && info.safeArea.top) { top = info.safeArea.top; }
        if (info.statusBarHeight && info.statusBarHeight > top) { top = info.statusBarHeight; }
        // 顶部原生按钮（back/me/share）若更低，取其 bottom+8
        var btns = info.menuButtons;
        if (btns) {
          ['back', 'me', 'share'].forEach(function (n) {
            var b = btns[n];
            if (b && b.bottom && b.bottom + 8 > top) { top = b.bottom + 8; }
          });
        }
        target.layout.safeTop = Math.ceil(top);
        if (info.safeArea && info.safeArea.bottom) {
          target.layout.safeBottom = Math.ceil(target.layout.windowHeight - info.safeArea.bottom);
        }
      }).catch(function () { target.layout.safeTop = fallbackTop; });
    }
    target.layout.safeTop = fallbackTop;
    return Promise.resolve();
  }

  // 双轨挂载：window 全局（老接入 / wx-shim 等）+ ESM default（新接入显式依赖）
  // （勿写 module.exports CJS 分支——esbuild 会据此判定为 CJS 模块，注入 module 对象导致本分支不执行）
  global.XhsBridge = bridge;
  return bridge;
})(typeof window !== 'undefined' ? window : this);

export default XhsBridge;

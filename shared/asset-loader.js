// asset-loader.js — 资产预加载管线：包内图片并行加载/进度/缓存 + 字体就绪协调（零依赖，ES2017/Chrome 61）
// 平台特性：容器纯离线，资产一律打包在包内（相对路径引用）；启动时预加载可消除玩法中
// 首次 drawImage 的卡顿（图片解码发生在 onload，不在渲染帧内）。
// 字体走 index.html 的 @font-face 声明（包内 woff2），本模块只负责 fonts.load 就绪等待。
// 挂载：window.AssetLoader / ESM export default（IIFE 内部变量经 return 传出）
var AssetLoader = (function (global) {
  'use strict';

  var cache = {};   // id → { img, w, h } | null（null = 加载失败占位）
  var loaded = false;

  function loadImage(item) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        cache[item.id] = { img: img, w: img.naturalWidth || img.width, h: img.naturalHeight || img.height };
        resolve(true);
      };
      img.onerror = function () {
        // 单张失败不阻塞整体（get 返回 null，游戏侧画占位）
        cache[item.id] = null;
        resolve(false);
      };
      img.src = item.src;
    });
  }

  var AssetLoaderInner = {
    /**
     * 预加载图片清单（并行）
     * @param {Array} manifest - [{ id, src }]，src 为包内相对路径（如 'assets/bg.png'）
     * @param {Function} [onProgress] - (done, total) 每完成一张回调（启动进度条用）
     * @returns {Promise<{ok:string[], fail:string[]}>}
     */
    load: function (manifest, onProgress) {
      loaded = true;
      var done = 0;
      var ok = [], fail = [];
      var jobs = (manifest || []).map(function (item) {
        return loadImage(item).then(function (success) {
          (success ? ok : fail).push(item.id);
          done++;
          if (onProgress) { onProgress(done, manifest.length); }
        });
      });
      return Promise.all(jobs).then(function () {
        return { ok: ok, fail: fail };
      });
    },

    /** 取图片记录 { img, w, h }；未加载/失败返回 null */
    get: function (id) {
      return cache[id] || null;
    },

    /** 便捷绘制：失败返回 false（调用方可画占位），支持等比/指定尺寸/源裁剪 */
    draw: function (ctx, id, x, y, w, h) {
      var rec = cache[id];
      if (!rec) return false;
      if (w !== undefined && h !== undefined) {
        ctx.drawImage(rec.img, x, y, w, h);
      } else {
        ctx.drawImage(rec.img, x, y);
      }
      return true;
    },

    /** 资产原始尺寸（DPR 大图按逻辑尺寸绘制的场景用） */
    size: function (id) {
      var rec = cache[id];
      return rec ? { w: rec.w, h: rec.h } : { w: 0, h: 0 };
    },

    /** 已调用过 load（防游戏忘记预加载就 draw 全空） */
    isLoaded: function () { return loaded; },

    /**
     * 等待 @font-face 字体就绪（CSS 在 index.html 声明；Chrome 61 支持 document.fonts）
     * @param {Array} families - 字体家族名列表，如 ['DIN Alternate', 'KaiTi']
     * @param {number} [timeoutMs=2000] - 超时放行（降级系统字体，不阻塞启动）
     * @returns {Promise} 永不 reject
     */
    loadFonts: function (families, timeoutMs) {
      var fonts = global.document && global.document.fonts;
      if (!fonts || typeof fonts.load !== 'function') return Promise.resolve();
      var ms = timeoutMs || 2000;
      var giveUp = new Promise(function (resolve) { setTimeout(resolve, ms); });
      var waits = families.map(function (f) {
        try { return fonts.load('16px "' + f + '"'); } catch (e) { return Promise.resolve(); }
      });
      var all = Promise.all(waits).catch(function () {});
      return Promise.race([all, giveUp]);
    }
  };

  global.AssetLoader = AssetLoaderInner;
  return AssetLoaderInner;
})(typeof window !== 'undefined' ? window : this);

export default AssetLoader;

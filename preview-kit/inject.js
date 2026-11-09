// inject.js — window.xhs mock 注入器（仅本地预览用，不进 zip）
// 在 game-dev.html 中位于 js/bundle.js 之前执行，让 XhsBridge.init 走 9.49+ 线上同款路径：
//   xhs-bridge 版本探测同步读 xhs.launchOptions.miniToolEnv.buildVersion（7 位格式，floor(bv/1000)>=9490），
//   再经 miniTool.getWindowInfo 取安全区/窗口真值 —— 本地不再走 fallback 44 降级分支。
// 档位来源：壳（preview/dev.html）写入 localStorage.__dev_profile；直接打开 game-dev.html 时用第一档。
(function () {
  'use strict';

  var KEY = '__dev_profile';
  var p = null;
  try { p = JSON.parse(window.localStorage.getItem(KEY) || 'null'); } catch (e) { p = null; }
  // 裸开 game-dev.html（无壳、无已存档位）：mock 档位无法与真实视口对齐（canvas 用 innerWidth、
  // 安全区用档位值），会产生误导性的错配布局——跳过 mock 走线上降级路径，与直接开 index.html 等效
  if (!p && window.top === window.self) {
    console.warn('[dev-inject] 裸页无档位：跳过 mock（走降级路径）。请经 preview/dev.html 壳打开，或先在壳中选一次档位');
    return;
  }
  if (!p || !p.w) p = (window.__DEV_PROFILES && window.__DEV_PROFILES[0]) || null;
  if (!p) { console.warn('[dev-inject] 无档位可用（profiles.js 未加载？）'); return; }

  // 1) DPR 覆盖：GameEngine 构造时读一次 devicePixelRatio 决定 canvas 物理分辨率
  try {
    Object.defineProperty(window, 'devicePixelRatio', { value: p.dpr, configurable: true });
  } catch (e) { /* 覆盖失败则沿用系统 DPR，仅清晰度略异 */ }

  // 2) 平台 mock：只挂本方案范围（窗口/安全区）；Storage/分享等一律不挂——
  //    xhs-bridge 全判空自动降级到 localStorage，与线上低版本客户端行为一致
  window.xhs = {
    launchOptions: { miniToolEnv: { buildVersion: 9510000 } },
    miniTool: {
      getWindowInfo: function () {
        return Promise.resolve({
          windowWidth: p.w,
          windowHeight: p.h,
          statusBarHeight: p.statusBar,
          safeArea: {
            left: 0, top: p.statusBar, right: p.w, bottom: p.h - p.safeBottom,
            width: p.w, height: p.h - p.statusBar - p.safeBottom
          },
          menuButtons: {
            back:  { bottom: p.menuBottom },
            me:    { bottom: p.menuBottom },
            share: { bottom: p.menuBottom }
          }
        });
      }
    }
  };

  // 3) 安全区可视化：红条标出被原生 UI 遮挡的区域（不挡操作）
  function drawOverlay() {
    if (!document.body) return;
    function bar(cls, top, height, label) {
      var el = document.createElement('div');
      el.setAttribute('style',
        'position:fixed;left:0;width:100%;pointer-events:none;z-index:2147483647;' +
        'background:rgba(255,0,0,.28);border:1px dashed rgba(255,0,0,.75);' +
        'box-sizing:border-box;color:#fff;font:10px sans-serif;display:flex;' +
        'align-items:center;justify-content:center;overflow:hidden;' + cls);
      el.style.top = top + 'px';
      el.style.height = Math.max(height, 0) + 'px';
      el.textContent = label;
      document.body.appendChild(el);
    }
    var safeTop = Math.max(p.statusBar, p.menuBottom + 8); // xhs-bridge 的避让取法
    bar('', 0, safeTop, '状态栏+原生按钮 ' + safeTop + 'px');
    bar('', p.h - p.safeBottom, p.safeBottom, p.safeBottom > 0 ? 'home 条 ' + p.safeBottom + 'px' : '');
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', drawOverlay);
  } else {
    drawOverlay();
  }

  // 4) 控制台探针：验证 V1/V2 用
  //    XhsBridge.layout.safeTop 应 = max(statusBar, menuBottom+8)，且 ≠ 44 fallback
  //    wx.getSystemInfoSync().windowWidth 应 = p.w；devicePixelRatio 应 = p.dpr
  window.__DEV_INFO = {
    profile: p,
    expected: { safeTop: Math.max(p.statusBar, p.menuBottom + 8), safeBottom: p.safeBottom },
    actual: function () {
      return {
        viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
        layout: window.XhsBridge ? JSON.parse(JSON.stringify(window.XhsBridge.layout)) : null,
        sysInfo: (typeof wx !== 'undefined' && wx.getSystemInfoSync) ? wx.getSystemInfoSync() : null
      };
    }
  };
  console.log('[dev-inject] 档位 =', p.name || p.id, p.w + 'x' + p.h + '@' + p.dpr);
})();

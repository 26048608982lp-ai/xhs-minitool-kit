// profiles.js — 预览档位库（仅本地预览用，不进 zip——pack.py 白名单天然排除）
// 每档：w/h 视口 CSS 像素，dpr 设备像素比，statusBar 状态栏高，menuBottom 原生按钮区底边，
//       safeBottom 底部 home 条/手势条高。
// ⚠️ menuBottom 与 Android 档 statusBar/视口为保守估计值，非实测——
//    真机抓到 getWindowInfo 真值后回填本表（壳也支持"自定义"档随时校准）。
window.__DEV_PROFILES = [
  { id: 'android-small',   name: 'Android 小屏',  w: 320, h: 569, dpr: 2,   statusBar: 24, menuBottom: 68, safeBottom: 0  },
  { id: 'iphone-classic',  name: 'iPhone 8',      w: 375, h: 667, dpr: 2,   statusBar: 20, menuBottom: 64, safeBottom: 0  },
  { id: 'iphone-x',        name: 'iPhone X',      w: 375, h: 812, dpr: 3,   statusBar: 44, menuBottom: 88, safeBottom: 34 },
  { id: 'iphone-xr',       name: 'iPhone XR',     w: 414, h: 896, dpr: 2,   statusBar: 48, menuBottom: 92, safeBottom: 34 },
  { id: 'android-main',    name: 'Android 主流',  w: 393, h: 851, dpr: 3,   statusBar: 36, menuBottom: 80, safeBottom: 16 },
  { id: 'android-tall',    name: 'Android 长屏',  w: 360, h: 780, dpr: 3,   statusBar: 33, menuBottom: 77, safeBottom: 16 }
];

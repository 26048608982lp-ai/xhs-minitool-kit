// share-kit.js — 社交裂变套件：战绩海报构建器 + 分享动作编排（零依赖，ES2017/Chrome 61）
// 从连环箭/年货大掌柜两份实现提炼；分享面板 UI 不在本层（各游戏按自身 UI 范式自绘）。
// 挂载：window.ShareKit / ESM export default——对 XhsBridge 懒查找（编排方法调用时须已存在）。
//
// 海报 = 固定布局槽位（bg→frame→题头→主数值+印章→星级→副信息→底部），主题 token 只管
// 颜色/字体/文案；形状级差异（弧形题头 vs 金饰带）用 bgPaint/headerPaint 整槽覆盖。
// 布局几何参考连环箭版实测参数（750×1000，3:4 竖版，像素验收通过）。
// 注意：IIFE 内部变量不可直接 export（esbuild 作用域提升会改名），经 return 传出。
var ShareKit = (function (global) {
  'use strict';

  // 懒查找：仅编排方法需要平台层；buildPoster 纯 canvas 无平台依赖
  function bridge() {
    var b = global.XhsBridge;
    if (!b) {
      throw new Error('[ShareKit] XhsBridge 未就绪：share-kit 须在 xhs-bridge.js 之后引入');
    }
    return b;
  }

  var POSTER_W = 750;
  var POSTER_H = 1000;

  // ---- 基础矢量（与游戏侧 Painter 同几何，零依赖内置）----
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function starPath(ctx, cx, cy, outerR) {
    var innerR = outerR * 0.44;
    ctx.beginPath();
    for (var i = 0; i < 10; i++) {
      var r = (i % 2 === 0) ? outerR : innerR;
      var a = -Math.PI / 2 + i * Math.PI / 5;
      var px = cx + r * Math.cos(a);
      var py = cy + r * Math.sin(a);
      if (i === 0) { ctx.moveTo(px, py); } else { ctx.lineTo(px, py); }
    }
    ctx.closePath();
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function text(ctx, str, x, y, font, color) {
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.fillText(str, x, y);
  }

  function clip(str, max) {
    return str.length > max ? str.slice(0, max) + '…' : str;
  }

  function todayText() {
    var now = new Date();
    return now.getFullYear() + '.' + pad2(now.getMonth() + 1) + '.' + pad2(now.getDate());
  }

  // ---- 主题默认值（纸白水墨风；红金喜庆风见 _shared/README 示例）----
  function defaultTheme() {
    return {
      bg: ['#FDFCF6', '#F2EDE0'],          // 纵向渐变两端；或 bgPaint(ctx, W, H) 覆盖
      frame: { color: 'rgba(46, 74, 75, 0.22)', width: 3, inset: 26, radius: 24 }, // null 关闭
      header: {
        color: '#2E4A4B',                   // 题头块色
        lineColor: 'rgba(107, 158, 137, 0.9)', // 题头底缘细线
        height: 236, arcDepth: 64,          // 底缘弧形下垂深度
        title: '游戏名', titleColor: '#FDFCF6', titleFont: 'bold 96px "KaiTi", "STKaiti", serif',
        subtitleColor: 'rgba(253, 252, 246, 0.85)', subtitleFont: '28px sans-serif'
      },                                    // 或 headerPaint(ctx, W, H, t, record) 覆盖整槽
      score: {
        label: '本局得分', labelColor: '#6E6A5E', labelFont: '28px sans-serif',
        numColor: '#2E4A4B', numFont: 'bold 168px "DIN Alternate", "Arial", sans-serif'
      },
      seal: { win: ['大', '捷'], lose: ['再', '战'], color: '#B54248', font: 'bold 34px "KaiTi", "STKaiti", serif' }, // null 关闭
      star: {
        filled: '#D4A853', empty: 'rgba(176, 137, 104, 0.12)',
        stroke: 'rgba(176, 137, 104, 0.7)', radius: 34, gap: 92, y: 622
      },                                    // null 关闭（无星级玩法）
      subFont: '32px sans-serif', subColor: '#6E6A5E',
      slogan: '你能超过我吗？', sloganColor: '#B54248', sloganFont: 'bold 40px "KaiTi", "STKaiti", serif',
      brand: '小红书小工具', brandColor: '#6E6A5E', brandFont: '24px sans-serif'
    };
  }

  var ShareKitInner = {
    // ==================== 海报构建 ====================

    /**
     * 生成战绩海报
     * @param {Object} record - { isWin, score, stars(0-3), subtitle(题头副标，缺省用今日日期), subText(星级下副信息行) }
     * @param {Object} [themeOverride] - 深合并到默认主题；bgPaint/headerPaint 为整槽覆盖函数
     * @returns {string} PNG dataUrl
     */
    buildPoster: function (record, themeOverride) {
      var t = defaultTheme();
      var over = themeOverride || {};
      Object.keys(over).forEach(function (k) {
        if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) &&
          typeof over[k].nodeType !== 'number' && typeof t[k] === 'object' && t[k] !== null) {
          Object.keys(over[k]).forEach(function (k2) { t[k][k2] = over[k][k2]; });
        } else {
          t[k] = over[k];
        }
      });
      var r = record || {};

      var canvas = document.createElement('canvas');
      canvas.width = POSTER_W;
      canvas.height = POSTER_H;
      var ctx = canvas.getContext('2d');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      // ① 背景
      if (typeof t.bgPaint === 'function') {
        t.bgPaint(ctx, POSTER_W, POSTER_H);
      } else {
        var bg = ctx.createLinearGradient(0, 0, 0, POSTER_H);
        bg.addColorStop(0, t.bg[0]);
        bg.addColorStop(1, t.bg[1]);
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, POSTER_W, POSTER_H);
      }

      // ② 细边框
      if (t.frame) {
        ctx.strokeStyle = t.frame.color;
        ctx.lineWidth = t.frame.width;
        roundRect(ctx, t.frame.inset, t.frame.inset,
          POSTER_W - t.frame.inset * 2, POSTER_H - t.frame.inset * 2, t.frame.radius);
        ctx.stroke();
      }

      // ③ 题头
      if (typeof t.headerPaint === 'function') {
        t.headerPaint(ctx, POSTER_W, POSTER_H, t, r);
      } else {
        var h = t.header;
        ctx.fillStyle = h.color;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(POSTER_W, 0);
        ctx.lineTo(POSTER_W, h.height);
        ctx.quadraticCurveTo(POSTER_W / 2, h.height + h.arcDepth, 0, h.height);
        ctx.closePath();
        ctx.fill();
        if (h.lineColor) {
          ctx.strokeStyle = h.lineColor;
          ctx.lineWidth = 4;
          ctx.beginPath();
          ctx.moveTo(0, h.height);
          ctx.quadraticCurveTo(POSTER_W / 2, h.height + h.arcDepth, POSTER_W, h.height);
          ctx.stroke();
        }
        text(ctx, h.title, POSTER_W / 2, 122, h.titleFont, h.titleColor);
        var subtitle = r.subtitle || (function () {
          var now = new Date();
          return (now.getMonth() + 1) + '月' + now.getDate() + '日';
        })();
        text(ctx, clip(subtitle, 16), POSTER_W / 2, 208, h.subtitleFont, h.subtitleColor);
      }

      // ④ 主数值 + 印章
      text(ctx, t.score.label, POSTER_W / 2, 372, t.score.labelFont, t.score.labelColor);
      text(ctx, String(r.score || 0), POSTER_W / 2 - 40, 486, t.score.numFont, t.score.numColor);
      if (t.seal) {
        ctx.save();
        ctx.translate(POSTER_W - 150, 470);
        ctx.rotate(0.10);
        ctx.fillStyle = t.seal.color;
        roundRect(ctx, -48, -48, 96, 96, 14);
        ctx.fill();
        ctx.fillStyle = '#FDFCF6';
        ctx.font = t.seal.font;
        var seal = r.isWin ? t.seal.win : t.seal.lose;
        ctx.fillText(seal[0], 0, -18);
        ctx.fillText(seal[1], 0, 18);
        ctx.restore();
      }

      // ⑤ 星级（3 槽）
      if (t.star) {
        var stars = Math.max(0, Math.min(3, r.stars || 0));
        for (var i = 0; i < 3; i++) {
          var sx = POSTER_W / 2 + (i - 1) * t.star.gap;
          starPath(ctx, sx, t.star.y, t.star.radius);
          ctx.fillStyle = i < stars ? t.star.filled : t.star.empty;
          ctx.fill();
          ctx.strokeStyle = t.star.stroke;
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }

      // ⑥ 副信息行
      if (r.subText) {
        text(ctx, r.subText, POSTER_W / 2, (t.star ? t.star.y : 600) + 76, t.subFont, t.subColor);
      }

      // ⑦ 底部：渐隐分隔线 + 日期 + 口号 + 落款
      var divider = ctx.createLinearGradient(80, 0, POSTER_W - 80, 0);
      divider.addColorStop(0, 'rgba(176,137,104,0)');
      divider.addColorStop(0.2, 'rgba(176,137,104,0.4)');
      divider.addColorStop(0.8, 'rgba(176,137,104,0.4)');
      divider.addColorStop(1, 'rgba(176,137,104,0)');
      ctx.strokeStyle = divider;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(80, 770);
      ctx.lineTo(POSTER_W - 80, 770);
      ctx.stroke();
      text(ctx, todayText(), POSTER_W / 2, 826, '26px sans-serif', '#B0A99A');
      text(ctx, t.slogan, POSTER_W / 2, 886, t.sloganFont, t.sloganColor);
      text(ctx, t.brand, POSTER_W / 2, 942, t.brandFont, t.brandColor);

      return canvas.toDataURL('image/png');
    },

    // ==================== 分享动作编排（依赖 XhsBridge；notify = function(msg) 可选）====================

    /** 存海报到相册（9.42+） */
    savePoster: function (dataUrl, notify) {
      return bridge().saveImage(dataUrl).then(function () {
        if (notify) { notify('海报已存相册，快去发笔记吧'); }
      }).catch(function () {
        if (notify) { notify('保存失败'); }
      });
    },

    /** 发笔记（唤起发布页带图预填；title 自动截 20 字） */
    postNote: function (opts) {
      var b = bridge();
      if (!b.canPostNote()) {
        if (opts.notify) { opts.notify('当前版本暂不支持发笔记'); }
        return Promise.resolve(false);
      }
      var title = opts.title || '';
      if (title.length > 20) { title = title.slice(0, 20); }
      return b.postNote({ title: title, content: opts.content || '', images: [opts.dataUrl] })
        .then(function () { return true; })
        .catch(function () {
          if (opts.notify) { opts.notify('发笔记失败，请重试'); }
          return false;
        });
    },

    /** 评论 PK（9.49+；容器会先关闭小工具再拉起评论区，失败静默） */
    openComment: function (opts) {
      var b = bridge();
      if (!b.canComment()) {
        if (opts.notify) { opts.notify('当前版本暂不支持评论互动'); }
        return Promise.resolve(false);
      }
      return b.openComment({ content: opts.content || '', imageDataUrl: opts.dataUrl })
        .then(function () { return true; })
        .catch(function () { return false; });
    },

    /** 关注作者（9.51+；已关注不动作；15404 日频控提示，20002/10003 静默） */
    followAuthor: function (opts) {
      var b = bridge();
      opts = opts || {};
      if (!b.canFollow()) { return Promise.resolve(-1); }
      return b.followAuthor().then(function (res) {
        return (res && typeof res.follow_status === 'number') ? res.follow_status : 1;
      }).catch(function (err) {
        if (err && err.errCode === 15404 && opts.notify) {
          opts.notify('今日关注引导次数已达上限');
        }
        return -1;
      });
    },

    /** 关注状态：-1 失败/0 未关注/1 已关注/2 作者本人 */
    getFollowStatus: function () {
      return bridge().getFollowStatus();
    },

    canFollow: function () { return bridge().canFollow(); },
    canComment: function () { return bridge().canComment(); },
    canPostNote: function () { return bridge().canPostNote(); }
  };

  global.ShareKit = ShareKitInner;
  return ShareKitInner;
})(typeof window !== 'undefined' ? window : this);

export default ShareKit;

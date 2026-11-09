// shell.js — 预览壳 v2 交互逻辑真源（preview-kit 单份参数化；业务仓经 /_kit/ 映射直读，无副本）
// 参数化：URL query ?title=<品牌名>&game=<id>（dev.mjs 打开浏览器时注入；缺省 title=预览台 game=app）
// 桥协议（与业务仓 preview/tuning.js 配对，msg.src 区分端点；工具类不接 tuning.js → 面板自然无回执）：
//   壳 → iframe : { src:'dev-shell', type:'tuning.set',  payload:{k,v} }  改滑杆参数（即时生效，部分需重开）
//                 { src:'dev-shell', type:'tuning.diff', payload:'HARD' } 切难度（iframe 侧 persist 后自 reload）
//                 { src:'dev-shell', type:'tuning.restart' }            重开当日
//                 { src:'dev-shell', type:'state.get' }                 拉取当前调参态
//   iframe → 壳 : { src:'dev-tuning', type:'state.info', payload:{difficulty,targetRate,spawnRate} }
var SS_KEY = '__dev_profile';
var QS = new URLSearchParams(location.search);
var GAME = QS.get('game') || 'app';
var TITLE = QS.get('title') || '预览台';

(function () {
  'use strict';
  document.title = TITLE + ' · 预览台';
  var brand = document.querySelector('header .brand');
  if (brand) brand.textContent = TITLE + ' · 预览台';

  var profiles = window.__DEV_PROFILES || [];
  var frame = document.getElementById('frame');
  var holder = document.getElementById('holder');
  var phone = frame.parentElement;
  var statusbar = document.getElementById('statusbar');
  var zoomLabel = document.getElementById('zoom-label');
  var current = null;
  var frameW = 375, frameH = 812, curScale = 1;
  try { current = JSON.parse(localStorage.getItem(SS_KEY) || 'null'); } catch (e) {}

  // ── 档位 ──
  function applyProfile(p, label) {
    current = p;
    localStorage.setItem(SS_KEY, JSON.stringify(p));
    frameW = p.w; frameH = p.h;
    frame.style.width = p.w + 'px';
    frame.style.height = p.h + 'px';
    fit();
    frame.contentWindow.location.reload();
  }

  function safeTopOf(p) { return Math.max(p.statusBar, p.menuBottom + 8); }
  function statusText(name) {
    return (name || current.name || '自定义') + ' — ' + frameW + '×' + frameH + '@' + current.dpr +
      ' → safeTop ' + safeTopOf(current) + ' / safeBottom ' + current.safeBottom +
      '（xhs-bridge 取 max(状态栏, 按钮底+8)） · 缩放 ' + Math.round(curScale * 100) + '%';
  }

  // ── scale 一屏适配：holder 提供缩放后占位并居中，phone transform 缩放（事件坐标浏览器自动映射） ──
  function fit() {
    var wrap = document.getElementById('frame-wrap');
    var availW = wrap.clientWidth - 32, availH = wrap.clientHeight - 32;
    var boxW = frameW + 20, boxH = frameH + 20; // phone padding 10×2
    curScale = Math.min(availW / boxW, availH / boxH, 1);
    phone.style.transform = 'scale(' + curScale + ')';
    holder.style.width = boxW * curScale + 'px';
    holder.style.height = boxH * curScale + 'px';
    zoomLabel.textContent = Math.round(curScale * 100) + '%';
    if (current) statusbar.textContent = statusText();
  }
  window.addEventListener('resize', fit);

  function renderButtons() {
    var box = document.getElementById('profiles');
    box.innerHTML = '';
    profiles.forEach(function (p) {
      var b = document.createElement('button');
      b.textContent = p.name;
      if (current && current.id === p.id) b.className = 'active';
      b.addEventListener('click', function () { applyProfile(p, null); });
      box.appendChild(b);
    });
  }

  // ── 自定义档 ──
  document.getElementById('btn-custom').addEventListener('click', function () {
    var c = document.getElementById('custom');
    c.classList.toggle('open');
    var base = current || profiles[0];
    ['w', 'h', 'dpr', 'statusBar', 'menuBottom', 'safeBottom'].forEach(function (k) {
      document.getElementById('c-' + k).value = base[k];
    });
  });
  document.getElementById('c-apply').addEventListener('click', function () {
    var num = function (id, dflt) { var v = Number(document.getElementById(id).value); return v > 0 ? v : dflt; };
    applyProfile({
      id: 'custom', name: '自定义',
      w: num('c-w', 375), h: num('c-h', 812), dpr: num('c-dpr', 2),
      statusBar: num('c-statusBar', 44), menuBottom: num('c-menuBottom', 88), safeBottom: num('c-safeBottom', 0)
    }, '自定义档');
  });

  // ── 工具按钮 ──
  document.getElementById('btn-reload').addEventListener('click', function () {
    frame.contentWindow.location.reload();
  });
  document.getElementById('btn-shot').addEventListener('click', shot);

  // 截图分形态（v3 preview-kit）：
  // ① canvas 形态（游戏类）：同 origin 取 iframe 内最大 canvas 原始分辨率导出（2D 无 taint；
  //    WebGL 未开 preserveDrawingBuffer 会黑帧——2D 游戏不适用此坑）
  // ② DOM 形态（工具类，无 canvas）：懒加载 vendor/html2canvas.min.js 进 iframe 文档，
  //    在 iframe 上下文对 body 截图（scale=档位 dpr 保持清晰度）
  function shot() {
    var doc;
    try { doc = frame.contentDocument; } catch (e) { doc = null; }
    if (!doc || !doc.body) { statusbar.textContent = '截图失败：游戏文档未就绪'; return; }
    var canvases = Array.prototype.slice.call(doc.querySelectorAll('canvas'));
    if (canvases.length) {
      var src = canvases.reduce(function (a, b) { return (a.width * a.height >= b.width * b.height) ? a : b; });
      var out = document.createElement('canvas');
      out.width = src.width; out.height = src.height;
      out.getContext('2d').drawImage(src, 0, 0);
      out.toBlob(function (blob) { saveBlob(blob, src.width + '×' + src.height); }, 'image/png');
    } else {
      statusbar.textContent = '截图…（DOM 形态 html2canvas）';
      loadIntoFrame(doc, '/_kit/preview-kit/vendor/html2canvas.min.js', function () {
        var w = doc.defaultView;
        if (!w.html2canvas) { statusbar.textContent = '截图失败：html2canvas 加载失败'; return; }
        w.html2canvas(doc.body, { scale: (current && current.dpr) || 2, backgroundColor: null }).then(function (cv) {
          cv.toBlob(function (blob) { saveBlob(blob, cv.width + '×' + cv.height); }, 'image/png');
        }).catch(function (e) { statusbar.textContent = '截图失败：' + e.message; });
      }, function () { statusbar.textContent = '截图失败：html2canvas 加载失败'; });
    }
  }
  function loadIntoFrame(doc, url, onload, onerr) {
    var s = doc.createElement('script');
    s.src = url;
    s.onload = onload;
    s.onerror = onerr;
    doc.head.appendChild(s);
  }
  function saveBlob(blob, sizeText) {
    var a = document.createElement('a');
    a.download = GAME + '-shot-' + (current && current.id || 'custom') + '-' + Date.now() + '.png';
    a.href = URL.createObjectURL(blob);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
    statusbar.textContent = '已截图 → ' + a.download + '（' + sizeText + '）';
  }

  // ── postMessage 桥：发命令 + 收回执 ──
  function send(type, payload) {
    frame.contentWindow.postMessage({ src: 'dev-shell', type: type, payload: payload }, '*');
  }
  window.addEventListener('message', function (e) {
    var m = e.data;
    if (!m || m.src !== 'dev-tuning') return;
    if (m.type === 'state.info') syncTuningPanel(m.payload);
  });
  frame.addEventListener('load', function () {
    // iframe 每次重载（切档/切难度/重开）后重新拉取调参态回填面板
    setTimeout(function () { send('state.get'); if (current) statusbar.textContent = statusText(); }, 400);
    send('state.get');
  });

  // ── 编辑区 Tab 切换 ──
  var tabs = document.querySelectorAll('#tabs button[data-tab]');
  tabs.forEach(function (b) {
    b.addEventListener('click', function () {
      tabs.forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active');
      document.querySelectorAll('.panel').forEach(function (p) { p.hidden = true; });
      document.getElementById('panel-' + b.getAttribute('data-tab')).hidden = false;
      if (b.getAttribute('data-tab') === 'config') loadConfig();
    });
  });

  // ── 调参面板（工具类不接 tuning.js：state.get 无回执 → 滑杆保持默认值，操作无副作用） ──
  var diffBox = document.getElementById('tun-diff');
  ['EASY', 'NORMAL', 'HARD'].forEach(function (d) {
    var b = document.createElement('button');
    b.textContent = d;
    b.setAttribute('data-diff', d);
    b.addEventListener('click', function () { send('tuning.diff', d); });
    diffBox.appendChild(b);
  });
  function bindRange(rid, oid, key) {
    var r = document.getElementById(rid), o = document.getElementById(oid);
    r.addEventListener('input', function () {
      var v = parseFloat(r.value);
      o.textContent = v.toFixed(2);
      send('tuning.set', { k: key, v: v });
    });
  }
  bindRange('r-target', 'o-target', 'targetRate');
  bindRange('r-spawn', 'o-spawn', 'spawnRate');
  document.getElementById('tun-restart').addEventListener('click', function () { send('tuning.restart'); });

  function syncTuningPanel(p) {
    if (!p) return;
    diffBox.querySelectorAll('[data-diff]').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-diff') === p.difficulty);
    });
    if (p.targetRate != null) {
      document.getElementById('r-target').value = p.targetRate;
      document.getElementById('o-target').textContent = Number(p.targetRate).toFixed(2);
    }
    if (p.spawnRate != null) {
      document.getElementById('r-spawn').value = p.spawnRate;
      document.getElementById('o-spawn').textContent = Number(p.spawnRate).toFixed(2);
    }
  }

  // ── 数值面板：① 关键参数摘要卡（真源=config/schema.json 的 x-summary 白名单，借鉴 aigamedesign SUMMARY_FIELDS 模式：
  //     dot path 深取值（数字段=数组索引）+ 人性化中文 label + format 渲染 + 值缺失自动隐藏条目）
  //              ② 完整配置树（全量 flatten，折叠降级+搜索） ──
  var CFG_FILES = ['cosmetics', 'customers', 'economy', 'game', 'products', 'progression'];
  var DOMAIN_META = { // 域显示名与图标（仅展示层；白名单在游戏侧 schema）
    economy: ['💰', '经济'], progression: ['📈', '节奏'], customers: ['👥', '客群'],
    products: ['🧾', '商品'], game: ['🏷️', '品牌'], cosmetics: ['🎨', '装扮']
  };
  var cfgRows = null; // [{file, path, value}] 全量
  var cfgJson = null; // {file: json} 摘要取值用
  function flatten(obj, prefix, file, out) {
    Object.keys(obj).forEach(function (k) {
      var p = prefix ? prefix + '.' + k : k;
      var v = obj[k];
      if (v && typeof v === 'object') flatten(v, p, file, out);
      else out.push({ file: file, path: p, value: v });
    });
  }
  function getVal(obj, path) { // "EASY_GOALS.0.targetRevenue" —— 数字段按数组索引
    return path.split('.').reduce(function (acc, key) {
      return acc == null ? undefined : acc[key];
    }, obj);
  }
  function fmtVal(v, format) {
    if (v == null) return '';
    switch (format) {
      case 'percent': return Math.round(v * 100) + '%';
      case 'multiplier': return v + 'x';
      case 'currency': return '￥' + v;
      case 'seconds': return v + 's';
      default: return String(v);
    }
  }
  function renderSummary(summary) {
    var box = document.getElementById('cfg-summary');
    if (!summary || !Object.keys(summary).length) {
      box.innerHTML = '<div class="cfg-empty">本工具未声明关键参数（config/schema.json 无 x-summary）</div>';
      return;
    }
    var html = '';
    Object.keys(summary).forEach(function (domain) {
      var meta = DOMAIN_META[domain] || ['📄', domain];
      var root = cfgJson[domain]; // domain 键=域文件名，path 相对该文件根
      var entries = summary[domain].map(function (f) {
        var raw = root ? getVal(root, f.path) : undefined;
        if (raw == null) return null; // 值缺失自动隐藏条目（不显示空行）
        return '<span class="sum-entry">' + esc(f.label) + ' <b>' + esc(fmtVal(raw, f.format)) + '</b></span>';
      }).filter(Boolean);
      if (!entries.length) return;
      html += '<div class="sum-row"><span class="sum-domain">' + meta[0] + ' ' + meta[1] + '</span><span class="sum-entries">' + entries.join('') + '</span></div>';
    });
    box.innerHTML = html || '<div class="cfg-empty">关键参数条目均缺失</div>';
  }
  function loadConfig() {
    if (cfgRows) { renderConfig(document.getElementById('cfg-search').value); return; }
    var schemaPromise = fetch('/config/schema.json').then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
    Promise.all([schemaPromise].concat(CFG_FILES.map(function (f) {
      return fetch('/config/' + f + '.json').then(function (r) {
        if (!r.ok) throw new Error(f + '.json ' + r.status);
        return r.json();
      }).then(function (j) {
        var out = [];
        flatten(j, '', f, out);
        return { j: j, rows: out };
      });
    }))).then(function (results) {
      var schema = results[0];
      var lists = results.slice(1);
      cfgJson = {};
      cfgRows = [];
      lists.forEach(function (r, i) { cfgJson[CFG_FILES[i]] = r.j; cfgRows = cfgRows.concat(r.rows); });
      renderSummary(schema && schema['x-summary']);
      renderConfig(document.getElementById('cfg-search').value);
    }).catch(function (e) {
      document.getElementById('cfg-summary').innerHTML = '';
      document.getElementById('cfg-list').innerHTML =
        '<div class="cfg-empty">本工具无 config/ 数值真源（' + e.message + '）——可接入自定义关键参数面板（schema x-summary 或独立声明）</div>';
      document.getElementById('cfg-full').style.display = 'none';
    });
  }
  function renderConfig(q) {
    var box = document.getElementById('cfg-list');
    var kw = (q || '').toLowerCase();
    var full = document.getElementById('cfg-full');
    if (kw) full.open = true; // 搜索时自动展开全量树
    var rows = kw ? cfgRows.filter(function (r) {
      return r.path.toLowerCase().indexOf(kw) >= 0 || String(r.value).toLowerCase().indexOf(kw) >= 0;
    }) : cfgRows;
    if (!rows.length) { box.innerHTML = '<div class="cfg-empty">无匹配</div>'; return; }
    var html = '';
    CFG_FILES.forEach(function (f) {
      var list = rows.filter(function (r) { return r.file === f; });
      if (!list.length) return;
      html += '<details' + (kw ? ' open' : '') + '><summary><b>' + f + '.json</b> <span class="cnt">' + list.length + ' 项</span></summary><table class="cfg-table">';
      list.forEach(function (r) { html += '<tr><td class="p">' + esc(r.path) + '</td><td class="v">' + esc(String(r.value)) + '</td></tr>'; });
      html += '</table></details>';
    });
    box.innerHTML = html;
  }
  function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
  document.getElementById('cfg-search').addEventListener('input', function () {
    if (cfgRows) renderConfig(this.value);
  });

  // ── 初始档位（无已存档用第三档 iPhone X，最接近 verify 基准） ──
  var init = current || profiles[2] || profiles[0];
  if (!current) { current = init; localStorage.setItem(SS_KEY, JSON.stringify(init)); } // 同步 current：statusText/renderButtons 依赖
  frameW = init.w; frameH = init.h;
  frame.style.width = init.w + 'px';
  frame.style.height = init.h + 'px';
  renderButtons();
  fit();
  statusbar.textContent = statusText(init.name || init.id);
})();

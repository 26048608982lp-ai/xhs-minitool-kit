// wxml-runtime.js — WXML 运行时渲染引擎（小程序→小工具转化线核心，Chrome 61 / ES2017）
// 职责：{{}} 表达式求值（无 eval）· wx:if/wx:for/插值渲染 · 事件委托（bind/catch→data-b-/data-c-）
//       · Component 组件实例化（properties/observers/lifetimes/triggerEvent/selectComponent）
// 配套：_tools/wxml2html.mjs（构建期把 WXML 转成本引擎可吃的 HTML，{{}} 原样保留）
// 双轨导出：window.WxmlRuntime + ESM default（业务代码禁直连本模块，经 page-router/Page 使用）
(function () {
  'use strict';

  // ============ 1. 表达式求值器（tokenizer + Pratt parser + AST 求值） ============

  function tokenize(src) {
    var tokens = [];
    var i = 0, n = src.length;
    while (i < n) {
      var c = src[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
      // 数字（含小数）
      if (c >= '0' && c <= '9') {
        var s = i;
        while (i < n && ((src[i] >= '0' && src[i] <= '9') || src[i] === '.')) i++;
        tokens.push({ t: 'num', v: parseFloat(src.slice(s, i)) });
        continue;
      }
      // 字符串
      if (c === "'" || c === '"') {
        var e = src.indexOf(c, i + 1);
        if (e < 0) throw new Error('未闭合字符串: ' + src);
        tokens.push({ t: 'str', v: src.slice(i + 1, e) });
        i = e + 1;
        continue;
      }
      // 标识符（含 $ _ 中文）
      if (/[A-Za-z_$\u4e00-\u9fa5]/.test(c)) {
        var s2 = i;
        while (i < n && /[A-Za-z0-9_$\u4e00-\u9fa5]/.test(src[i])) i++;
        tokens.push({ t: 'id', v: src.slice(s2, i) });
        continue;
      }
      // 运算符（多字符优先：=== / !== 三字符，其余两字符）
      var three = src.substr(i, 3);
      var two = src.substr(i, 2);
      if (three === '===' || three === '!==') {
        tokens.push({ t: 'op', v: three }); i += 3; continue;
      }
      if (two === '&&' || two === '||' ||
          two === '>=' || two === '<=' || two === '==' || two === '!=') {
        tokens.push({ t: 'op', v: two }); i += 2; continue;
      }
      if ('.[]()!+-*/%<>?:,'.indexOf(c) >= 0) {
        tokens.push({ t: 'op', v: c }); i++; continue;
      }
      throw new Error('无法识别的字符: "' + c + '" in ' + src);
    }
    return tokens;
  }

  // Pratt parser → AST {t:'lit'|'var'|'member'|'index'|'un'|'bin'|'cond'|'call'}
  function parseExpr(tokens) {
    var p = 0;
    function peek() { return tokens[p]; }
    function eat(v) {
      var tk = tokens[p];
      if (!tk || tk.v !== v) throw new Error('期望 "' + v + '" 实际 ' + (tk ? tk.v : 'EOF'));
      p++;
      return tk;
    }
    var BIN = { '||': 1, '&&': 2, '==': 3, '===': 3, '!=': 3, '!==': 3, '<': 4, '>': 4, '<=': 4, '>=': 4,
                '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 };
    function primary() {
      var tk = peek();
      if (!tk) throw new Error('表达式意外结束');
      if (tk.t === 'num' || tk.t === 'str') { p++; return { t: 'lit', v: tk.v }; }
      if (tk.t === 'op' && (tk.v === '-' || tk.v === '!')) {
        p++; return { t: 'un', op: tk.v, a: primary() };
      }
      if (tk.t === 'op' && tk.v === '(') { p++; var e = cond(); eat(')'); return e; }
      if (tk.t === 'id') {
        p++;
        if (tk.v === 'true') return { t: 'lit', v: true };
        if (tk.v === 'false') return { t: 'lit', v: false };
        if (tk.v === 'null') return { t: 'lit', v: null };
        return { t: 'var', n: tk.v };
      }
      throw new Error('意外的 token: ' + tk.v);
    }
    function member() { // 后缀 .x [expr] (args)
      var node = primary();
      for (;;) {
        var tk = peek();
        if (tk && tk.t === 'op' && tk.v === '.') {
          p++;
          var nameTk = tokens[p];
          if (!nameTk || nameTk.t !== 'id') { throw new Error('点号后期望属性名，实际 ' + (nameTk ? nameTk.v : 'EOF')); }
          p++;
          node = { t: 'member', o: node, n: nameTk.v };
        } else if (tk && tk.t === 'op' && tk.v === '[') {
          p++;
          var idx = cond();
          eat(']');
          node = { t: 'index', o: node, i: idx };
        } else if (tk && tk.t === 'op' && tk.v === '(') {
          p++;
          var args = [];
          if (peek() && !(peek().t === 'op' && peek().v === ')')) {
            args.push(cond());
            while (peek() && peek().v === ',') { p++; args.push(cond()); }
          }
          eat(')');
          node = { t: 'call', f: node, a: args };
        } else break;
      }
      return node;
    }
    function bin(minPrec) {
      var left = member();
      for (;;) {
        var tk = peek();
        if (!tk || tk.t !== 'op' || !BIN[tk.v] || BIN[tk.v] < minPrec) break;
        p++;
        var right = bin(BIN[tk.v] + 1);
        left = { t: 'bin', op: tk.v, a: left, b: right };
      }
      return left;
    }
    function cond() {
      var test = bin(0);
      if (peek() && peek().v === '?') {
        p++;
        var yes = cond();
        eat(':');
        var no = cond();
        return { t: 'cond', test: test, yes: yes, no: no };
      }
      return test;
    }
    var ast = cond();
    if (p < tokens.length) throw new Error('表达式尾部多余 token: ' + tokens[p].v);
    return ast;
  }

  function evalNode(node, scope) {
    switch (node.t) {
      case 'lit': return node.v;
      case 'var':
        if (node.n in scope.data) return scope.data[node.n];
        if (scope.host && typeof scope.host[node.n] === 'function') {
          return scope.host[node.n]; // 方法引用（供 call）
        }
        return undefined;
      case 'member': {
        var o = evalNode(node.o, scope);
        if (o == null) return undefined;
        return o[node.n];
      }
      case 'index': {
        var ob = evalNode(node.o, scope);
        var ix = evalNode(node.i, scope);
        if (ob == null) return undefined;
        return ob[ix];
      }
      case 'un': {
        var v = evalNode(node.a, scope);
        return node.op === '-' ? -v : !v;
      }
      case 'bin': {
        var a = evalNode(node.a, scope), b = evalNode(node.b, scope);
        switch (node.op) {
          case '+': return a + b;
          case '-': return a - b;
          case '*': return a * b;
          case '/': return a / b;
          case '%': return a % b;
          case '<': return a < b;
          case '>': return a > b;
          case '<=': return a <= b;
          case '>=': return a >= b;
          case '==': return a == b;   // 小程序 {{}} 即 == 语义
          case '!=': return a != b;
          case '===': return a === b;
          case '!==': return a !== b;
          case '&&': return a && b;
          case '||': return a || b;
        }
        return undefined;
      }
      case 'cond': return evalNode(node.test, scope) ? evalNode(node.yes, scope) : evalNode(node.no, scope);
      case 'call': {
        var fn = evalNode(node.f, scope);
        if (typeof fn !== 'function') {
          console.warn('[wxml-runtime] 调用非函数:', node.f && node.f.n);
          return undefined;
        }
        var self = node.f.t === 'member' ? evalNode(node.f.o, scope) : scope.host;
        var args = node.a.map(function (a) { return evalNode(a, scope); });
        return fn.apply(self, args);
      }
    }
    return undefined;
  }

  // {{...}} 解析缓存（同表达式 AST 复用）
  var astCache = {};
  function compile(expr) {
    if (!astCache[expr]) {
      try { astCache[expr] = parseExpr(tokenize(expr)); }
      catch (e) { console.warn('[wxml-runtime] 表达式解析失败: "' + expr + '"', e.message); astCache[expr] = null; }
    }
    return astCache[expr];
  }
  // 完整插值串：'abc {{a}} def {{b+1}}' → 求值拼接（单段且整段 {{}} 时返回原值——保留对象/数组类型，供 dataset 传递）
  function evalInterp(text, scope) {
    if (text.indexOf('{{') < 0) return text;
    var m = /^\s*\{\{([\s\S]*)\}\}\s*$/.exec(text);
    if (m) {
      var ast = compile(m[1]);
      return ast ? evalNode(ast, scope) : '';
    }
    return text.replace(/\{\{([\s\S]*?)\}\}/g, function (_, e) {
      var a = compile(e);
      return toStr(a ? evalNode(a, scope) : '');
    });
  }
  function toStr(v) {
    if (v == null) return '';
    return String(v);
  }

  // ============ 2. 绑定收集与渲染 ============

  var WIF_ATTRS = ['data-wif', 'data-welif', 'data-welse'];
  var RESERVED_PREFIX = ['b-', 'c-', 'wif', 'welif', 'welse', 'wfor', 'wkey', 'wfor-item', 'wfor-index', 'wshow', 'wxc'];
  // 元素属性名是否含插值
  function hasInterp(s) { return typeof s === 'string' && s.indexOf('{{') >= 0; }

  // 收集容器内的绑定（不递归进结构指令的模板——模板在实例化时单独收集）
  function collectBinds(root) {
    var binds = [];
    walk(root, binds, null);
    return binds;

    function walk(el, out, stopAtDirective) {
      var node = el.firstChild;
      while (node) {
        var next = node.nextSibling; // 处理中可能被摘出
        if (node.nodeType === 3) { // 文本
          if (hasInterp(node.nodeValue)) out.push({ k: 'text', node: node, raw: node.nodeValue });
        } else if (node.nodeType === 1) { // 元素
          var tag = node.tagName;
          if (node.hasAttribute('data-wfor')) {
            out.push({ k: 'for', el: node });
            node = next; continue; // 不深入：实例化时处理
          }
          var hasCond = node.hasAttribute('data-wif') || node.hasAttribute('data-welif') || node.hasAttribute('data-welse');
          if (hasCond) {
            out.push({ k: 'if', el: node });
            node = next; continue;
          }
          collectAttrs(node, out);
          if (tag !== 'TEMPLATE') walk(node, out, false);
        }
        node = next;
      }
    }
  }

  function collectAttrs(el, out) {
    var attrs = el.attributes;
    // 倒序遍历（live NamedNodeMap，循环内可能移除当前项）
    for (var i = attrs.length - 1; i >= 0; i--) {
      var a = attrs[i];
      if (!hasInterp(a.value)) { continue; }
      // data-wsrc（转换器改名自插值 src，规避浏览器对 src 的加载语义）→ 按 src 绑定求值回填
      var name = a.name === 'data-wsrc' ? 'src' : a.name;
      out.push({ k: 'attr', el: el, name: name, raw: a.value });
      // src/href：立即摘除字面插值（防克隆/入 DOM 瞬间按 "{{...}}" 发起 404 请求），渲染时回填真值
      if (a.name === 'src' || a.name === 'href') { el.removeAttribute(a.name); }
    }
  }

  // ---- 结构指令预处理：把 wfor/wif 元素从 DOM 摘出，留锚点注释 ----
  function extractDirectives(binds) {
    var dirs = [];
    for (var i = 0; i < binds.length; i++) {
      var b = binds[i];
      if (b.k === 'for') {
        var anchor = document.createComment('wfor');
        b.el.parentNode.insertBefore(anchor, b.el);
        b.el.parentNode.removeChild(b.el);
        b.anchor = anchor;
        b.itemName = b.el.getAttribute('data-wfor-item') || 'item';
        b.indexName = b.el.getAttribute('data-wfor-index') || 'index';
        b.listRaw = b.el.getAttribute('data-wfor');
        // for 模板自身的属性绑定（class 等）在实例化时收集
        dirs.push(b);
      } else if (b.k === 'if') {
        dirs.push(b); // if 组在渲染时处理（首次渲染时摘出）
      }
    }
    return dirs;
  }

  // if 组成组：兄弟序列中 wif 打头，后随 welif*/welse
  function groupIfs(dirs) {
    var groups = [], cur = null;
    for (var i = 0; i < dirs.length; i++) {
      var d = dirs[i];
      if (d.k !== 'if') { cur = null; continue; }
      if (d.el.hasAttribute('data-wif')) {
        cur = [d]; groups.push(cur);
      } else if (cur) {
        cur.push(d);
      } else {
        console.warn('[wxml-runtime] 孤立的 wx:elif/else');
      }
    }
    return groups;
  }
  // binds 上标记 if 组（mountPage 与克隆实例共用）
  function prepareIfGroups(binds) {
    var groups = groupIfs(binds.filter(function (b) { return b.k === 'if'; }));
    groups.forEach(function (g) {
      g[0].__group = g;
      for (var i = 1; i < g.length; i++) g[i].__grouped = true;
    });
  }

  // ---- 渲染重放（全量；工具页数据量级下足够） ----
  // binds 里的 attr/text 按序求值；for/if 指令重放
  function renderBinds(binds, scope, ctx) {
    for (var i = 0; i < binds.length; i++) {
      var b = binds[i];
      try {
        if (b.k === 'text') {
          b.node.nodeValue = toStr(evalInterp(b.raw, scope));
        } else if (b.k === 'attr') {
          applyAttr(b.el, b.name, evalInterp(b.raw, scope), ctx);
        }
        // for/if 已由 renderDirectives 处理
      } catch (e) {
        console.warn('[wxml-runtime] 绑定渲染失败: ' + (b.raw || b.name), e);
      }
    }
  }

  function applyAttr(el, name, value, ctx) {
    if (name === 'class') { el.setAttribute('class', toStr(value)); return; }
    // 组件宿主属性 → 转发组件实例（properties 更新；优先于 DOM value/checked 同名语义）
    var comp = ctx && ctx.compOf && ctx.compOf(el);
    if (comp) { comp.__updateProp(name, value); return; }
    // 包内绝对路径（业务 js 里写死 '/images/...'）→ 小工具包内 assets 相对路径
    if ((name === 'src' || name === 'href') && typeof value === 'string' && value.indexOf('/') === 0 &&
        value.indexOf('//') !== 0 && value.indexOf('data:') !== 0) {
      el.setAttribute(name, './assets' + value);
      return;
    }
    if (name === 'value') {
      if (el.value != value) el.value = value == null ? '' : value; // 宽松比较：避免 '1'!==1 每帧覆写
      return;
    }
    if (name === 'checked' || name === 'selected') { el[name] = !!value; return; }
    if (name === 'disabled' || name === 'readonly') { if (value) el.setAttribute(name, ''); else el.removeAttribute(name); return; }
    el.setAttribute(name, toStr(value));
  }

  function renderDirectives(binds, scope, ctx) {
    for (var i = 0; i < binds.length; i++) {
      var b = binds[i];
      if (b.k === 'for') renderFor(b, scope, ctx);
      else if (b.k === 'if' && !b.__grouped) renderIfChain(b.__group || [b], scope, ctx);
    }
  }

  function renderFor(b, scope, ctx) {
    // 清空旧实例
    var anchor = b.anchor;
    while (anchor.nextSibling && anchor.nextSibling.__wfor === b) {
      var old = anchor.nextSibling;
      destroyScope(old, ctx);
      old.parentNode.removeChild(old);
    }
    var list = evalInterp(b.listRaw, scope);
    if (!Array.isArray(list)) {
      if (list != null) console.warn('[wxml-runtime] wx:for 目标非数组: ' + b.listRaw);
      return;
    }
    var isBlock = b.el.tagName === 'WX-BLOCK';
    for (var idx = 0; idx < list.length; idx++) {
      var item = list[idx];
      var frag = document.createDocumentFragment();
      if (isBlock) {
        var cloneInner = b.el.cloneNode(true).childNodes;
        // wx-block 透明：克隆其子节点（block 无实体无样式）
        var tmpDiv = document.createElement('div');
        while (cloneInner.length) tmpDiv.appendChild(cloneInner[0]);
        renderCloneInto(tmpDiv, b, scope, item, idx, ctx);
        moveFiltered(tmpDiv, frag);
      } else {
        var clone = b.el.cloneNode(true);
        clone.removeAttribute('data-wfor');
        clone.removeAttribute('data-wfor-item');
        clone.removeAttribute('data-wfor-index');
        clone.removeAttribute('data-wkey');
        renderCloneInto(clone, b, scope, item, idx, ctx);
        frag.appendChild(clone);
      }
      // 标记实例归属（含 block 多子节点：逐个标）
      for (var c = frag.firstChild; c; c = c.nextSibling) { if (c.nodeType === 1) c.__wfor = b; } // 仅元素：文本/注释节点带 expando 会让清理循环误入 destroyScope
      anchor.parentNode.insertBefore(frag, anchor.nextSibling);
    }
  }

  function renderCloneInto(clone, b, scope, item, idx, ctx) {
    var itemScope = {
      data: {},
      host: scope.host
    };
    itemScope.data[b.itemName] = item;
    itemScope.data[b.indexName] = idx;
    itemScope.data.__proto__ = scope.data; // 原型链：item 覆盖外层
    var binds = collectBinds(clone);
    prepareIfGroups(binds);
    extractDirectives(binds);
    hydrateComponents(clone, itemScope, ctx ? ctx.page : null);
    renderBinds(binds, itemScope, ctx);
    renderDirectives(binds, itemScope, ctx);
    clone.__scope = itemScope;
    clone.__binds = binds;
  }

  // block 搬运：剔除纯空白文本节点（微信编译器剔除模板空白；空白会顶在 anchor 后阻塞清理循环）
  function moveFiltered(tmpDiv, frag) {
    while (tmpDiv.firstChild) {
      var n = tmpDiv.firstChild;
      if (n.nodeType === 3 && !/\S/.test(n.nodeValue)) { tmpDiv.removeChild(n); continue; }
      frag.appendChild(n);
    }
  }

  function renderIfChain(group, scope, ctx) {
    // 组内每个成员：锚点后清旧实例 → 命中分支克隆渲染
    var hit = null;
    for (var i = 0; i < group.length; i++) {
      var d = group[i];
      var exprAttr = d.el.getAttribute('data-wif') || d.el.getAttribute('data-welif');
      if (exprAttr != null) {
        var v = evalInterp(exprAttr, scope);
        if (v) { hit = d; break; }
      } else if (d.el.hasAttribute('data-welse')) { // else 兜底
        hit = d; break;
      }
    }
    for (var j = 0; j < group.length; j++) {
      var g = group[j];
      if (!g.anchor) { // 首次：摘出留锚
        g.anchor = document.createComment('wif');
        g.el.parentNode.insertBefore(g.anchor, g.el);
        g.el.parentNode.removeChild(g.el);
      }
      while (g.anchor.nextSibling && g.anchor.nextSibling.__wif === g) {
        var old = g.anchor.nextSibling;
        destroyScope(old, ctx);
        old.parentNode.removeChild(old);
      }
    }
    if (!hit) return;
    var isBlock = hit.el.tagName === 'WX-BLOCK';
    var frag = document.createDocumentFragment();
    if (isBlock) {
      var tmpDiv = document.createElement('div');
      var kids = hit.el.cloneNode(true).childNodes;
      while (kids.length) tmpDiv.appendChild(kids[0]);
      renderScopeClone(tmpDiv, scope, ctx);
      moveFiltered(tmpDiv, frag);
    } else {
      var clone = hit.el.cloneNode(true);
      clone.removeAttribute('data-wif');
      clone.removeAttribute('data-welif');
      clone.removeAttribute('data-welse');
      renderScopeClone(clone, scope, ctx);
      frag.appendChild(clone);
    }
    for (var c = frag.firstChild; c; c = c.nextSibling) { if (c.nodeType === 1) c.__wif = hit; } // 同 renderFor：expando 只标元素
    hit.anchor.parentNode.insertBefore(frag, hit.anchor.nextSibling);
  }

  function renderScopeClone(clone, scope, ctx) {
    var binds = collectBinds(clone);
    prepareIfGroups(binds);
    extractDirectives(binds);
    hydrateComponents(clone, scope, ctx ? ctx.page : null);
    renderBinds(binds, scope, ctx);
    renderDirectives(binds, scope, ctx);
    clone.__scope = scope;
    clone.__binds = binds;
  }

  // 销毁前清理：组件实例 detached
  function destroyScope(el, ctx) {
    destroyComponentsIn(el);
    var kids = el.querySelectorAll('[__wfor], [__wif]');
    for (var i = 0; i < kids.length; i++) destroyComponentsIn(kids[i]);
  }
  function destroyComponentsIn(el) {
    if (!el.querySelectorAll) return;
    var comps = el.querySelectorAll('[__comp]');
    for (var i = 0; i < comps.length; i++) {
      var inst = comps[i].__compInst;
      if (inst) callLifetime(inst, 'detached');
    }
    if (el.hasAttribute && el.hasAttribute('__comp') && el.__compInst) callLifetime(el.__compInst, 'detached');
  }

  // ============ 3. 事件系统（委托） ============

  var longpressFlag = false; // longpress 触发后抑制一次 click(tap)

  function bindEvents(rootEl, pageRef) {
    // section 只绑一次；pageRef 为实时指针对象 { page: inst }（mountPage 更新）
    var handler = function (domEvent) { dispatch(domEvent, rootEl, pageRef); };
    ['click', 'input', 'blur', 'focus', 'change', 'touchstart', 'touchmove', 'touchend', 'touchcancel', 'keydown'].forEach(function (t) {
      rootEl.addEventListener(t, handler, t === 'touchmove' ? { passive: false } : true);
    });
  }

  var lpTimer = null;
  var lpStartX = 0, lpStartY = 0;
  function dispatch(domEvent, rootEl, pageRef) {
    // pageRef 支持 { page: inst } 实时指针（页面重建后取最新实例）或直接实例
    var page = pageRef && pageRef.page ? pageRef.page : pageRef;
    var type = domEvent.type;
    if (type === 'touchstart') {
      var t0 = domEvent.touches[0];
      lpStartX = t0.clientX; lpStartY = t0.clientY;
      lpTimer = setTimeout(function () {
        lpTimer = null;
        longpressFlag = true;
        fireHandlers(domEvent, rootEl, page, 'longpress', {});
      }, 350);
      return;
    }
    if (type === 'touchmove') {
      if (lpTimer) {
        var t1 = domEvent.touches[0];
        if (Math.abs(t1.clientX - lpStartX) > 10 || Math.abs(t1.clientY - lpStartY) > 10) { clearTimeout(lpTimer); lpTimer = null; }
      }
      fireHandlers(domEvent, rootEl, page, 'touchmove', {}, true); // 命中即 preventDefault（弹层锁滚动）
      return;
    }
    if (type === 'touchend' || type === 'touchcancel') {
      if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
      fireHandlers(domEvent, rootEl, page, 'touch' + (type === 'touchend' ? 'end' : 'cancel'), null);
      return;
    }
    if (type === 'click') {
      if (longpressFlag) { longpressFlag = false; return; } // longpress 已触发，抑制 tap
      fireHandlers(domEvent, rootEl, page, 'tap', { x: domEvent.clientX, y: domEvent.clientY });
      return;
    }
    if (type === 'input' || type === 'change') {
      fireHandlers(domEvent, rootEl, page, type, { value: domEvent.target.value });
      return;
    }
    if (type === 'blur') { fireHandlers(domEvent, rootEl, page, 'blur', { value: domEvent.target.value }); return; }
    if (type === 'focus') { fireHandlers(domEvent, rootEl, page, 'focus', { value: domEvent.target.value }); return; }
    if (type === 'keydown') {
      if (domEvent.key === 'Enter') fireHandlers(domEvent, rootEl, page, 'confirm', { value: domEvent.target.value });
      return;
    }
  }

  // 微信事件语义：从 target 沿祖先路径逐元素执行——元素自身 handler 优先于祖先的 catch；
  // 遇 catchtap 元素执行后停止冒泡（此前"全局先找 catch"的模型会吞掉内层 bindtap，已废弃）
  function fireHandlers(domEvent, rootEl, page, wxType, detail, preventOnly) {
    var anyHit = false;
    var cur = domEvent.target;
    while (cur && cur !== rootEl) {
      if (cur.getAttribute) {
        var bindFn = cur.getAttribute('data-b-' + wxType);
        var catchFn = cur.getAttribute('data-c-' + wxType);
        if (preventOnly && (bindFn || catchFn)) { domEvent.preventDefault(); return; }
        if (bindFn) { anyHit = true; invoke(domEvent, cur, rootEl, page, bindFn, wxType, detail); }
        if (catchFn) {
          anyHit = true;
          invoke(domEvent, cur, rootEl, page, catchFn, wxType, detail);
          domEvent.stopPropagation(); // catch：阻止继续冒泡（祖先 handler 不再执行）
          return;
        }
      }
      cur = cur.parentNode;
    }
    return anyHit;
  }

  function invoke(domEvent, el, rootEl, page, fnName, wxType, detail) {
    var scopeOwner = findOwner(el, rootEl, page); // 组件实例或页面实例
    var fn = scopeOwner && scopeOwner[fnName];
    if (typeof fn !== 'function') {
      console.warn('[wxml-runtime] 事件方法不存在: ' + fnName + ' (' + wxType + ')');
      return;
    }
    var ev = makeWxEvent(domEvent, el, wxType, detail);
    try { fn.call(scopeOwner, ev); } catch (e) { console.error('[wxml-runtime] 事件处理异常: ' + fnName, e); }
  }

  function findOwner(el, rootEl, page) {
    // 最近组件宿主（含自身）优先
    var cur = el;
    while (cur && cur !== rootEl) {
      if (cur.__compInst) return cur.__compInst;
      cur = cur.parentNode || (cur.host || null);
    }
    return page;
  }

  function collectDataset(el) {
    var ds = {};
    var attrs = el.attributes;
    for (var i = 0; i < attrs.length; i++) {
      var n = attrs[i].name;
      if (n.indexOf('data-') !== 0) continue;
      var key = n.slice(5);
      if (isReservedData(key)) continue;
      ds[toCamel(key)] = attrs[i].value;
    }
    return ds;
  }
  function isReservedData(key) {
    for (var i = 0; i < RESERVED_PREFIX.length; i++) {
      if (key === RESERVED_PREFIX[i] || key.indexOf(RESERVED_PREFIX[i]) === 0) return true;
    }
    return false;
  }
  function toCamel(s) {
    return s.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); });
  }

  function makeWxEvent(domEvent, el, wxType, detail) {
    var touch = domEvent.touches && domEvent.touches[0];
    return {
      type: wxType,
      timeStamp: domEvent.timeStamp,
      target: { id: domEvent.target.id || '', dataset: collectDataset(domEvent.target) },
      currentTarget: { id: el.id || '', dataset: collectDataset(el) },
      detail: detail || {},
      touches: domEvent.touches || [],
      changedTouches: domEvent.changedTouches || [],
      clientX: touch ? touch.clientX : domEvent.clientX,
      clientY: touch ? touch.clientY : domEvent.clientY,
      preventDefault: function () { if (domEvent.preventDefault) domEvent.preventDefault(); },
      stopPropagation: function () { domEvent.stopPropagation(); }
    };
  }

  // ============ 4. Component 组件系统 ============

  var componentRegistry = {};
  var pickerFactory = null; // 由外部注册（UiKit 弹层实现），签名 (el, fireChange) —— wx-picker 模拟

  function registerComponent(name, config) {
    config.__name = name;
    componentRegistry[name.toLowerCase()] = config;
  }

  function getCompTemplate(name) {
    var tpl = document.querySelector('template[data-wxc="' + name + '"]');
    return tpl;
  }
  function docRoot() { return document; }

  // 扫描容器内已注册组件标签 → 实例化（跳过已实例化）
  function hydrateComponents(container, scope, page) {
    // wx-picker 模拟（点击弹选择层；pickerFactory 由 UiKit 注册）
    var pickers = container.querySelectorAll('wx-picker');
    for (var pi = 0; pi < pickers.length; pi++) {
      var pk = pickers[pi];
      if (!pk.__pickerBound && pickerFactory) {
        pk.__pickerBound = true;
        pickerFactory(pk, scope, page);
      }
    }
    var names = Object.keys(componentRegistry);
    if (!names.length) return;
    var sels = names.join(',');
    var els = container.querySelectorAll(sels);
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.__compInst) continue;
      var cfg = componentRegistry[el.tagName.toLowerCase()];
      if (!cfg) continue;
      createComponentInstance(el, cfg, scope, page);
    }
  }

  function createComponentInstance(hostEl, cfg, hostScope, page) {
    var inst = {
      __isComponent: true,
      data: deepClone(cfg.data || {}),
      properties: {},
      __cfgProps: cfg.properties || {},
      __observers: cfg.observers || {},
      __observerOld: {},
      __lifetimes: cfg.lifetimes || {},
      __hostEl: hostEl,
      __hostScope: hostScope,
      __page: page,
      is: cfg.__name
    };
    hostEl.__compInst = inst;
    hostEl.setAttribute('__comp', '');
    inst.__updateProp = function (name, value) { updateComponentProp(inst, name, value); };

    // properties：宿主属性求值（hostScope）→ 类型归一 → observer
    var propsDef = cfg.properties || {};
    Object.keys(propsDef).forEach(function (pn) {
      var def = propsDef[pn];
      var raw = hostEl.getAttribute(pn);
      var v;
      if (raw == null) v = def && def.value !== undefined ? def.value : undefined;
      else if (hasInterp(raw)) v = evalInterp(raw, hostScope);
      else v = raw;
      inst.properties[pn] = coerceType(v, def && def.type);
      inst.data[pn] = inst.properties[pn];
      inst.__observerOld[pn] = inst.properties[pn];
    });

    // methods 绑定（this = 组件实例）
    var methods = cfg.methods || {};
    Object.keys(methods).forEach(function (mn) { inst[mn] = methods[mn]; });

    inst.setData = function (patch, cb) {
      if (!patch) return;
      Object.keys(patch).forEach(function (k) { setPath(inst.data, k, patch[k]); });
      renderComponent(inst);
      fireObservers(inst, Object.keys(patch));
      if (typeof cb === 'function') cb();
    };
    inst.triggerEvent = function (name, detail, opts) {
      var attr = 'data-b-' + name.toLowerCase();
      var fnName = hostEl.getAttribute(attr);
      if (!fnName) {
        var cattr = 'data-c-' + name.toLowerCase();
        fnName = hostEl.getAttribute(cattr);
      }
      if (!fnName) return;
      // 宿主方法宿主：向上找最近组件实例（嵌套组件→外层组件方法），否则页面
      var owner = page;
      var cur = hostEl.parentNode;
      while (cur && cur !== docRoot()) {
        if (cur.__compInst) { owner = cur.__compInst; break; }
        cur = cur.parentNode;
      }
      var fn = owner && owner[fnName];
      if (typeof fn !== 'function') { console.warn('[wxml-runtime] 组件事件方法不存在: ' + fnName); return; }
      var ev = {
        type: name, detail: detail || {},
        currentTarget: { id: hostEl.id, dataset: collectDataset(hostEl) },
        target: { id: hostEl.id, dataset: collectDataset(hostEl) }
      };
      fn.call(owner, ev);
    };
    inst.selectComponent = function (sel) { return selectComponentIn(hostEl, sel); };
    inst.createSelectorQuery = function () {
      return (typeof window.WxApiShim !== 'undefined' && window.WxApiShim.createSelectorQuery)
        ? window.WxApiShim.createSelectorQuery(hostEl) : null;
    };

    // 组件模板填充（离屏收集绑定并摘字面 src——入 DOM 前完成，防 {{...}} 竞态请求）
    var tpl = getCompTemplate(cfg.__name);
    if (tpl) {
      var frag = tpl.content.cloneNode(true);
      var binds = collectBinds(frag);
      extractDirectives(binds);
      prepareIfGroups(binds);
      inst.__binds = binds;
      inst.__scope = { data: inst.data, host: inst };
      hostEl.innerHTML = '';
      hostEl.appendChild(frag);
      hydrateComponents(hostEl, inst.__scope, inst); // 嵌套组件
      renderBinds(binds, inst.__scope, compCtx(inst, page));
      renderDirectives(binds, inst.__scope, compCtx(inst, page));
    }

    callLifetime(inst, 'attached');
    requestAnimationFrame(function () { callLifetime(inst, 'ready'); });
    return inst;
  }

  function compCtx(inst, page) {
    return {
      page: page,
      compOf: function (el) { return el.__compInst || null; }
    };
  }

  function renderComponent(inst) {
    if (!inst.__binds) return;
    renderBinds(inst.__binds, inst.__scope, compCtx(inst, inst.__page));
    renderDirectives(inst.__binds, inst.__scope, compCtx(inst, inst.__page));
  }

  // 宿主属性变化 → 更新 properties（applyAttr 转发）
  function updateComponentProp(inst, name, value) {
    var def = (inst.__cfgProps || {})[name];
    var v = coerceType(value, def && def.type);
    if (inst.properties[name] === v) return;
    inst.properties[name] = v;
    inst.data[name] = v;
    renderComponent(inst);
    fireObservers(inst, [name]);
    // prop 定义级 observer
    var ob = def && def.observer;
    if (typeof ob === 'function') ob.call(inst, v, inst.properties[name]);
  }

  function fireObservers(inst, changedKeys) {
    // 字段级 observers: {'a, b.c': fn}——求值对比旧值
    Object.keys(inst.__observers).forEach(function (keyExpr) {
      var keys = keyExpr.split(',').map(function (s) { return s.trim(); });
      var hit = keys.some(function (k) {
        return changedKeys.some(function (ck) { return ck === k || ck.indexOf(k + '.') === 0 || k.indexOf(ck + '.') === 0; });
      });
      if (!hit) return;
      var vals = keys.map(function (k) { return getPath(inst.data, k); });
      var oldKey = '__old_' + keyExpr;
      var olds = inst[oldKey] || [];
      if (JSON.stringify(vals) !== JSON.stringify(olds)) {
        inst[oldKey] = vals;
        inst.__observers[keyExpr].apply(inst, vals);
      }
    });
  }

  function callLifetime(inst, name) {
    var fn = inst.__lifetimes[name] || (typeof inst[name] === 'function' && name.indexOf('ed') > 0 ? inst[name] : null);
    if (typeof fn === 'function') {
      try { fn.call(inst); } catch (e) { console.error('[wxml-runtime] 组件生命周期异常: ' + name, e); }
    }
  }

  function selectComponentIn(rootEl, sel) {
    var el = rootEl ? rootEl.querySelector(sel) : null;
    if (!el) return null;
    if (el.__compInst) return el.__compInst;
    // 非组件元素：查后代组件宿主
    var inner = el.querySelector('[__comp]');
    return inner ? inner.__compInst : null;
  }

  // ============ 5. 页面挂载集成（page-router 调用） ============

  function mountPage(page, sectionEl) {
    // binds/锚点/模板缓存于 section（普通页二次进入复用：模板元素已从 DOM 摘出，
    // 重新 collectBinds 会永远丢失 wx:if/wx:for 结构）
    if (!sectionEl.__wrBinds) {
      var binds = collectBinds(sectionEl);
      extractDirectives(binds);
      prepareIfGroups(binds);
      sectionEl.__wrBinds = binds;
    }
    page.__wr = { el: sectionEl, binds: sectionEl.__wrBinds };
    var scope = { data: page.data, host: page };
    var ctx = { page: page, compOf: function (el) { return el.__compInst || null; } };
    page.__wr.scope = scope;
    page.__wr.ctx = ctx;
    if (!sectionEl.__wrPageRef) {
      sectionEl.__wrPageRef = { page: page };
      bindEvents(sectionEl, sectionEl.__wrPageRef);
    } else {
      sectionEl.__wrPageRef.page = page; // 页面重建：更新实例指针
    }
    hydrateComponents(sectionEl, scope, page); // 顶层静态区组件标签实例化（wfor/wif 克隆区在渲染时各自 hydrate）
    renderPage(page);
  }

  function renderPage(page) {
    var wr = page.__wr;
    if (!wr) return;
    renderBinds(wr.binds, wr.scope, wr.ctx);
    renderDirectives(wr.binds, wr.scope, wr.ctx);
  }

  function unmountPage(page) {
    var wr = page.__wr;
    if (!wr) return;
    destroyComponentsIn(wr.el);
  }

  // ============ 工具 ============
  function setPath(obj, path, value) {
    var keys = path.split('.');
    var cur = obj;
    for (var i = 0; i < keys.length - 1; i++) {
      if (cur[keys[i]] == null || typeof cur[keys[i]] !== 'object') cur[keys[i]] = {};
      cur = cur[keys[i]];
    }
    cur[keys[keys.length - 1]] = value;
  }
  function getPath(obj, path) {
    var keys = path.split('.');
    var cur = obj;
    for (var i = 0; i < keys.length; i++) {
      if (cur == null) return undefined;
      cur = cur[keys[i]];
    }
    return cur;
  }
  function deepClone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
  function coerceType(v, type) {
    if (!type) return v;
    try {
      if (type === Number) return Number(v);
      if (type === String) return v == null ? '' : String(v);
      if (type === Boolean) return !!v && v !== 'false';
      if (type === Array) return Array.isArray(v) ? v : (v == null || v === '' ? [] : JSON.parse(v));
      if (type === Object) return typeof v === 'object' ? v : JSON.parse(v || '{}');
    } catch (e) { /* 宽松降级原值 */ }
    return v;
  }

  var WxmlRuntime = {
    expr: { tokenize: tokenize, parse: parseExpr, evalNode: evalNode, evalInterp: evalInterp, compile: compile },
    registerComponent: registerComponent,
    hydrateComponents: hydrateComponents,
    mountPage: mountPage,
    renderPage: renderPage,
    unmountPage: unmountPage,
    createComponentInstance: createComponentInstance,
    selectComponentIn: selectComponentIn,
    setPath: setPath,
    registerPicker: function (fn) { pickerFactory = fn; },
    __debug: { collectBinds: collectBinds, renderDirectives: renderDirectives }
  };

  if (typeof window !== 'undefined') window.WxmlRuntime = WxmlRuntime;
  return WxmlRuntime;
})();
export default null;

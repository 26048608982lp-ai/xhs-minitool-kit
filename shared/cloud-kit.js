// cloud-kit.js — 云存储 + 排行榜公共封装（官方 §3.16/§3.17，内测能力，客户端 9.51+）
// 依赖：XhsBridge（window 全局，读 buildVersion/storage）；零直接依赖、ES2017/Chrome 61。
// 业务禁止直连 window.xhs.miniTool——本模块是这两个能力的唯一封装入口。
//
// rank = 统一排行榜门面（游戏线/小程序线共用）：内部云榜优先 + 本机 TOP N 兜底，
//   submit 本机总是记录；list/my 云不可用或失败时降级返回 source:'local' / status:'LOCAL'，
//   UI 据此标注"全网排行 / 本机记录"，业务无需再写"要不要用本地榜"的分支。
//
// 官方文档 2026-11-05 版要点（改本文件前对照 §3.16/§3.17）：
//   内测期能力与限制可能调整，勿作为核心功能唯一依赖；必须保留本地降级路径（本模块已内置）
//   未授权：云存储 errCode 1006 / 排行榜 errCode 1005（store.* 显式 reject 由业务隐藏入口；rank.* 自动降级）
//   限频：「小工具 × 接口」150 QPS，超限 2009——勿在游戏循环/高频定时器里调用；
//         本模块内置：榜单结果 30s 本地缓存、submitScore 后自动失效缓存
//   榜单未就绪 2002 → 指数退避重试（500ms/1s/2s/4s），仍失败降级本机榜；data:[] 才是真实空榜
//   云存储逐项三态：SUCCESS / FAILED / UNKNOWN（UNKNOWN 禁止重发，用 store.query 对账）
//   配额：单批 ≤100 条（超限自动拆批）、单条 content 序列化后 ≤64KB（超限 1003，业务自行精简/分条）
var CloudKit = (function (global) {
  'use strict';

  var VERSION_CLOUD = 9510;          // §3.6：9510 = 客户端 9.51.0
  var BATCH_MAX = 100;               // 单批上限（items/ids），超限 errCode 1002
  var LIST_TTL_MS = 30 * 1000;       // 榜单本地缓存（官方建议 30s~60s）
  var RETRY_DELAYS = [500, 1000, 2000, 4000]; // 2002 退避节奏（官方建议）

  var PERIODS = ['all', 'month', 'week', 'day']; // period 枚举（非法本地报错 10001）

  function miniTool() {
    var xhs = global.xhs;
    return (xhs && xhs.miniTool) || null;
  }

  function isAtLeast(buildVersion, minClientVersion) {
    return Math.floor(buildVersion / 1000) >= minClientVersion;
  }

  function bridgeVersion() {
    var bridge = global.XhsBridge;
    return (bridge && bridge.buildVersion) || 0;
  }

  // 版本 + 方法存在性双重探测（官方 §3.1 可用性判断）
  function canUse(apiNames) {
    var mt = miniTool();
    if (!isAtLeast(bridgeVersion(), VERSION_CLOUD) || !mt) { return false; }
    for (var i = 0; i < apiNames.length; i++) {
      if (typeof mt[apiNames[i]] !== 'function') { return false; }
    }
    return true;
  }

  function rejectCode(errMsg, code) {
    return Promise.reject({ errMsg: errMsg, errCode: code });
  }

  // 调用透传：resolve 原样（含 errMsg/业务字段），reject 原样（含 errCode）——判码用 errCode 整数
  function callApi(apiName, args) {
    var mt = miniTool();
    if (!mt || typeof mt[apiName] !== 'function') {
      return rejectCode(apiName + ':fail unsupported', -1);
    }
    try {
      return Promise.resolve(mt[apiName](args));
    } catch (e) {
      return Promise.reject(e && typeof e === 'object' ? e : { errMsg: apiName + ':fail ' + e });
    }
  }

  // 批量参数自动拆批（官方：超 100 返回 1002，建议拆批重试——此处前置拆免业务感知）
  // splitBatches(['a','b']) → [['a'],['b']]；串行执行 batchFn，结果按原顺序拼接
  function runBatches(list, batchFn) {
    var batches = [];
    for (var i = 0; i < list.length; i += BATCH_MAX) {
      batches.push(list.slice(i, i + BATCH_MAX));
    }
    if (!batches.length) { batches.push([]); }
    var out = [];
    var p = Promise.resolve();
    batches.forEach(function (batch) {
      p = p.then(function () {
        return batchFn(batch).then(function (res) {
          out = out.concat(res);
        });
      });
    });
    return p.then(function () { return out; });
  }

  // 逐项结果提取：addCloudStorage/updateCloudStorage/removeCloudStorage 返回 { data: [{id, status}] }
  function pickItems(res, fallbackIds) {
    var data = (res && res.data) || [];
    return data.map(function (it, i) {
      return { id: (it && it.id) || (fallbackIds && fallbackIds[i]) || '', status: (it && it.status) || 'UNKNOWN' };
    });
  }

  // 延迟
  function delay(ms) {
    return new Promise(function (resolve) { global.setTimeout(resolve, ms); });
  }

  // ==================== CloudStore（§3.16 云存储）====================
  // 「用户 × 小工具」隔离的个人数据：同账号跨设备恢复。collection=业务分类（表名），content=业务 JSON 对象。
  // 🔴 写入非事务：返回逐项 status，FAILED 可重放、UNKNOWN 用 query 对账（禁止盲目重发）
  // 🔴 update 是整行覆盖（非字段合并）：要保留的字段必须一起提交
  var store = {
    can: function () {
      return canUse(['addCloudStorage', 'updateCloudStorage', 'queryCloudStorage', 'removeCloudStorage']);
    },

    // add(collection, [{...content}]) → [{id, status}]（id 为服务端 24 位十六进制；UNKNOWN 且无 id 时为空串）
    add: function (collection, items) {
      if (!store.can()) { return rejectCode('addCloudStorage:fail unauthorized(1006)', 1006); }
      if (!collection || !Array.isArray(items) || !items.length) {
        return rejectCode('addCloudStorage:fail invalid args', 10001);
      }
      return runBatches(items, function (batch) {
        return callApi('addCloudStorage', { collection: collection, items: batch.map(function (c) { return { content: c }; }) })
          .then(function (res) { return pickItems(res); });
      });
    },

    // update(collection, [{id, {...content}}]) → [{id, status}]；🔴 整行覆盖，同批 id 不得重复
    update: function (collection, items) {
      if (!store.can()) { return rejectCode('updateCloudStorage:fail unauthorized(1006)', 1006); }
      if (!collection || !Array.isArray(items) || !items.length) {
        return rejectCode('updateCloudStorage:fail invalid args', 10001);
      }
      var seen = {};
      for (var i = 0; i < items.length; i++) {
        var id = items[i] && items[i].id;
        if (!id || seen[id]) { return rejectCode('updateCloudStorage:fail invalid/dup id', 10001); }
        seen[id] = true;
      }
      return runBatches(items, function (batch) {
        return callApi('updateCloudStorage', { collection: collection, items: batch })
          .then(function (res) { return pickItems(res, batch.map(function (it) { return it.id; })); });
      });
    },

    // query({ collection?, ids?, limit?, cursor? }) → { items, nextCursor?, hasMore? }（原样透传）
    // 读失败整次 reject；items:[] 才是「确实没有」——不得把读失败当无数据渲染
    query: function (opts) {
      if (!store.can()) { return rejectCode('queryCloudStorage:fail unauthorized(1006)', 1006); }
      return callApi('queryCloudStorage', opts || {});
    },

    // queryAll(collection, limit?) — 分页自动翻取聚合（适用小集合，如全部待办；大集合请用 query 分页渲染）
    queryAll: function (collection, limit) {
      var all = [];
      var cursor;
      function page() {
        var opts = { collection: collection };
        if (limit) { opts.limit = limit; }
        if (cursor) { opts.cursor = cursor; }
        return store.query(opts).then(function (res) {
          all = all.concat((res && res.items) || []);
          if (res && res.hasMore && res.nextCursor) {
            cursor = res.nextCursor;
            return page();
          }
          return all;
        });
      }
      return page();
    },

    // remove(collection, ids) → [{id, status}]；硬删不可恢复；幂等；同批 id 不得重复
    remove: function (collection, ids) {
      if (!store.can()) { return rejectCode('removeCloudStorage:fail unauthorized(1006)', 1006); }
      if (!collection || !Array.isArray(ids) || !ids.length) {
        return rejectCode('removeCloudStorage:fail invalid args', 10001);
      }
      return runBatches(ids, function (batch) {
        return callApi('removeCloudStorage', { collection: collection, ids: batch })
          .then(function (res) { return pickItems(res, batch); });
      });
    }
  };

  // ==================== CloudRank（§3.17 排行榜）====================
  // board：榜位 1–5 整数（默认 1）；period：'all'|'month'|'week'|'day'（默认 all）
  // 周期按北京时间 0 点重置（每周一/每月 1 日）；各周期只保留最好成绩
  // 🔴 上传时必须勾选「用户头像昵称授权」，否则调用按未授权失败（1005）→ 隐藏入口降级
  var rankListCache = {}; // key = board + '|' + period → { list, at }

  function validPeriod(period) {
    if (period === undefined || period === null) { return true; }
    return PERIODS.indexOf(period) >= 0;
  }

  // ---- 本机 TOP N 兜底存储（经 XhsBridge.storage；无 bridge 时静默不记，不阻塞主流程）----
  // 云榜不可用（未授权/低版本/内测波动）时 UI 的降级数据源：显示"本机记录"而非开天窗
  var LOCAL_MAX = 20;

  function localKey(board) { return 'cloudkit_rank_local_' + (board === undefined ? 1 : board); }

  function localRead(board) {
    try {
      var bridge = global.XhsBridge;
      var raw = bridge ? bridge.storageGet(localKey(board)) : '';
      if (raw && typeof raw === 'object' && raw instanceof Array) { return raw; }
    } catch (e) {}
    return [];
  }

  function localSubmit(board, score) {
    var list = localRead(board);
    list.push({ score: score, at: Date.now() });
    list.sort(function (a, b) { return b.score - a.score; });
    list = list.slice(0, LOCAL_MAX);
    try {
      var bridge = global.XhsBridge;
      if (bridge) { bridge.storageSet(localKey(board), list); }
    } catch (e) {}
    return list;
  }

  function localBest(board) {
    var list = localRead(board);
    return list.length ? list[0].score : null;
  }

  // 本机榜 → 云榜行结构对齐（nickname 置 null 由渲染兜底为"我"）
  function localAsRows(board) {
    return localRead(board).map(function (it, i) {
      return { rank: i + 1, score: it.score, nickname: null };
    });
  }

  var rank = {
    can: function () {
      return canUse(['submitScore', 'getRankList', 'getMyRank']);
    },

    // submit(score, board?) → Promise<{ score, source }>：历史最高分 + 数据来源
    //   统一门面语义：本机**总是**记录一份（降级数据源）；云可用时再上行，返回总榜历史最高
    //   云不可用（can=false/失败）不 reject——降级返回本机最高，source:'local' 供 UI 标注
    //   分数原值不缩放；±1,000,000 有限数值前置校验（1004 语义本地拦截，参数非法仍 reject）
    submit: function (score, board) {
      if (typeof score !== 'number' || !isFinite(score) ||
          score < -1000000 || score > 1000000) {
        return rejectCode('submitScore:fail score out of range(1004)', 1004);
      }
      var cloudOk = rank.can();
      localSubmit(board, score);
      if (!cloudOk) {
        return Promise.resolve({ score: localBest(board), source: 'local' });
      }
      var opts = { score: score };
      if (board !== undefined) { opts.board = board; }
      // 新成绩可能改变各期榜单，失效全部缓存
      rankListCache = {};
      return callApi('submitScore', opts).then(function (res) {
        return { score: (res && res.score !== undefined) ? res.score : localBest(board), source: 'cloud' };
      }).catch(function () {
        // 云上行失败：本地已记录，降级返回本机最高（下次可重试上行）
        return { score: localBest(board), source: 'local' };
      });
    },

    // list(board?, period?) → Promise<{ source: 'cloud'|'local', list: [{rank, score, nickname}] }>
    //   云路径：前 100 名降序；30s 本地缓存 + 2002 未就绪指数退避（500ms/1s/2s/4s）；data:[] 才是真实空榜
    //   降级路径：云不可用或上行全败 → 本机 TOP N（UI 应标注"本机记录"），永不 reject（参数非法除外）
    list: function (board, period) {
      if (!validPeriod(period)) {
        return rejectCode('getRankList:fail invalid period(10001)', 10001);
      }
      var b = board === undefined ? 1 : board;
      var p = period === undefined ? 'all' : period;
      var key = b + '|' + p;
      var hit = rankListCache[key];
      var now = Date.now();
      if (hit && now - hit.at < LIST_TTL_MS) {
        return Promise.resolve({ source: 'cloud', list: hit.list });
      }
      if (!rank.can()) {
        return Promise.resolve({ source: 'local', list: localAsRows(board) });
      }
      function attempt(tries) {
        return callApi('getRankList', { board: b, period: p }).then(function (res) {
          var list = (res && res.data) || [];
          rankListCache[key] = { list: list, at: Date.now() };
          return { source: 'cloud', list: list };
        }, function (err) {
          if (err && err.errCode === 2002 && tries < RETRY_DELAYS.length) {
            return delay(RETRY_DELAYS[tries]).then(function () {
              return attempt(tries + 1);
            });
          }
          // 云榜失败（含退避后仍 2002）：降级本机榜，不向上抛——UI 用 source 标注即可
          return { source: 'local', list: localAsRows(board) };
        });
      }
      return attempt(0);
    },

    // my(board?, period?) → Promise<{ status, rank, score }>；先判 status 再消费 rank/score
    // status：EXACT(前500精确名次) / OVER_LIMIT(500+，rank/score 均 null，建议展示"500+") /
    //         NO_SCORE(本期无成绩) / NOT_PARTICIPATING(未参与)——官方四态，查询业务失败走 resolve
    //         + 本门面扩展 LOCAL（云不可用：本机榜名次与本机最高分，rank=1..N）
    my: function (board, period) {
      if (!validPeriod(period)) {
        return rejectCode('getMyRank:fail invalid period(10001)', 10001);
      }
      if (!rank.can()) {
        var best = localBest(board);
        return Promise.resolve({
          status: best === null ? 'NO_SCORE' : 'LOCAL',
          rank: best === null ? null : 1,
          score: best
        });
      }
      var opts = {};
      if (board !== undefined) { opts.board = board; }
      if (period !== undefined) { opts.period = period; }
      return callApi('getMyRank', opts).catch(function () {
        // 查询失败降级本机视角，保持 resolve 语义（与官方"业务态不走 fail"一致）
        var b2 = localBest(board);
        return { status: b2 === null ? 'NO_SCORE' : 'LOCAL', rank: b2 === null ? null : 1, score: b2 };
      });
    },

    // 主动失效云榜缓存（下拉刷新等场景）；本机记录是用户数据，不在清理范围
    clearCache: function () { rankListCache = {}; }
  };

  // 双轨挂载：window 全局 + ESM export（IIFE return 对象，勿直接 export 内部变量）
  var kit = {
    store: store,
    rank: rank,
    canCloudStore: store.can,
    canRank: rank.can,
    ERR: { // 错误码速查（官方 §3.16/§3.17 错误码表）
      ARGS: 10001, BATCH_LIMIT: 1002, CONTENT_TOO_LARGE: 1003, SCORE_RANGE: 1004,
      RANK_UNAUTHORIZED: 1005, STORE_UNAUTHORIZED: 1006, READ_FAIL: 2001,
      RANK_NOT_READY: 2002, PARTIAL_OK: 2003, WRITE_UNKNOWN: 2004,
      DUP_KEY: 2005, AUTH_UNAVAILABLE: 2008, RATE_LIMIT: 2009, INTERNAL: 2999, WHITELIST: 10003
    }
  };

  global.CloudKit = kit;
  return kit;
})(typeof window !== 'undefined' ? window : this);

export default CloudKit;

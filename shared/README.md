# shared/ — 跨仓共享运行时模块（真源）

| 文件 | 职责 |
|---|---|
| xhs-bridge.js | 平台能力唯一入口（版本探测/Storage/安全区/振动/媒体/社交 API） |
| cloud-kit.js | 云存储 + 统一排行榜门面（云优先 + 本机 TOP N 兜底，官方 §3.16/§3.17 内测 9.51+） |
| share-kit.js | 分享海报布局引擎 + 发笔记/评论区/关注编排 |
| asset-loader.js | 包内图片并行预加载 + @font-face 字体就绪 |
| page-router.js | 小程序多页面模型（App/Behavior/Page 构造器 + behaviors 合成 + 页面栈 + 自绘导航栏/tabBar） |
| wx-api-shim.js | wx.* 全局模拟（四层覆盖策略 + 键盘引擎 + canvas 适配器 + mockCloud 云离线化唯一落点） |
| wxml-runtime.js | WXML 运行时渲染引擎（表达式求值 / 锚点克隆渲染 / 事件路径遍历 / Component 系统） |
| ui-kit.js | wx.show* 系列（toast/modal/loading/actionSheet）纯 DOM 实现 |

**供给线**：前 4 件为跨形态平台层（游戏/小程序两线共用）；后 4 件为小程序线引擎件，由 `D:\miniprograms\RedNoteMiniTool` 供给（2026-11-09 上提），游戏线不消费，但清单内统一走同步脚本。

**真源规则**：本目录是唯一母本。消费方（`D:\games\RedNoteGame`、`D:\miniprograms\RedNoteMiniTool`）的 `_shared/` 是构建期副本，由各仓 `_tools/sync-shared.py`（本仓 `sync-shared.py` 的副本）同步：

```bash
# 改共享模块：在任一仓改 _shared/ → 回灌真源 → 另一仓拉取
python _tools/sync-shared.py <本仓绝对路径> --push     # 改动仓回灌
python _tools/sync-shared.py <另一仓绝对路径>          # 消费仓拉取
```

各业务仓 `_shared/README.md` 是该线的接入视图（含业务线专属模块说明），**不参与同步**；本文件的 API 级明细以各消费仓 README 为准，此处只登记清单与同步规则。

Chrome 61 / 纯离线 / IIFE 双轨导出（`window.Xxx` + ESM export）约束见消费仓 README 设计约束节。

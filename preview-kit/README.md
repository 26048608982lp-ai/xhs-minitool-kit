# preview-kit — 小工具/游戏本地预览壳（单份真源）

本地开发预览壳 v2：机型档位模拟 + 安全区遮挡 + 固定视口 scale 一屏 + 编辑区（调参桥/数值树）+ 截图。
本目录是**唯一真源**，业务仓经其 dev.mjs 的 `/_kit/` 静态映射直读本目录文件——**无副本、零同步义务**。

```
dev.html        壳骨架（两栏+顶栏通栏；参数化：URL query ?title=<品牌>&game=<id>）
shell.js        壳交互（scale 一屏/调参桥/截图分形态/config 树/品牌填充）
profiles.js     机型档位库（6 档+自定义；档位真值待真机回填，见文件内注释）
inject.js       iframe 侧 mock（window.xhs 模拟 + DPR 覆盖 + 安全区红条 overlay）
vendor/html2canvas.min.js  DOM 形态截图用（仅工具类懒加载，MIT）
```

## 业务仓接入（游戏类）

以游戏目录（nianhuo/guandong/naicha…）为单位，三处：

1. **dev.mjs**：静态服务加 `/_kit/` 映射（strip 前缀后 join 本目录，含越径防护），启动 URL 换成
   `/_kit/preview-kit/dev.html?title=<游戏名>&game=<目录名>`
2. **game-dev.html**：脚本引用改绝对路径 `/_kit/preview-kit/profiles.js`、`/_kit/preview-kit/inject.js`（bundle-dev 不变）
3. **preview/** 目录只留游戏专属件：`dev-entry.js`（import 顺序：tuning.js → src/main.js）、`tuning.js`（调参桥接端，import 游戏 data 层）、`bundle-dev.js`（构建产物）

游戏无需实现任何壳接口——不接 tuning.js 则调参面板自然无回执（不报错）。

## 业务仓接入（工具类，无 canvas 的 DOM 页面）

同游戏三处；差异：

- game-dev.html 换成工具入口（如 `index.html` 结构页 + 构建产物），iframe src 仍是 `/game-dev.html`（dev.mjs 根路径 fallback 已指向它）
- 无 `preview/tuning.js` → 调参面板不生效（正常）
- 无 `config/` → 数值面板显示「本工具无 config」提示；后续可接入自定义关键参数面板（规划中，借鉴 aigamedesign 键白名单摘要模式）
- 截图自动走 html2canvas 分支（shell.js 检测 iframe 内无 canvas 时懒加载 vendor）

## 数值显示（关键参数摘要）

数值 tab 默认显示**关键参数摘要卡**：白名单真源在业务仓 `config/schema.json` 顶层 `x-summary` 字段（`{域名: [{path, label, format}]}`，path 相对该域文件根、数字段=数组索引；format ∈ percent/multiplier/currency/seconds/plain）。值缺失的条目自动隐藏；完整 flatten 树折叠降级（搜索时自动展开）。业务仓无 schema/x-summary 时摘要区显示提示、树照常。此模式借鉴 aigamedesign 项目 SUMMARY_FIELDS 键白名单提取器。

## 状态与坐标约定

- 档位存 `localStorage.__dev_profile`（壳与 iframe 经它解耦通信）
- 调参存 iframe 侧 `sessionStorage.__dev_tuning`（协议：`dev-shell` 四命令 → `dev-tuning` state.info 回执，见 shell.js 头注）
- safeTop 口径 = max(状态栏, 原生按钮底+8)（与 `_shared/xhs-bridge.js` 一致）

## 版本

- v3 2026-11-09 preview-kit 单份参数化（真源落本目录，业务仓删副本改映射）；截图分形态（canvas 直取/html2canvas 懒加载）
- v2 2026-11-09 两栏+顶栏通栏/scale 一屏/postMessage 调参桥/截图/config 树（业务仓副本时代）
- v1 2026-10-30 初版档位壳（nianhuo 首例，机制详见 RedNoteGame `nianhuo/docs/本地预览器方案.md`）

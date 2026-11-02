# 小红书小工具构建踩坑实录（gotchas）

> 全部为作者实测（2026-10，Windows 11 + PowerShell 5.1 / Python 3.12 / Chrome 156），非转述。
> 每条附：现象 → 根因 → 修法。本文件也是配套四件套工具的设计依据。

## 坑 1：PowerShell 打的 zip 被平台拒收

- **现象**：`Compress-Archive` 打包上传，平台直接拒收，提示包格式问题。
- **根因**：PowerShell 5.1 的 `Compress-Archive` 写入的条目名用反斜杠（`css\main.css`）。zip 规范（APPNOTE）规定条目名用正斜杠；平台解包校验通不过反斜杠条目。
- **修法**：两选一——
  1. .NET `System.IO.Compression.ZipArchive` 逐条目 `CreateEntry('css/main.css')`（PowerShell 内）
  2. Python `zipfile`（`zf.write(abs_p, arcname)` 传入正斜杠名即所得）——本库 `pack.py` 即此方案，并在打包后**回读验证**（无反斜杠 / index.html 在根 / 条目数一致）。
- **教训**：打完包一定回读 `namelist()` 检查，别信打包工具。

## 坑 2：mp3 打进包 → 拒收

- **现象**：2026-10-29 实测，含 `.mp3` 的包被拒收。
- **根因**：平台 zip 白名单只有 `.html/.css/.js/图片/.woff·woff2/.json`，**不含任何音频格式**。
- **修法**：BGM/音效在构建期 base64 内嵌进 JS（如 `window.__BGM_B64` 模式），打包器对音频扩展名直接拦截并提示（`pack.py` 的 `EXCLUDE_EXT` + SKIP 日志）。
- **教训**：音频不是"塞进包"的问题，是管线问题——构建期处理，不是打包期侥幸。

## 坑 3：可选链 `?.` 直接 SyntaxError 白屏

- **现象**：本地 Chrome 跑得好好的，进了平台白屏。
- **根因**：小工具 JS 基线 **ES2017（Chrome 61）**。`a?.b`、`a ?? b` 在 Chrome 61 是语法错误——不是运行时兼容问题，是**解析期直接炸**，整个 js 文件不执行。
- **修法**：
  1. 构建期转译：esbuild `--target=chrome61`，源码随便写新语法
  2. 无构建的小工具：判空一律 `a && a.b`
- **教训**：别拿"我浏览器能跑"当判据；本地起一个 Chrome 61 级别的环境或者直接用 `scan.py` 扫（OPT_CHAIN/NULLISH 检查项）。

## 坑 4：内联 script / 行内事件被 CSP 拦

- **现象**：`<script>...</script>` 不执行、`onclick=` 无反应，console 报 CSP 违规。
- **根因**：平台 CSP 禁内联 `<script>`、行内事件（`onclick=`）、`javascript:` URI、`eval`/`new Function`。
- **修法**：JS 一律外置 `.js` 用 `<script src>` 引入；事件用 `addEventListener`。
- **教训**：从别的页面搬代码时，`onclick=` 是最高频的迁移雷。

## 坑 5：任何网络请求都是雷

- **现象**：加载外部图片/字体/API 的代码在平台内静默失败或报错。
- **根因**：小工具**纯离线硬约束**——fetch/XHR/WebSocket/SSE/外部图片/CDN 字体全部禁用；媒体类端 API 只收 `data:` base64 或本地 filePath。
- **修法**：所有资源打包在工具内；`scan.py` 对打包范围内的 js/html 扫 FETCH/XHR/WEBSOCKET/SSE/EXTERNAL_URL（放行 127.0.0.1/localhost 供本地调试）。

## 附：平台端能力速览

`window.xhs.miniTool`（判空降级使用），**按客户端版本分层**（9.42→9.51+），Storage 有限额、AI 文本生成需加白。明细以官方文档为准：<https://miniapp-sandbox.xiaohongshu.com/minitool/doc>

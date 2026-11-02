# xhs-minitool-kit

小红书小工具（minitool）**构建合规工具四件套**：扫得了禁令、打得出平台肯收的 zip、验得动最终表现。纯 Python 标准库，零依赖（仅 verify 需要 playwright）。

## 为什么存在

小红书小工具是跑在受限沙箱里的**纯离线 Web 静态包**，平台审核会直接拒收不合规的包。以下约束全部来自实测（详见 [docs/gotchas.md](docs/gotchas.md)）：

| 约束 | 踩坑后果 |
|---|---|
| zip 条目名必须正斜杠 | PowerShell `Compress-Archive` 打出的包（`css\main.css`）**直接拒收** |
| zip 白名单**不含任何音频格式** | mp3 打进包 → **拒收**；BGM 须 base64 内嵌进 JS |
| JS 基线 ES2017（Chrome 61） | 可选链 `?.` / 空值合并 `??` → **直接 SyntaxError 白屏** |
| CSP：禁内联 script / 行内事件 / eval | `onclick=`、内联 `<script>` → 运行时被拦 |
| 纯离线 | fetch/XHR/外部 URL/CDN 字体一律禁用 |

官方文档：https://miniapp-sandbox.xiaohongshu.com/minitool/doc

## 快速开始

```bash
# 1. 扫描（五禁令 + ES2017 语法 + 文件白名单，扫的就是打包范围）
python scan.py <工具根目录>        # 根目录 = 含 index.html 的目录

# 2. 打包（正斜杠条目 + 音频拦截 + 回读验证）
python pack.py <工具根目录> 输出.zip

# 3. 一键链：build(可选) → scan → pack → 体积清单
python release.py <工具根目录>     # 目录下有 build.mjs 会先 node build.mjs

# 4. 无头终验：手机竖屏加载 + 截图 + console 收集（需 pip install playwright，优先用系统 Chrome）
python verify.py http://127.0.0.1:8080/index.html home 195,700
```

## 工具明细

| 工具 | 干什么 | 依赖 |
|---|---|---|
| `scan.py` | 五禁令（fetch/XHR/WebSocket/SSE/eval/new Function）+ CSP（内联 script/行内事件/iframe）+ ES2017 语法（`?.` `??` ESM）+ 外部 URL + 文件白名单 | 无 |
| `pack.py` | 只装 `index.html + js/ + assets/ + css/`，正斜杠条目，音频格式拦截，回读验证 | 无 |
| `release.py` | build（存在 build.mjs 才跑）→ scan → pack → 体积清单（assets >4MB 提醒压缩） | 无 |
| `verify.py` | 无头 Chromium 390×844 加载、按坐标点击、截图、console error 收集 | playwright（优先系统 Chrome，无则 `playwright install chromium`） |

## 立场声明

- 本工具集随作者自己的小红书小工具游戏迭代而更新，**as-is** 提供，不承诺响应 SLA
- 平台规则会变（版本分层 9.42→9.51+ 已发生多次），以官方文档为准；规则变了欢迎提 issue

## License

[MIT](LICENSE)

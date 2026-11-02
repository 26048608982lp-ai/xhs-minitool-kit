# -*- coding: utf-8 -*-
"""小红书小工具合规扫描器：五禁令 + ES2017 语法 + 文件白名单

用法: python scan.py <工具根目录>
  工具根目录 = 含 index.html 的目录（即 zip 的根）
扫描范围与 pack.py 打包白名单精确对齐：index.html + js/ + assets/ + css/
—— 其它文件（src/、docs/ 等）不进 zip，不在扫描范围
"""
import argparse
import os
import re
import sys

sys.stdout.reconfigure(encoding="utf-8")

ALLOWED_EXT = {".html", ".css", ".js", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".woff", ".woff2", ".json"}
INCLUDE_TOP = ["index.html"]
INCLUDE_DIRS = ["js", "assets", "css"]
# 平台 zip 白名单不含音频（实测拒收 mp3）：pack 会跳过这些文件不进包。
# 音频是 BGM base64 管线的合法源原料（构建期内嵌进 JS），故此处 WARN 提示而非 FAIL。
EXCLUDE_EXT = (".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac")


def collect(root):
    """与 pack.py 相同的白名单收集（存在才扫）"""
    files = []
    for top in INCLUDE_TOP:
        fp = os.path.join(root, top)
        if os.path.isfile(fp):
            files.append(os.path.relpath(fp, root))
    for d in INCLUDE_DIRS:
        dp = os.path.join(root, d)
        if not os.path.isdir(dp):
            continue
        for dirpath, _, filenames in os.walk(dp):
            for fn in filenames:
                files.append(os.path.relpath(os.path.join(dirpath, fn), root))
    return files


def scan(root):
    issues, warns, checked = [], [], 0
    if not os.path.isfile(os.path.join(root, "index.html")):
        issues.append("FATAL: index.html 不存在于工具根目录")
    for rel in collect(root):
        fn = os.path.basename(rel)
        ext = os.path.splitext(fn)[1].lower()
        fp = os.path.join(root, rel)
        if ext in EXCLUDE_EXT:
            warns.append(f"AUDIO_SKIP: {rel} 不会进包（平台拒收音频）——若为 BGM/音效源料，确认已 base64 内嵌进 JS")
            continue
        if ext not in ALLOWED_EXT:
            issues.append(f"WHITELIST: {rel} 扩展名 {ext} 不在白名单")
            continue
        if ext in (".html", ".js", ".css", ".json"):
            checked += 1
            try:
                text = open(fp, encoding="utf-8", errors="ignore").read()
            except Exception as e:
                issues.append(f"READ_ERR: {rel} {e}")
                continue
            if ext == ".html":
                for m in re.finditer(r"<script(?![^>]*\bsrc=)[^>]*>", text, re.I):
                    issues.append(f"INLINE_SCRIPT: {rel} 内联 script 标签")
                for m in re.finditer(r"\son\w+\s*=", text):
                    issues.append(f"INLINE_EVENT: {rel} 行内事件 {m.group(0)}")
                if "javascript:" in text.lower():
                    issues.append(f"JS_URI: {rel} 含 javascript: URI")
                if re.search(r"<iframe", text, re.I):
                    issues.append(f"IFRAME: {rel} 含 iframe")
            if ext in (".js", ".html"):
                for pat, name in [
                    (r"\bfetch\s*\(", "FETCH"),
                    (r"\bXMLHttpRequest\b", "XHR"),
                    (r"\bWebSocket\b", "WEBSOCKET"),
                    (r"\bEventSource\b", "SSE"),
                    (r"\bnew\s+Function\b", "NEW_FUNCTION"),
                    (r"(?<![\w.])eval\s*\(", "EVAL"),
                    (r"(?<![\"\w])\?\.(?![\"'])", "OPT_CHAIN"),
                    (r"(?<![\"\w])\?\?(?![\"'])", "NULLISH"),
                    (r"^\s*import\s+[{'\"]", "ESM_IMPORT"),
                    (r"^\s*export\s+(default|const|let|var|function|class|\{)", "ESM_EXPORT"),
                    (r"https?://(?!127\.0\.0\.1|localhost)[\w.-]+", "EXTERNAL_URL"),
                ]:
                    for i, line in enumerate(text.splitlines(), 1):
                        if re.search(pat, line):
                            issues.append(f"{name}: {rel}:{i} {line.strip()[:90]}")
    return issues, warns, checked


def main():
    ap = argparse.ArgumentParser(description="小红书小工具合规扫描（五禁令 + ES2017 + 白名单）")
    ap.add_argument("tool_dir", help="工具根目录（zip 根，含 index.html）")
    args = ap.parse_args()

    root = args.tool_dir.rstrip("/\\")
    issues, warns, checked = scan(root)
    print(f"扫描目录: {root}（文本文件 {checked} 个）")
    for w in warns:
        print("  WARN " + w)
    if not issues:
        print("RESULT: PASS — 无违规项")
        sys.exit(0)
    print(f"RESULT: FAIL — {len(issues)} 个问题")
    seen = set()
    for i in issues:
        if i not in seen:
            print("  " + i)
            seen.add(i)
    sys.exit(1)


if __name__ == "__main__":
    main()

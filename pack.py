# -*- coding: utf-8 -*-
"""小红书小工具 zip 打包器（正斜杠条目 + 平台可收的包）

- 只装运行时产物：index.html + js/ + assets/ + css/（存在才装）
- 条目名一律正斜杠（python zipfile 写入名即所得）
- 音频格式不进包（平台 zip 白名单不含音频，实测拒收 mp3）——BGM/音效须 base64 内嵌进 JS
- 回读验证：无反斜杠、index.html 在根、条目数一致

用法: python pack.py <工具根目录> <输出zip>
"""
import argparse
import os
import sys
import zipfile

sys.stdout.reconfigure(encoding="utf-8")

INCLUDE_TOP = ["index.html"]
INCLUDE_DIRS = ["js", "assets", "css"]
EXCLUDE_EXT = (".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac")


def main():
    ap = argparse.ArgumentParser(description="小红书小工具 zip 打包（正斜杠 + 回读验证）")
    ap.add_argument("tool_dir", help="工具根目录（zip 根，含 index.html）")
    ap.add_argument("output", help="输出 zip 路径")
    args = ap.parse_args()

    tool_dir = args.tool_dir.rstrip("/\\")
    zip_path = args.output

    if not os.path.isfile(os.path.join(tool_dir, "index.html")):
        print(f"FATAL: index.html 不存在于 {tool_dir}")
        sys.exit(1)

    entries = []
    for top in INCLUDE_TOP:
        p = os.path.join(tool_dir, top)
        if os.path.isfile(p):
            entries.append((p, top))
    for d in INCLUDE_DIRS:
        dp = os.path.join(tool_dir, d)
        if not os.path.isdir(dp):
            continue
        for root, _, files in os.walk(dp):
            for fn in files:
                if fn.lower().endswith(EXCLUDE_EXT):
                    print(f"  SKIP(音频不支持): {fn}")
                    continue
                abs_p = os.path.join(root, fn)
                rel = os.path.relpath(abs_p, tool_dir).replace("\\", "/")
                entries.append((abs_p, rel))

    if os.path.exists(zip_path):
        os.remove(zip_path)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for abs_p, arcname in entries:
            zf.write(abs_p, arcname)

    # 回读验证
    with zipfile.ZipFile(zip_path) as zf:
        names = zf.namelist()
        bad = [n for n in names if "\\" in n]
        assert not bad, f"反斜杠条目: {bad[:3]}"
        assert "index.html" in names, "zip 根缺 index.html"
        assert len(names) == len(entries), "条目数不一致"
        total_uncompressed = sum(i.file_size for i in zf.infolist())

    size_kb = os.path.getsize(zip_path) // 1024
    print(f"PACK OK: {zip_path}")
    print(f"  {len(names)} 条目 / {size_kb} KB 压缩 / {total_uncompressed//1024} KB 原始 — 全正斜杠，index.html 在根")
    for n in names:
        print(f"  - {n}")


if __name__ == "__main__":
    main()

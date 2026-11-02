# -*- coding: utf-8 -*-
"""release.py — 一键发布链：build(可选) → scan → pack（任一步失败即停）

用法: python release.py <工具根目录> [--out 输出.zip]
  工具根目录下若存在 build.mjs，会先执行 `node build.mjs`（构建钩子约定，无则跳过）
产物: 正斜杠条目的 zip，平台可直接上传
"""
import argparse
import os
import subprocess
import sys
import zipfile

sys.stdout.reconfigure(encoding="utf-8")

TOOLS = os.path.dirname(os.path.abspath(__file__))


def run(step, cmd, cwd):
    print(f"\n=== [{step}] {' '.join(cmd)} ===")
    r = subprocess.run(cmd, cwd=cwd)
    if r.returncode != 0:
        print(f"STOP: {step} 失败 (exit {r.returncode})")
        sys.exit(1)


def main():
    ap = argparse.ArgumentParser(description="一键发布链：build(可选) → scan → pack + 体积清单")
    ap.add_argument("tool_dir", help="工具根目录（zip 根，含 index.html）")
    ap.add_argument("--out", help="输出 zip 路径（默认 <目录名>.zip 在当前工作目录）")
    args = ap.parse_args()

    tool_dir = os.path.abspath(args.tool_dir).rstrip("\\")
    if not os.path.isdir(tool_dir):
        print(f"FATAL: 目录不存在 {tool_dir}")
        sys.exit(1)
    zip_path = os.path.abspath(args.out) if args.out else \
        os.path.join(os.getcwd(), os.path.basename(tool_dir) + ".zip")

    # ① 构建（可选钩子：存在 build.mjs 才跑）
    if os.path.isfile(os.path.join(tool_dir, "build.mjs")):
        run("build", ["node", "build.mjs"], tool_dir)
    else:
        print("\n=== [build] 无 build.mjs，跳过 ===")

    # ② 合规扫描（五禁令 + ES2017 + 白名单，扫打包范围）
    run("scan", [sys.executable, os.path.join(TOOLS, "scan.py"), tool_dir], tool_dir)

    # ③ 打包（index.html + js/ + assets/ + css/ → zip）
    run("pack", [sys.executable, os.path.join(TOOLS, "pack.py"), tool_dir, zip_path], tool_dir)

    # ④ 体积清单（包内资产是体积大头；平台未公开硬限额，>4MB 给压缩建议）
    with zipfile.ZipFile(zip_path) as zf:
        items = sorted(zf.infolist(), key=lambda i: -i.file_size)
    total = sum(i.file_size for i in items)
    print(f"\n体积清单（原始 {total/1024:.0f} KB / 压缩 {os.path.getsize(zip_path)/1024:.0f} KB）:")
    for i in items[:5]:
        print(f"  {i.file_size/1024:8.1f} KB  {i.filename}")
    if len(items) > 5:
        print(f"  ... 其余 {len(items)-5} 项")
    img_total = sum(i.file_size for i in items if "/assets/" in i.filename)
    if img_total > 4 * 1024 * 1024:
        print(f"  ⚠ assets/ 共 {img_total/1024/1024:.1f} MB：建议压缩图片（webp/降分辨率）后重新发布")
    print(f"\nRELEASE OK: {zip_path} — 可走上传提审流程")


if __name__ == "__main__":
    main()

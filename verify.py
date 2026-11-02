# -*- coding: utf-8 -*-
"""小工具终验：无头浏览器加载 + 截图 + console 收集

用法: python verify.py <url> <name> [x,y ...] [--out 目录]
  例: python verify.py http://127.0.0.1:8080/index.html home 195,700
依赖: pip install playwright（仅本工具需要；scan/pack/release 零依赖）
输出: <out>/<name>-1.png（初始）、<name>-c<N>.png（每次点击后）、console 报告
"""
import argparse
import os
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")
from playwright.sync_api import sync_playwright


def main():
    ap = argparse.ArgumentParser(description="无头终验：加载 + 截图 + console 收集（手机竖屏 390x844）")
    ap.add_argument("url", help="要加载的 URL（如 http://127.0.0.1:8080/index.html）")
    ap.add_argument("name", help="截图名前缀")
    ap.add_argument("clicks", nargs="*", default=[], help="点击坐标，格式 x,y（可多个）")
    ap.add_argument("--out", default="verify-out", help="截图输出目录（默认 ./verify-out）")
    args = ap.parse_args()

    clicks = []
    for a in args.clicks:
        x, y = a.split(",")
        clicks.append((int(x), int(y)))

    os.makedirs(args.out, exist_ok=True)

    with sync_playwright() as pw:
        b = pw.chromium.launch(headless=True)
        page = b.new_page(viewport={"width": 390, "height": 844})  # 手机竖屏
        errors, logs = [], []
        page.on("console", lambda m: (errors if m.type == "error" else logs).append(m.text[:200]))
        page.on("pageerror", lambda e: errors.append("PAGEERROR: " + str(e)[:200]))
        try:
            page.goto(args.url, wait_until="domcontentloaded", timeout=30000)
        except Exception as e:
            print("GOTO_ERR", e)
        page.wait_for_timeout(4000)
        page.screenshot(path=os.path.join(args.out, f"{args.name}-1.png"))
        print(f"shot1 saved; console errors={len(errors)}")
        for i, (x, y) in enumerate(clicks):
            page.mouse.click(x, y)
            page.wait_for_timeout(2500)
            page.screenshot(path=os.path.join(args.out, f"{args.name}-c{i+1}.png"))
            print(f"click({x},{y}) -> shot c{i+1}")
        print("=== CONSOLE ERRORS ===")
        for e in errors[:20]:
            print("  " + e)
        print(f"=== total errors: {len(errors)}, logs: {len(logs)} ===")
        b.close()


if __name__ == "__main__":
    main()

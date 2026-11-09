# -*- coding: utf-8 -*-
"""sync-shared.py — 跨仓共享模块同步器（真源：本仓 shared/ → 各业务仓 _shared/）

背景：RedNoteGame（游戏线）与 RedNoteMiniTool（小程序线）各自维护 _shared/ 副本，
真源统一在本仓（xhs-minitool-kit）shared/。本脚本三仓皆有 git，覆盖操作永远可 diff/revert 回滚。

用法（在任一业务仓根目录执行其 _tools/ 下的副本）:
  python _tools/sync-shared.py <业务仓绝对路径>          # pull：真源 → 业务仓 _shared/
  python _tools/sync-shared.py <业务仓绝对路径> --push    # push：业务仓 _shared/ → 真源（改完共享模块回灌）

工作流约定：
  改共享模块的正确姿势：在任一仓改 _shared/ → sync-shared.py --push 回灌真源
                       → 到另一仓 sync-shared.py 拉取 → 两仓各自 git commit
  🔴 不改清单内的文件名（SHARED_FILES）；各仓 _shared/README.md 是业务线视图，不参与同步
"""
import hashlib
import shutil
import sys
from pathlib import Path

KIT_ROOT = Path(r"D:\dev\xhs-minitool-kit")
SHARED_SRC = KIT_ROOT / "shared"
# 共享清单（真源 ↔ 业务仓 _shared 同名直拷）
# 前 4 件=跨形态平台层（游戏/小程序两线共用）；后 4 件=小程序线引擎件（2026-11-09 上提真源，RedNoteGame 不消费）
SHARED_FILES = [
    "xhs-bridge.js", "cloud-kit.js", "share-kit.js", "asset-loader.js",
    "page-router.js", "wx-api-shim.js", "wxml-runtime.js", "ui-kit.js",
]


def sha256(p: Path) -> str:
    if not p.exists():
        return "-"
    return hashlib.sha256(p.read_bytes()).hexdigest()[:12]


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    dest_root = Path(sys.argv[1])
    dest_shared = dest_root / "_shared"
    if not dest_shared.is_dir():
        print(f"FATAL: {dest_shared} 不存在（应在业务仓根目录执行）")
        return 1
    push = "--push" in sys.argv[2:]

    src_dir, dst_dir = (dest_shared, SHARED_SRC) if push else (SHARED_SRC, dest_shared)
    arrow = "业务仓 → 真源" if push else "真源 → 业务仓"
    print(f"sync-shared（{arrow}）  真源: {SHARED_SRC}")

    changed, same, missing = [], [], []
    for name in SHARED_FILES:
        s, d = src_dir / name, dst_dir / name
        if sha256(s) == sha256(d):
            same.append(name)
            continue
        if not s.exists():
            missing.append(f"{name}（源缺失，跳过）")
            continue
        dst_dir.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(s, d)
        changed.append(f"{name}: {sha256(d)} → {sha256(s)}")

    for line in changed:
        print(f"  覆盖 {line}")
    for line in missing:
        print(f"  ⚠ {line}")
    print(f"完成: 覆盖 {len(changed)} / 一致 {len(same)} / 异常 {len(missing)}")
    if changed:
        print("（覆盖后请 git diff 复核再提交；误覆盖可 git checkout -- 恢复）")
    return 0


if __name__ == "__main__":
    sys.exit(main())

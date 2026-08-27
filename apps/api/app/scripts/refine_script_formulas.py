from __future__ import annotations

import argparse

from app.db.session import init_db
from app.services.script_library_batch_service import refine_existing_formula_library


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="基于已有公式卡重新梳理公式库，不重新蒸馏原剧。")
    parser.add_argument("--batch-size", type=int, default=8)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    init_db()
    formulas = refine_existing_formula_library(batch_size=max(2, args.batch_size))
    print({"formulas": len(formulas)}, flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

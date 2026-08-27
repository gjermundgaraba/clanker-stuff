#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from suites.longmemeval.longmemeval import prepare


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(
        description="Generate the pinned LongMemEval v2 Harbor conditions"
    )
    parser.add_argument("--cache-dir", type=Path)
    parser.add_argument("--manifest", type=Path, default=root / "longmemeval.json")
    parser.add_argument(
        "--output-dir", type=Path, default=root / "generated"
    )
    args = parser.parse_args()
    count = prepare(args.manifest, args.output_dir, args.cache_dir)
    print(f"generated {count} LongMemEval v2 Harbor tasks in {args.output_dir}")


if __name__ == "__main__":
    main()

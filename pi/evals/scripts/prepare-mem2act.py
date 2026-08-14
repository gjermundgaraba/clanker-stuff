#!/usr/bin/env python3

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

from pi_evals.mem2act import main


if __name__ == "__main__":
    main()

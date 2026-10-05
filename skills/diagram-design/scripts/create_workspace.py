#!/usr/bin/env python3
"""Create a diagram workspace and print only its absolute path to stdout."""

import argparse
from datetime import date
from pathlib import Path
import re
import tempfile
import unicodedata


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Create a unique workspace under /tmp/diagram-design/YYYY-MM-DD/."
    )
    parser.add_argument("topic", nargs="?", default="diagram", help="short task topic")
    args = parser.parse_args()

    topic = unicodedata.normalize("NFKD", args.topic).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", "-", topic.lower()).strip("-")[:48].rstrip("-")
    slug = slug or "diagram"
    parent = Path("/tmp/diagram-design") / date.today().isoformat()
    try:
        parent.mkdir(parents=True, exist_ok=True)
        workspace = tempfile.mkdtemp(prefix=f"{slug}-", dir=parent)
    except OSError as error:
        parser.exit(1, f"Could not create diagram workspace: {error}\n")
    print(workspace)


if __name__ == "__main__":
    main()

"""Export the isolated Voice-only host worktree, never a live Desktop install."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess

BASE = "bf0203a794a07aac3ff764972ab9087baa4e4f4e"


def git(source: Path, *args: str) -> bytes:
    return subprocess.check_output(["git", "-C", str(source), *args])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True, help="Isolated Hermes Voice-only worktree")
    args = parser.parse_args()
    source = args.source.resolve(strict=True)
    if git(source, "rev-parse", "HEAD").decode().strip() != BASE:
        parser.error("Host worktree HEAD must match the pinned base exactly")
    root = Path(__file__).resolve().parent
    declared = set(json.loads((root / "source-paths.json").read_text()))
    for item in declared:
        path = Path(item)
        if path.is_absolute() or ".." in path.parts or not item.startswith(("apps/desktop/", "website/docs/")):
            parser.error("Unsafe or unrelated source path in integration manifest")
        if not (source / path).is_file() or (source / path).is_symlink():
            parser.error("Missing or symlinked host source")
    # Intent-to-add is confined to this user-specified detached worktree. No commits.
    git(source, "add", "--intent-to-add", "--", *sorted(declared))
    changes = set(git(source, "diff", "--name-only").decode().splitlines())
    if not changes <= declared:
        parser.error("Worktree contains unrelated changes; use a clean isolated Voice worktree")
    patch = git(source, "diff", "--binary", "--full-index", "--", *sorted(declared))
    if not patch:
        parser.error("No Voice integration changes to export")
    output = root / "native-duplex-host.patch"
    output.write_bytes(patch)
    receipt = {
        "hostBase": BASE,
        "patchSha256": hashlib.sha256(patch).hexdigest(),
        "changedFiles": sorted(changes),
        "files": {name: hashlib.sha256((source / name).read_bytes()).hexdigest() for name in sorted(changes)},
        "integrationScope": "native-live-voice",
        "liveAppModified": False,
    }
    (root / "host-compatibility.json").write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"files": len(changes), "patchSha256": receipt["patchSha256"]}))


if __name__ == "__main__":
    main()

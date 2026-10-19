#!/usr/bin/env python3
"""Create a shareable source-only ZIP; no runtime data or dependencies."""
import argparse
import json
import sys
import zipfile
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from firstcue_lib import VERSION


def package(root, output):
    root, output = Path(root).resolve(), Path(output).resolve()
    files = []
    for file in root.rglob("*"):
        if not file.is_file():
            continue
        parts = file.relative_to(root).parts
        allowed = (len(parts) == 1 and parts[0] in {"SKILL.md", ".env.example", ".gitignore"}
                   or parts[0] == "references" and file.suffix == ".md"
                   or parts[0] == "agents" and file.suffix in {".yaml", ".yml"}
                   or parts[0] in {"scripts", "tests"} and file.suffix == ".py"
                   or parts[:2] == ("tests", "fixtures") and file.suffix == ".json")
        if not allowed or "__pycache__" in parts:
            continue
        if file.is_symlink() or not file.resolve().is_relative_to(root):
            raise ValueError("Refusing a symlink or source path outside the skill")
        files.append(file)
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "x", zipfile.ZIP_DEFLATED) as archive:
        for file in sorted(files):
            archive.write(file, "firstcue-monitor/" + file.relative_to(root).as_posix())
    with zipfile.ZipFile(output) as archive:
        if archive.testzip() is not None:
            raise ValueError("ZIP integrity check failed")
        names = archive.namelist()
        if "firstcue-monitor/SKILL.md" not in names or "firstcue-monitor/scripts/firstcue.py" not in names:
            raise ValueError("ZIP is missing skill entrypoints")
    return {"version": VERSION, "outputFile": str(output), "files": len(files), "bytes": output.stat().st_size}


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default=str(root.parent / "releases" / f"firstcue-monitor-v{VERSION}.zip"))
    args = parser.parse_args()
    print(json.dumps(package(root, args.out), ensure_ascii=False, indent=2))

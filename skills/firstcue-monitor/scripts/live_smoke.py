#!/usr/bin/env python3
"""Explicit public-network smoke test, without secrets, state or messages."""
import argparse
import json
import os
import sys
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from firstcue_lib.collect import Collector
from firstcue_lib.core import initial_state, safe_error
from firstcue_lib.http import PublicHTTP


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", choices=("openai", "bing", "sogou"), default="openai")
    flags = parser.parse_args()
    state = initial_state()
    state["settings"].update(readPerRunLimit=1, searchPerRunLimit=1)
    env = {k: os.environ[k] for k in ("HTTPS_PROXY", "HTTP_PROXY") if os.environ.get(k)}
    http = PublicHTTP(state, env)
    try:
        result = Collector(state, http, env=env).collect(query="AI coding agents", source_id=flags.source)
        print(json.dumps({"run": result["run"], "savedEvidence": len(state["evidence"]),
              "sample": [{k: item.get(k) for k in ("id", "title", "url", "publishedAt", "contentKind", "readError")} for item in result["items"][:3]],
              "notes": "Public network only; no paid APIs, model calls, messages or persisted state."}, ensure_ascii=False, indent=2))
        return 1 if result["run"]["status"] == "failed" else 0
    except (ValueError, OSError) as error:
        print(json.dumps({"error": safe_error(error, env)}), file=sys.stderr)
        return 1
    finally:
        http.close()


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    sys.exit(main())

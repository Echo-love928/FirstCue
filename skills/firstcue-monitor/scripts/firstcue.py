#!/usr/bin/env python3
"""FirstCue v2 CLI. Python 3.10+; no pip, npm, server or model API."""
import argparse
import contextlib
import json
import os
import platform
import sys
import time
from pathlib import Path

sys.dont_write_bytecode = True
if sys.version_info < (3, 10):
    sys.exit("FirstCue requires Python 3.10 or newer")
sys.path.insert(0, str(Path(__file__).resolve().parent))

from firstcue_lib import VERSION
from firstcue_lib.analysis import record_report, render_report, select_evidence, stale_event
from firstcue_lib.collect import Collector, read_original
from firstcue_lib.core import (ingest, load_env, new_id, now_iso, read_json, read_state,
                               safe_error, save_state, state_lock, string, timestamp,
                               validate_entity, validate_settings)
from firstcue_lib.http import PublicHTTP, public_url
from firstcue_lib.notify import notify, valid_webhook
from firstcue_lib.parsing import evidence

SKILL_ROOT = Path(__file__).resolve().parent.parent
ACTIONS = {"rules": {"list", "add", "update", "pause", "resume", "delete"},
           "sources": {"list", "add", "update", "pause", "resume", "delete"},
           "accounts": {"list", "add", "update", "pause", "resume", "delete"},
           "config": {"show", "set"}, "evidence": {"list", "show"},
           "reports": {"list", "record", "show", "render"}, "notifications": {"list", "show"},
           "notify": {"preview", "send", "retry"}}


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError(message)


def parser():
    p = Parser(description="FirstCue hotspot skill: Python standard library only; host AI supplies analysis")
    p.add_argument("command", nargs="?", default="doctor", help="doctor, help, init, status, config, rules, sources, accounts, collect, read, evidence, reports, notifications, notify")
    p.add_argument("action", nargs="?")
    for key in ("data-dir", "env-file", "out", "json", "file", "name", "query", "kind", "id", "url", "user-name", "rule", "source", "search", "report", "channel"):
        p.add_argument("--" + key)
    for key in ("hours", "limit", "offset"):
        p.add_argument("--" + key, type=int)
    p.add_argument("--sort", choices=("heat", "published", "discovered"), default="heat")
    for key in ("notify", "history", "unreviewed", "audit", "due", "refresh", "network"):
        p.add_argument("--" + key, action="store_true")
    return p


def required(value, name):
    if not value:
        raise ValueError(f"Missing {name}")
    return value


def number(value, default, low, high):
    value = default if value is None else value
    if type(value) is not int or not low <= value <= high:
        raise ValueError(f"Expected integer {low}..{high}")
    return value


def payload(flags):
    if bool(flags.json) == bool(flags.file):
        raise ValueError("Provide exactly one of --json or --file")
    value = read_json(flags.file) if flags.file else json.loads(flags.json)
    if not isinstance(value, dict):
        raise ValueError("JSON input must be an object")
    return value


def configured(env):
    return {"x": bool(env.get("TWITTERAPI_IO_KEY")),
            "mail": all(env.get(k) for k in ("SMTP_HOST", "SMTP_USER", "SMTP_PASS", "SMTP_FROM", "NOTIFY_EMAIL")),
            "feishu": valid_webhook(env.get("FEISHU_WEBHOOK_URL")), "feishuSigning": bool(env.get("FEISHU_SIGNING_SECRET")),
            "proxy": bool(env.get("HTTPS_PROXY") or env.get("HTTP_PROXY")), "ai": "host-agent"}


def help_info():
    return {"name": "FirstCue standalone skill", "version": VERSION,
            "usage": "python <skill>/scripts/firstcue.py <command> [action] [options]",
            "commands": {"doctor": "Environment check; --network adds one public RSS request",
                         "init": "Create independent state; no network calls", "status": "Configuration flags, usage, runs and due targets",
                         "config": "show | set --json PATCH (or --file FILE)",
                         "rules": "list | add --name NAME --query QUERY [--kind keyword|topic] [--notify] | update --id ID --json PATCH | pause|resume|delete --id ID",
                         "sources": "list | add --name NAME --kind rss|page --url URL | update --id ID --json PATCH | pause|resume|delete --id ID",
                         "accounts": "list | add --user-name NAME | update --id ID --json PATCH | pause|resume|delete --id ID",
                         "collect": "[--query TEXT | --rule ID] [--source ID] [--hours 1..120] [--due] [--refresh] [--out FILE]",
                         "read": "--url URL (read an original page for host verification)",
                         "evidence": "list [--source ID] [--rule ID] [--search TEXT] [--history] [--hours N] [--sort heat|published|discovered] [--limit 1..100] [--offset N] [--unreviewed] [--audit] | show --id ID",
                         "reports": "list | record --file JSON | show --id ID | render --id ID [--out FILE]",
                         "notifications": "list | show --id ID", "notify": "preview|send --report ID --channel mail|feishu | retry --id ID"},
            "globalOptions": {"--data-dir PATH": "Default <skill>/.firstcue", "--env-file PATH": "Default <skill>/.env; process env wins", "--out PATH": "Save JSON result or Markdown for reports render"},
            "analysis": "The invoking AI analyzes evidence. No model API is called.", "dependencies": "Python 3.10+ standard library only"}


def main(args=None):
    flags = parser().parse_args(args)
    command = flags.command
    if command == "help":
        return help_info()
    if command not in {*ACTIONS, "doctor", "init", "status", "collect", "read"}:
        raise ValueError("Unknown command: " + command)
    action = flags.action or ("show" if command == "config" else "preview" if command == "notify" else "list")
    if command in ACTIONS and action not in ACTIONS[command] or command not in ACTIONS and flags.action:
        raise ValueError("Unknown action for " + command)
    directory = Path(flags.data_dir or SKILL_ROOT / ".firstcue").resolve()
    env_file = Path(flags.env_file or SKILL_ROOT / ".env").resolve()
    file_env = load_env(env_file) if env_file.exists() else {}
    if flags.env_file and not env_file.exists():
        raise ValueError("Explicit environment file does not exist")
    env = {**file_env, **os.environ}
    readonly = (command in {"doctor", "status", "evidence", "notifications"}
                or command in {"rules", "sources", "accounts", "config", "reports"} and action in {"list", "show", "render"}
                or command == "notify" and action == "preview")
    try:
        with contextlib.nullcontext() if readonly else state_lock(directory):
            state = read_state(directory)
            persist = lambda: save_state(directory, state)
            if command == "doctor":
                actions = ["Read SKILL.md, then collect --query YOUR_TOPIC. No installation is required."]
                if not env.get("TWITTERAPI_IO_KEY"):
                    actions.append("X is optional: set TWITTERAPI_IO_KEY in this skill's .env to enable it.")
                result = {"version": VERSION, "python": platform.python_version(), "stdlibOnly": True, "ready": True,
                          "skillDir": str(SKILL_ROOT), "dataDir": str(directory), "configured": configured(env), "nextSteps": actions}
                if flags.network:
                    http = PublicHTTP(state, env)
                    try:
                        doc = http.request("https://openai.com/news/rss.xml")
                        result["network"] = {"status": "success", "httpStatus": doc["status"], "message": "One public RSS endpoint is reachable; this does not verify other sources."}
                    except (ValueError, OSError) as error:
                        result["network"] = {"status": "failed", "message": safe_error(error, env)}
                    finally:
                        http.close()
            elif command == "init":
                persist()
                result = {"initialized": True, "dataDir": str(directory), "configured": configured(env)}
            elif command == "status":
                result = {"version": VERSION, "dataDir": str(directory), "configured": configured(env), "settings": state["settings"],
                          "rules": len(state["rules"]), "enabledRules": sum(r["enabled"] for r in state["rules"]),
                          "dueRules": [{"id": r["id"], "name": r["name"]} for r in state["rules"] if r["enabled"] and (not r.get("lastCollectedAt") or time.time() - (timestamp(r["lastCollectedAt"]) or 0) >= 1800)],
                          "evidence": len(state["evidence"]), "reports": len(state["analyses"]), "usage": state["usage"], "recentRuns": state["runs"][:5],
                          "notifications": [{k: j.get(k) for k in ("id", "channel", "status", "count", "error", "lastAttemptAt")} for j in state["notifications"][:10]],
                          "scheduling": "Host-triggered only; no server, daemon or model API"}
            elif command == "config":
                if action == "set":
                    state["settings"] = validate_settings({**state["settings"], **validate_settings(payload(flags), partial=True)})
                    persist()
                result = state["settings"]
            elif command in {"rules", "sources", "accounts"}:
                rows = state[command]
                if action == "list":
                    result = rows
                elif action == "add":
                    raw = payload(flags) if flags.json or flags.file else ({"name": flags.name, "query": flags.query, "kind": flags.kind or "keyword", "notify": flags.notify} if command == "rules" else {"name": flags.name, "kind": flags.kind or "rss", "url": flags.url} if command == "sources" else {"userName": flags.user_name})
                    parsed = validate_entity(command, raw)
                    if command == "sources":
                        public_url(parsed["url"])
                    if command == "accounts" and any(r["userName"].lower() == parsed["userName"].lower() for r in rows):
                        raise ValueError("Account already exists")
                    result = {**parsed, "id": new_id(), "createdAt": now_iso()}
                    rows.append(result)
                    persist()
                else:
                    identity = required(flags.id, "--id")
                    item = next((r for r in rows if r["id"] == identity), None)
                    if not item:
                        raise ValueError(command + " item not found")
                    if action in {"pause", "resume"}:
                        item["enabled"] = action == "resume"
                    elif action == "delete":
                        if item.get("builtin"):
                            raise ValueError("Pause built-in sources instead of deleting them")
                        rows.remove(item)
                    elif action == "update":
                        raw = payload(flags)
                        if item.get("builtin"):
                            if set(raw) - {"enabled", "name"}:
                                raise ValueError("Only name and enabled may change for built-in sources")
                            parsed = validate_entity("sources", raw, partial=True)
                        else:
                            parsed = validate_entity(command, raw, partial=True)
                        if "url" in parsed:
                            public_url(parsed["url"])
                        if command == "accounts" and parsed.get("userName") and any(r["id"] != identity and r["userName"].lower() == parsed["userName"].lower() for r in rows):
                            raise ValueError("Account already exists")
                        if command == "rules" and any(k in parsed and parsed[k] != item.get(k) for k in ("query", "kind")):
                            item["lastCollectedAt"] = None
                        item.update(parsed)
                    result = {"deleted": item["id"]} if action == "delete" else item
                    persist()
            elif command in {"collect", "read"}:
                http = PublicHTTP(state, env)
                try:
                    if command == "collect":
                        if flags.query and (flags.rule or flags.due):
                            raise ValueError("--query cannot be combined with --rule or --due")
                        query = string(flags.query, "query", 500) if flags.query is not None else None
                        result = Collector(state, http, env=env, persist=persist).collect(query=query, rule_id=flags.rule, source_id=flags.source, hours=number(flags.hours, state["settings"]["lookbackHours"], 1, 120), refresh=flags.refresh, due=flags.due)
                    else:
                        item = evidence({"id": "manual", "kind": "web"}, {"url": required(flags.url, "--url"), "title": "Manual original", "text": ""})
                        result = ingest(state, read_original(http, item))
                finally:
                    persist()
                    http.close()
            elif command == "evidence":
                if action == "show":
                    result = state["evidence"].get(required(flags.id, "--id"))
                    if not result:
                        raise ValueError("Evidence not found")
                else:
                    result = select_evidence(state, source_id=flags.source, rule_id=flags.rule, search=flags.search or "", sort=flags.sort,
                        hours=number(flags.hours, 120, 1, 120), history=flags.history, unreviewed=flags.unreviewed, audit=flags.audit,
                        limit=number(flags.limit, 100, 1, 100), offset=number(flags.offset, 0, 0, 10000000))
            elif command == "reports":
                if action == "list":
                    result = [{"id": r["id"], "title": r["title"], "engine": r["engine"], "createdAt": r["createdAt"], "count": len(r["events"]), "staleCount": sum(stale_event(state, e) for e in r["events"])} for r in reversed(list(state["analyses"].values()))]
                elif action == "record":
                    result = record_report(state, read_json(required(flags.file, "--file")))
                    persist()
                else:
                    report = state["analyses"].get(required(flags.id, "--id"))
                    if not report:
                        raise ValueError("Report not found")
                    result = {"id": report["id"], "markdown": render_report(state, report)} if action == "render" else {**report, "events": [{**e, "stale": stale_event(state, e)} for e in report["events"]]}
            elif command == "notifications":
                if action == "list":
                    result = [{k: v for k, v in j.items() if k not in {"events", "keys"}} for j in state["notifications"]]
                else:
                    identity = required(flags.id, "--id")
                    result = next((j for j in state["notifications"] if j["id"] == identity), None)
                    if not result:
                        raise ValueError("Notification not found")
            elif command == "notify":
                http = PublicHTTP(state, env)
                try:
                    result = notify(state, report_id=flags.report, channel=flags.channel, retry_id=required(flags.id, "--id") if action == "retry" else None, send=action != "preview", env=env, http=http, persist=persist)
                finally:
                    http.close()
            if flags.out:
                out = Path(flags.out).resolve()
                out.parent.mkdir(parents=True, exist_ok=True)
                text = result["markdown"] if command == "reports" and action == "render" else json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
                out.write_text(text, encoding="utf-8")
                return {"outputFile": str(out), **({"run": result["run"]} if isinstance(result, dict) and "run" in result else {})}
            return result
    except Exception as error:
        raise ValueError(safe_error(error, env)) from None


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    try:
        result = main()
        print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))
        if isinstance(result, dict) and (result.get("run", {}).get("status") == "failed" or result.get("status") in {"failed", "uncertain"}):
            sys.exit(1)
    except (ValueError, OSError, KeyError, TypeError) as error:
        print(json.dumps({"error": safe_error(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)

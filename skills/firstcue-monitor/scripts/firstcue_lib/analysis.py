"""Validate and store evidence-backed reports supplied by any host AI."""
import copy
import re
import time

from .core import fingerprint, hash_text, heat, iso_date, new_id, now_iso, string, timestamp, unique


def record_report(state, raw):
    if not isinstance(raw, dict) or set(raw) != {"engine", "title", "events"}:
        raise ValueError("Report must contain engine, title and events only")
    report = {"engine": string(raw["engine"], "engine", 200), "title": string(raw["title"], "title", 300), "events": []}
    if not isinstance(raw["events"], list) or len(raw["events"]) > 100:
        raise ValueError("Report events must be an array of at most 100 items")
    fields = {"title", "summary", "verdict", "importance", "relevance", "reason", "occurredAt", "ruleIds", "citations"}
    for source in raw["events"]:
        if not isinstance(source, dict) or set(source) - fields or fields - {"occurredAt", "ruleIds"} - set(source):
            raise ValueError("Invalid report event fields")
        event = copy.deepcopy(source)
        for key, maximum in {"title": 400, "summary": 5000, "reason": 3000}.items():
            event[key] = string(event[key], key, maximum)
        for key, choices in {"verdict": {"confirmed", "uncertain", "refuted"}, "importance": {"urgent", "high", "medium", "low"}, "relevance": {"direct", "weak", "unrelated", "insufficient"}}.items():
            if event[key] not in choices:
                raise ValueError(f"Invalid {key}")
        event.setdefault("occurredAt", None)
        event.setdefault("ruleIds", [])
        if event["occurredAt"] is not None and not iso_date(event["occurredAt"]):
            raise ValueError("occurredAt must be a valid, non-future date or null")
        if not isinstance(event["ruleIds"], list) or any(not isinstance(key, str) or not any(rule["id"] == key for rule in state["rules"]) for key in event["ruleIds"]):
            raise ValueError("Analysis refers to an unknown rule")
        citations = event["citations"]
        if not isinstance(citations, list) or not 1 <= len(citations) <= 20:
            raise ValueError("An event needs 1..20 citations")
        for cite in citations:
            if not isinstance(cite, dict) or set(cite) != {"evidenceId", "quote"}:
                raise ValueError("Invalid citation fields")
            key = string(cite["evidenceId"], "evidenceId", 200)
            quote = string(cite["quote"], "quote", 2000)
            item = state["evidence"].get(key)
            if not item or item.get("aliasOf"):
                raise ValueError(f"Unknown or superseded evidence: {key}")
            if re.sub(r"\s+", " ", quote) not in re.sub(r"\s+", " ", item["text"]).strip():
                raise ValueError(f"Citation is not present in saved evidence: {key}")
            cite.update(evidenceId=key, quote=quote)
        usable = [state["evidence"][c["evidenceId"]] for c in citations if not state["evidence"][c["evidenceId"]].get("excluded") and state["evidence"][c["evidenceId"]]["contentKind"] != "snippet"]
        if event["verdict"] == "confirmed" and not usable:
            raise ValueError("A confirmed claim needs readable evidence beyond search snippets")
        ids = unique(c["evidenceId"] for c in citations)
        event.update(id=hash_text(event["title"] + "|" + ",".join(sorted(ids))),
                     evidenceHashes={key: state["evidence"][key]["contentHash"] for key in ids},
                     ruleFingerprints={key: fingerprint([next(r for r in state["rules"] if r["id"] == key)["query"], next(r for r in state["rules"] if r["id"] == key).get("kind")]) for key in event["ruleIds"]})
        report["events"].append(event)
    report.update(id=new_id(), createdAt=now_iso())
    state["analyses"][report["id"]] = report
    return report


def stale_event(state, event):
    for key, saved in event["evidenceHashes"].items():
        item = state["evidence"].get(key, {})
        if item.get("contentHash") != saved or item.get("aliasOf"):
            return True
    for key, saved in event.get("ruleFingerprints", {}).items():
        rule = next((r for r in state["rules"] if r["id"] == key), None)
        if not rule or fingerprint([rule["query"], rule.get("kind")]) != saved:
            return True
    return False


def select_evidence(state, *, hours=120, history=False, search="", source_id=None, rule_id=None, sort="heat", limit=100, offset=0, unreviewed=False, audit=False):
    reviewed = {key for report in state["analyses"].values() for event in report["events"] if not stale_event(state, event) for key in event["evidenceHashes"]}
    cutoff = time.time() - hours * 3600
    items = [item for item in state["evidence"].values() if
             (audit or not item.get("excluded") and not item.get("aliasOf"))
             and (history or (timestamp(item.get("publishedAt") or item["firstDiscoveredAt"]) or 0) >= cutoff)
             and (not source_id or source_id in item["discoveredBy"])
             and (not rule_id or rule_id in item["ruleIds"])
             and (not search or search.casefold() in (item["title"] + " " + item["text"]).casefold())
             and (not unreviewed or item["id"] not in reviewed)]
    def heat_key(item):
        score = heat(item)
        return (-(score if score is not None else -1), -(timestamp(item.get("publishedAt") or item["firstDiscoveredAt"]) or 0), item["id"])
    items.sort(key=heat_key)
    selected = items[offset:offset + limit]
    if sort != "heat":
        key = "publishedAt" if sort == "published" else "firstDiscoveredAt"
        selected.sort(key=lambda item: (-(timestamp(item.get(key)) or -1), item["id"]))
    return {"total": len(items), "offset": offset, "nextOffset": offset + limit if offset + limit < len(items) else None,
            "items": [{**item, "analysisPending": item["id"] not in reviewed, "heat": heat(item), "timeBasis": "published" if item.get("publishedAt") else "first_discovered"} for item in selected]}


def markdown(value):
    return re.sub(r"([\\`*_\[\]<>#])", r"\\\1", str(value))


def render_report(state, report):
    lines = ["# " + markdown(report["title"]), "", f"生成时间：{report['createdAt']} · 分析引擎：{markdown(report['engine'])}", "", "分析结论由宿主 AI 基于保存的材料给出；多条转载不等于多份独立证据。", ""]
    for event in report["events"]:
        stale = " · 材料或目标已变化，需要复审" if stale_event(state, event) else ""
        lines.extend(["## " + markdown(event["title"]), "", event["summary"], "", f"重要性：{event['importance']} · 结论：{event['verdict']} · 相关性：{event['relevance']}{stale}", "", "依据：" + event["reason"], "", "事件时间：" + (event["occurredAt"] or "未确认，请参阅来源发布时间"), ""])
        for cite in event["citations"]:
            item = state["evidence"][cite["evidenceId"]]
            lines.extend([f"- [{markdown(item['title'])}](<{item['url']}>) · {item.get('publishedAt') or '发布时间未知'} · {item['contentKind']}", "  > " + markdown(cite["quote"]), ""])
    return "\n".join(lines)

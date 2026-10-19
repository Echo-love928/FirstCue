"""Direct collection; AI analysis is deliberately performed by the host."""
import copy
import json
import time
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from .core import day_key, hash_text, ingest, new_id, now_iso, reserve, safe_error, timestamp, unique
from .http import canonical
from .parsing import evidence, literal_redirect, parse_article, parse_feed, parse_listing, parse_search, parse_tweet


def read_original(http, item):
    doc = http.request(item["url"])
    redirect = literal_redirect(doc["text"], doc["url"])
    if redirect:
        doc = http.request(redirect)
    article = parse_article(doc["text"], doc["url"])
    return evidence({"id": item["sourceId"], "kind": item["sourceKind"]}, {
        **item, **article, "url": doc["url"], "title": article["title"] or item["title"],
        "publishedAt": article["publishedAt"] or item.get("publishedAt"),
        "dateBasis": article["dateBasis"] if article["publishedAt"] else item.get("dateBasis", "unavailable"),
        "fetchedAt": now_iso(),
    })


class Collector:
    def __init__(self, state, http, *, env=None, persist=lambda: None):
        self.state, self.http, self.env, self.persist = state, http, env or {}, persist

    def cached(self, key, fn, refresh=False):
        old = self.state["cache"].get(key)
        if not refresh and old and old["expires"] > time.time() * 1000:
            return {"items": copy.deepcopy(old["items"]), "status": "cached"}
        items = fn()
        self.state["cache"][key] = {"expires": time.time() * 1000 + self.state["settings"]["cacheMinutes"] * 60000, "items": copy.deepcopy(items)}
        return {"items": items, "status": "success" if items else "empty"}

    def web(self, source, query, refresh=False):
        def fetch():
            u = urlsplit(source["url"])
            params = dict(parse_qsl(u.query))
            params[{"sogou": "query", "baidu": "word"}.get(source["id"], "q")] = query
            doc = self.http.request(urlunsplit((u.scheme, u.netloc, u.path, urlencode(params), "")))
            return parse_search(doc["text"], source, doc["url"])
        return self.cached(hash_text(f"search:{source['id']}:{query}"), fetch, refresh)

    def feed(self, source, refresh=False):
        def fetch():
            doc = self.http.request(source["url"])
            return (parse_feed(doc["text"], {**source, "url": doc["url"]}) if source["kind"] == "rss"
                    else parse_listing(doc["text"], source, doc["url"]))
        return self.cached(hash_text(source["kind"] + ":" + source["url"]), fetch, refresh)

    def twitter(self, source, query, scope, hours):
        if not self.env.get("TWITTERAPI_IO_KEY"):
            return {"items": [], "status": "unconfigured", "message": "TWITTERAPI_IO_KEY is not configured for this skill"}
        state, settings, now = self.state, self.state["settings"], time.time() * 1000
        cutoff, key = now - hours * 3600000, hash_text("x:" + query)
        previous = state["checkpoints"].get(key, {})
        resumable = previous.get("until", 0) >= cutoff
        cp = copy.deepcopy(previous) if resumable else {"since": max(cutoff, previous.get("completedUntil", cutoff) - 600000), "until": now, "cursor": ""}
        if not resumable and previous.get("lastCompletedAt") and now - previous["lastCompletedAt"] < settings["cacheMinutes"] * 60000:
            return {"items": [], "status": "cached", "message": "X query checked recently; saved evidence remains queryable"}
        state["checkpoints"][key] = cp
        items, invalid = [], 0
        for _ in range(settings["xPagesPerQuery"]):
            usage = state["usage"].get(day_key(), {})
            if usage.get("xResults", 0) + 20 > settings["xResultDailyLimit"] or not reserve(state, "xRequests", 1, settings["xDailyLimit"]):
                self.persist()
                return {"items": items, "status": "limited", "message": "X daily budget reached; unfinished window retained"}
            self.persist()
            params = {"query": f"({query}) -filter:replies -filter:retweets since_time:{int(cp['since'] / 1000)} until_time:{int(cp['until'] / 1000)}", "queryType": "Latest", "cursor": cp.get("cursor") or ""}
            try:
                doc = self.http.request("https://api.twitterapi.io/twitter/tweet/advanced_search?" + urlencode(params), headers={"X-API-Key": self.env["TWITTERAPI_IO_KEY"]}, no_redirect=True)
                data = json.loads(doc["text"])
                if not isinstance(data, dict) or data.get("status") not in {None, "success"} or not isinstance(data.get("tweets"), list) or type(data.get("has_next_page")) is not bool:
                    raise ValueError("X response schema invalid")
            except (ValueError, OSError) as error:
                return {"items": items, "status": "partial" if items else "failed", "message": safe_error(error, self.env)}
            if not reserve(state, "xResults", len(data["tweets"]), settings["xResultDailyLimit"]):
                self.persist()
                return {"items": items, "status": "limited", "message": "X returned more results than remaining budget; window retained"}
            for raw in data["tweets"]:
                try:
                    item = parse_tweet(raw, source)
                    when = timestamp(item.get("publishedAt"))
                    if when is None or when * 1000 < cutoff or when * 1000 > cp["until"] + 300000:
                        continue
                    item["ruleIds"] = scope
                    ingest(state, item)
                    items.append(item)
                except (ValueError, TypeError, AttributeError):
                    invalid += 1
            if not data["has_next_page"]:
                state["checkpoints"][key] = {"completedUntil": cp["until"], "lastCompletedAt": now}
                self.persist()
                return {"items": items, "status": "partial" if invalid else "success" if items else "empty", "message": f"{invalid} malformed X records skipped" if invalid else None}
            cursor = data.get("next_cursor")
            if not isinstance(cursor, str) or not cursor or cursor == cp.get("cursor"):
                self.persist()
                return {"items": items, "status": "partial", "message": "X continuation cursor is missing or unchanged; current page retained for safe retry"}
            cp["cursor"] = cursor
            state["checkpoints"][key] = copy.deepcopy(cp)
            self.persist()
        return {"items": items, "status": "partial", "message": "X page limit reached; continuation cursor saved for the next run"}

    def collect(self, *, query=None, rule_id=None, source_id=None, hours=None, refresh=False, due=False):
        state, now = self.state, time.time()
        hours = state["settings"]["lookbackHours"] if hours is None else hours
        rules = [{"id": None, "name": query, "query": query}] if query else [r for r in state["rules"] if r["enabled"] and (not rule_id or r["id"] == rule_id) and (not due or not r.get("lastCollectedAt") or now - (timestamp(r["lastCollectedAt"]) or 0) >= 1800)]
        if due and not rules:
            return {"status": "skipped", "analysisRequired": False, "message": "No targets are due"}
        if not rules:
            raise ValueError("No enabled targets. Add a rule or pass --query.")
        sources = [s for s in state["sources"] if s["enabled"] and (not source_id or s["id"] == source_id)]
        if not sources:
            raise ValueError("No enabled matching sources")
        run = {"id": new_id(), "startedAt": now_iso(), "finishedAt": None, "status": "running", "targets": [{"id": r["id"], "query": r["query"]} for r in rules], "results": [], "evidenceIds": []}
        state["runs"] = [run] + state["runs"][:49]
        self.persist()
        collected, failed = {}, set()

        def accept(item, scope):
            item["ruleIds"], item["queries"] = scope, [r["query"] for r in rules]
            stored = ingest(state, item)
            when = timestamp(stored.get("publishedAt"))
            if when is not None and when < time.time() - hours * 3600:
                collected.pop(stored["id"], None)
            else:
                collected[stored["id"]] = stored

        def job(source, query_text, scope, fn):
            if source["id"] in failed:
                return
            try:
                result = fn()
                for item in result["items"]:
                    accept(item, scope)
                run["results"].append({"sourceId": source["id"], "query": query_text, "count": len(result["items"]), "status": result["status"], "message": result.get("message")})
                if result["status"] in {"failed", "limited", "unconfigured"}:
                    failed.add(source["id"])
            except (ValueError, OSError, TypeError) as error:
                failed.add(source["id"])
                run["results"].append({"sourceId": source["id"], "query": query_text, "status": "failed", "count": 0, "message": safe_error(error, self.env)})
            run["evidenceIds"] = list(collected)
            self.persist()

        searches = 0
        for prefix in ("", "site:bilibili.com ", "(site:weibo.com OR site:weibo.cn) "):
            for rule in rules:
                for engine in [s for s in sources if s["kind"] == "search"]:
                    if searches >= state["settings"]["searchPerRunLimit"]:
                        break
                    if engine["id"] not in failed:
                        searches += 1
                        q = prefix + rule["query"]
                        job(engine, q, [rule["id"]] if rule["id"] else [], lambda: self.web(engine, q, refresh))
        scope = [r["id"] for r in rules if r["id"]]
        for source in [s for s in sources if s["kind"] == "x"]:
            for rule in rules:
                ids = [rule["id"]] if rule["id"] else []
                job(source, rule["query"], ids, lambda: self.twitter(source, rule["query"], ids, hours))
            for account in [a for a in state["accounts"] if a["enabled"]]:
                q = "from:" + account["userName"]
                job(source, q, scope, lambda: self.twitter(source, q, scope, hours))
        for source in [s for s in sources if s["kind"] in {"rss", "page"}]:
            job(source, None, scope, lambda: self.feed(source, refresh))
        reads = 0
        for item in list(collected.values()):
            if item.get("excluded"):
                continue
            urls = item["outboundUrls"][:2] if item["contentKind"] == "post" else [item["url"]]
            for url in urls:
                if reads >= state["settings"]["readPerRunLimit"]:
                    break
                key = hash_text("read:" + canonical(url))
                cached = state["cache"].get(key)
                try:
                    if not refresh and cached and cached["expires"] > time.time() * 1000:
                        value = copy.deepcopy(cached["item"])
                    else:
                        reads += 1
                        base = evidence({"id": item["sourceId"], "kind": "web"}, {"url": url, "title": "Linked original", "text": "", "parentEvidenceIds": [item["id"]]}) if item["contentKind"] == "post" else item
                        value = read_original(self.http, base)
                        state["cache"][key] = {"expires": time.time() * 1000 + state["settings"]["cacheMinutes"] * 60000, "item": copy.deepcopy(value)}
                    if item["contentKind"] != "post" and value["id"] != item["id"]:
                        value["firstDiscoveredAt"] = state["evidence"][item["id"]]["firstDiscoveredAt"]
                        for k in ("discoveredBy", "ruleIds"):
                            value[k] = unique(value.get(k, []) + item[k])
                        state["evidence"][item["id"]].update(aliasOf=value["id"], excluded=True)
                        collected.pop(item["id"], None)
                    accept(value, item["ruleIds"])
                except (ValueError, OSError) as error:
                    ingest(state, {**item, "readError": safe_error(error, self.env)})
                self.persist()
        run["evidenceIds"], run["finishedAt"] = list(collected), now_iso()
        available = any(r["status"] in {"success", "empty", "cached"} or r["status"] == "partial" and r["count"] > 0 for r in run["results"])
        problems = any(r["status"] in {"failed", "partial", "unconfigured", "limited"} for r in run["results"])
        run["status"] = "failed" if not available else "partial" if problems else "success"
        if available:
            for rule in rules:
                if rule["id"]:
                    rule["lastCollectedAt"] = run["finishedAt"]
        self.persist()
        items = [state["evidence"][key] for key in collected if not state["evidence"][key].get("excluded")]
        return {"run": run, "analysisRequired": True, "items": items[:100], "truncated": len(items) > 100,
                "message": "Evidence only. The host AI must assess relevance, claims and importance; query matches are discovery hints."}

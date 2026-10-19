import copy
import json
import os
import smtplib
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from firstcue_lib.analysis import record_report, render_report, select_evidence, stale_event
from firstcue_lib.collect import Collector
from firstcue_lib.core import hash_text, ingest, initial_state, now_iso, material_hash, read_json
from firstcue_lib.notify import (DeliveryRejected, eligible_event, feishu_sign, notify,
                                preview_notification, send_channel)
from firstcue_lib.parsing import evidence


class FakeHTTP:
    def __init__(self, fn):
        self.fn = fn
    def request(self, raw, **options):
        return self.fn(raw, options)


def tweet(identity):
    return {"id": str(identity), "text": "New model release with a documented change", "createdAt": now_iso(), "author": {"userName": "ExampleAI"}, "isReply": False, "likeCount": 0}


def fixture():
    state = initial_state()
    state["rules"].append({"id": "rule", "name": "AI", "query": "AI", "kind": "keyword", "enabled": True, "notify": True})
    item = ingest(state, evidence({"id": "official", "kind": "rss"}, {"url": "https://example.com/release", "title": "New model", "text": "We released the new model today with a larger context window.", "contentKind": "article", "publishedAt": now_iso(time.time() - 10), "ruleIds": ["rule"]}))
    raw = {"engine": "Any host AI", "title": "Daily digest", "events": [{"title": "New model", "summary": "A new model was released.", "verdict": "confirmed", "importance": "high", "relevance": "direct", "reason": "The saved announcement describes the release.", "occurredAt": None, "ruleIds": ["rule"], "citations": [{"evidenceId": item["id"], "quote": "We released the new model today"}]}]}
    return state, item, raw


ENV = {"FEISHU_WEBHOOK_URL": "https://open.feishu.cn/open-apis/bot/v2/hook/fake-webhook", "FEISHU_SIGNING_SECRET": "test-secret"}


class CollectionTests(unittest.TestCase):
    def test_x_fixed_window_and_cursor_resume_after_restart(self):
        state = initial_state()
        state["settings"]["xPagesPerQuery"] = 1
        requests, saves = [], []
        def request(raw, opts):
            requests.append(parse_qs(urlsplit(raw).query, keep_blank_values=True))
            self.assertEqual(opts["headers"], {"X-API-Key": "fake"})
            self.assertTrue(opts["no_redirect"])
            return {"text": json.dumps({"tweets": [tweet(len(requests))], "has_next_page": len(requests) == 1, "next_cursor": "next" if len(requests) == 1 else None})}
        source = next(s for s in state["sources"] if s["id"] == "twitter")
        collector = Collector(state, FakeHTTP(request), env={"TWITTERAPI_IO_KEY": "fake"}, persist=lambda: saves.append(1))
        self.assertEqual(collector.twitter(source, "AI", [], 120)["status"], "partial")
        state = json.loads(json.dumps(state))
        collector = Collector(state, FakeHTTP(request), env={"TWITTERAPI_IO_KEY": "fake"})
        self.assertEqual(collector.twitter(source, "AI", [], 120)["status"], "success")
        self.assertEqual(requests[1]["cursor"], ["next"])
        self.assertEqual(requests[0]["query"], requests[1]["query"])
        self.assertEqual(len(state["evidence"]), 2)
        self.assertEqual(collector.twitter(source, "AI", [], 120)["status"], "cached")
        self.assertEqual(len(requests), 2)
        self.assertGreaterEqual(len(saves), 2)

    def test_x_old_window_bad_cursor_and_quota_failures(self):
        state = initial_state()
        key = hash_text("x:AI")
        state["checkpoints"][key] = {"since": 1, "until": 2, "cursor": "obsolete"}
        source = next(s for s in state["sources"] if s["id"] == "twitter")
        collector = Collector(state, FakeHTTP(lambda raw, opts: {"text": json.dumps({"tweets": [tweet(1)], "has_next_page": True, "next_cursor": ""})}), env={"TWITTERAPI_IO_KEY": "fake"})
        self.assertEqual(collector.twitter(source, "AI", [], 120)["status"], "partial")
        self.assertGreater(state["checkpoints"][key]["since"], 2)
        start = state["checkpoints"][key]["until"]
        def fail(raw, opts):
            raise ValueError("network failed")
        collector.http = FakeHTTP(fail)
        self.assertEqual(collector.twitter(source, "AI", [], 120)["status"], "failed")
        self.assertEqual(state["checkpoints"][key]["until"], start)
        state["settings"]["xDailyLimit"] = 2
        self.assertEqual(collector.twitter(source, "AI", [], 120)["status"], "limited")

    def test_partial_sources_feed_cache_and_unconfigured_x(self):
        state = initial_state()
        state["sources"] = [s for s in state["sources"] if s["id"] in {"bing", "twitter"}]
        state["sources"].append({"id": "feed", "name": "Feed", "kind": "rss", "enabled": True, "url": "https://example.com/feed"})
        state["settings"]["readPerRunLimit"] = 0
        feeds = []
        def request(raw, opts):
            if urlsplit(raw).hostname == "www.bing.com":
                raise ValueError("Search challenge")
            self.assertEqual(urlsplit(raw).hostname, "example.com")
            feeds.append(1)
            return {"url": raw, "text": f'<rss><channel><item><title>Actual announcement</title><link>https://example.com/a</link><description>Actual material</description><pubDate>{now_iso()}</pubDate></item></channel></rss>'}
        collector = Collector(state, FakeHTTP(request))
        result = collector.collect(query="AI")
        self.assertEqual(result["run"]["status"], "partial")
        self.assertEqual(len(result["items"]), 1)
        self.assertTrue(result["analysisRequired"])
        self.assertNotIn("verdict", result["items"][0])
        self.assertEqual(next(r for r in result["run"]["results"] if r["sourceId"] == "twitter")["status"], "unconfigured")
        collector.collect(query="AI")
        self.assertEqual(len(feeds), 1)

    def test_old_original_displaces_undated_search_snippet(self):
        state = initial_state()
        state["sources"] = [s for s in state["sources"] if s["id"] == "bing"]
        state["settings"]["searchPerRunLimit"] = 1
        def request(raw, opts):
            text = '<li class="b_algo"><h2><a href="https://example.com/old">Old release</a></h2><div class="b_caption"><p>Undated summary</p></div></li>' if urlsplit(raw).hostname == "www.bing.com" else '<meta property="article:published_time" content="2020-01-01T00:00:00Z"><article>This old announcement contains plenty of readable original material but is not new.</article>'
            return {"url": raw, "text": text}
        result = Collector(state, FakeHTTP(request)).collect(query="AI")
        self.assertEqual(result["items"], [])
        self.assertEqual(select_evidence(state)["total"], 0)
        self.assertEqual(select_evidence(state, history=True)["total"], 1)

    def test_search_redirect_alias_is_not_independent_evidence(self):
        state = initial_state()
        state["sources"] = [s for s in state["sources"] if s["id"] == "sogou"]
        state["settings"]["searchPerRunLimit"] = 1
        def request(raw, opts):
            route = urlsplit(raw).path
            text = ('<div class="vrwrap"><h3><a href="https://www.sogou.com/link?url=abc">Release story</a></h3><div class="str_info">Search summary</div></div>' if route == "/web" else 'window.location.replace("https://example.com/news/release")' if route == "/link" else '<article>This announcement includes sufficient original details for the host AI to examine.</article>')
            return {"url": raw, "text": text}
        result = Collector(state, FakeHTTP(request)).collect(query="AI")
        self.assertEqual(len(result["items"]), 1)
        self.assertEqual(result["items"][0]["url"], "https://example.com/news/release")
        self.assertEqual(select_evidence(state, audit=True)["total"], 2)

    def test_due_targets_use_30_minute_schedule_and_preserve_pause(self):
        state, _, _ = fixture()
        state["rules"][0]["lastCollectedAt"] = now_iso()
        collector = Collector(state, FakeHTTP(lambda *_: self.fail("No network expected")))
        self.assertEqual(collector.collect(due=True)["status"], "skipped")
        state["rules"][0].update(enabled=False, lastCollectedAt=None)
        self.assertEqual(collector.collect(due=True)["status"], "skipped")


class AnalysisTests(unittest.TestCase):
    def test_report_checks_actual_quotes_and_rejects_unread_confirmations(self):
        state, item, raw = fixture()
        bad = copy.deepcopy(raw)
        bad["events"][0]["citations"][0]["quote"] = "Invented quotation"
        with self.assertRaisesRegex(ValueError, "Citation"):
            record_report(state, bad)
        state["evidence"][item["id"]]["contentKind"] = "snippet"
        with self.assertRaisesRegex(ValueError, "readable"):
            record_report(state, raw)
        self.assertEqual(len(state["analyses"]), 0)

    def test_report_versions_evidence_and_target_and_exports_citations(self):
        state, item, raw = fixture()
        report = record_report(state, raw)
        self.assertFalse(stale_event(state, report["events"][0]))
        self.assertEqual(select_evidence(state, unreviewed=True)["total"], 0)
        self.assertIn("https://example.com/release", render_report(state, report))
        ingest(state, {**item, "text": "Changed original material"})
        self.assertTrue(stale_event(state, report["events"][0]))
        self.assertEqual(select_evidence(state, unreviewed=True)["total"], 1)
        state, item, raw = fixture()
        report = record_report(state, raw)
        state["rules"][0]["query"] = "Different product"
        self.assertTrue(stale_event(state, report["events"][0]))
        self.assertEqual(preview_notification(state, report, "feishu", ENV)["count"], 0)

    def test_heat_shortlist_and_pagination_do_not_invent_missing_metrics(self):
        state = initial_state()
        for i in range(105):
            ingest(state, evidence({"id": "test", "kind": "rss"}, {"url": f"https://example.com/{i}", "title": f"News {i}", "text": "material", "publishedAt": now_iso(time.time() - i), "metrics": {"likes": i} if i else {}}))
        result = select_evidence(state, sort="published")
        self.assertEqual(len(result["items"]), 100)
        self.assertEqual(result["nextOffset"], 100)
        self.assertEqual(result["items"][0]["metrics"]["likes"], 5)
        self.assertEqual(len(select_evidence(state, offset=100)["items"]), 5)

    def test_legacy_state_report_hashes_remain_valid(self):
        # This frozen fixture was produced by the original Node v1 modules,
        # rather than by the Python implementation being tested.
        legacy = read_json(Path(__file__).parent / "fixtures" / "v1-state.json")
        self.assertEqual(legacy["schemaVersion"], 1)
        for item in legacy["evidence"].values():
            self.assertEqual(material_hash(item), item["contentHash"])
        for report in legacy["analyses"].values():
            self.assertFalse(stale_event(legacy, report["events"][0]))
        self.assertEqual(select_evidence(legacy, history=True)["total"], 1)


class NotificationTests(unittest.TestCase):
    def test_preview_does_not_send_and_repeated_reports_are_deduplicated(self):
        state, _, raw = fixture()
        report = record_report(state, raw)
        sends = []
        options = {"env": ENV, "sender": lambda *a: sends.append(a)}
        self.assertEqual(notify(state, report_id=report["id"], channel="feishu", **options)["status"], "preview")
        self.assertEqual(sends, [])
        result = notify(state, report_id=report["id"], channel="feishu", send=True, **options)
        self.assertEqual(result["status"], "accepted")
        duplicate = record_report(state, {**raw, "title": "Another digest"})
        self.assertEqual(preview_notification(state, duplicate, "feishu", ENV)["count"], 0)
        self.assertEqual(len(sends), 1)

    def test_uncertain_delivery_is_not_retried(self):
        state, _, raw = fixture()
        report = record_report(state, raw)
        def fail(*args):
            raise TimeoutError("timeout after request")
        result = notify(state, report_id=report["id"], channel="feishu", send=True, env=ENV, sender=fail)
        self.assertEqual(result["status"], "uncertain")
        with self.assertRaisesRegex(ValueError, "definitively failed"):
            notify(state, retry_id=result["id"], send=True, env=ENV)

    def test_failed_retries_respect_cooldown_target_pause_and_attempt_limit(self):
        state, _, raw = fixture()
        report = record_report(state, raw)
        def reject(*args):
            raise DeliveryRejected("Rejected")
        result = notify(state, report_id=report["id"], channel="feishu", send=True, env=ENV, sender=reject)
        self.assertEqual(result["status"], "failed")
        with self.assertRaisesRegex(ValueError, "cooldown"):
            notify(state, retry_id=result["id"], send=True, env=ENV)
        later = time.time() + 31 * 60
        with self.assertRaisesRegex(ValueError, "destination changed"):
            notify(state, retry_id=result["id"], send=True, env={**ENV, "FEISHU_WEBHOOK_URL": ENV["FEISHU_WEBHOOK_URL"] + "-new"}, now=later)
        state["rules"][0]["enabled"] = False
        with self.assertRaisesRegex(ValueError, "paused"):
            notify(state, retry_id=result["id"], send=True, env=ENV, now=later)
        state["rules"][0]["enabled"] = True
        state["notifications"][0]["attempts"] = 4
        with self.assertRaisesRegex(ValueError, "limit"):
            notify(state, retry_id=result["id"], send=True, env=ENV, now=later)

    def test_feishu_signature_payload_and_byte_limit(self):
        self.assertEqual(feishu_sign("100", "secret"), "KUnJ8wrVSlQE2kFHpc7kL1u/Kp43Y+UBQpRojlmoDyo=")
        bodies = []
        def request(raw, opts):
            bodies.append(json.loads(opts["body"]))
            self.assertTrue(opts["no_redirect"])
            return {"text": '{"code":0}'}
        http = FakeHTTP(request)
        send_channel("feishu", '<at user_id="all">test</at>', "id", http, ENV)
        self.assertEqual(bodies[0]["content"]["post"]["zh_cn"]["content"][0][0]["tag"], "text")
        self.assertTrue(bodies[0]["sign"])
        with self.assertRaisesRegex(DeliveryRejected, "18 KB"):
            send_channel("feishu", "长" * 20000, "id", http, ENV)
        self.assertEqual(len(bodies), 1)

    def test_smtp_requires_tls_and_uses_stable_message_id(self):
        calls = []
        class SMTP:
            def __init__(self, host, port, **kwargs):
                calls.append(("connect", host, port))
            def ehlo(self):
                calls.append("ehlo")
            def starttls(self, **kwargs):
                calls.append("tls")
            def login(self, user, password):
                calls.append("login")
            def send_message(self, message, **kwargs):
                calls.append(("send", message["Message-ID"], kwargs["to_addrs"]))
                return {}
            def close(self):
                calls.append("close")
        env = {"SMTP_HOST": "smtp.example.com", "SMTP_USER": "user", "SMTP_PASS": "secret", "SMTP_FROM": "sender@example.com", "NOTIFY_EMAIL": "reader@example.com"}
        with patch("firstcue_lib.notify.smtplib.SMTP", SMTP):
            send_channel("mail", "Digest", "stable-id", None, env)
        self.assertLess(calls.index("tls"), calls.index("login"))
        self.assertIn(("send", "<stable-id@firstcue.local>", ["reader@example.com"]), calls)
        self.assertEqual(calls[-1], "close")


if __name__ == "__main__":
    unittest.main()

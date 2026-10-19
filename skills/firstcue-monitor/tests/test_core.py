import base64
import gzip
import io
import json
import os
import socket
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from firstcue_lib.core import (count, day_key, fingerprint, ingest, initial_state, iso_date,
                               load_env, material_hash, read_state, reserve, safe_error,
                               save_state, state_lock, timestamp)
from firstcue_lib.http import PublicHTTP, canonical, exchange, public_url
from firstcue_lib.parsing import (Document, evidence, parse_article, parse_feed,
                                  parse_listing, parse_search, parse_tweet)


class CoreTests(unittest.TestCase):
    def test_rss_atom_namespaces_relative_links_and_dates(self):
        source = {"id": "feed", "kind": "rss", "url": "https://example.com/feed"}
        xml = '<feed xmlns="http://www.w3.org/2005/Atom" xml:base="https://example.com/news/"><entry><title>Launch</title><link href="release"/><updated>2026-10-18T00:00:00Z</updated><summary>Actual material</summary></entry><entry><title>No link</title></entry></feed>'
        items = parse_feed(xml, source)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["url"], "https://example.com/news/release")
        self.assertIsNone(items[0]["publishedAt"])
        self.assertIsNotNone(items[0]["updatedAt"])
        self.assertEqual(items[0]["contentKind"], "feed")
        rss = '<rss xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><item><title>RSS</title><link>https://example.com/a</link><dc:creator>Original author</dc:creator><content:encoded>&lt;p&gt;Full body text&lt;/p&gt;</content:encoded><pubDate>Sun, 18 Oct 2026 12:00:00 GMT</pubDate></item></channel></rss>'
        item = parse_feed(rss, source)[0]
        self.assertEqual(item["author"], "Original author")
        self.assertEqual(item["text"], "Full body text")
        self.assertEqual(item["publishedAt"], "2026-10-18T12:00:00.000Z")

    def test_feed_rejects_entity_declarations_invalid_xml_and_unsafe_links(self):
        source = {"id": "feed", "kind": "rss", "url": "https://example.com/feed"}
        for raw in ('<!DOCTYPE rss [<!ENTITY a "evil">]><rss/>', '<rss><channel>', '<html>not feed</html>'):
            with self.assertRaises(ValueError):
                parse_feed(raw, source)
        self.assertEqual(parse_feed('<rss><channel><item><link>http://127.0.0.1/private</link></item></channel></rss>', source), [])

    def test_search_parsers_decode_original_urls_and_stop_on_unknown_layout(self):
        encoded = base64.urlsafe_b64encode(b"https://example.com/news?utm_source=bing").decode().rstrip("=")
        fixtures = {
            "bing": f'<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?u=a1{encoded}">Release</a></h2><div class="b_caption"><p>Real summary</p></div></li>',
            "sogou": '<div class="vrwrap"><h3><a href="https://example.com/news">Release</a></h3><div class="str_info">Real summary</div></div>',
            "baidu": '<div class="c-result" data-log="{&quot;mu&quot;:&quot;https://example.com/news&quot;}"><h3><a href="https://m.baidu.com/link?x=1">Release</a></h3><div class="c-abstract">Real summary</div></div>',
            "duckduckgo": '<div class="result"><a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fnews">Release</a><p class="result__snippet">Real summary</p></div>',
        }
        for engine, raw in fixtures.items():
            with self.subTest(engine=engine):
                source = {"id": engine, "kind": "search"}
                items = parse_search(raw, source, "https://www.bing.com/search")
                self.assertEqual(items[0]["url"], "https://example.com/news")
                self.assertEqual(items[0]["text"], "Real summary")
        with self.assertRaisesRegex(ValueError, "layout"):
            parse_search('<html>Unexpected page</html>', {"id": "bing"}, "https://www.bing.com/search")
        with self.assertRaisesRegex(ValueError, "challenge"):
            parse_search('<html>Verify you are human</html>', {"id": "bing"}, "https://www.bing.com/search")
        self.assertEqual(parse_search('<html>No results found</html>', {"id": "bing"}, "https://www.bing.com/search"), [])

    def test_article_excludes_scripts_tracks_publication_and_labels_descriptions(self):
        html = '<meta property="article:modified_time" content="2026-10-18T00:00:00Z"><article><h1>Launch</h1><p>This original announcement has enough readable material for the host to analyze its claims.</p><script>stealSecrets()</script><a href="http://localhost/private">private</a><a href="https://other.example.org/release">source</a></article>'
        article = parse_article(html, "https://example.com/a")
        self.assertNotIn("stealSecrets", article["text"])
        self.assertIsNone(article["publishedAt"])
        self.assertIsNotNone(article["updatedAt"])
        self.assertEqual(article["outboundUrls"], ["https://other.example.org/release"])
        video = parse_article('<meta name="description" content="This is a readable video description but it is not a transcript or the video itself.">', "https://www.bilibili.com/video/BV123")
        self.assertEqual(video["contentKind"], "description")
        structured = parse_article('<script type="application/ld+json">{"@graph":[{"datePublished":"2026-10-18T00:00:00Z"}]}</script><article>A public announcement with enough readable original content to be examined.</article>', "https://example.com/a")
        self.assertEqual(structured["publishedAt"], "2026-10-18T00:00:00.000Z")

    def test_listing_links_are_confined_to_origin(self):
        raw = '<main><article><time datetime="2026-10-18T00:00:00Z"></time><a href="/news/release"><h2>New model release</h2></a><a href="https://fake.example.org/news/other">Other release</a></article></main>'
        items = parse_listing(raw, {"id": "news", "kind": "page"}, "https://example.com/news")
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["url"], "https://example.com/news/release")

    def test_html_parser_has_structure_limit(self):
        with self.assertRaisesRegex(ValueError, "limits"):
            Document('<div>' * 300)

    def test_twitter_types_stable_ids_and_missing_metrics(self):
        raw = {"id": "123", "text": "Original release", "createdAt": "Sun Oct 18 12:00:00 +0000 2026", "author": {"userName": "author", "followers": "50"}, "isReply": False, "likeCount": 0}
        source = {"id": "twitter", "kind": "x"}
        item = parse_tweet(raw, source)
        self.assertFalse(item["excluded"])
        self.assertEqual(item["metrics"], {"likes": 0})
        self.assertEqual(item["publishedAt"], "2026-10-18T12:00:00.000Z")
        for change in ({"isReply": True}, {"quoted_tweet": {}}, {"retweeted_tweet": {}}, {"isReply": None}):
            self.assertTrue(parse_tweet({**raw, **change}, source)["excluded"])
        self.assertEqual(item["id"], parse_tweet({**raw, "author": {"userName": "renamed"}}, source)["id"])

    def test_ingest_preserves_richer_body_and_earliest_known_date(self):
        state = initial_state()
        item = evidence({"id": "rss", "kind": "rss"}, {"url": "https://example.com/a", "title": "News", "text": "Original long body", "contentKind": "article", "publishedAt": "2026-10-18T00:00:00.000Z", "metrics": {"likes": 10}})
        original = ingest(state, item)
        later = ingest(state, {**item, "text": "Short", "contentKind": "snippet", "discoveredBy": ["bing"], "metrics": {"views": 100}, "publishedAt": None})
        self.assertEqual(len(state["evidence"]), 1)
        self.assertEqual(later["text"], original["text"])
        self.assertEqual(later["firstDiscoveredAt"], original["firstDiscoveredAt"])
        self.assertEqual(later["publishedAt"], original["publishedAt"])
        self.assertEqual(later["discoveredBy"], ["rss", "bing"])
        self.assertEqual(later["metrics"], {"likes": 10, "views": 100})

    def test_counts_daily_budgets_and_redaction(self):
        self.assertEqual(count("1.2万"), 12000)
        self.assertEqual(count("1,200"), 1200)
        for raw in (None, "", "hidden", -1, True, float("nan")):
            self.assertIsNone(count(raw))
        state = initial_state()
        now = datetime(2026, 10, 18, 16, 1, tzinfo=timezone.utc).timestamp()
        self.assertEqual(day_key(now), "2026-10-19")
        self.assertTrue(reserve(state, "xRequests", 1, 1, now))
        self.assertFalse(reserve(state, "xRequests", 1, 1, now))
        text = safe_error(ValueError("secret-value https://open.feishu.cn/secret-path"), {"API_KEY": "secret-value"})
        self.assertNotIn("secret-value", text)
        self.assertNotIn("secret-path", text)

    def test_atomic_state_lock_corrupt_file_and_env_parsing(self):
        with tempfile.TemporaryDirectory(prefix="firstcue-core-", dir=os.environ.get("FIRSTCUE_TEST_TMP")) as name:
            with state_lock(name):
                with self.assertRaisesRegex(ValueError, "busy"):
                    with state_lock(name):
                        pass
                state = initial_state()
                state["rules"].append({"id": "saved"})
                save_state(name, state)
                save_state(name, state)
            self.assertEqual(read_state(name)["rules"][0]["id"], "saved")
            Path(name, "state.json").write_text("{bad", encoding="utf-8")
            with self.assertRaises(ValueError):
                read_state(name)
            file = Path(name, ".env")
            file.write_text('KEY="value # content"\nexport EMPTY=\nOTHER=value # note\n', encoding="utf-8")
            self.assertEqual(load_env(file), {"KEY": "value # content", "EMPTY": "", "OTHER": "value"})


class NetworkTests(unittest.TestCase):
    def client(self, transport, resolver=lambda host: ["93.184.216.34"]):
        return PublicHTTP(initial_state(), resolver=resolver, transport=transport, min_delay=0)

    def test_private_and_ambiguous_destinations_are_blocked(self):
        for raw in ("http://127.0.0.1", "http://[::1]", "http://[::ffff:127.0.0.1]", "http://169.254.169.254", "http://10.0.0.1", "file:///etc/passwd", "https://user:pass@example.com", "https://example.com:8080", "http://example.com\\@127.0.0.1"):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                public_url(raw)
        calls = []
        http = self.client(lambda *a, **k: calls.append(a), resolver=lambda host: ["93.184.216.34", "10.0.0.1"])
        with self.assertRaisesRegex(ValueError, "DNS"):
            http.request("https://example.com")
        self.assertEqual(calls, [])

    def test_redirects_do_not_forward_secrets_or_enter_private_networks(self):
        http = self.client(lambda *a, **k: {"status": 302, "headers": {"location": "http://127.0.0.1/private"}, "body": b""})
        with self.assertRaisesRegex(ValueError, "redirects"):
            http.request("https://example.com", headers={"X-API-Key": "secret"})
        with self.assertRaisesRegex(ValueError, "private|reserved"):
            http.request("https://example.com")

    def test_rate_limit_persists_and_body_size_and_charsets_are_bounded(self):
        calls = []
        def limited(*args, **kwargs):
            calls.append(args)
            return {"status": 429, "headers": {"Retry-After": "30"}, "body": b"limited"}
        http = self.client(limited)
        with self.assertRaisesRegex(ValueError, "429"):
            http.request("https://example.com")
        with self.assertRaisesRegex(ValueError, "cooling"):
            http.request("https://example.com")
        self.assertEqual(len(calls), 1)
        http = self.client(lambda *a, **k: {"status": 200, "headers": {"content-type": "text/html; charset=gbk"}, "body": "新闻".encode("gbk")})
        self.assertEqual(http.request("https://example.com")["text"], "新闻")
        with self.assertRaisesRegex(ValueError, "size"):
            http.request("https://example.com", max_bytes=1)

    def test_direct_socket_is_dns_pinned_and_gzip_has_decompressed_limit(self):
        connections = []
        data = gzip.compress(b"original evidence")
        class FakeResponse(io.BytesIO):
            status = 200
            def getheaders(self):
                return [("content-encoding", "gzip")]
        class FakeConnection:
            def __init__(self, host, port, **kwargs):
                connections.append((host, port))
            def request(self, method, target, **kwargs):
                self._create_connection(("example.com", 443), 10)
            def getresponse(self):
                return FakeResponse(data)
            def close(self):
                pass
        with patch("firstcue_lib.http.http.client.HTTPSConnection", FakeConnection), patch("firstcue_lib.http.socket.create_connection", return_value=object()) as connect:
            result = exchange("https://example.com/a", method="GET", headers={}, body=None, timeout=10, max_bytes=100, addresses=["93.184.216.34"])
            self.assertEqual(result["body"], b"original evidence")
            self.assertEqual(connections, [("example.com", 443)])
            self.assertEqual(connect.call_args.args[0], ("93.184.216.34", 443))
            with self.assertRaisesRegex(ValueError, "size"):
                exchange("https://example.com/a", method="GET", headers={}, body=None, timeout=10, max_bytes=2, addresses=["93.184.216.34"])


if __name__ == "__main__":
    unittest.main()

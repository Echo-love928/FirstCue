"""Bounded HTML/RSS parsing with html.parser and ElementTree."""
import base64
import json
import re
import xml.etree.ElementTree as ET
from html import unescape
from html.parser import HTMLParser
from urllib.parse import parse_qs, urljoin, urlsplit

from .core import count, hash_text, iso_date, material_hash, now_iso, timestamp, unique
from .http import canonical

VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
SKIP = {"script", "style", "nav", "footer", "header", "aside", "form", "noscript"}


class Node:
    def __init__(self, tag="", attrs=(), parent=None):
        self.tag, self.attrs, self.parent, self.children = tag, dict(attrs), parent, []

    def has_class(self, *names):
        return bool(set((self.attrs.get("class") or "").split()) & set(names))

    def walk(self):
        # Iterative traversal avoids recursion on deeply nested web HTML.
        stack = list(reversed(self.children))
        while stack:
            node = stack.pop()
            if isinstance(node, Node):
                yield node
                stack.extend(reversed(node.children))

    def text(self, skip=SKIP):
        values, stack = [], [self]
        while stack:
            node = stack.pop()
            if isinstance(node, str):
                values.append(node)
            elif node.tag not in skip:
                stack.extend(reversed(node.children))
        return " ".join(values)

    def first(self, predicate):
        return next((n for n in self.walk() if predicate(n)), None)

    def ancestor(self, predicate):
        node = self.parent
        while node:
            if predicate(node):
                return node
            node = node.parent
        return None


class Document(HTMLParser):
    def __init__(self, text):
        super().__init__(convert_charrefs=True)
        self.root, self.stack, self.nodes = Node("document"), [], 0
        self.stack = [self.root]
        self.feed(text)
        self.close()

    def handle_starttag(self, tag, attrs):
        if tag in {"li", "p", "h1", "h2", "h3", "h4"}:
            # Common HTML optional end tags; this is not a browser DOM engine.
            for index in range(len(self.stack) - 1, 0, -1):
                if self.stack[index].tag == tag:
                    self.stack = self.stack[:index]
                    break
        self.nodes += 1
        if self.nodes > 100000 or len(self.stack) > 256:
            raise ValueError("HTML structure exceeds parsing limits")
        node = Node(tag, attrs, self.stack[-1])
        self.stack[-1].children.append(node)
        if tag not in VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                self.stack = self.stack[:index]
                break

    def handle_data(self, data):
        self.stack[-1].children.append(data)


def clean(text):
    return re.sub(r"\s+", " ", Document(str(text or "")).root.text()).strip()


def evidence(source, raw):
    url = canonical(raw["url"])
    result = {"contentKind": "snippet", "author": urlsplit(url).hostname, "publishedAt": None,
              "fetchedAt": now_iso(), "updatedAt": None, "outboundUrls": [], "metrics": {},
              "ruleIds": [], "discoveredBy": [source["id"]], "sourceId": source["id"], "sourceKind": source["kind"], **raw,
              "url": url, "title": clean(raw.get("title", ""))[:400], "text": clean(raw.get("text", ""))[:12000]}
    key = "x:" + raw["externalId"] if source["kind"] == "x" and raw.get("externalId") else url
    result["id"], result["contentHash"] = hash_text(key), material_hash(result)
    return result


def challenge(html):
    sample = clean(html)[:3000] + html[:2000]
    if re.search(r"verify (?:you are|you're) human|checking your browser|just a moment|unusual traffic|b_captcha|anomaly\.js|安全验证|访问验证|异常流量|登录后查看|请先登录|新浪通行证", sample, re.I):
        raise ValueError("Access challenge or login wall; collection stopped for this source")


def search_link(raw, base):
    url = urljoin(base, raw)
    u, params = urlsplit(url), parse_qs(urlsplit(url).query)
    if re.search(r"(^|\.)bing\.com$", u.hostname or "") and u.path == "/ck/a" and params.get("u", [""])[0].startswith("a1"):
        value = params["u"][0][2:]
        return canonical(base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)).decode("utf-8"))
    if re.search(r"(^|\.)duckduckgo\.com$", u.hostname or "") and params.get("uddg"):
        return canonical(params["uddg"][0])
    return canonical(url)


def parse_search(html, source, base):
    challenge(html)
    root = Document(html).root
    engine = source["id"]
    entries = {
        "bing": lambda n: n.has_class("b_algo"),
        "sogou": lambda n: n.has_class("vrwrap", "rb"),
        "baidu": lambda n: n.has_class("c-result", "result", "c-container"),
        "duckduckgo": lambda n: n.has_class("result"),
    }
    snippets = {"bing": {"b_caption"}, "sogou": {"str_info", "str-text-info", "txt-info", "ft"},
                "baidu": {"c-abstract", "c-span-last", "cosc-summary"}, "duckduckgo": {"result__snippet"}}
    if engine not in entries:
        raise ValueError("Search parser not supported")
    result = {}
    for node in root.walk():
        if not entries[engine](node) or node.first(lambda n: "data-ad" in n.attrs or n.has_class("ad-label")):
            continue
        if engine == "duckduckgo":
            link = node.first(lambda n: n.tag == "a" and n.has_class("result__a"))
        else:
            heading = node.first(lambda n: n.tag == ("h2" if engine == "bing" else "h3"))
            link = heading.first(lambda n: n.tag == "a") if heading else None
        if not link or not link.attrs.get("href") or not clean(link.text()):
            continue
        try:
            href = link.attrs["href"]
            if engine == "baidu":
                try:
                    href = json.loads(node.attrs.get("data-log", "{}" )).get("mu") or href
                except (ValueError, TypeError, AttributeError):
                    pass
            url = search_link(href, base)
            u = urlsplit(url)
            if re.search(r"(^|\.)(bing|sogou|baidu|duckduckgo)\.com$", u.hostname or "") and u.path not in {"/link", "/ck/a"}:
                continue
            snippet = node.first(lambda n: n.has_class(*snippets[engine]))
            item = evidence(source, {"url": url, "title": link.text(), "text": snippet.text() if snippet else link.text()})
            result[item["id"]] = item
        except (ValueError, UnicodeError):
            continue
    if not result and not re.search(r"no results|did not match|没有找到|未找到相关|找不到和您的查询", root.text(), re.I):
        raise ValueError("Search layout not recognized; not a verified empty result")
    return list(result.values())[:20]


def literal_redirect(html, base):
    u = urlsplit(base)
    if not re.search(r"(^|\.)(sogou|baidu)\.com$", u.hostname or "") or u.path != "/link":
        return None
    match = re.search(r'window\.location\.replace\(\s*("(?:[^"\\]|\\.)*")\s*\)', html)
    return canonical(json.loads(match.group(1))) if match else None


def parse_article(html, base):
    challenge(html)
    root = Document(html).root
    metas = {}
    for node in root.walk():
        if node.tag == "meta":
            key = node.attrs.get("property") or node.attrs.get("name") or node.attrs.get("itemprop")
            if key:
                metas[key.lower()] = node.attrs.get("content") or ""
    def first_text(tag):
        node = root.first(lambda n: n.tag == tag)
        return node.text() if node else ""
    title = metas.get("og:title") or first_text("h1") or first_text("title")
    author_node = root.first(lambda n: n.attrs.get("rel") == "author")
    author = metas.get("author") or (author_node.text() if author_node else "") or urlsplit(base).hostname
    date_node = root.first(lambda n: n.tag == "time" and n.attrs.get("datetime"))
    date = metas.get("article:published_time") or metas.get("datepublished") or (date_node.attrs["datetime"] if date_node else None)
    for node in root.walk():
        if node.tag != "script" or node.attrs.get("type") != "application/ld+json":
            continue
        try:
            queue = [(json.loads(node.text(skip=set())), 0)]
            while queue:
                obj, depth = queue.pop()
                if depth > 6:
                    continue
                if isinstance(obj, list):
                    queue.extend((x, depth + 1) for x in obj)
                elif isinstance(obj, dict):
                    date = date or obj.get("datePublished")
                    if "@graph" in obj:
                        queue.append((obj["@graph"], depth + 1))
        except (ValueError, RecursionError):
            continue
    description_only = bool(re.search(r"(^|\.)(bilibili\.com|weibo\.com|weibo\.cn)$", urlsplit(base).hostname or ""))
    main = root.first(lambda n: n.tag == "article") or root.first(lambda n: n.tag == "main") or root.first(lambda n: n.tag == "body") or root
    text = clean(metas.get("og:description") or metas.get("description") or "") if description_only else re.sub(r"\s+", " ", main.text()).strip()
    if len(text) < 40:
        raise ValueError("Readable original text unavailable")
    links = []
    for link in main.walk():
        if link.tag == "a" and link.attrs.get("href"):
            try:
                url = canonical(urljoin(base, link.attrs["href"]))
                if urlsplit(url).hostname != urlsplit(base).hostname:
                    links.append(url)
            except ValueError:
                continue
    return {"title": clean(title), "text": text, "author": clean(author), "publishedAt": iso_date(date),
            "updatedAt": iso_date(metas.get("article:modified_time")), "dateBasis": "page_metadata" if date else "unavailable",
            "contentKind": "description" if description_only else "article", "outboundUrls": unique(links)[:20]}


def local_name(tag):
    return tag.rsplit("}", 1)[-1].rsplit(":", 1)[-1]


def parse_feed(xml, source):
    if re.search(r"<!DOCTYPE|<!ENTITY", xml, re.I):
        raise ValueError("Prohibited XML entity declaration")
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        raise ValueError("Invalid XML feed") from None
    atom = local_name(root.tag) == "feed"
    channel = next((n for n in root if local_name(n.tag) == "channel"), None)
    if not atom and (local_name(root.tag) != "rss" or channel is None):
        raise ValueError("Response is not RSS or Atom")
    results = []
    base = urljoin(source["url"], root.attrib.get("{http://www.w3.org/XML/1998/namespace}base", ""))
    for item in [n for n in (root if atom else channel) if local_name(n.tag) == ("entry" if atom else "item")][:100]:
        fields = {}
        for child in item:
            fields.setdefault(local_name(child.tag), []).append(child)
        def value(key):
            node = fields.get(key, [None])[0]
            return "".join(node.itertext()) if node is not None else ""
        if atom:
            link = next((n.attrib.get("href") for n in fields.get("link", []) if n.attrib.get("rel", "alternate") == "alternate"), None)
        else:
            link = value("link")
        if not link:
            continue
        raw_date = value("pubDate") or value("published") or value("date")
        if timestamp(raw_date) is not None and not iso_date(raw_date):
            continue
        try:
            item_base = urljoin(base, item.attrib.get("{http://www.w3.org/XML/1998/namespace}base", ""))
            author = value("creator") or value("author") or urlsplit(source["url"]).hostname
            results.append(evidence(source, {"url": urljoin(item_base, link), "title": value("title"),
                "text": value("encoded") or value("content") or value("description") or value("summary") or value("title"),
                "contentKind": "feed", "publishedAt": iso_date(raw_date), "updatedAt": iso_date(value("updated")),
                "dateBasis": "feed_published" if raw_date else "unavailable", "author": author}))
        except ValueError:
            continue
    return results


def parse_listing(html, source, base):
    challenge(html)
    root, results = Document(html).root, {}
    for node in root.walk():
        if node.tag != "a" or not node.attrs.get("href") or not node.ancestor(lambda n: n.tag in {"main", "article"} or n.has_class("post", "entry")):
            continue
        try:
            url = canonical(urljoin(base, node.attrs["href"]))
            u = urlsplit(url)
            if u.hostname != urlsplit(base).hostname or not re.search(r"/(news|blog|changelog|updates|posts|announcements|20\d{2})/.+", u.path, re.I):
                continue
            heading = node.first(lambda n: n.tag in {"h2", "h3", "h4"})
            title = heading.text() if heading else node.text()
            if len(clean(title)) < 8:
                continue
            card = node.ancestor(lambda n: n.tag == "article")
            date_node = card.first(lambda n: n.tag == "time" and n.attrs.get("datetime")) if card else None
            item = evidence(source, {"url": url, "title": title, "text": title, "publishedAt": iso_date(date_node.attrs["datetime"] if date_node else None)})
            results[item["id"]] = item
        except ValueError:
            continue
    if not results:
        raise ValueError("Listing structure not recognized; not a verified empty result")
    return list(results.values())[:20]


def parse_tweet(tweet, source):
    author = tweet.get("author", {}) if isinstance(tweet, dict) else {}
    if not isinstance(tweet, dict) or not isinstance(tweet.get("id"), str) or not re.fullmatch(r"\d{1,30}", tweet["id"]) or not isinstance(tweet.get("text"), str) or not isinstance(author, dict) or not re.fullmatch(r"[A-Za-z0-9_]{1,15}", str(author.get("userName", ""))):
        raise ValueError("Malformed tweet")
    if tweet.get("isReply") is True or tweet.get("inReplyToId"):
        post_type = "reply"
    elif tweet.get("retweeted_tweet") is not None or tweet["text"].startswith("RT @"):
        post_type = "repost"
    elif tweet.get("quoted_tweet") is not None:
        post_type = "quote"
    else:
        post_type = "original" if tweet.get("isReply") is False else "unknown"
    metrics = {}
    for key, raw in {"likes": tweet.get("likeCount"), "reposts": tweet.get("retweetCount"), "replies": tweet.get("replyCount"), "views": tweet.get("viewCount"), "bookmarks": tweet.get("bookmarkCount")}.items():
        parsed = count(raw)
        if parsed is not None:
            metrics[key] = parsed
    links = []
    entities = tweet.get("entities") or {}
    for link in entities.get("urls", []) if isinstance(entities, dict) else []:
        try:
            links.append(canonical(link.get("expanded_url") or link.get("url")))
        except (ValueError, AttributeError):
            continue
    return evidence(source, {"url": f"https://x.com/{author['userName']}/status/{tweet['id']}", "externalId": tweet["id"],
        "title": tweet["text"][:200], "text": tweet["text"], "contentKind": "post", "postType": post_type,
        "publishedAt": iso_date(tweet.get("createdAt")), "dateBasis": "platform_published", "author": author.get("name") or author["userName"],
        "authorId": author.get("id"), "authorUserName": author["userName"], "authorFollowers": count(author.get("followers")),
        "authorBlueVerified": author.get("isBlueVerified") is True, "metrics": metrics, "outboundUrls": links,
        "excluded": post_type != "original", "exclusionReason": None if post_type == "original" else f"X {post_type} is excluded from the feed"})

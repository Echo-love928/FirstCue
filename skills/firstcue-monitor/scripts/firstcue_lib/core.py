"""Independent state, validation and shared evidence primitives."""
import contextlib
import copy
import hashlib
import json
import math
import os
import re
import tempfile
import time
import uuid
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def hash_text(value):
    return hashlib.sha256(str(value).encode("utf-8")).hexdigest()[:24]


def fingerprint(value):
    return hash_text(compact(value))


def now_iso(now=None):
    return datetime.fromtimestamp(time.time() if now is None else now, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def timestamp(raw):
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        dt = datetime.fromisoformat(raw.strip().replace("Z", "+00:00"))
    except ValueError:
        try:
            dt = parsedate_to_datetime(raw)
        except (ValueError, TypeError, OverflowError):
            return None
    if dt.tzinfo is None:
        # A date without a timezone is interpreted consistently as UTC.
        dt = dt.replace(tzinfo=timezone.utc)
    try:
        result = dt.timestamp()
        return result if math.isfinite(result) else None
    except (ValueError, OverflowError, OSError):
        return None


def iso_date(raw, now=None):
    value = timestamp(raw)
    return now_iso(value) if value is not None and value <= (time.time() if now is None else now) + 300 else None


def day_key(now=None):
    return datetime.fromtimestamp(time.time() if now is None else now, timezone(timedelta(hours=8))).strftime("%Y-%m-%d")


SETTINGS = {
    "lookbackHours": (120, 1, 120), "searchPerRunLimit": (16, 1, 20),
    "readPerRunLimit": (10, 0, 30), "xPagesPerQuery": (3, 1, 3),
    "xDailyLimit": (200, 1, 10000), "xResultDailyLimit": (2000, 20, 100000),
    "cacheMinutes": (30, 1, 1440), "intervalMinutes": (30, 30, 30),
}


def validate_settings(raw, partial=False):
    if not isinstance(raw, dict) or set(raw) - set(SETTINGS):
        raise ValueError("Unknown or invalid settings")
    result = {} if partial else {k: v[0] for k, v in SETTINGS.items()}
    for key, value in raw.items():
        _, minimum, maximum = SETTINGS[key]
        if type(value) is not int or not minimum <= value <= maximum:
            raise ValueError(f"{key} must be an integer in {minimum}..{maximum}")
        result[key] = value
    return result


def string(value, name, maximum, minimum=1):
    if not isinstance(value, str) or not minimum <= len(value.strip()) <= maximum:
        raise ValueError(f"{name} must be text of length {minimum}..{maximum}")
    return value.strip()


def validate_entity(kind, raw, partial=False):
    fields = {
        "rules": {"name", "query", "kind", "enabled", "notify"},
        "sources": {"name", "kind", "url", "enabled"},
        "accounts": {"userName", "enabled"},
    }[kind]
    if not isinstance(raw, dict) or set(raw) - fields:
        raise ValueError(f"Unknown or invalid {kind} fields")
    result = {} if partial else {"enabled": True}
    if kind == "rules" and not partial:
        result.update(kind="keyword", notify=False)
    for key, value in raw.items():
        if key in {"enabled", "notify"}:
            if type(value) is not bool:
                raise ValueError(f"{key} must be true or false")
            result[key] = value
        elif key == "kind":
            if value not in ({"keyword", "topic"} if kind == "rules" else {"rss", "page"}):
                raise ValueError("Invalid kind")
            result[key] = value
        elif key == "userName":
            if not isinstance(value, str) or not re.fullmatch(r"@?[A-Za-z0-9_]{1,15}", value):
                raise ValueError("Invalid X user name")
            result[key] = value.lstrip("@")
        else:
            result[key] = string(value, key, {"name": 150, "query": 500, "url": 4000}[key])
    required = {"rules": {"name", "query"}, "sources": {"name", "kind", "url"}, "accounts": {"userName"}}[kind]
    if not partial and required - set(result):
        raise ValueError(f"Missing fields: {', '.join(sorted(required - set(result)))}")
    return result


def initial_state():
    sources = [
        ("bing", "Bing", "search", "https://www.bing.com/search", True),
        ("sogou", "搜狗", "search", "https://www.sogou.com/web", True),
        ("baidu", "百度（备选）", "search", "https://m.baidu.com/s", False),
        ("duckduckgo", "DuckDuckGo（备选）", "search", "https://html.duckduckgo.com/html/", False),
        ("twitter", "X / TwitterAPI.io", "x", "https://api.twitterapi.io", True),
        ("openai", "OpenAI News", "rss", "https://openai.com/news/rss.xml", True),
        ("google", "Google AI", "rss", "https://blog.google/innovation-and-ai/technology/ai/rss/", True),
        ("huggingface", "Hugging Face", "rss", "https://huggingface.co/blog/feed.xml", True),
        ("cursor", "Cursor", "rss", "https://cursor.com/changelog/rss.xml", True),
        ("vscode", "VS Code", "rss", "https://code.visualstudio.com/feed.xml", True),
        ("anthropic", "Anthropic", "page", "https://www.anthropic.com/news", True),
        ("qwen", "Qwen", "page", "https://qwenlm.github.io/", True),
        ("deepseek", "DeepSeek", "page", "https://api-docs.deepseek.com/", True),
    ]
    return {"schemaVersion": 1, "settings": validate_settings({}), "rules": [],
            "sources": [dict(id=i, name=n, kind=k, url=u, enabled=e, builtin=True) for i, n, k, u, e in sources],
            "accounts": [], "evidence": {}, "analyses": {}, "checkpoints": {},
            "cache": {}, "backoff": {}, "usage": {}, "runs": [], "notifications": []}


def read_json(file):
    # UTF-8 BOM from Windows editors is accepted. NaN/Infinity are not JSON.
    def invalid(value):
        raise ValueError(f"Invalid JSON number: {value}")
    return json.loads(Path(file).read_text(encoding="utf-8-sig"), parse_constant=invalid)


def read_state(directory):
    file = Path(directory) / "state.json"
    if not file.exists():
        return initial_state()
    state = read_json(file)
    if not isinstance(state, dict) or state.get("schemaVersion") != 1:
        raise ValueError("Unsupported state version")
    validate_settings(state["settings"])
    for key in ("evidence", "analyses", "checkpoints", "cache", "backoff", "usage"):
        if not isinstance(state.get(key), dict):
            raise ValueError(f"Invalid state: {key}")
    for key in ("rules", "sources", "accounts", "runs", "notifications"):
        if not isinstance(state.get(key), list):
            raise ValueError(f"Invalid state: {key}")
    return state


def atomic_json(file, value):
    file = Path(file)
    file.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=file.name + ".", suffix=".tmp", dir=file.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, file)
    finally:
        Path(name).unlink(missing_ok=True)


def save_state(directory, state):
    atomic_json(Path(directory) / "state.json", state)


@contextlib.contextmanager
def state_lock(directory):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    lock = directory / ".lock"
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        raise ValueError(f"Data directory is busy or has a stale lock: {lock}. Check its PID before removing it.") from None
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump({"pid": os.getpid(), "startedAt": now_iso()}, stream)
        yield
    finally:
        lock.unlink()


def reserve(state, name, amount, limit, now=None):
    usage = state["usage"].setdefault(day_key(now), {})
    if usage.get(name, 0) + amount > limit:
        return False
    usage[name] = usage.get(name, 0) + amount
    return True


def count(value):
    if type(value) in (int, float):
        return int(value) if math.isfinite(value) and 0 <= value <= 2**53 - 1 and int(value) == value else None
    if not isinstance(value, str) or not re.fullmatch(r"(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?\s*[kKmMbB万亿]?", value.strip()):
        return None
    match = re.fullmatch(r"(\d+(?:\.\d+)?)\s*([kKmMbB万亿])?", value.strip().replace(",", ""))
    number, unit = match.groups()
    number = float(number) * {"k": 1000, "m": 1000000, "b": 1000000000, "万": 10000, "亿": 100000000}.get((unit or "").lower(), 1)
    if not math.isfinite(number) or number > 2**53 - 1 or not unit and not number.is_integer():
        return None
    return math.floor(number + .5)


def heat(item):
    weights = {"likes": 1, "reposts": 2, "replies": 1, "views": .01, "bookmarks": 2, "favorites": 2, "coins": 2, "danmaku": 1, "points": 1}
    values = [(count(item.get("metrics", {}).get(k)), weight) for k, weight in weights.items()]
    known = [(value, weight) for value, weight in values if value is not None]
    return sum(value * weight for value, weight in known) if known else None


def material_hash(item):
    return fingerprint([item.get("title"), item.get("text"), item.get("publishedAt") or None,
                        item.get("author") or "", item.get("authorId") or "", item.get("postType") or None, bool(item.get("excluded"))])


def unique(values):
    return list(dict.fromkeys(values))


def ingest(state, incoming):
    item = copy.deepcopy(incoming)
    old = state["evidence"].get(item["id"], {})
    richer_old = old and old.get("contentKind") != "snippet" and item.get("contentKind") == "snippet"
    merged = {**item, **old, "fetchedAt": item["fetchedAt"]} if richer_old else {**old, **item}
    merged["firstDiscoveredAt"] = old.get("firstDiscoveredAt") or item.get("firstDiscoveredAt") or item["fetchedAt"]
    for key in ("ruleIds", "discoveredBy"):
        merged[key] = unique(old.get(key, []) + item.get(key, []))
    merged["metrics"] = {**old.get("metrics", {}), **item.get("metrics", {})}
    old_time, new_time = timestamp(old.get("publishedAt")), timestamp(merged.get("publishedAt"))
    if old_time is not None and (new_time is None or old_time < new_time):
        merged["publishedAt"] = old["publishedAt"]
    merged["contentHash"] = material_hash(merged)
    state["evidence"][item["id"]] = merged
    return merged


def load_env(file):
    result = {}
    for line in Path(file).read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        match = re.fullmatch(r"(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)", line)
        if not match:
            raise ValueError("Invalid environment file line; expected NAME=value")
        key, value = match.groups()
        if value.startswith(('"', "'")):
            quote = value[0]
            end = value.find(quote, 1)
            if end < 0 or value[end + 1:].strip() and not value[end + 1:].strip().startswith("#"):
                raise ValueError("Invalid quoted environment value")
            value = value[1:end]
        else:
            value = re.split(r"\s+#", value, maxsplit=1)[0].strip()
        result[key] = value
    return result


def safe_error(error, env=None):
    text = str(error)
    for key, value in (os.environ if env is None else env).items():
        if re.search(r"KEY|TOKEN|SECRET|PASS|WEBHOOK", key, re.I) and value and len(value) >= 4:
            text = text.replace(value, "[redacted]")
    return re.sub(r"https?://[^\s\"'<>]+", "[URL]", text)[:800]


def new_id():
    return str(uuid.uuid4())

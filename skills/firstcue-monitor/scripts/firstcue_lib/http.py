"""Public HTTP client with DNS pinning, bounded bodies and persistent backoff."""
import base64
import gzip
import http.client
import ipaddress
import re
import socket
import ssl
import time
from urllib.parse import parse_qsl, quote, urlencode, urljoin, urlsplit, urlunsplit, unquote

from .core import iso_date, now_iso, timestamp


def public_address(value):
    try:
        ip = ipaddress.ip_address(value)
        if getattr(ip, "ipv4_mapped", None):
            ip = ip.ipv4_mapped
        return ip.is_global and not (ip.is_multicast or ip.is_reserved or ip.is_loopback or ip.is_link_local or ip.is_unspecified)
    except ValueError:
        return False


def public_url(raw):
    if not isinstance(raw, str) or re.search(r"[\x00-\x20\x7f\\]", raw):
        raise ValueError("Invalid public URL")
    u = urlsplit(raw)
    host = u.hostname or ""
    if u.scheme not in {"http", "https"} or u.username is not None or u.password is not None or u.port not in {None, 80, 443}:
        raise ValueError("Only public HTTP(S) URLs on standard ports without credentials are allowed")
    if not host or "." not in host and ":" not in host or re.search(r"(^|\.)(localhost|local|internal|test|invalid)\.?$", host, re.I):
        raise ValueError("Local, private and reserved destinations are blocked")
    try:
        ipaddress.ip_address(host)
    except ValueError:
        if ":" in host or "%" in host:
            raise ValueError("Invalid public hostname") from None
    else:
        if not public_address(host):
            raise ValueError("Local, private and reserved destinations are blocked")
    return u


def canonical(raw):
    u = public_url(raw)
    host = u.hostname.encode("idna").decode("ascii").lower()
    if host in {"www.twitter.com", "twitter.com", "www.x.com"}:
        host = "x.com"
    if ":" in host:
        host = "[" + host + "]"
    if u.port and u.port != (443 if u.scheme == "https" else 80):
        host += ":" + str(u.port)
    query = [(k, v) for k, v in parse_qsl(u.query, keep_blank_values=True) if not re.match(r"^(utm_|fbclid$|gclid$|spm|vd_source$)", k, re.I)]
    return urlunsplit((u.scheme, host, quote(u.path or "/", safe="/%:@!$&'()*+,;=-._~"), urlencode(sorted(query)), ""))


def resolve_public(host):
    return list(dict.fromkeys(row[4][0] for row in socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)))


def exchange(raw, *, method, headers, body, timeout, max_bytes, addresses, proxy=None):
    """Pin direct sockets to prevalidated IPs while preserving Host and TLS SNI.

    Explicit HTTP proxies are trusted to resolve their CONNECT target; direct
    requests never perform a second, unguarded target DNS lookup.
    """
    u = public_url(raw)
    host = u.hostname.encode("idna").decode("ascii")
    port = u.port or (443 if u.scheme == "https" else 80)
    target = urlunsplit(("", "", quote(u.path or "/", safe="/%:@!$&'()*+,;=-._~"), quote(u.query, safe="%=&?/:;+,@!$'()*-._~"), ""))
    kwargs = {"timeout": timeout}
    request_headers = dict(headers)
    if proxy:
        p = urlsplit(proxy)
        if p.scheme != "http" or not p.hostname or p.path not in {"", "/"} or p.query or p.fragment:
            raise ValueError("Proxy must be an http:// proxy; HTTPS targets use CONNECT with TLS verification")
        auth = {}
        if p.username is not None:
            token = base64.b64encode((unquote(p.username) + ":" + unquote(p.password or "")).encode()).decode()
            auth["Proxy-Authorization"] = "Basic " + token
        if u.scheme == "https":
            conn = http.client.HTTPSConnection(p.hostname, p.port or 80, context=ssl.create_default_context(), **kwargs)
            conn.set_tunnel(host, port, headers=auth)
        else:
            conn = http.client.HTTPConnection(p.hostname, p.port or 80, **kwargs)
            target = urlunsplit((u.scheme, u.netloc, quote(u.path or "/", safe="/%:@!$&'()*+,;=-._~"), quote(u.query, safe="%=&?/:;+,@!$'()*-._~"), ""))
            request_headers.update(auth)
    else:
        conn = (http.client.HTTPSConnection(host, port, context=ssl.create_default_context(), **kwargs)
                if u.scheme == "https" else http.client.HTTPConnection(host, port, **kwargs))
        # http.client uses this factory for its TCP socket, then applies TLS
        # using the original hostname. No global socket monkey-patch is used.
        def connect_pinned(_address, wait=timeout, source_address=None, **_kwargs):
            last = None
            for address in addresses:
                try:
                    return socket.create_connection((address, port), timeout=wait, source_address=source_address)
                except OSError as error:
                    last = error
            raise last or OSError("No public addresses available")
        conn._create_connection = connect_pinned
    try:
        conn.request(method, target, body=body, headers=request_headers)
        response = conn.getresponse()
        response_headers = {k.lower(): v for k, v in response.getheaders()}
        if int(response_headers.get("content-length", "0")) > max_bytes:
            raise ValueError("Response exceeds size limit")
        encoding = response_headers.get("content-encoding", "").lower()
        if encoding not in {"", "identity", "gzip"}:
            raise ValueError("Unsupported HTTP content encoding")
        reader = gzip.GzipFile(fileobj=response) if encoding == "gzip" else response
        data = reader.read(max_bytes + 1)
        if len(data) > max_bytes:
            raise ValueError("Response exceeds size limit")
        return {"status": response.status, "headers": response_headers, "body": data}
    finally:
        conn.close()


class PublicHTTP:
    def __init__(self, state, env=None, *, resolver=resolve_public, transport=exchange, min_delay=2):
        self.state, self.env = state, env or {}
        self.resolver, self.transport = resolver, transport
        self.min_delay, self.last = min_delay, {}

    def request(self, raw, *, method="GET", headers=None, body=None, no_redirect=False, max_bytes=3 * 1024 * 1024, timeout=20):
        if method not in {"GET", "POST"}:
            raise ValueError("Unsupported HTTP method")
        request_headers = {"User-Agent": "FirstCueSkill/2.0 (personal research)", "Accept": "text/html,application/xml,application/json;q=0.9,*/*;q=0.5", "Accept-Encoding": "gzip", **(headers or {})}
        if isinstance(body, str):
            body = body.encode("utf-8")
        raw = canonical(raw)
        for _ in range(5):
            u = public_url(raw)
            host = u.hostname
            if self.state["backoff"].get(host, 0) > time.time() * 1000:
                raise ValueError(f"{host}: source is cooling down until {now_iso(self.state['backoff'][host] / 1000)}")
            addresses = self.resolver(host)
            if not addresses or any(not public_address(address) for address in addresses):
                raise ValueError("DNS resolves to private/reserved network")
            delay = self.last.get(host, 0) + self.min_delay - time.monotonic()
            if delay > 0:
                time.sleep(delay)
            self.last[host] = time.monotonic()
            proxy = self.env.get("HTTPS_PROXY") or self.env.get("HTTP_PROXY") if u.scheme == "https" else self.env.get("HTTP_PROXY")
            try:
                response = self.transport(raw, method=method, headers=request_headers, body=body, timeout=timeout, max_bytes=max_bytes, addresses=addresses, proxy=proxy)
            except (OSError, http.client.HTTPException) as error:
                raise ValueError(f"{host}: connection failed or request timed out ({type(error).__name__})") from None
            status = response["status"]
            response_headers = {k.lower(): v for k, v in response["headers"].items()}
            if status in {301, 302, 303, 307, 308}:
                if no_redirect or method == "POST" or any(re.search(r"authorization|api-key", k, re.I) for k in headers or {}):
                    raise ValueError("Credential-bearing or POST redirects are blocked")
                location = response_headers.get("location")
                if not location:
                    raise ValueError("Redirect target missing")
                raw = canonical(urljoin(raw, location))
                continue
            if status in {429, 503}:
                retry = response_headers.get("retry-after", "")
                seconds = float(retry) if retry.isdigit() else (timestamp(retry) or time.time() + 60) - time.time()
                self.state["backoff"][host] = time.time() * 1000 + max(1000, seconds * 1000)
            if not 200 <= status < 300:
                raise ValueError(f"{host}: HTTP {status}" + (" rate limited" if status == 429 else ""))
            data = response["body"]
            if len(data) > max_bytes:
                raise ValueError("Response exceeds size limit")
            charset = re.search(r"charset=[\"']?([\w-]+)", response_headers.get("content-type", ""), re.I)
            encoding = charset.group(1) if charset else "utf-8"
            # Some public search pages declare GBK only in their HTML head.
            if not charset:
                meta = re.search(rb"charset\s*=\s*[\"']?([\w-]+)", data[:4096], re.I)
                if meta:
                    encoding = meta.group(1).decode("ascii")
            try:
                text = data.decode(encoding, errors="replace")
            except LookupError:
                text = data.decode("utf-8", errors="replace")
            return {"url": raw, "status": status, "headers": response_headers, "text": text}
        raise ValueError("Too many redirects")

    def close(self):
        pass

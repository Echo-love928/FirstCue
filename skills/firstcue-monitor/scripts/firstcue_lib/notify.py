"""Optional SMTP and Feishu delivery with durable, conservative send state."""
import base64
import copy
import hashlib
import hmac
import json
import re
import smtplib
import ssl
import time
from email.message import EmailMessage
from email.utils import parseaddr
from urllib.parse import urlsplit

from .analysis import stale_event
from .core import hash_text, new_id, now_iso, safe_error, timestamp


class DeliveryRejected(ValueError):
    """Explicitly rejected before the provider could accept delivery."""


def valid_webhook(raw):
    try:
        u = urlsplit(raw or "")
        return u.scheme == "https" and u.hostname == "open.feishu.cn" and not u.port and u.username is None and u.password is None and not u.query and not u.fragment and bool(re.fullmatch(r"/open-apis/bot/v2/hook/[A-Za-z0-9-]+", u.path))
    except ValueError:
        return False


def feishu_sign(timestamp_value, secret):
    return base64.b64encode(hmac.new((str(timestamp_value) + "\n" + secret).encode(), b"", hashlib.sha256).digest()).decode()


def channel_target(channel, env):
    if channel == "feishu":
        if not valid_webhook(env.get("FEISHU_WEBHOOK_URL")):
            raise ValueError("Configure a valid FEISHU_WEBHOOK_URL in the skill environment")
        return hash_text(env["FEISHU_WEBHOOK_URL"])
    if channel != "mail":
        raise ValueError("Channel must be mail or feishu")
    if not all(env.get(k) for k in ("SMTP_HOST", "SMTP_USER", "SMTP_PASS", "SMTP_FROM")) or not re.fullmatch(r"[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+", env.get("NOTIFY_EMAIL", "")):
        raise ValueError("Configure SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM and one NOTIFY_EMAIL")
    return hash_text(env["NOTIFY_EMAIL"].strip().lower())


def eligible_event(state, event, now=None):
    now = time.time() if now is None else now
    if stale_event(state, event) or event["relevance"] != "direct" or event["verdict"] == "refuted":
        return False
    if event["ruleIds"] and not any(r["id"] in event["ruleIds"] and r["enabled"] and r["notify"] for r in state["rules"]):
        return False
    items = [state["evidence"][c["evidenceId"]] for c in event["citations"]]
    if all(i.get("excluded") for i in items):
        return False
    dates = [timestamp(i.get("publishedAt")) for i in items]
    dates = [d for d in dates if d is not None]
    when = timestamp(event.get("occurredAt")) if event.get("occurredAt") else min(dates) if dates else min(timestamp(i["firstDiscoveredAt"]) or 0 for i in items)
    return when is not None and now - 120 * 3600 <= when <= now


def event_key(state, event):
    return hash_text("|".join(sorted({state["evidence"][c["evidenceId"]]["url"] for c in event["citations"]})))


def preview_notification(state, report, channel, env, now=None):
    target = channel_target(channel, env)
    used = {key for job in state["notifications"] if job["channel"] == channel and job["targetId"] == target for key in job["keys"]}
    events, keys = [], []
    for event in report["events"]:
        key = event_key(state, event)
        if key in used or key in keys or not eligible_event(state, event, now):
            continue
        keys.append(key)
        events.append(copy.deepcopy(event))
    lines = ["[FirstCue] 热点汇总", ""]
    for event in events:
        lines.extend([event["title"], f"[{event['importance']} / {event['verdict']}] {event['summary']}", event["reason"]])
        lines.extend(state["evidence"][c["evidenceId"]]["url"] for c in event["citations"])
        lines.append("")
    return {"channel": channel, "targetId": target, "count": len(events), "events": events, "keys": keys, "text": "\n".join(lines)}


def send_channel(channel, text, identity, http, env):
    if channel == "feishu":
        payload = {"msg_type": "post", "content": {"post": {"zh_cn": {"title": "[FirstCue] 热点汇总", "content": [[{"tag": "text", "text": line}] for line in text.split("\n")]}}}}
        if env.get("FEISHU_SIGNING_SECRET"):
            stamp = str(int(time.time()))
            payload.update(timestamp=stamp, sign=feishu_sign(stamp, env["FEISHU_SIGNING_SECRET"]))
        body = json.dumps(payload, ensure_ascii=False)
        if len(body.encode()) > 18 * 1024:
            raise DeliveryRejected("Feishu digest exceeds 18 KB. Create a smaller report; content was not truncated.")
        result = http.request(env["FEISHU_WEBHOOK_URL"], method="POST", headers={"Content-Type": "application/json"}, body=body, no_redirect=True, max_bytes=65536)
        try:
            data = json.loads(result["text"])
        except ValueError:
            raise ValueError("Feishu returned invalid JSON; delivery is uncertain") from None
        if not isinstance(data, dict) or data.get("code", data.get("StatusCode")) != 0:
            raise DeliveryRejected("Feishu rejected the message")
        return
    try:
        port = int(env.get("SMTP_PORT") or "587")
        if not 1 <= port <= 65535 or env.get("SMTP_SECURE", "false").lower() not in {"true", "false"}:
            raise ValueError()
    except ValueError:
        raise DeliveryRejected("Invalid SMTP_PORT or SMTP_SECURE") from None
    secure = env.get("SMTP_SECURE", "true" if port == 465 else "false").lower() == "true"
    sender = parseaddr(env["SMTP_FROM"])[1]
    if not re.fullmatch(r"[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+", sender) or any(c in env["SMTP_FROM"] for c in "\r\n"):
        raise DeliveryRejected("Invalid SMTP_FROM")
    msg = EmailMessage()
    msg["From"], msg["To"], msg["Subject"], msg["Message-ID"] = env["SMTP_FROM"], env["NOTIFY_EMAIL"], "[FirstCue] 热点汇总", f"<{identity}@firstcue.local>"
    msg.set_content(text)
    client = None
    try:
        context = ssl.create_default_context()
        client = smtplib.SMTP_SSL(env["SMTP_HOST"], port, timeout=20, context=context) if secure else smtplib.SMTP(env["SMTP_HOST"], port, timeout=20)
        if not secure:
            client.ehlo()
            client.starttls(context=context)
            client.ehlo()
        client.login(env["SMTP_USER"], env["SMTP_PASS"])
        refused = client.send_message(msg, from_addr=sender, to_addrs=[env["NOTIFY_EMAIL"]])
        if refused:
            raise DeliveryRejected("SMTP refused recipient")
    except (smtplib.SMTPAuthenticationError, smtplib.SMTPRecipientsRefused, smtplib.SMTPSenderRefused, smtplib.SMTPDataError) as error:
        raise DeliveryRejected(f"SMTP explicitly rejected delivery ({type(error).__name__})") from None
    finally:
        if client:
            client.close()


def notify(state, *, report_id=None, channel=None, retry_id=None, send=False, env=None, http=None, persist=lambda: None, sender=send_channel, now=None):
    env, now = env or {}, time.time() if now is None else now
    if retry_id:
        job = next((j for j in state["notifications"] if j["id"] == retry_id), None)
        if not job:
            raise ValueError("Notification not found")
        channel = job["channel"]
        if job["status"] != "failed":
            raise ValueError("Only definitively failed notifications can be retried; accepted or uncertain sends must not be resent automatically")
        if job["attempts"] >= 4:
            raise ValueError("Notification attempt limit reached")
        if channel_target(channel, env) != job["targetId"]:
            raise ValueError("Notification destination changed; old digest cannot be forwarded")
        if not all(eligible_event(state, event, now) for event in job["events"]):
            raise ValueError("Notification contains paused, expired or changed evidence; create a new report")
    else:
        report = state["analyses"].get(report_id)
        if not report:
            raise ValueError("Report not found")
        preview = preview_notification(state, report, channel, env, now)
        if not send or not preview["count"]:
            return {k: v for k, v in {**preview, "status": "preview" if preview["count"] else "empty"}.items() if k != "events"}
        job = {**preview, "id": new_id(), "reportId": report_id, "createdAt": now_iso(), "status": "pending", "attempts": 0}
    if not send:
        return job
    latest = max([timestamp(j.get("lastAttemptAt")) or 0 for j in state["notifications"] if j["channel"] == channel] or [0])
    if now - latest < 1800:
        raise ValueError("Channel cooldown: wait 30 minutes between delivery attempts")
    job.update(status="sending", attempts=job["attempts"] + 1, lastAttemptAt=now_iso(now))
    if not retry_id:
        state["notifications"].insert(0, job)
    persist()
    try:
        sender(channel, job["text"], job["id"], http, env)
        job.update(status="accepted", acceptedAt=now_iso(), error=None)
    except Exception as error:
        # Once an attempt has started, unexpected failures are delivery-uncertain.
        job.update(status="failed" if isinstance(error, DeliveryRejected) else "uncertain", error=safe_error(error, env))
    persist()
    return {**{key: job.get(key) for key in ("id", "channel", "status", "count", "attempts", "error")}, "message": "Provider accepted the request; this is not a read receipt" if job["status"] == "accepted" else None}

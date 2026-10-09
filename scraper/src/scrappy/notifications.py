"""Independent push/email delivery with a durable record for every attempt."""

from email.message import EmailMessage
from html import escape
import json
import os
import re
import smtplib
import ssl
from urllib.request import Request, urlopen


def send_ntfy(payload):
    topic = os.environ.get("NTFY_TOPIC", "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{24,}", topic):
        raise ValueError("NTFY_TOPIC inválido.")
    request = Request("https://ntfy.sh/", method="POST",
                      data=json.dumps({"topic": topic, **payload}, ensure_ascii=False).encode("utf-8"),
                      headers={"Content-Type": "application/json"})
    with urlopen(request, timeout=15) as response:
        receipt = json.loads(response.read())
    if receipt.get("event") != "message" or not receipt.get("id"):
        raise RuntimeError("ntfy no confirmó el envío.")


def send_email(payload):
    user = os.environ.get("GMAIL_USER", "").strip()
    password = os.environ.get("GMAIL_APP_PASSWORD", "").strip()
    recipient = os.environ.get("NOTIFY_EMAIL_TO", "").strip()
    if not user or not password or not recipient:
        raise ValueError("Falta configuración de correo.")
    message = EmailMessage()
    message["From"], message["To"], message["Subject"] = user, recipient, payload["title"]
    link = payload.get("click", "")
    message.set_content(payload["message"] + (f"\n{link}" if link else ""))
    html = f"<p>{escape(payload['message'])}</p>"
    if link:
        html += f'<p><a href="{escape(link, quote=True)}">Ver producto</a></p>'
    message.add_alternative(html, subtype="html")
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=15, context=ssl.create_default_context()) as smtp:
        smtp.login(user, password)
        if smtp.send_message(message):
            raise RuntimeError("El destinatario rechazó el correo.")


def deliver(database, product_id, kind, payload, now, *, channels=None):
    """Try both channels even on delivery/audit failure; never store raw errors."""
    channels = channels if channels is not None else {"ntfy": send_ntfy, "email": send_email}
    sent = False
    audit_failed = False
    for channel, send in channels.items():
        error = None
        try:
            send(payload)
        except Exception:
            error = f"No se pudo enviar por {channel}."
        sent |= error is None
        try:
            database.request("POST", "notifications", {
                "product_id": product_id, "type": kind, "channel": channel,
                "status": "failed" if error else "sent", "payload": payload,
                "error": error, "sent_at": now.isoformat(),
            })
        except Exception:
            audit_failed = True
    if audit_failed:
        raise RuntimeError("No se pudieron registrar todos los intentos de notificación.")
    return sent


def test_notification(database, now, *, channels=None):
    payload = {"title": "✅ Notificación de prueba de Scrappy",
               "message": "✅ Notificación de prueba de Scrappy", "priority": 3, "tags": ["white_check_mark"]}
    if not deliver(database, None, "test", payload, now, channels=channels):
        raise RuntimeError("Fallaron ambos canales de notificación.")

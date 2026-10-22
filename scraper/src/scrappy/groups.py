"""Deliver durable group claims without replaying ambiguous receipts."""

import os
from urllib.parse import urlsplit, urlencode
from decimal import Decimal

from scrappy.notifications import deliver


def process_product_groups(database, checked_at, *, notify=deliver):
    base = os.environ.get("PURCHASE_APP_ORIGIN", "").strip().rstrip("/")
    parsed = urlsplit(base)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.query or parsed.fragment:
        raise ValueError("PURCHASE_APP_ORIGIN debe ser una URL HTTPS válida para los avisos de grupos.")
    failed = False
    for event in database.claim_product_group_events():
        snapshot = event["snapshot"]
        offer = snapshot["offer"]
        currency = "S/" if snapshot["currency"] == "PEN" else snapshot["currency"]
        money = lambda amount: f"{currency} {Decimal(str(amount)):,.2f}"
        title = "📉 Bajó aún más" if event["kind"] == "dropped_further" else "🔥 Meta alcanzada"
        payload = {
            "title": f"{title}: {snapshot['name']}",
            "message": f"{offer['domain']}: {money(snapshot['price'])} · meta {money(snapshot['target'])}. "
                       f"Lectura: {offer['checked_at']}. Más barata entre las opciones verificadas. "
                       f"Tiendas excluidas: {snapshot['excluded']}. Tienda: {offer['url']}",
            "priority": 4, "tags": ["moneybag"],
            "click": f"{base}/?{urlencode({'group': event['group_id'], 'group_event': event['id']})}",
        }
        try:
            sent = notify(database, None, event["kind"], payload, checked_at,
                          audit_context={"group_id": event["group_id"], "group_event_id": event["id"],
                                         "group_version": event["version"], "offer": offer})
            database.finish_product_group_event(event["id"], sent)
            failed |= not sent
        except Exception:
            # The claim already advanced state; no automatic duplicate delivery.
            failed = True
    if failed:
        raise RuntimeError("Aviso de grupo sin entrega confirmada; consulta el historial.")

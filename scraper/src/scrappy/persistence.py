"""Server-only Supabase transport and atomic validated-review persistence."""

import json
import os
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.parse import quote
from urllib.request import Request, urlopen
from uuid import UUID


class Database:
    def __init__(self):
        self.url = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
        self.key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
        if not self.url or not self.key:
            raise ValueError("Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY.")
        parsed = urlsplit(self.url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.query or parsed.fragment or parsed.path:
            raise ValueError("SUPABASE_URL debe ser la URL HTTPS del proyecto, sin ruta.")

    def request(self, method, path, data=None):
        if method == "POST" and path == "notifications":
            path, data = "rpc/record_notification", {"p_notification": data}
        request = Request(
            f"{self.url}/rest/v1/{path}", method=method,
            data=json.dumps(data, allow_nan=False).encode() if data is not None else None,
            headers={"apikey": self.key, "Authorization": f"Bearer {self.key}",
                     "Content-Type": "application/json", "Prefer": "return=representation"},
        )
        try:
            with urlopen(request, timeout=15) as response:
                body = response.read()
            return json.loads(body) if body else None
        except HTTPError as exc:
            raise RuntimeError(f"Supabase rechazó la operación (HTTP {exc.code}).") from None
        except (URLError, TimeoutError, OSError):
            raise RuntimeError("No se pudo conectar con Supabase.") from None

    def due_products(self, now, product_id=None):
        return self.request("POST", "rpc/due_products", {
            "p_now": now.isoformat(), "p_product_id": product_id,
        })

    def claim_basket_events(self, list_id=None):
        return self.request("POST", "rpc/claim_basket_events", {"p_list_id": list_id})

    def has_product_group(self, product_id):
        rows = self.request("GET", f"product_group_members?product_id=eq.{UUID(product_id)}&select=group_id")
        return bool(rows)

    def claim_product_group_events(self):
        return self.request("POST", "rpc/claim_product_group_events", {})

    def begin_product_goal_delivery(self, product_id, checked_at):
        return self.request("POST", "rpc/begin_product_goal_delivery", {
            "p_id": str(UUID(product_id)), "p_checked_at": checked_at.isoformat(),
        })

    def finish_product_goal_delivery(self, product_id, token):
        self.request("POST", "rpc/finish_product_goal_delivery", {
            "p_id": str(UUID(product_id)), "p_token": str(UUID(token)),
        })

    def finish_product_group_event(self, event_id, sent):
        self.request("POST", "rpc/finish_product_group_event", {"p_id": str(UUID(event_id)), "p_sent": sent})

    def save_exchange_rate(self, rate):
        return self.request("POST", "rpc/cache_exchange_rate", {"p_rate": rate})

    def finish_basket_event(self, event_id, sent):
        self.request("POST", "rpc/finish_basket_event", {"p_id": str(UUID(event_id)), "p_sent": sent})

    def save_review(self, product, checked_at, result, checks):
        return self.request("POST", "rpc/save_review", {
            "p_product_id": product["id"],
            "p_expected_checked_at": product["last_checked_at"],
            "p_checked_at": checked_at.isoformat(), "p_accepted": result.accepted,
            "p_checks": checks,
        })

    def save_alert_state(self, product, checked_at, changes, *, delivery_token=None):
        # Compare the saved review version and prior alert state before writing.
        if not self.request("POST", "rpc/complete_product_goal_delivery" if delivery_token else "rpc/save_product_alert_state", {
            "p_id": str(UUID(product['id'])), "p_checked_at": checked_at.isoformat(),
            "p_expected": {field: product[field] for field in ("alert_state", "last_alert_price", "last_alert_at")},
            "p_changes": changes,
            **({"p_token": str(UUID(delivery_token))} if delivery_token else {}),
        }):
            raise RuntimeError("El producto cambió durante la notificación.")

    def last_failure_notification(self, product):
        path = (f"notifications?product_id=eq.{UUID(product['id'])}"
                "&type=eq.extraction_failed&select=sent_at&order=sent_at.desc&limit=1")
        if product["last_success_at"]:
            path += f"&sent_at=gt.{quote(product['last_success_at'], safe='')}"
        rows = self.request("GET", path)
        return rows[0] if rows else None

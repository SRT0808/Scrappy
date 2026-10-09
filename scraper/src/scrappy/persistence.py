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

    def save_review(self, product, checked_at, result, checks):
        return self.request("POST", "rpc/save_review", {
            "p_product_id": product["id"],
            "p_expected_checked_at": product["last_checked_at"],
            "p_checked_at": checked_at.isoformat(), "p_accepted": result.accepted,
            "p_checks": checks,
        })

    def save_alert_state(self, product, checked_at, changes):
        # Compare the saved review version and prior alert state before writing.
        path = (f"products?id=eq.{UUID(product['id'])}"
                f"&last_checked_at=eq.{quote(checked_at.isoformat(), safe='')}"
                f"&alert_state=eq.{product['alert_state']}&status=in.(active,error)")
        for field in ("last_alert_price", "last_alert_at"):
            value = product[field]
            path += f"&{field}=is.null" if value is None else f"&{field}=eq.{quote(str(value), safe='')}"
        if not self.request("PATCH", path, changes):
            raise RuntimeError("El producto cambió durante la notificación.")

    def last_failure_notification(self, product):
        path = (f"notifications?product_id=eq.{UUID(product['id'])}"
                "&type=eq.extraction_failed&select=sent_at&order=sent_at.desc&limit=1")
        if product["last_success_at"]:
            path += f"&sent_at=gt.{quote(product['last_success_at'], safe='')}"
        rows = self.request("GET", path)
        return rows[0] if rows else None

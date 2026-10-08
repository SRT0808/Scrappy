"""Command-line entry point for the connected workflow scaffold."""

import argparse
from datetime import datetime, timezone
import json
import os
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


def record_empty_run() -> None:
    """Verify database access by recording a completed run with zero checks."""
    url = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not url or not key:
        raise ValueError("Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY.")
    parsed = urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.query or parsed.fragment or parsed.path:
        raise ValueError("SUPABASE_URL debe ser la URL HTTPS del proyecto, sin ruta.")

    trigger = {"schedule": "cron", "workflow_dispatch": "dispatch"}.get(
        os.environ.get("GITHUB_EVENT_NAME", ""), "local"
    )
    started_at = datetime.now(timezone.utc).isoformat()
    payload = {
        "started_at": started_at,
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "trigger": trigger,
        "checked": 0,
        "ok_count": 0,
        "fail_count": 0,
    }
    request = Request(
        f"{url}/rest/v1/runs",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=15):
            pass
    except HTTPError as exc:
        raise RuntimeError(f"Supabase rechazó el registro de ejecución (HTTP {exc.code}).") from None
    except (URLError, TimeoutError, OSError):
        raise RuntimeError("No se pudo conectar con Supabase.") from None


def main() -> None:
    parser = argparse.ArgumentParser(description="Scrappy price tracker")
    parser.add_argument(
        "--mode", choices=("all", "product", "test_notification"), default="all"
    )
    parser.add_argument("--product-id", default="")
    args = parser.parse_args()
    if args.mode == "product" and not args.product_id.strip():
        parser.error("--product-id es obligatorio para --mode product")
    try:
        record_empty_run()
    except (ValueError, RuntimeError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        raise SystemExit(1) from None
    print(f"Supabase conectado: ejecución vacía registrada, modo {args.mode}. Motor pendiente de implementar.")


if __name__ == "__main__":
    main()

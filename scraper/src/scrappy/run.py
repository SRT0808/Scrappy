"""Select overdue products, validate fresh readings and persist each review."""

import argparse
from dataclasses import replace
from datetime import datetime, timezone
from decimal import Decimal
import os
import re
import sys
import time
from uuid import UUID

from scrappy.extract import Extraction, extract
from scrappy.persistence import Database
from scrappy.probe import CHALLENGE, fetch
from scrappy.validation import validate_review


def utcnow():
    return datetime.now(timezone.utc)


def read_product(product, recipe):
    """Use the verified domain mode; failures become auditable readings."""
    try:
        page = fetch(product["url"], recipe.get("fetch_mode", "http"), 25)
        title = page.css("title::text").get() or ""
        if page.status >= 400 or CHALLENGE.search(title) or CHALLENGE.search(page.get_all_text()[:2000]):
            return Extraction(warnings=["La tienda bloqueó la lectura o devolvió un error HTTP."])
        return extract(page.body, product["url"], recipe)
    except Exception:
        return Extraction(warnings=["No se pudo obtener o extraer el producto."])


def check_row(reading, checked_at, result):
    price = reading.price
    safe_price = price is not None and price.is_finite() and 0 <= price <= Decimal("9999999999.99")
    return {
        "checked_at": checked_at.isoformat(), "ok": result.accepted,
        "price": str(price) if safe_price else None,
        "currency": reading.currency if reading.currency and re.fullmatch(r"[A-Z]{3}", reading.currency) else None,
        "method": reading.method,
        "confidence": str(reading.confidence), "error_code": result.error_code,
        "warnings": list(reading.warnings) + list(result.warnings),
    }


def review_product(database, product, recipe, *, read=read_product, now=utcnow, sleep=time.sleep, options=None):
    attempts = []

    def fresh_read():
        try:
            reading = read(product, recipe)
        except Exception:
            reading = Extraction(warnings=["No se pudo obtener o extraer el producto."])
        if reading.price is not None and reading.price.is_finite() and reading.price > Decimal("9999999999.99"):
            reading = replace(reading, confidence=0, warnings=reading.warnings + ["El precio excede el rango permitido."])
        attempts.append((reading, now()))
        return reading

    reading = fresh_read()
    result = validate_review(
        reading, registered_currency=product["currency"],
        last_valid_price=Decimal(str(product["last_price"])) if product["last_price"] is not None else None,
        reread=fresh_read, sleep=sleep, **(options or {}),
    )
    checks = [check_row(item, timestamp, result) for item, timestamp in attempts]
    database.save_review(product, attempts[-1][1], result, checks)
    # Only the persisted result may reach the future alert state machine.
    return result


def execute_reviews(database, product_id=None, *, read=read_product, now=utcnow, sleep=time.sleep):
    started = now()
    trigger = {"schedule": "cron", "workflow_dispatch": "dispatch"}.get(os.environ.get("GITHUB_EVENT_NAME", ""), "local")
    run = database.request("POST", "runs", {"started_at": started.isoformat(), "trigger": trigger})[0]
    products = database.due_products(started, product_id)
    if product_id and not products:
        raise ValueError("No existe un producto activo con ese ID.")
    recipes = {row["domain"]: row for row in database.request("GET", "domain_recipes?select=*")}
    settings = {row["key"]: row["value"] for row in database.request("GET", "settings?select=key,value")}
    options = {}
    if "max_change_percent" in settings:
        options["max_change_percent"] = Decimal(str(settings["max_change_percent"]))
    for key in ("confirmation_delay_seconds", "suppress_unavailable_alerts"):
        if key in settings:
            options[key] = settings[key]
    checked = ok = 0
    completed = False
    try:
        for product in products:
            result = review_product(database, product, recipes.get(product["domain"], {}), read=read, now=now, sleep=sleep, options=options)
            checked += 1
            ok += int(result.accepted)
        completed = True
    finally:
        counts = {"checked": checked, "ok_count": ok, "fail_count": checked - ok}
        database.request("PATCH", f"runs?id=eq.{UUID(run['id'])}", {
            "finished_at": now().isoformat() if completed else None, **counts,
        })
    return counts


def main():
    parser = argparse.ArgumentParser(description="Scrappy price tracker")
    parser.add_argument("--mode", choices=("all", "product", "test_notification"), default="all")
    parser.add_argument("--product-id", default="")
    args = parser.parse_args()
    product_id = None
    if args.mode == "product":
        try:
            product_id = str(UUID(args.product_id.strip()))
        except ValueError:
            parser.error("--product-id debe ser un UUID válido para --mode product")
    if args.mode == "test_notification":
        parser.error("Las notificaciones todavía no están implementadas.")
    try:
        counts = execute_reviews(Database(), product_id)
    except (ValueError, RuntimeError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        raise SystemExit(1) from None
    print(f"Revisión terminada: {counts['checked']} productos, {counts['ok_count']} válidos, {counts['fail_count']} rechazados.")


if __name__ == "__main__":
    main()

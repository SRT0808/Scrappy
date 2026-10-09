"""Bounded initial readings, claimed once and kept inactive until owner confirmation."""

from dataclasses import replace
from decimal import Decimal
from pathlib import Path
import hashlib
import json
from uuid import UUID

from scrappy.extract import Extraction, extract
from scrappy.probe import CHALLENGE, MODES, fetch
from scrappy.network import public_url


def price_string(value):
    try:
        price = Decimal(str(value))
        if price.is_finite() and 0 < price <= Decimal("9999999999.99"):
            rounded = price.quantize(Decimal("0.01"))
            return format(rounded, "f") if rounded > 0 else None
    except (ArithmeticError, ValueError):
        pass
    return None


def read_initial(request, recipe, *, fetch_page=fetch, validate_url=public_url, evidence=Path(".scrappy/readings")):
    url = request["url"]
    recipe = dict(recipe)
    if request.get("selector"):
        recipe.update(price_selector=request["selector"], force_selector=True)
    preferred = recipe.get("fetch_mode", "http")
    modes = [preferred, *[mode for mode in MODES if mode != preferred]] if preferred in MODES else list(MODES)
    result = Extraction(warnings=["No se pudo leer el precio. Prueba un selector CSS."])
    attempts = []
    evidence.mkdir(parents=True, exist_ok=True)
    prefix = str(UUID(request["id"]))
    validate_url(url)
    for mode in modes:
        attempt = {"mode": mode}
        try:
            page = fetch_page(url, mode, 25)
            validate_url(str(page.url))
            body = page.body.encode() if isinstance(page.body, str) else page.body
            (evidence / f"{prefix}-{mode}.html").write_bytes(body)
            title = page.css("title::text").get() or ""
            blocked = page.status >= 400 or CHALLENGE.search(title + page.get_all_text()[:2000])
            attempt.update(status=page.status, sha256=hashlib.sha256(body).hexdigest(), blocked=bool(blocked))
            if not blocked:
                current = extract(body, url, recipe)
                if current.confidence >= result.confidence or (current.price and not result.price):
                    result = current
                    recipe["fetch_mode"] = mode
                if current.ok:
                    break
        except Exception as error:
            attempt["error"] = type(error).__name__
        finally:
            attempts.append(attempt)
    payload = replace(result, name=result.name[:300] if result.name else None).to_dict()
    for key in ("price", "original_price"):
        payload[key] = price_string(payload[key])
    payload["candidates"] = [{**candidate, "price": price_string(candidate["price"])}
                             for candidate in result.candidates if price_string(candidate.get("price"))][:5]
    (evidence / f"{prefix}.json").write_text(json.dumps({"attempts": attempts, "result": payload}, ensure_ascii=False), encoding="utf-8")
    recipe.pop("force_selector", None)
    return payload, recipe


def execute_reading(database, reading_id, *, read=read_initial):
    request = database.request("POST", "rpc/claim_product_reading", {"p_id": str(UUID(reading_id))})
    if request is None:
        return
    try:
        rows = database.request("GET", f"domain_recipes?domain=eq.{request['domain']}&select=*")
        result, recipe = read(request, rows[0] if rows else {})
    except (ValueError, OSError):
        result = Extraction(warnings=["No se pudo obtener una lectura pública. Revisa la URL."]).to_dict()
        recipe = {}
    database.request("POST", "rpc/complete_product_reading", {"p_id": request["id"], "p_result": result, "p_recipe": recipe})

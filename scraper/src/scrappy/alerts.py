"""Decimal target thresholds, hysteresis and confirmed-delivery alert state."""

from datetime import datetime, timedelta
from decimal import Decimal

from scrappy.notifications import deliver


def target_price(product):
    if product["target_type"] == "price":
        return Decimal(str(product["target_price"]))
    reference = Decimal(str(product["reference_price"]))
    percent = Decimal(str(product["target_percent"]))
    return reference * (1 - percent / 100)


def goal_event(product, price, *, alert_allowed=True):
    target = target_price(product)
    if product["alert_state"] == "triggered":
        if price > target * Decimal("1.03"):
            return "rearm"
        previous = product["last_alert_price"]
        if alert_allowed and price <= target and previous is not None and price <= Decimal(str(previous)) * Decimal("0.95"):
            return "dropped_further"
    elif alert_allowed and price <= target:
        return "goal_reached"
    return None


def money(product, price):
    currency = "S/" if product["currency"] == "PEN" else product["currency"]
    return f"{currency} {price:,.2f}"


def notification_payload(kind, product, price=None):
    name = product.get("name") or product["domain"]
    title = name
    if kind == "goal_reached":
        title = f"🔥 {name}"
        reference = Decimal(str(product["reference_price"])) if product.get("reference_price") is not None else None
        message = f"Ahora {money(product, price)} · tu meta {money(product, target_price(product))}"
        if reference and reference > 0:
            discount = (reference - price) / reference * 100
            message += f" · −{discount:.0f}% vs referencia {money(product, reference)}"
    elif kind == "dropped_further":
        message = f"📉 {name} bajó aún más: {money(product, price)} (antes {money(product, Decimal(str(product['last_alert_price'])))})"
        title = f"📉 {name} bajó aún más"
    elif kind == "extraction_failed":
        message = f"⚠️ No pude leer {name}. Revísalo en Scrappy."
    else:
        message = f"🤔 Precio raro en {name}: {money(product, price)}"
        if product.get("last_price") is not None:
            message += f" (antes {money(product, Decimal(str(product['last_price'])))})"
        message += ". Verificando."
    return {"title": title, "message": message, "priority": 4 if kind in ("goal_reached", "dropped_further") else 3,
            "tags": ["moneybag"] if kind in ("goal_reached", "dropped_further") else ["warning"], "click": product["url"]}


def process_alerts(database, product, result, checked_at, *, notify=deliver, suspicious_price=None):
    """Called only after save_review succeeds; goal state excludes read errors."""
    if suspicious_price is not None:
        notify(database, product["id"], "suspicious_change", notification_payload("suspicious_change", product, suspicious_price), checked_at)
    if not result.accepted:
        if product["consecutive_failures"] + 1 < 3:
            return
        recent = database.last_failure_notification(product)
        if recent and checked_at - datetime.fromisoformat(recent["sent_at"].replace("Z", "+00:00")) < timedelta(days=7):
            return
        notify(database, product["id"], "extraction_failed", notification_payload("extraction_failed", product), checked_at)
        return
    price = result.reading.price
    event = goal_event(product, price, alert_allowed=result.alert_allowed)
    if event == "rearm":
        database.save_alert_state(product, checked_at, {"alert_state": "armed"})
    elif event:
        if notify(database, product["id"], event, notification_payload(event, product, price), checked_at):
            database.save_alert_state(product, checked_at, {
                "alert_state": "triggered", "last_alert_price": str(price), "last_alert_at": checked_at.isoformat(),
            })

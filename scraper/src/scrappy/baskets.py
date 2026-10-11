"""Deliver each atomically claimed aggregate crossing once, after product reviews."""

from decimal import Decimal

from scrappy.notifications import deliver


def process_baskets(database, checked_at, list_id=None, *, notify=deliver):
    failed = False
    for event in database.claim_basket_events(list_id):
        currency = "S/" if event["currency"] == "PEN" else event["currency"]
        payload = {
            "title": f"🧺 Canasta alcanzada: {event['name']}",
            "message": f"Total {currency} {Decimal(str(event['total'])):,.2f} · gasto máximo "
                       f"{currency} {Decimal(str(event['budget'])):,.2f}. Todos los precios están completos.",
            "priority": 4, "tags": ["moneybag"],
        }
        if event.get("savings") is not None:
            payload["message"] += f" Ahorro {currency} {Decimal(str(event['savings'])):,.2f}"
            if event.get("savings_percent") is not None:
                payload["message"] += f" ({Decimal(str(event['savings_percent'])):.2f}%)."
        for rate in event.get("exchange_rates", []):
            payload["message"] += (f" Conversión {rate['from']}/{rate['to']}: {rate['rate']}"
                                   f" · {rate['date']} · {rate['source']}.")
        if event.get("cause") == "conversion":
            payload["message"] += " La meta se cruzó por un cambio de conversión; los precios no cambiaron."
        try:
            sent = notify(database, None, "basket_goal_reached", payload, checked_at,
                          audit_context={"basket_event_id": event["id"], "list_id": event["list_id"]})
            database.finish_basket_event(event["id"], sent)
            failed |= not sent
        except Exception:
            # A network receipt can be ambiguous. Never resend an existing claim.
            failed = True
    if failed:
        raise RuntimeError("No se pudo confirmar o registrar el aviso de canasta; revisa el historial.")

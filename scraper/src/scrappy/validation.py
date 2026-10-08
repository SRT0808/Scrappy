"""Validate review readings before persistence and target-alert evaluation."""

from collections.abc import Callable
from dataclasses import dataclass
from decimal import Decimal
import math
import re
import time

from scrappy.extract import Extraction


@dataclass(frozen=True)
class ReviewValidation:
    reading: Extraction
    accepted: bool
    alert_allowed: bool
    error_code: str | None = None
    confirmation: Extraction | None = None
    warnings: tuple[str, ...] = ()


def is_unavailable(availability: str | None) -> bool:
    """Recognize structured availability and common explicit stock labels."""
    if not availability:
        return False
    label = re.sub(r"[\s_-]+", "", availability.strip().rsplit("/", 1)[-1].rsplit("#", 1)[-1]).lower()
    return label in {
        "outofstock", "soldout", "discontinued", "agotado", "agotada",
        "sinstock", "nodisponible", "oos",
    }


def _invalid_reason(reading: Extraction, currency: str) -> str | None:
    if reading.currency != currency:
        return "currency_mismatch"
    price = reading.price
    if price is None or not price.is_finite() or price <= 0 or not reading.ok:
        return "invalid_reading"
    return None


def validate_review(
    reading: Extraction,
    *,
    registered_currency: str,
    last_valid_price: Decimal | None,
    reread: Callable[[], Extraction],
    max_change_percent: Decimal = Decimal("50"),
    confirmation_delay_seconds: float = 3,
    suppress_unavailable_alerts: bool = True,
    sleep: Callable[[float], None] = time.sleep,
) -> ReviewValidation:
    """Confirm large changes once; rejected readings must not replace last_price.

    The caller supplies a fresh fetch/extraction via reread. An accepted price
    may be persisted even when alert_allowed is false. This flag only permits
    target evaluation; target conditions and alert state belong to the motor.
    """
    if not registered_currency or not re.fullmatch(r"[A-Z]{3}", registered_currency):
        raise ValueError("La moneda registrada debe ser un código de tres letras mayúsculas.")
    if not max_change_percent.is_finite() or max_change_percent < 0:
        raise ValueError("El umbral de cambio debe ser finito y no negativo.")
    if not math.isfinite(confirmation_delay_seconds) or confirmation_delay_seconds <= 0:
        raise ValueError("La pausa de confirmación debe ser finita y positiva.")
    if last_valid_price is not None and (not last_valid_price.is_finite() or last_valid_price <= 0):
        raise ValueError("El último precio válido debe ser finito y positivo.")

    if reason := _invalid_reason(reading, registered_currency):
        return ReviewValidation(reading, False, False, reason)

    confirmation = None
    current = reading
    # Strict comparison keeps changes of exactly the configured threshold valid.
    if last_valid_price is not None and abs(reading.price - last_valid_price) * 100 > last_valid_price * max_change_percent:
        sleep(confirmation_delay_seconds)
        try:
            confirmation = reread()
        except Exception:
            # Fetch failures must never let an unconfirmed jump reach alerts.
            return ReviewValidation(reading, False, False, "confirmation_failed")
        if reason := _invalid_reason(confirmation, registered_currency):
            return ReviewValidation(reading, False, False, reason, confirmation)
        if confirmation.price != reading.price:
            return ReviewValidation(reading, False, False, "price_mismatch", confirmation)
        current = confirmation

    unavailable = is_unavailable(reading.availability) or is_unavailable(current.availability)
    blocked = suppress_unavailable_alerts and unavailable
    warnings = ("Producto agotado; precio válido, alerta de meta bloqueada.",) if blocked else ()
    return ReviewValidation(current, True, not blocked, confirmation=confirmation, warnings=warnings)

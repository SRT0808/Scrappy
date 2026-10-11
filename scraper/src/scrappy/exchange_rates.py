"""Fetch the daily BCRP reference rate on the server; retain cache on failure."""

from datetime import date, timedelta, timezone
from decimal import Decimal, InvalidOperation
import json
import re
from urllib.request import Request, urlopen

# Lima has no daylight saving time; Windows needs no IANA package for this offset.
LIMA = timezone(timedelta(hours=-5))

SOURCE = "BCRPData:PD04638PD"
URL = "https://estadisticas.bcrp.gob.pe/estadisticas/series/api/PD04638PD/json"
MONTHS = {name: index for index, names in enumerate(
    ("ene jan", "feb", "mar", "abr apr", "may", "jun", "jul", "ago aug", "set sep", "oct", "nov", "dic dec"), 1)
    for name in names.split()}


def latest_rate(payload, today):
    """Use the latest published, finite, positive observation, never a fill value."""
    if not isinstance(payload, dict) or not isinstance(payload.get("periods"), list):
        raise ValueError("Respuesta BCRPData inválida.")
    observations = []
    for period in payload["periods"]:
        try:
            match = re.fullmatch(r"(\d{2})\.([A-Za-z]{3})\.(\d{2})", period["name"])
            if not match:
                continue
            observed = date(2000 + int(match[3]), MONTHS[match[2].lower()], int(match[1]))
            values = period["values"]
            if not isinstance(values, list) or len(values) != 1:
                continue
            rate = Decimal(str(values[0]))
            if observed <= today and rate.is_finite() and 0 < rate < 1000:
                observations.append((observed, rate))
        except (KeyError, TypeError, ValueError, InvalidOperation):
            continue
    if not observations:
        raise ValueError("BCRPData no contiene una tasa publicada válida.")
    observed, rate = max(observations, key=lambda item: item[0])
    return {"rate_date": observed.isoformat(), "from_currency": "USD", "to_currency": "PEN",
            "rate": str(rate), "source": SOURCE}


def fetch_rate(today):
    request = Request(URL, headers={"Accept": "application/json", "User-Agent": "Scrappy/0.1"})
    with urlopen(request, timeout=15) as response:
        payload = json.loads(response.read(2_000_000))
    return latest_rate(payload, today)


def refresh_exchange_rate(database, checked_at, *, fetch=fetch_rate):
    """A provider outage leaves cached rates intact; DB failures remain visible."""
    # Python on Windows need not have an IANA database installed.
    today = checked_at.astimezone(LIMA).date()
    try:
        rate = fetch(today)
    except (OSError, ValueError):
        return False
    database.save_exchange_rate({**rate, "fetched_at": checked_at.isoformat()})
    return True

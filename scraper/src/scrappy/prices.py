"""Locale-aware monetary normalization without guessing an ambiguous dollar."""

from decimal import Decimal, InvalidOperation
import re
from urllib.parse import urlsplit

MONEY = re.compile(r"(?:S/\.?|US\$|USD|PEN|EUR|GBP|CAD|AUD|CLP|COP|MXN|€|£|\$)\s*([0-9][0-9\s\u00a0.,]*[0-9]|[0-9])", re.I)
CODES = re.compile(r"\b(USD|PEN|EUR|GBP|CAD|AUD|CLP|COP|MXN|ARS|BRL|JPY|CHF)\b", re.I)


def normalize_price(value: object) -> Decimal | None:
    if value is None or isinstance(value, bool):
        return None
    text = str(value).strip()
    if re.search(r"[-−]\s*\d", text):
        return None
    match = re.search(r"\d[\d\s\u00a0.,]*", text)
    if not match:
        return None
    number = re.sub(r"\s", "", match.group()).rstrip(".,")
    last = max(number.rfind("."), number.rfind(","))
    if last >= 0 and 1 <= len(number) - last - 1 <= 2:
        number = re.sub(r"[.,]", "", number[:last]) + "." + number[last + 1:]
    else:
        number = re.sub(r"[.,]", "", number)
    try:
        price = Decimal(number)
        return price if price.is_finite() and price > 0 else None
    except InvalidOperation:
        return None


def currency_for(text: str, structured: str | None = None, url: str = "", lang: str = "") -> str | None:
    if structured and CODES.fullmatch(structured.strip()):
        return structured.strip().upper()
    if match := CODES.search(text):
        return match.group().upper()
    for symbol, code in (("S/", "PEN"), ("€", "EUR"), ("£", "GBP"), ("US$", "USD")):
        if symbol in text:
            return code
    if "$" in text:
        host = urlsplit(url).hostname or ""
        for suffix, code in ((".pe", "PEN"), (".cl", "CLP"), (".co", "COP"), (".mx", "MXN"), (".ca", "CAD"), (".au", "AUD"), (".us", "USD")):
            if host.endswith(suffix):
                return code
        return {"en-us": "USD", "en-ca": "CAD", "en-au": "AUD", "es-pe": "PEN", "es-cl": "CLP", "es-co": "COP", "es-mx": "MXN"}.get(lang.lower())
    return None

"""Pin and verify the owner's YesStyle shipping and currency preferences."""

import json
import re
from urllib.parse import urlsplit

from curl_cffi.requests import Cookies


def is_yesstyle(url):
    return urlsplit(url).hostname in {"yesstyle.com", "www.yesstyle.com"}


def preference_cookies(url, *, browser=False):
    if not is_yesstyle(url):
        return [] if browser else Cookies()
    # Values returned by YesStyle's shopper-site-preference-update operation.
    values = {"coid": "170", "tcurrency": "19"}
    domain = urlsplit(url).hostname
    if browser:
        return [{"name": key, "value": value, "domain": domain, "path": "/", "secure": True}
                for key, value in values.items()]
    cookies = Cookies()
    for key, value in values.items():
        cookies.set(key, value, domain=domain, path="/")
    return cookies


def yesstyle_context(root):
    """Read server page context and Product offers; never infer it from locale."""
    countries, currencies, destinations, offer_currencies = set(), set(), set(), set()
    decoder = json.JSONDecoder()

    def walk(value):
        if isinstance(value, dict):
            yield value
            for child in value.values():
                yield from walk(child)
        elif isinstance(value, list):
            for child in value:
                yield from walk(child)

    for script in root.xpath("//script"):
        text = script.text or ""
        for match in re.finditer(r"self\.__next_f\.push\(", text):
            try:
                chunk, _ = decoder.raw_decode(text[match.end():])
                if not isinstance(chunk, list) or len(chunk) < 2:
                    continue
                payload = chunk[1]
                if not isinstance(payload, str):
                    continue
                for basic_match in re.finditer(r'"basic"\s*:\s*', payload):
                    basic, _ = decoder.raw_decode(payload[basic_match.end():])
                    if isinstance(basic, dict):
                        countries.add(str(basic.get("countryId")))
                        currencies.add(str(basic.get("currencyCode")))
            except (ValueError, TypeError, IndexError):
                continue
        if "ld+json" in script.get("type", "").lower():
            try:
                document = json.loads(text)
            except (ValueError, TypeError):
                continue
            for product in walk(document):
                types = product.get("@type", [])
                types = types if isinstance(types, list) else [types]
                if not {"Product", "ProductGroup"}.intersection(types):
                    continue
                for offer in walk(product.get("offers", [])):
                    if "priceCurrency" in offer:
                        offer_currencies.add(str(offer["priceCurrency"]))
                    destination = offer.get("shippingDestination")
                    if isinstance(destination, dict):
                        destinations.add(str(destination.get("addressCountry")))
    verified = (countries == {"170"} and currencies == {"USD"}
                and destinations == {"PE"} and offer_currencies == {"USD"})
    return {"verified": verified, "country_ids": sorted(countries), "currencies": sorted(currencies),
            "shipping_destinations": sorted(destinations), "offer_currencies": sorted(offer_currencies)}


def context_warning(context):
    if context["verified"]:
        return "Contexto YesStyle verificado: destino PE; moneda USD."
    return ("Contexto YesStyle no confirmado para Perú/USD; lectura rechazada. "
            f"País={','.join(context['country_ids']) or 'ausente'}; "
            f"destino={','.join(context['shipping_destinations']) or 'ausente'}; "
            f"moneda={','.join(context['currencies']) or 'ausente'}; "
            f"moneda de oferta={','.join(context['offer_currencies']) or 'ausente'}.")

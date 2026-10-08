"""Structured data, owner recipes and conservative visible-price candidates."""

from dataclasses import asdict, dataclass, field
from decimal import Decimal
import json
import re
from urllib.parse import urljoin, urlsplit

from scrapling import Selector

from scrappy.prices import MONEY, currency_for, normalize_price
from scrappy.recipes import JsonStorage

THRESHOLD = 0.8
EXCLUDED = re.compile(r"cuota|/mes|per month|installment|shipping|env[ií]o|impuesto|tax|related|relacionad|recommend|recomendad|cross.sell|upsell|old.price|original.price|list.price|regular.price|price.old|tachado", re.I)


@dataclass
class Extraction:
    name: str | None = None
    price: Decimal | None = None
    currency: str | None = None
    original_price: Decimal | None = None
    image_url: str | None = None
    availability: str | None = None
    method: str = "none"
    confidence: float = 0.0
    candidates: list = field(default_factory=list)
    warnings: list = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return bool(self.name and self.price and self.currency and self.confidence >= THRESHOLD)

    def to_dict(self) -> dict:
        result = asdict(self)
        for key in ("price", "original_price"):
            result[key] = str(result[key]) if result[key] is not None else None
        return result


def text_of(node) -> str:
    return " ".join(node.itertext()).strip()


def walk(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def schema_types(value) -> set:
    values = value if isinstance(value, list) else [value]
    return {str(item).rsplit("/", 1)[-1] for item in values}


def metadata(root, *keys) -> str | None:
    for key in keys:
        values = root.xpath("//meta[@property=$key or @name=$key or @itemprop=$key]/@content", key=key)
        if values and values[0].strip():
            return values[0].strip()
    return None


def excluded(node) -> bool:
    for ancestor in [node, *list(node.iterancestors())[:5]]:
        if ancestor.tag in ("s", "del", "strike", "script", "style", "nav", "footer", "aside") or "hidden" in ancestor.attrib or ancestor.get("aria-hidden") == "true":
            return True
        attrs = " ".join(str(value) for value in ancestor.attrib.values())
        if re.search(r"display\s*:\s*none|visibility\s*:\s*hidden|line-through", attrs, re.I) or EXCLUDED.search(attrs):
            return True
    parent = node.getparent()
    context = text_of(parent) if parent is not None and len(text_of(parent)) < 180 else text_of(node)
    return bool(EXCLUDED.search(context))


def extract(html: str | bytes, url: str, recipe: dict | None = None) -> Extraction:
    recipe = recipe or {}
    state = recipe.setdefault("adaptive_state", None)
    state = state if isinstance(state, dict) else {}
    recipe["adaptive_state"] = state
    page = Selector(html, url=url, adaptive=True, _storage=JsonStorage(url, state))
    root = page._root
    h1 = root.xpath("//h1")
    titles = root.xpath("//title/text()")
    name = text_of(h1[0]) if h1 else metadata(root, "og:title") or (titles[0].strip() if titles else None)
    lang = root.get("lang", "")
    cur = metadata(root, "product:price:currency", "og:price:currency", "priceCurrency")
    image = metadata(root, "og:image")
    base = Extraction(name=name, image_url=urljoin(url, image) if image else None)
    products = []
    documents = []
    for script in root.xpath('//script[contains(translate(@type,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"ld+json")]'):
        try:
            documents.extend(walk(json.loads(script.text or "")))
        except (ValueError, TypeError):
            base.warnings.append("JSON-LD inválido; se probarán otras estrategias.")
    references = {item["@id"]: item for item in documents if isinstance(item.get("@id"), str)}
    for product in documents:
        if schema_types(product.get("@type")) & {"Product", "ProductGroup"}:
            products.append(product)
    # URL identity wins; multiple different products require confirmation.
    matches = [p for p in products if urlsplit(urljoin(url, str(p.get("url", "")))).path.rstrip("/") == urlsplit(url).path.rstrip("/") and p.get("url")]
    if matches:
        products = matches
    valid = []
    for product in products:
        offers = product.get("offers", [])
        offers = offers if isinstance(offers, list) else [offers]
        resolved = [references.get(offer.get("@id"), offer) if isinstance(offer, dict) else offer for offer in offers]
        for offer in resolved:
            if not isinstance(offer, dict):
                continue
            specifications = offer.get("priceSpecification", [])
            specifications = specifications if isinstance(specifications, list) else [specifications]
            sources = [offer, *[s for s in specifications if isinstance(s, dict)]]
            for source in sources:
                amount = source.get("price", source.get("lowPrice"))
                price = normalize_price(amount)
                currency = currency_for(str(amount), source.get("priceCurrency") or offer.get("priceCurrency") or product.get("priceCurrency"), url, lang)
                if price is not None and currency:
                    availability = offer.get("availability") or product.get("availability")
                    candidate = {"price": str(price), "currency": currency, "name": product.get("name") or name, "availability": availability, "context": "JSON-LD", "score": 0.98}
                    valid.append((product, candidate))
                    break
    if valid:
        available = [pair for pair in valid if str(pair[1]["availability"]).rsplit("/", 1)[-1].lower() not in ("outofstock", "soldout", "discontinued")]
        pool = available or valid
        currencies = {c["currency"] for _, c in pool}
        names = {c["name"] for _, c in pool}
        ambiguous = len(currencies) > 1 or len(names) > 1
        product, chosen = min(pool, key=lambda pair: Decimal(pair[1]["price"]))
        product_image = product.get("image")
        if isinstance(product_image, list):
            product_image = product_image[0] if product_image else None
        if isinstance(product_image, dict):
            product_image = product_image.get("url")
        result = Extraction(name=chosen["name"], price=Decimal(chosen["price"]), currency=chosen["currency"], availability=chosen["availability"], image_url=urljoin(url, product_image) if isinstance(product_image, str) else base.image_url, method="json_ld", confidence=0.5 if ambiguous else 0.98, candidates=[c for _, c in pool][:5], warnings=base.warnings.copy())
        if ambiguous:
            result.warnings.append("Varios productos o monedas; requiere confirmación.")
            return result
        if result.ok:
            return result
    # Scope microdata to the Product/Offer, never to a related-product carousel.
    meta_candidates = []
    for key in ("product:price:amount", "og:price:amount"):
        amount = metadata(root, key)
        if amount:
            meta_candidates.append((amount, cur))
    for node in root.xpath('//*[@itemprop="price"]'):
        if excluded(node):
            continue
        scopes = node.xpath('ancestor::*[@itemscope]')
        if scopes and not any(schema_types(s.get("itemtype")) & {"Product", "Offer", "AggregateOffer"} for s in scopes):
            continue
        currency_nodes = scopes[-1].xpath('.//*[@itemprop="priceCurrency"]') if scopes else []
        micro_cur = (currency_nodes[0].get("content") or text_of(currency_nodes[0])) if currency_nodes else cur
        meta_candidates.append((node.get("content") or text_of(node), micro_cur))
    normalized = {(normalize_price(v), currency_for(v, c, url, lang)) for v, c in meta_candidates}
    normalized = {(p, c) for p, c in normalized if p and c}
    if normalized:
        price, currency = sorted(normalized)[0]
        base.price, base.currency, base.method = price, currency, "meta_microdata"
        base.confidence = 0.9 if len(normalized) == 1 else 0.5
        if len(normalized) > 1:
            base.candidates = [{"price": str(p), "currency": c, "context": "meta/microdatos", "score": 0.5} for p, c in sorted(normalized)[:5]]
            base.warnings.append("Precios estructurados contradictorios; requiere confirmación.")
            return base
        if base.ok:
            return base
    if selector := recipe.get("price_selector"):
        try:
            exact = page.css(selector)
            nodes = exact or page.css(selector, adaptive=True, percentage=80)
            if nodes:
                node = nodes[0]._root
                amount = node.get("content") or text_of(node)
                base.price = normalize_price(amount)
                base.currency = currency_for(amount, cur, url, lang)
                base.method = "recipe" if exact else "adaptive"
                base.confidence = 0.95 if exact and len(nodes) == 1 else 0.6
                if name_selector := recipe.get("name_selector"):
                    names = page.css(name_selector)
                    if names:
                        base.name = text_of(names[0]._root)
                if base.ok:
                    page.css(selector, auto_save=True)
                    return base
                base.warnings.append("Receta ambigua o recuperada adaptativamente; requiere confirmación.")
        except (ValueError, TypeError) as exc:
            base.warnings.append(f"Selector de receta inválido ({type(exc).__name__}).")
    candidates = []
    for node in root.xpath('//*[not(self::script or self::style)]'):
        attrs = " ".join(node.get(key, "") for key in ("class", "id", "itemprop", "data-testid"))
        if not re.search(r"price|precio|amount|sale", attrs, re.I) or excluded(node):
            continue
        content = text_of(node)
        if len(content) > 160:
            continue
        for match in MONEY.finditer(content):
            amount = match.group()
            price = normalize_price(amount)
            currency = currency_for(amount, cur, url, lang)
            if price:
                style = node.get("style", "")
                score = 0.82 if re.search(r"sale|current|final|offer|special", attrs, re.I) else 0.7
                if re.search(r"font-size:\s*(?:[2-9]\d)px", style):
                    score = min(0.86, score + 0.12)
                candidates.append({"price": str(price), "currency": currency, "context": content[:160], "score": score})
    unique = {}
    for candidate in candidates:
        key = (candidate["price"], candidate["currency"])
        if key not in unique or candidate["score"] > unique[key]["score"]:
            unique[key] = candidate
    base.candidates = sorted(unique.values(), key=lambda c: c["score"], reverse=True)[:5]
    if base.candidates:
        top = base.candidates[0]
        base.price, base.currency, base.method = Decimal(top["price"]), top["currency"], "heuristic"
        base.confidence = top["score"]
        if len(base.candidates) > 1 and base.candidates[1]["score"] >= top["score"] - 0.1:
            base.confidence = 0.5
            base.warnings.append("Precios visibles ambiguos; requiere confirmación.")
    if not base.currency and base.price:
        base.warnings.append("Moneda ambigua; requiere confirmación.")
    if not base.ok:
        base.warnings.append("Lectura no confiable; enseñar un selector CSS o confirmar un candidato.")
    return base

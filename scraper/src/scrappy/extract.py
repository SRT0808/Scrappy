"""Structured data, owner recipes and conservative visible-price candidates."""

from dataclasses import asdict, dataclass, field
from decimal import Decimal
import json
import re
import unicodedata
from urllib.parse import urljoin, urlsplit

from scrapling import Selector

from scrappy.prices import MONEY, currency_for, normalize_price
from scrappy.recipes import JsonStorage
from scrappy.storefront import context_warning, is_yesstyle, yesstyle_context

THRESHOLD = 0.8
EXCLUDED = re.compile(r"cuota|/mes|per month|installment|shipping|env[ií]o|impuesto|tax|related|relacionad|recommend|recomendad|cross.sell|upsell|old.price|original.price|list.price|regular.price|price.old|tachado", re.I)

# Observed storefront renames, scoped to the PID and its explicit presentation.
# In particular, the translated Jumbo bundle title no longer mentions Jumbo.
YESSTYLE_PRESENTATIONS = {
    "1137945361": ("50ml x 2 pcs", (
        "PDRN Hyaluronic Acid Capsule 100 Serum Set Kpop Demon Hunters Collaboration 2pcs Bundle Set",
        "Combo de Sérum PDRN Hyaluronic Acid Capsule 100 Kpop Demon Hunters 2uds")),
    "1129356823": ("100ml", (
        "Protector Solar Madagascar Centella Hyalu-Cica Water-Fit Sun Serum Jumbo",
        "Sérum Solar Madagascar Centella Hyalu-Cica Water-Fit Jumbo")),
    "1121503383": ("50ml x 2 pcs", (
        "Protector Solar Madagascar Centella Hyalu-Cica Water-Fit Sun Serum Twin Pack",
        "Sérum Solar Madagascar Centella Hyalu-Cica Water-Fit Pack Doble")),
    "1137960612": ("60ml x 2 pcs", (
        "PDRN Hyaluronic Acid 100 Moisturizing Cream 2pcs Bundle Set",
        "Combo de Crema Facial PDRN Hyaluronic Acid 100 2uds")),
    "1137960568": ("100ml x 2 pcs", (
        "Madagascar Centella Hyalu-Cica Water-Fit Sun Serum Jumbo 2pcs Bundle Set",
        "Combo de Sérum Solar Madagascar Centella Hyalu-Cica Water-Fit 2uds")),
}


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


def yesstyle_title_key(name):
    """Normalize observed translations without discarding variant words or quantities."""
    name = "".join(c for c in unicodedata.normalize("NFKD", name.casefold())
                   if not unicodedata.combining(c))
    # Keep decimal points, slashes and plus signs: they can describe a variant.
    name = " ".join(name.split())
    for prefix, suffix in (("mascarilla facial ", " sheet mask"),
                           ("crema facial ", " moisturizing cream")):
        if name.startswith(prefix):
            return name[len(prefix):] + suffix
    if name.startswith("serum solar ") and name.endswith("sun serum"):
        return name[len("serum solar "):]
    return name


def confirmed_identity_matches(candidate, confirmed, url, product, offer):
    if candidate["currency"] != confirmed.get("currency"):
        return False
    exact = candidate["name"] == confirmed.get("name")
    if not is_yesstyle(url):
        return exact
    pid = re.search(r"/pid\.(\d+)(?:/|$)", urlsplit(url).path)
    skus = [str(item["sku"]) for item in (product, offer) if item.get("sku") is not None]
    if skus and (not pid or any(sku != pid[1] for sku in skus)):
        return False
    presentation = YESSTYLE_PRESENTATIONS.get(pid[1]) if pid else None
    if presentation:
        expected_option, titles = presentation
        option = re.search(r"\(option:\s*([^()]+)\)\s*$", str(offer.get("name", "")), re.I)
        if not option or option[1].strip().casefold() != expected_option:
            return False
        aliases = {yesstyle_title_key(title) for title in titles}
        if (skus and confirmed.get("name")
                and yesstyle_title_key(candidate["name"]) in aliases
                and yesstyle_title_key(confirmed["name"]) in aliases):
            return True
    if exact:
        return True
    # Legacy confirmations contain only name/currency. A PID alone cannot prove
    # that a renamed item is still the confirmed presentation.
    return bool(pid and skus and confirmed.get("name")
                and yesstyle_title_key(candidate["name"]) == yesstyle_title_key(confirmed["name"]))


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


def css_path(node) -> str:
    parts = []
    for item in reversed([node, *node.iterancestors()]):
        if not isinstance(item.tag, str):
            continue
        position = 1 + sum(sibling.tag == item.tag for sibling in item.itersiblings(preceding=True))
        parts.append(f"{item.tag}:nth-of-type({position})")
    return " > ".join(parts)


def recipe_read(page, base, recipe, cur, url, lang):
    selector = recipe.get("price_selector")
    if not selector:
        return False
    try:
        exact = page.css(selector)
        nodes = exact or page.css(selector, adaptive=True, percentage=80)
        if nodes:
            node = nodes[0]._root
            amount = node.get("content") or text_of(node)
            if recipe.get("match_index") is not None:
                matches = list(MONEY.finditer(amount))
                if len(matches) != recipe.get("match_count") or recipe["match_index"] >= len(matches):
                    base.warnings.append("El contexto del precio elegido cambió; requiere confirmación.")
                    return False
                amount = matches[recipe["match_index"]].group()
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
                return True
            base.warnings.append("Receta ambigua o recuperada adaptativamente; requiere confirmación.")
    except (ValueError, TypeError) as exc:
        base.warnings.append(f"Selector de receta inválido ({type(exc).__name__}).")
    return False


def visible_price_candidates(root, cur, url, lang):
    candidates = []
    for node in root.xpath('//*[not(self::script or self::style)]'):
        attrs = " ".join(node.get(key, "") for key in ("class", "id", "itemprop", "data-testid"))
        if not re.search(r"price|precio|amount|sale", attrs, re.I) or excluded(node):
            continue
        content = text_of(node)
        if len(content) > 160:
            continue
        matches = list(MONEY.finditer(content))
        for match_index, match in enumerate(matches):
            amount = match.group()
            price = normalize_price(amount)
            currency = currency_for(amount, cur, url, lang)
            if price:
                style = node.get("style", "")
                score = 0.82 if re.search(r"sale|current|final|offer|special", attrs, re.I) else 0.7
                if re.search(r"font-size:\s*(?:[2-9]\d)px", style):
                    score = min(0.86, score + 0.12)
                candidates.append({"price": str(price), "currency": currency, "context": content[:160], "score": score,
                                   "selector": css_path(node), "match_index": match_index, "match_count": len(matches)})
    unique = {}
    for candidate in candidates:
        key = (candidate["price"], candidate["currency"])
        if key not in unique or candidate["score"] > unique[key]["score"]:
            unique[key] = candidate
    return sorted(unique.values(), key=lambda c: c["score"], reverse=True)[:5]


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
    confirmed = state.get("confirmed_candidates", {}).get(url, {})
    cur = confirmed.get("currency") or cur
    image = metadata(root, "og:image")
    base = Extraction(name=name, image_url=urljoin(url, image) if image else None)
    if is_yesstyle(url):
        context = yesstyle_context(root)
        base.warnings.append(context_warning(context))
        if not context["verified"]:
            return base
        cur = "USD"
    originals = {p for node in root.xpath('//s | //del | //strike | //*[@itemprop="highPrice"]')
                 if (p := normalize_price(node.get("content") or text_of(node))) is not None}
    if len(originals) == 1:
        base.original_price = originals.pop()
    if confirmed.get("selector") and not recipe.get("force_selector"):
        recipe = {**recipe, "price_selector": confirmed["selector"], "force_selector": True,
                  "match_index": confirmed.get("match_index"), "match_count": confirmed.get("match_count")}
    if recipe.get("force_selector"):
        recipe_read(page, base, recipe, cur, url, lang)
        # An explicitly taught selector must never silently fall back to another price.
        return base
    products = []
    documents = []
    for script in root.xpath('//script[contains(translate(@type,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"ld+json")]'):
        try:
            documents.extend(walk(json.loads(script.text or "")))
        except (ValueError, TypeError):
            base.warnings.append("JSON-LD inválido; se probarán otras estrategias.")
    references = {}
    for item in documents:
        if isinstance(item.get("@id"), str):
            previous = references.get(item["@id"], {})
            # A later bare @id reference must not replace its full graph node.
            references[item["@id"]] = {**previous, **item}
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
                currency = currency_for(str(amount), source.get("priceCurrency") or offer.get("priceCurrency") or product.get("priceCurrency") or cur, url, lang)
                if price is not None and currency:
                    availability = offer.get("availability") or product.get("availability")
                    candidate = {"price": str(price), "currency": currency, "name": product.get("name") or name, "availability": availability, "context": "JSON-LD", "score": 0.98}
                    valid.append((product, candidate, offer))
                    break
    if valid:
        selected = [pair for pair in valid if confirmed.get("name")
                    and confirmed_identity_matches(pair[1], confirmed, url, pair[0], pair[2])]
        if confirmed.get("name") and not confirmed.get("selector") and not selected:
            base.warnings.append("El producto confirmado cambió; requiere confirmación.")
            return base
        if selected:
            valid = selected
        available = [pair for pair in valid if str(pair[1]["availability"]).rsplit("/", 1)[-1].lower() not in ("outofstock", "soldout", "discontinued")]
        pool = available or valid
        currencies = {c["currency"] for _, c, _ in pool}
        names = {c["name"] for _, c, _ in pool}
        ambiguous = len(currencies) > 1 or len(names) > 1
        product, chosen, _ = min(pool, key=lambda pair: Decimal(pair[1]["price"]))
        product_image = product.get("image")
        if isinstance(product_image, list):
            product_image = product_image[0] if product_image else None
        if isinstance(product_image, dict):
            product_image = product_image.get("url")
        result = Extraction(name=chosen["name"], price=Decimal(chosen["price"]), currency=chosen["currency"], original_price=base.original_price, availability=chosen["availability"], image_url=urljoin(url, product_image) if isinstance(product_image, str) else base.image_url, method="json_ld", confidence=0.5 if ambiguous else 0.98, candidates=[c for _, c, _ in pool][:5], warnings=base.warnings.copy())
        if ambiguous:
            result.warnings.append("Varios productos o monedas; requiere confirmación.")
            return result
        visible = visible_price_candidates(root, chosen["currency"], url, lang)
        if visible:
            top = visible[0]
            visible_is_ambiguous = len(visible) > 1 and visible[1]["score"] >= top["score"] - 0.1
            if not visible_is_ambiguous and (top["price"], top["currency"]) != (chosen["price"], chosen["currency"]):
                result.confidence = 0.5
                result.candidates = [chosen, top]
                result.warnings.append("El precio JSON-LD difiere del precio visible; requiere confirmación.")
                return result
        if result.ok:
            return result
    # Scope microdata to the Product/Offer, never to a related-product carousel.
    meta_candidates = []
    for key in ("product:price:amount", "og:price:amount"):
        amount = metadata(root, key)
        if amount:
            meta_node = root.xpath('//meta[@property=$key or @name=$key or @itemprop=$key]', key=key)[0]
            meta_candidates.append((amount, cur, css_path(meta_node)))
    for node in root.xpath('//*[@itemprop="price"]'):
        if excluded(node):
            continue
        scopes = node.xpath('ancestor::*[@itemscope]')
        if scopes and not any(schema_types(s.get("itemtype")) & {"Product", "Offer", "AggregateOffer"} for s in scopes):
            continue
        currency_nodes = scopes[-1].xpath('.//*[@itemprop="priceCurrency"]') if scopes else []
        micro_cur = (currency_nodes[0].get("content") or text_of(currency_nodes[0])) if currency_nodes else cur
        meta_candidates.append((node.get("content") or text_of(node), micro_cur, css_path(node)))
    normalized = {(normalize_price(v), currency_for(v, c, url, lang)) for v, c, _ in meta_candidates}
    normalized = {(p, c) for p, c in normalized if p and c}
    if normalized:
        price, currency = sorted(normalized)[0]
        base.price, base.currency, base.method = price, currency, "meta_microdata"
        base.confidence = 0.9 if len(normalized) == 1 else 0.5
        if len(normalized) > 1:
            base.candidates = [{"price": str(p), "currency": c, "context": "meta/microdatos", "score": 0.5,
                                "selector": next(s for raw, currency, s in meta_candidates if normalize_price(raw) == p and currency_for(raw, currency, url, lang) == c)}
                               for p, c in sorted(normalized)[:5]]
            base.warnings.append("Precios estructurados contradictorios; requiere confirmación.")
            return base
        if base.ok:
            return base
    if recipe_read(page, base, recipe, cur, url, lang):
        return base
    candidates = []
    for node in root.xpath('//*[not(self::script or self::style)]'):
        attrs = " ".join(node.get(key, "") for key in ("class", "id", "itemprop", "data-testid"))
        if not re.search(r"price|precio|amount|sale", attrs, re.I) or excluded(node):
            continue
        content = text_of(node)
        if len(content) > 160:
            continue
        matches = list(MONEY.finditer(content))
        for match_index, match in enumerate(matches):
            amount = match.group()
            price = normalize_price(amount)
            currency = currency_for(amount, cur, url, lang)
            if price:
                style = node.get("style", "")
                score = 0.82 if re.search(r"sale|current|final|offer|special", attrs, re.I) else 0.7
                if re.search(r"font-size:\s*(?:[2-9]\d)px", style):
                    score = min(0.86, score + 0.12)
                candidates.append({"price": str(price), "currency": currency, "context": content[:160], "score": score,
                                   "selector": css_path(node), "match_index": match_index, "match_count": len(matches)})
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

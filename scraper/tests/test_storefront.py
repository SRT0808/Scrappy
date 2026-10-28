"""Regional context must be explicit and cannot be bypassed by owner selectors."""

from contextlib import nullcontext
from decimal import Decimal
from pathlib import Path
import json
import unittest
from unittest.mock import patch

from scrappy.extract import extract
from scrappy.probe import fetch
from scrappy.run import review_product
from scrappy.storefront import preference_cookies

URL = "https://www.yesstyle.com/es/product/info.html/pid.1124536886"


def product_page(country=170, currency="USD", destination="PE", price="0.89"):
    basic = {"countryId": country, "currencyCode": currency, "token": "private-test-token"}
    payload = '1:{"basic":' + json.dumps(basic) + '}'
    stream = '<script>self.__next_f.push(' + json.dumps([1, payload]) + ')</script>'
    product = {"@type": "Product", "name": "APLB 25ml", "offers": {
        "@type": "Offer", "price": price, "priceCurrency": currency,
        "shippingDetails": [{"shippingDestination": {"addressCountry": destination}}]}}
    return ('<html lang="en-US"><head>' + stream + '<script type="application/ld+json">'
            + json.dumps(product) + '</script></head><body><h1>APLB 25ml</h1>'
            + '<span class="sale-price">US$ ' + price + '</span></body></html>')


class StorefrontTests(unittest.TestCase):
    def test_current_failed_products_match_only_their_observed_presentation(self):
        fixtures = json.loads((Path(__file__).parent / "fixtures/yesstyle_identity.json").read_text(encoding="utf-8"))
        for fixture in fixtures:
            url, product = fixture["url"], fixture["product"]
            previous, current = fixture["confirmed"], product["name"]

            def read(confirmed, title, option=None, sku=None, missing_option=False):
                node = {**product, "name": title}
                offer = {**product["offers"][0]}
                if option is not None:
                    offer["name"] = title + " (option: " + option + ")"
                if missing_option:
                    offer.pop("name")
                if sku is not None:
                    offer["sku"] = sku
                node["offers"] = [offer]
                html = product_page()
                start = html.index('<script type="application/ld+json">') + len('<script type="application/ld+json">')
                end = html.index('</script>', start)
                html = (html[:start] + json.dumps(node) + html[end:]).replace(
                    'US$ 0.89</span>', 'US$ ' + offer["price"] + '</span>')
                recipe = {"adaptive_state": {"version": "0.4.15", "elements": {}, "confirmed_candidates": {
                    url: {"name": confirmed, "currency": "USD"}}}}
                return extract(html, url, recipe)

            for old, new in ((previous, current), (current, previous)):
                with self.subTest(url=url, old=old):
                    self.assertTrue(read(old, new).ok)
                    self.assertTrue(read(old, old).ok)
                    for option in ("25ml", "50ml", "100ml", "50ml x 2 pcs", "100ml x 2 pcs", "60ml x 2 pcs"):
                        if not product["offers"][0]["name"].endswith("(option: " + option + ")"):
                            self.assertFalse(read(old, new, option=option).ok)
                    self.assertFalse(read(old, new, sku=1).ok)
                    self.assertFalse(read(old, new, missing_option=True).ok)
                    self.assertFalse(read(old, new + " 3pcs Bundle Set").ok)
                    self.assertFalse(read(old, old, option="25ml").ok)

    def identity_read(self, confirmed_name, name, sku=1124536886, currency="USD"):
        html = product_page().replace('"name": "APLB 25ml"',
                                     '"name": ' + json.dumps(name) +
                                     (', "sku": ' + json.dumps(sku) if sku is not None else ''))
        recipe = {"adaptive_state": {"version": "0.4.15", "elements": {}, "confirmed_candidates": {
            URL: {"name": confirmed_name, "currency": currency}}}}
        return extract(html, URL, recipe)

    def test_translated_titles_require_matching_sku_and_preserve_presentation(self):
        pairs = [
            ("Mascarilla Facial Glutathione Niacinamide", "Glutathione Niacinamide Sheet Mask"),
            ("Crema Facial PDRN Hyaluronic Acid 100", "PDRN Hyaluronic Acid 100 Moisturizing Cream"),
            ("Sérum Solar Madagascar Centella Hyalu-Cica Water-Fit Sun Serum",
             "Madagascar Centella Hyalu-Cica Water-Fit Sun Serum"),
        ]
        for spanish, english in pairs:
            for old, new in ((spanish, english), (english, spanish)):
                with self.subTest(old=old, new=new):
                    self.assertTrue(self.identity_read(old, new).ok)
                    for changed in (new + " Jumbo", new + " 2pcs Bundle Set", new + " 50ml", "Other Product"):
                        self.assertFalse(self.identity_read(old, changed).ok)
                    for sku in (None, 1137960568):
                        rejected = self.identity_read(old, new, sku=sku)
                        self.assertFalse(rejected.ok)
                        self.assertIsNone(rejected.price)
                    self.assertFalse(self.identity_read(old, new, currency="PEN").ok)

    def test_same_title_cannot_hide_changed_sku_or_quantity(self):
        self.assertFalse(self.identity_read("APLB 25ml", "APLB 25ml", sku=1137960568).ok)
        self.assertTrue(self.identity_read("APLB 25ml", "APLB 25ml").ok)
        self.assertFalse(self.identity_read("APLB 25ml", "APLB 50ml").ok)
        self.assertFalse(self.identity_read("APLB 25ml", "APLB 25ml 2pcs Bundle Set").ok)
        for old, new in (("1.5ml", "1/5ml"), ("SPF50+", "SPF50")):
            self.assertFalse(self.identity_read("Mascarilla Facial APLB " + old,
                                                "APLB " + new + " Sheet Mask").ok)

    def test_translated_identity_stays_scoped_to_yesstyle_and_preserves_price_checks(self):
        old, new = "Mascarilla Facial Glutathione Niacinamide", "Glutathione Niacinamide Sheet Mask"
        reading = self.identity_read(old, new)
        database, alerts = unittest.mock.Mock(), unittest.mock.Mock()
        product = {"currency": "USD", "last_price": "0.89"}
        accepted = review_product(database, product, {}, read=lambda *_: reading, alerts=alerts)
        self.assertTrue(accepted.accepted)
        rejected = review_product(database, product, {},
                                  read=lambda *_: self.identity_read(old, new + " 2pcs Bundle Set"),
                                  alerts=alerts)
        self.assertFalse(rejected.accepted)
        self.assertFalse(rejected.alert_allowed)
        self.assertEqual(rejected.error_code, "invalid_reading")
        self.assertIsNone(database.save_review.call_args.args[3][0]["price"])
        for url in ("https://shop.pe/product", "https://www.yesstyle.com.evil.test/product"):
            recipe = {"adaptive_state": {"version": "0.4.15", "elements": {}, "confirmed_candidates": {
                url: {"name": old, "currency": "USD"}}}}
            self.assertFalse(extract(product_page().replace('"APLB 25ml"', json.dumps(new)), url, recipe).ok)

    def test_offer_sku_filters_cheaper_variant_and_conflicting_product_sku(self):
        html = product_page()
        start = html.index('<script type="application/ld+json">') + len('<script type="application/ld+json">')
        end = html.index('</script>', start)
        product = json.loads(html[start:end])
        offer = product['offers']
        product['offers'] = [{**offer, 'sku': 1137960568, 'price': '0.01'},
                             {**offer, 'sku': 1124536886}]
        recipe = {"adaptive_state": {"version": "0.4.15", "elements": {}, "confirmed_candidates": {
            URL: {"name": "APLB 25ml", "currency": "USD"}}}}

        def read():
            return extract(html[:start] + json.dumps(product) + html[end:], URL, recipe)

        result = read()
        self.assertEqual(result.price, Decimal('0.89'))
        self.assertTrue(result.ok)
        product['sku'] = 1137960568
        self.assertFalse(read().ok)

    def test_verified_peru_usd_price_and_audit_warning(self):
        result = extract(product_page(), URL)
        self.assertTrue(result.ok)
        self.assertEqual((result.price, result.currency), (Decimal("0.89"), "USD"))
        self.assertIn("destino PE; moneda USD", " ".join(result.warnings))
        self.assertNotIn("private-test-token", str(result.to_dict()))

    def test_wrong_missing_conflicting_or_malformed_context_rejects_without_candidates(self):
        valid = product_page()
        bodies = [product_page(country=226, destination="US", price="0.98"),
                  product_page(destination="US"), product_page(currency="EUR"),
                  valid.replace('self.__next_f.push', 'other.push'),
                  valid.replace('application/ld+json', 'application/json'),
                  valid.replace('[1,', '[invalid,'),
                  valid.replace('[1,', '{"payload":'),
                  valid + product_page(country=226, destination="US", price="0.98")]
        for body in bodies:
            for recipe in ({}, {"force_selector": True, "price_selector": ".sale-price"}):
                with self.subTest(body=body[:80], recipe=recipe):
                    result = extract(body, URL, recipe)
                    self.assertFalse(result.ok)
                    self.assertIsNone(result.price)
                    self.assertEqual(result.candidates, [])
                    self.assertIn("lectura rechazada", " ".join(result.warnings))

    def test_verified_context_preserves_visible_price_disagreement(self):
        result = extract(product_page().replace('US$ 0.89</span>', 'US$ 0.98</span>'), URL)
        self.assertFalse(result.ok)
        self.assertEqual([c["price"] for c in result.candidates], ["0.89", "0.98"])

    def test_context_does_not_apply_to_other_or_lookalike_domains(self):
        for url in ("https://shop.pe/product", "https://www.yesstyle.com.evil.test/product"):
            self.assertEqual(list(preference_cookies(url)), [])
            self.assertEqual(preference_cookies(url, browser=True), [])
            self.assertTrue(extract(product_page(country=226, destination="US"), url).ok)

    def test_http_cookies_are_scoped_and_browser_modes_share_preferences(self):
        with patch("scrappy.probe.public_url"), patch("scrappy.probe.public_proxy", return_value=nullcontext("proxy")):
            with patch("scrappy.probe.http_get") as get, patch("scrappy.probe.ResponseFactory.from_http_request"):
                fetch(URL, "http", 25)
                jar = get.call_args.kwargs["cookies"].jar
                self.assertEqual({c.name: c.value for c in jar}, {"coid": "170", "tcurrency": "19"})
                self.assertTrue(all(c.domain == "www.yesstyle.com" and c.path == "/" for c in jar))
                self.assertEqual(get.call_args.kwargs["proxy"], "proxy")
            for fetcher, mode in (("DynamicFetcher", "dynamic"), ("StealthyFetcher", "stealth")):
                with patch("scrappy.probe." + fetcher + ".fetch") as browser:
                    fetch(URL, mode, 25)
                    kwargs = browser.call_args.kwargs
                    self.assertEqual({c["name"]: c["value"] for c in kwargs["cookies"]},
                                     {"coid": "170", "tcurrency": "19"})
                    self.assertTrue(all(c["domain"] == "www.yesstyle.com" for c in kwargs["cookies"]))
                    self.assertEqual(kwargs["proxy"], "proxy")


if __name__ == "__main__":
    unittest.main()

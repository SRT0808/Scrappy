"""Regional context must be explicit and cannot be bypassed by owner selectors."""

from contextlib import nullcontext
from decimal import Decimal
import json
import unittest
from unittest.mock import patch

from scrappy.extract import extract
from scrappy.probe import fetch
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

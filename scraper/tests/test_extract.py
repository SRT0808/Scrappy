"""Price and extraction tests, including unsafe ambiguous and hidden prices."""

from decimal import Decimal
from pathlib import Path
import unittest

from scrappy.extract import extract
from scrappy.prices import currency_for, normalize_price

FIXTURES = Path(__file__).parent / "fixtures"


class PriceTests(unittest.TestCase):
    def test_formats(self):
        for raw, expected in (("S/ 1,999.00", "1999.00"), ("1.999,00", "1999.00"), ("$1 999", "1999"), ("USD 29.99", "29.99"), ("1,999", "1999"), ("19,9", "19.9"), ("1\u00a0999,50", "1999.50")):
            with self.subTest(raw=raw):
                self.assertEqual(normalize_price(raw), Decimal(expected))

    def test_rejects_nonpositive_and_nonprices(self):
        for raw in ("0", "-1", None, "NaN", "Infinity", "free", True):
            with self.subTest(raw=raw):
                self.assertIsNone(normalize_price(raw))

    def test_currency_context_and_ambiguous_dollar(self):
        self.assertEqual(currency_for("$99", "USD", "https://shop.pe"), "USD")
        self.assertEqual(currency_for("S/ 99"), "PEN")
        self.assertEqual(currency_for("€99"), "EUR")
        self.assertEqual(currency_for("$99", url="https://shop.pe"), "PEN")
        self.assertEqual(currency_for("$99", lang="en-US"), "USD")
        self.assertIsNone(currency_for("$99", url="https://shop.com", lang="en"))


class ExtractTests(unittest.TestCase):
    def fixture(self, name, recipe=None):
        return extract((FIXTURES / name).read_bytes(), "https://shop.pe/product", recipe)

    def test_json_ld_graph_array_and_lowest_available_offer(self):
        result = self.fixture("json_ld.html")
        self.assertTrue(result.ok)
        self.assertEqual(result.method, "json_ld")
        self.assertEqual(result.price, Decimal("1999"))
        self.assertEqual(result.currency, "PEN")
        self.assertEqual(result.image_url, "https://shop.pe/monitor.jpg")
        self.assertEqual(result.availability, "https://schema.org/InStock")

    def test_meta(self):
        result = self.fixture("meta.html")
        self.assertTrue(result.ok)
        self.assertEqual((result.price, result.currency, result.method), (Decimal("29.99"), "USD", "meta_microdata"))

    def test_microdata_excludes_related(self):
        result = self.fixture("microdata.html")
        self.assertTrue(result.ok)
        self.assertEqual((result.price, result.currency), (Decimal("39.90"), "EUR"))

    def test_heuristic_excludes_installments_shipping_tax_related_and_hidden(self):
        result = self.fixture("heuristic.html")
        self.assertTrue(result.ok)
        self.assertEqual(result.method, "heuristic")
        self.assertEqual(result.price, Decimal("1999.00"))
        self.assertEqual(len(result.candidates), 1)

    def test_recipe_saves_fingerprint_after_confident_read(self):
        recipe = {"price_selector": ".old-selector", "name_selector": "h1"}
        result = self.fixture("recipe_before.html", recipe)
        self.assertTrue(result.ok)
        self.assertEqual(result.method, "recipe")
        self.assertTrue(recipe["adaptive_state"]["elements"])

    def test_ambiguous_visible_prices_require_confirmation_and_cap_candidates(self):
        html = "<h1>Product</h1>" + "".join(f'<div><span class="sale-price">S/ {i}</span></div>' for i in range(10, 17))
        result = extract(html, "https://shop.pe/product")
        self.assertFalse(result.ok)
        self.assertEqual(len(result.candidates), 5)

    def test_ambiguous_dollar_is_not_success(self):
        result = extract('<h1>Product</h1><span class="sale-price">$99</span>', "https://shop.com/product")
        self.assertFalse(result.ok)
        self.assertIsNone(result.currency)

    def test_aggregate_offer_and_nested_product(self):
        result = extract('<script type="application/ld+json">[{"data":{"@type":"ProductGroup","name":"Kit","offers":{"@type":"AggregateOffer","lowPrice":"20","priceCurrency":"USD"}}}]</script>', "https://shop.com/product")
        self.assertTrue(result.ok)
        self.assertEqual(result.price, Decimal("20"))

    def test_multiple_products_do_not_choose_related_cheapest(self):
        html = '<script type="application/ld+json">[{"@type":"Product","name":"Main","offers":{"price":99,"priceCurrency":"USD"}},{"@type":"Product","name":"Related","offers":{"price":1,"priceCurrency":"USD"}}]</script>'
        self.assertFalse(extract(html, "https://shop.com/product").ok)

    def test_url_identity_selects_main_product(self):
        html = '<script type="application/ld+json">[{"@type":"Product","url":"/product","name":"Main","offers":{"price":99,"priceCurrency":"USD"}},{"@type":"Product","url":"/related","name":"Related","offers":{"price":1,"priceCurrency":"USD"}}]</script>'
        result = extract(html, "https://shop.com/product")
        self.assertTrue(result.ok)
        self.assertEqual(result.price, Decimal("99"))

    def test_malformed_json_falls_back(self):
        result = extract('<script type="application/ld+json">broken</script><h1>Product</h1><span class="sale-price">S/ 99</span>', "https://shop.pe/product")
        self.assertTrue(result.ok)
        self.assertTrue(result.warnings)

    def test_offer_reference_is_independent_of_graph_order(self):
        offer = '{"@id":"#offer","@type":"Offer","price":99,"priceCurrency":"USD"}'
        product = '{"@type":"Product","name":"Main","offers":{"@id":"#offer"}}'
        for nodes in ((offer, product), (product, offer)):
            with self.subTest(nodes=nodes):
                html = '<script type="application/ld+json">{"@graph":[' + ','.join(nodes) + ']}</script>'
                result = extract(html, "https://shop.com/product")
                self.assertTrue(result.ok)
                self.assertEqual(result.price, Decimal("99"))

    def test_currency_conflict_and_out_of_stock(self):
        html = '<script type="application/ld+json">{"@type":"Product","name":"Main","offers":[{"price":99,"priceCurrency":"USD","availability":"https://schema.org/OutOfStock"}]}</script>'
        result = extract(html, "https://shop.com/product")
        self.assertTrue(result.ok)
        self.assertIn("OutOfStock", result.availability)
        mixed = html.replace('"USD"', '"USD"').replace('}]', '},{"price":100,"priceCurrency":"EUR","availability":"https://schema.org/OutOfStock"}]')
        self.assertFalse(extract(mixed, "https://shop.com/product").ok)


if __name__ == "__main__":
    unittest.main()

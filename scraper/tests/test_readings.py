"""Initial readings never activate products, review alerts or publish recipes."""

from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from scrapling import Selector
from scrappy.extract import extract
from scrappy.readings import execute_reading, price_string, public_url, read_initial
from scrappy.run import main

REQUEST = {"id": "11111111-1111-4111-8111-111111111111", "url": "https://shop.pe/product", "domain": "shop.pe", "selector": None}


def page(html, status=200):
    selector = Selector(html)
    return SimpleNamespace(body=html.encode(), status=status, url=REQUEST["url"], css=selector.css, get_all_text=selector.get_all_text)


class ReadingTests(unittest.TestCase):
    def read(self, html, request=None, recipe=None):
        with TemporaryDirectory() as directory:
            return read_initial(request or REQUEST, recipe or {}, fetch_page=lambda *_: page(html), validate_url=lambda _: None, evidence=Path(directory))

    def test_ready_read_has_original_price_and_safe_decimal_strings(self):
        result, recipe = self.read('<h1>Monitor</h1><del>S/ 120</del><span class="sale-price">S/ 100</span>')
        self.assertEqual((result["name"], result["price"], result["currency"], result["original_price"]), ("Monitor", "100.00", "PEN", "120.00"))
        self.assertEqual(recipe["fetch_mode"], "http")
        self.assertTrue(result["candidates"][0]["selector"])

    def test_selector_overrides_structured_data_and_never_silently_falls_back(self):
        html = '<h1>Monitor</h1><meta property="product:price:amount" content="100"><meta property="product:price:currency" content="PEN"><span class="sale">S/ 80</span>'
        result, _ = self.read(html, {**REQUEST, "selector": ".sale"})
        self.assertEqual((result["price"], result["method"]), ("80.00", "recipe"))
        failed, _ = self.read(html, {**REQUEST, "selector": ".missing"})
        self.assertIsNone(failed["price"])

    def test_confirmed_candidate_selector_survives_future_price_changes(self):
        result, recipe = self.read('<h1>Monitor</h1><span class="price">S/ 100</span><span class="price">S/ 90</span>')
        choice = next(c for c in result["candidates"] if c["price"] == "90.00")
        recipe["adaptive_state"]["confirmed_candidates"] = {REQUEST["url"]: {"selector": choice["selector"], "currency": "PEN"}}
        future = extract('<h1>Monitor</h1><span class="price">S/ 95</span><span class="price">S/ 85</span>', REQUEST["url"], recipe)
        self.assertEqual(str(future.price), "85")
        self.assertEqual(future.method, "recipe")

    def test_explicit_selector_replaces_a_previously_confirmed_selector(self):
        recipe = {"adaptive_state": {"version": "0.4.15", "elements": {}, "confirmed_candidates": {
            REQUEST["url"]: {"selector": ".old", "currency": "PEN", "match_index": 1, "match_count": 2}
        }}}
        html = '<h1>Monitor</h1><span class="old">S/ 100 o S/ 90</span><span class="new">S/ 80</span>'
        result, _ = self.read(html, {**REQUEST, "selector": ".new"}, recipe)
        self.assertEqual((result["price"], result["method"]), ("80.00", "recipe"))
        failed, _ = self.read(html, {**REQUEST, "selector": ".missing"}, recipe)
        self.assertIsNone(failed["price"])

    def test_confirmed_structured_product_identity_is_learned(self):
        html = '<script type="application/ld+json">[{"@type":"Product","name":"A","offers":{"price":100,"priceCurrency":"USD"}},{"@type":"Product","name":"B","offers":{"price":90,"priceCurrency":"PEN"}}]</script>'
        recipe = {"adaptive_state": {"version": "0.4.15", "elements": {}, "confirmed_candidates": {REQUEST["url"]: {"name": "A", "currency": "USD"}}}}
        result = extract(html, REQUEST["url"], recipe)
        self.assertEqual((result.name, str(result.price), result.currency), ("A", "100", "USD"))
        self.assertTrue(result.ok)

    def test_selected_second_price_in_one_element_keeps_its_position(self):
        result, recipe = self.read('<h1>Monitor</h1><div class="price">S/ 100 o S/ 90</div>')
        choice = next(c for c in result["candidates"] if c["price"] == "90.00")
        recipe["adaptive_state"]["confirmed_candidates"] = {REQUEST["url"]: {**choice, "currency": "PEN"}}
        future = extract('<h1>Monitor</h1><div class="price">S/ 95 o S/ 85</div>', REQUEST["url"], recipe)
        self.assertEqual(str(future.price), "85")
        changed = extract('<h1>Monitor</h1><div class="price">S/ 95</div>', REQUEST["url"], recipe)
        self.assertIsNone(changed.price)

    def test_missing_confirmed_structured_product_never_accepts_another_price(self):
        recipe = {"adaptive_state": {"version": "0.4.15", "elements": {}, "confirmed_candidates": {
            REQUEST["url"]: {"name": "Monitor A", "currency": "PEN"}
        }}}
        for name, currency in (("Monitor B", "PEN"), ("Monitor A", "USD")):
            with self.subTest(name=name, currency=currency):
                html = ('<script type="application/ld+json">{"@type":"Product","name":"' + name
                        + '","offers":{"price":50,"priceCurrency":"' + currency + '"}}</script>')
                html += '<meta property="product:price:amount" content="50"><span class="sale">S/ 50</span>'
                result = extract(html, REQUEST["url"], recipe)
                self.assertIsNone(result.price)
                self.assertFalse(result.ok)
                self.assertTrue(any("confirmado cambió" in warning for warning in result.warnings))

    def test_confirmed_name_keeps_non_json_ld_extraction_available(self):
        recipe = {"adaptive_state": {"version": "0.4.15", "elements": {}, "confirmed_candidates": {
            REQUEST["url"]: {"name": "Monitor", "currency": "PEN"}
        }}}
        result = extract('<h1>Monitor</h1><meta property="product:price:amount" content="80">', REQUEST["url"], recipe)
        self.assertTrue(result.ok)
        self.assertEqual(str(result.price), "80")

    def test_ambiguous_currency_stays_unset_for_owner_confirmation(self):
        result, _ = self.read('<h1>Monitor</h1><span class="price">$99</span>', {**REQUEST, "url": "https://shop.com/product"})
        self.assertIsNone(result["currency"])
        self.assertEqual(result["price"], "99.00")

    def test_blocked_store_has_bounded_escalation_and_evidence(self):
        fetch = Mock(return_value=page('<title>Access denied</title>', 403))
        with TemporaryDirectory() as directory:
            result, _ = read_initial(REQUEST, {}, fetch_page=fetch, validate_url=lambda _: None, evidence=Path(directory))
            self.assertEqual(fetch.call_count, 3)
            self.assertEqual(len(list(Path(directory).glob('*.html'))), 3)
            self.assertEqual(len(list(Path(directory).glob('*.json'))), 1)
        self.assertIsNone(result["price"])

    def test_nonpublic_and_credential_urls_are_rejected(self):
        for address in ('127.0.0.1', '10.0.0.1', '169.254.169.254', '::1'):
            with self.subTest(address=address), patch('scrappy.network.socket.getaddrinfo', return_value=[(0, 0, 0, '', (address, 443))]):
                with self.assertRaises(ValueError): public_url(REQUEST["url"])
        for url in ('file:///tmp/test', 'https://user:pass@shop.pe', 'https://shop.pe:8080'):
            with self.assertRaises(ValueError): public_url(url)

    def test_claimed_reading_only_completes_once_and_never_writes_products_or_recipes(self):
        database = Mock()
        database.request.side_effect = [REQUEST, [], None]
        read = Mock(return_value=({"price": "100.00"}, {"fetch_mode": "http"}))
        execute_reading(database, REQUEST["id"], read=read)
        self.assertEqual([call.args[1] for call in database.request.call_args_list],
                         ['rpc/claim_product_reading', 'domain_recipes?domain=eq.shop.pe&select=*', 'rpc/complete_product_reading'])
        database.request.reset_mock(); database.request.side_effect = [None]
        read.reset_mock()
        execute_reading(database, REQUEST["id"], read=read)
        read.assert_not_called()
        self.assertEqual(database.request.call_count, 1)

    def test_rejected_public_url_completes_as_a_failed_reading(self):
        database = Mock(); database.request.side_effect = [REQUEST, [], None]
        execute_reading(database, REQUEST["id"], read=Mock(side_effect=ValueError('private data')))
        payload = database.request.call_args.args[2]
        self.assertIsNone(payload['p_result']['price'])
        self.assertNotIn('private data', str(payload))

    def test_price_range_and_cli_reading_id_validation(self):
        for value in (None, 'NaN', 'Infinity', '-1', '10000000000'):
            self.assertIsNone(price_string(value))
        self.assertEqual(price_string('9999999999.99'), '9999999999.99')
        with patch('sys.argv', ['scrappy.run', '--mode', 'reading', '--reading-id', REQUEST['id']]), patch('scrappy.run.Database'), patch('scrappy.run.execute_reading') as reading, patch('scrappy.run.execute_reviews') as reviews:
            main(); reading.assert_called_once(); reviews.assert_not_called()


if __name__ == '__main__':
    unittest.main()

"""Escalation and persistence must not accept blocked or ambiguous pages."""

from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from scrapling.engines.toolbelt.custom import Response

from scrappy.probe import evaluate, ordered_urls, summary
from scrappy.recipes import RecipeStore


def response(body, status=200):
    return Response(url="https://shop.pe/product", content=body, status=status, reason="", cookies={}, headers={}, request_headers={})


class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)
        self.store = RecipeStore(self.path / "state.json")

    def test_block_escalates_and_success_is_remembered_in_fresh_store(self):
        pages = [response("<title>Access denied</title>", 403), response('<h1>Product</h1><span class="sale-price">S/ 99</span>')]
        with patch("scrappy.probe.fetch", side_effect=pages) as fetch:
            row = evaluate("https://shop.pe/product", self.store, self.path)
        self.assertTrue(row["ok"])
        self.assertEqual([call.args[1] for call in fetch.call_args_list], ["http", "dynamic"])
        self.assertEqual(RecipeStore(self.path / "state.json").get("shop.pe")["fetch_mode"], "dynamic")
        self.assertTrue((self.path / row["attempts"][0]["html"]).exists())

    def test_http_200_challenge_cannot_be_a_product(self):
        body = '<title>Just a moment</title><h1>Challenge</h1><span class="sale-price">S/ 99</span>'
        with patch("scrappy.probe.fetch", return_value=response(body)) as fetch:
            row = evaluate("https://shop.pe/product", self.store, self.path)
        self.assertFalse(row["ok"])
        self.assertEqual(fetch.call_count, 3)
        self.assertEqual(self.store.recipes, {})

    def test_exceptions_are_bounded_and_do_not_leak_details(self):
        with patch("scrappy.probe.fetch", side_effect=TimeoutError("secret-cookie")) as fetch:
            row = evaluate("https://shop.pe/product", self.store, self.path)
        self.assertEqual(fetch.call_count, 3)
        self.assertNotIn("secret-cookie", str(row))
        self.assertFalse(row["ok"])

    def test_remembered_mode_falls_back_and_failed_probe_does_not_overwrite(self):
        self.store.save("shop.pe", {"fetch_mode": "stealth", "price_selector": ".owner-selector"})
        with patch("scrappy.probe.fetch", return_value=response("<h1>Empty product</h1>")) as fetch:
            row = evaluate("https://shop.pe/product", self.store, self.path)
        self.assertFalse(row["ok"])
        self.assertEqual([call.args[1] for call in fetch.call_args_list], ["stealth", "http", "dynamic"])
        self.assertEqual(self.store.get("shop.pe")["fetch_mode"], "stealth")

    def test_round_robin_urls_and_validation(self):
        path = self.path / "urls.txt"
        path.write_text("# sample\nhttps://a.pe/1\nhttps://a.pe/2\nhttps://b.pe/1\nhttps://a.pe/1\n", encoding="utf-8")
        self.assertEqual(ordered_urls(path), ["https://a.pe/1", "https://b.pe/1", "https://a.pe/2"])
        path.write_text("https://user:password@a.pe/product", encoding="utf-8")
        with self.assertRaises(ValueError):
            ordered_urls(path)

    def test_summary_empty_and_failures(self):
        self.assertEqual(summary([])["success_rate"], 0)
        row = {"ok": False, "domain": "shop.pe"}
        self.assertEqual(summary([row])["failed_domains"], ["shop.pe"])


if __name__ == "__main__":
    unittest.main()

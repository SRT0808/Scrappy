"""Connected reviews with saved HTML, rejected candidates and persistence failures."""

from contextlib import redirect_stderr
from dataclasses import replace
from datetime import datetime, timezone
from decimal import Decimal
import io
import json
from pathlib import Path
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError, URLError

from scrappy.extract import extract, Extraction
from scrappy.persistence import Database
from scrappy.run import execute_reviews, main, read_product, review_product

NOW = datetime(2026, 10, 8, tzinfo=timezone.utc)
PRODUCT = {"id": "00000000-0000-0000-0000-000000000001", "url": "https://shop.pe/product",
           "domain": "shop.pe", "currency": "PEN", "last_price": "100.00", "last_checked_at": None}
RUN_ID = "00000000-0000-0000-0000-000000000002"


class ReviewTests(unittest.TestCase):
    def setUp(self):
        self.reading = extract((Path(__file__).parent / "fixtures/json_ld.html").read_bytes(), PRODUCT["url"])
        self.reading = replace(self.reading, price=Decimal("100"))
        self.database = Mock()
        self.read = Mock(return_value=self.reading)
        self.sleep = Mock()

    def review(self, product=None):
        return review_product(self.database, product or PRODUCT, {}, read=self.read, now=lambda: NOW, sleep=self.sleep)

    def saved_checks(self):
        return self.database.save_review.call_args.args[3]

    def test_ordinary_and_first_price_are_persisted_after_validation(self):
        for last_price in (None, "100"):
            with self.subTest(last_price=last_price):
                result = self.review({**PRODUCT, "last_price": last_price})
                self.assertTrue(result.accepted)
                self.assertEqual(self.saved_checks()[0]["price"], "100")
                self.assertTrue(self.saved_checks()[0]["ok"])
        self.sleep.assert_not_called()

    def test_confirmed_jump_records_both_fresh_attempts(self):
        self.read.return_value = replace(self.reading, price=Decimal("40"))
        result = self.review()
        self.assertTrue(result.accepted)
        self.assertEqual(self.read.call_count, 2)
        self.sleep.assert_called_once_with(3)
        self.assertEqual([row["price"] for row in self.saved_checks()], ["40", "40"])
        self.assertTrue(all(row["ok"] for row in self.saved_checks()))

    def test_discrepant_jump_keeps_rejected_prices_as_evidence(self):
        self.read.side_effect = [replace(self.reading, price=Decimal("40")), self.reading]
        result = self.review()
        self.assertFalse(result.accepted)
        self.assertFalse(result.alert_allowed)
        self.assertEqual([row["price"] for row in self.saved_checks()], ["40", "100"])
        self.assertTrue(all(not row["ok"] and row["error_code"] == "price_mismatch" for row in self.saved_checks()))

    def test_currency_mismatch_and_failed_reads_are_audited(self):
        for reading in (replace(self.reading, currency="USD"), Extraction()):
            with self.subTest(reading=reading):
                self.read.return_value = reading
                self.assertFalse(self.review().accepted)
                self.assertFalse(self.saved_checks()[0]["ok"])

    def test_confirmation_exception_is_a_second_failed_attempt(self):
        self.read.side_effect = [replace(self.reading, price=Decimal("40")), TimeoutError("private")]
        result = self.review()
        self.assertFalse(result.accepted)
        self.assertEqual(len(self.saved_checks()), 2)
        self.assertIsNone(self.saved_checks()[1]["price"])
        self.assertNotIn("private", str(self.saved_checks()))

    def test_unavailable_price_persists_but_cannot_trigger_target(self):
        self.read.return_value = replace(self.reading, availability="OutOfStock")
        result = self.review()
        self.assertTrue(result.accepted)
        self.assertFalse(result.alert_allowed)
        self.assertTrue(self.saved_checks()[0]["warnings"])

    def test_invalid_numbers_fit_database_and_cannot_be_accepted(self):
        for value in ("-1", "NaN", "Infinity", "10000000000"):
            with self.subTest(value=value):
                self.read.return_value = replace(self.reading, price=Decimal(value))
                self.assertFalse(self.review().accepted)
                self.assertIsNone(self.saved_checks()[0]["price"])

    def test_persistence_failure_cannot_return_result_for_alerts(self):
        self.database.save_review.side_effect = RuntimeError("Sin conexión")
        with self.assertRaises(RuntimeError):
            self.review()

    def configure_run(self, products):
        self.database.due_products.return_value = products
        self.database.request.side_effect = [[{"id": RUN_ID}], [], [], None]

    def test_run_counts_valid_and_failed_reviews_and_uses_selection(self):
        self.configure_run([PRODUCT, {**PRODUCT, "id": RUN_ID}])
        self.read.side_effect = [self.reading, Extraction()]
        counts = execute_reviews(self.database, read=self.read, now=lambda: NOW, sleep=self.sleep)
        self.assertEqual(counts, {"checked": 2, "ok_count": 1, "fail_count": 1})
        self.database.due_products.assert_called_once_with(NOW, None)
        self.assertEqual(self.database.request.call_args.args[2]["finished_at"], NOW.isoformat())

    def test_empty_run_completes_without_fetch(self):
        self.configure_run([])
        self.assertEqual(execute_reviews(self.database, read=self.read, now=lambda: NOW)["checked"], 0)
        self.read.assert_not_called()

    def test_partial_run_preserves_counts_without_claiming_completion(self):
        self.configure_run([PRODUCT, PRODUCT])
        self.database.save_review.side_effect = [None, RuntimeError("Sin conexión")]
        with self.assertRaises(RuntimeError):
            execute_reviews(self.database, read=self.read, now=lambda: NOW)
        payload = self.database.request.call_args.args[2]
        self.assertEqual(payload["checked"], 1)
        self.assertIsNone(payload["finished_at"])

    def test_fetch_reuses_verified_recipe_mode_and_saved_html(self):
        page = Mock(status=200, body=(Path(__file__).parent / "fixtures/json_ld.html").read_bytes())
        page.css.return_value.get.return_value = "Producto"
        page.get_all_text.return_value = "Producto"
        with patch("scrappy.run.fetch", return_value=page) as fetch:
            result = read_product(PRODUCT, {"fetch_mode": "dynamic"})
        fetch.assert_called_once_with(PRODUCT["url"], "dynamic", 25)
        self.assertTrue(result.ok)
        page.status = 403
        with patch("scrappy.run.fetch", return_value=page):
            self.assertFalse(read_product(PRODUCT, {}).ok)


class DatabaseTests(unittest.TestCase):
    def setUp(self):
        env = patch.dict("os.environ", {"SUPABASE_URL": "https://example.supabase.co/", "SUPABASE_SERVICE_ROLE_KEY": "private-key"}, clear=True)
        env.start()
        self.addCleanup(env.stop)

    def test_rpc_transport_serializes_timestamp_uuid_and_auth(self):
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock()
        response.read.return_value = b'[]'
        with patch("scrappy.persistence.urlopen", return_value=response) as open_url:
            self.assertEqual(Database().due_products(NOW, PRODUCT["id"]), [])
        request = open_url.call_args.args[0]
        self.assertEqual(request.full_url, "https://example.supabase.co/rest/v1/rpc/due_products")
        self.assertEqual(json.loads(request.data), {"p_now": NOW.isoformat(), "p_product_id": PRODUCT["id"]})
        self.assertEqual(request.get_header("Authorization"), "Bearer private-key")
        self.assertEqual(open_url.call_args.kwargs["timeout"], 15)

    def test_save_uses_one_atomic_rpc_and_expected_version(self):
        database = Database()
        with patch.object(database, "request") as request:
            database.save_review(PRODUCT, NOW, Mock(accepted=False), [{"ok": False}])
        self.assertEqual(request.call_args.args[:2], ("POST", "rpc/save_review"))
        self.assertIsNone(request.call_args.args[2]["p_expected_checked_at"])
        self.assertFalse(request.call_args.args[2]["p_accepted"])

    def test_missing_or_invalid_credentials_do_not_send_request(self):
        for changes in ({"SUPABASE_URL": ""}, {"SUPABASE_SERVICE_ROLE_KEY": ""},
                        *({"SUPABASE_URL": url} for url in ("http://example.co", "https://user@example.co", "https://example.co/rest", "https://example.co?key=private-key"))):
            with self.subTest(changes=changes), patch.dict("os.environ", changes), patch("scrappy.persistence.urlopen") as open_url:
                with self.assertRaises(ValueError):
                    Database()
                open_url.assert_not_called()

    def test_transport_failures_omit_response_and_secrets(self):
        for error in (HTTPError("", 401, "private-key", {}, io.BytesIO(b"private-key")), URLError("private-key"), TimeoutError("private-key")):
            with self.subTest(error=type(error).__name__), patch("scrappy.persistence.urlopen", side_effect=error):
                with self.assertRaises(RuntimeError) as caught:
                    Database().due_products(NOW)
                self.assertNotIn("private-key", str(caught.exception))

    def test_cli_failure_exits_nonzero(self):
        with patch("sys.argv", ["scrappy.run"]), patch("scrappy.run.execute_reviews", side_effect=RuntimeError("Sin conexión")), redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as caught:
                main()
        self.assertEqual(caught.exception.code, 1)

    def test_cli_invalid_product_and_pending_notifications_do_not_access_database(self):
        for args in (["--mode", "product"], ["--mode", "product", "--product-id", "bad"], ["--mode", "test_notification"]):
            with self.subTest(args=args), patch("sys.argv", ["scrappy.run", *args]), patch("scrappy.run.Database") as database, redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as caught:
                    main()
                self.assertEqual(caught.exception.code, 2)
                database.assert_not_called()


if __name__ == "__main__":
    unittest.main()

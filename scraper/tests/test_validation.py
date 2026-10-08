"""Review validation tests using saved HTML and deterministic fresh readings."""

from dataclasses import replace
from decimal import Decimal
from pathlib import Path
import unittest
from unittest.mock import Mock

from scrappy.extract import extract
from scrappy.validation import is_unavailable, validate_review

FIXTURES = Path(__file__).parent / "fixtures"


class ReviewValidationTests(unittest.TestCase):
    def setUp(self):
        self.reading = extract((FIXTURES / "json_ld.html").read_bytes(), "https://shop.pe/product")
        self.reread = Mock()
        self.sleep = Mock()

    def validate(self, reading=None, **options):
        settings = dict(
            registered_currency="PEN", last_valid_price=Decimal("1999"),
            reread=self.reread, sleep=self.sleep,
        )
        settings.update(options)
        return validate_review(reading or self.reading, **settings)

    def test_ordinary_and_first_reading_do_not_reread(self):
        for previous in (None, Decimal("1999"), Decimal("2000")):
            with self.subTest(previous=previous):
                result = self.validate(last_valid_price=previous)
                self.assertTrue(result.accepted)
                self.assertTrue(result.alert_allowed)
                self.assertIsNone(result.confirmation)
        self.reread.assert_not_called()
        self.sleep.assert_not_called()

    def test_exact_threshold_and_just_over_in_both_directions(self):
        for price, requires_confirmation in (("50", False), ("150", False), ("49.99", True), ("150.01", True)):
            with self.subTest(price=price):
                reading = replace(self.reading, price=Decimal(price))
                self.reread.reset_mock()
                self.sleep.reset_mock()
                self.reread.return_value = reading
                result = self.validate(reading, last_valid_price=Decimal("100"))
                self.assertTrue(result.accepted)
                self.assertTrue(result.alert_allowed)
                self.assertEqual(self.reread.call_count, int(requires_confirmation))
                self.assertEqual(self.sleep.call_count, int(requires_confirmation))

    def test_confirmation_waits_then_accepts_matching_fresh_reading(self):
        first = replace(self.reading, price=Decimal("900"))
        second = replace(first, method="recipe")
        events = []
        def pause(seconds):
            events.append(("sleep", seconds))
        def fresh_read():
            events.append(("read", None))
            return second
        result = self.validate(first, reread=fresh_read, sleep=pause)
        self.assertEqual(events, [("sleep", 3), ("read", None)])
        self.assertTrue(result.accepted)
        self.assertTrue(result.alert_allowed)
        self.assertIs(result.reading, second)
        self.assertIs(result.confirmation, second)
        self.assertEqual(first.price, Decimal("900"))

    def test_different_second_price_is_suspicious_even_if_it_returns_to_previous(self):
        first = replace(self.reading, price=Decimal("900"))
        for second_price in ("901", "1999"):
            with self.subTest(price=second_price):
                second = replace(first, price=Decimal(second_price))
                self.reread.return_value = second
                result = self.validate(first)
                self.assertFalse(result.accepted)
                self.assertFalse(result.alert_allowed)
                self.assertEqual(result.error_code, "price_mismatch")
                self.assertIs(result.reading, first)
                self.assertIs(result.confirmation, second)

    def test_currency_change_or_missing_currency_rejected_before_reread(self):
        for currency in ("USD", None):
            with self.subTest(currency=currency):
                result = self.validate(replace(self.reading, price=Decimal("900"), currency=currency))
                self.assertFalse(result.accepted)
                self.assertFalse(result.alert_allowed)
                self.assertEqual(result.error_code, "currency_mismatch")
        self.reread.assert_not_called()
        self.sleep.assert_not_called()

    def test_invalid_first_readings_are_rejected(self):
        invalid = [replace(self.reading, price=p) for p in (None, Decimal("0"), Decimal("-1"), Decimal("NaN"), Decimal("Infinity"))]
        invalid.append(replace(self.reading, confidence=0.5))
        invalid.append(replace(self.reading, name=None))
        for reading in invalid:
            with self.subTest(reading=reading):
                result = self.validate(reading)
                self.assertFalse(result.accepted)
                self.assertFalse(result.alert_allowed)
                self.assertEqual(result.error_code, "invalid_reading")
        self.reread.assert_not_called()

    def test_bad_confirmation_cannot_authorize_alert(self):
        first = replace(self.reading, price=Decimal("900"))
        for second, code in (
            (replace(first, currency="USD"), "currency_mismatch"),
            (replace(first, currency=None), "currency_mismatch"),
            (replace(first, confidence=0.5), "invalid_reading"),
            (replace(first, price=None), "invalid_reading"),
        ):
            with self.subTest(code=code, second=second):
                self.reread.return_value = second
                result = self.validate(first)
                self.assertFalse(result.accepted)
                self.assertFalse(result.alert_allowed)
                self.assertEqual(result.error_code, code)
                self.assertIs(result.confirmation, second)

    def test_failed_confirmation_is_bounded_and_safe(self):
        self.reread.side_effect = TimeoutError("private response")
        result = self.validate(replace(self.reading, price=Decimal("900")))
        self.assertFalse(result.accepted)
        self.assertFalse(result.alert_allowed)
        self.assertEqual(result.error_code, "confirmation_failed")
        self.reread.assert_called_once_with()
        self.sleep.assert_called_once_with(3)
        self.assertNotIn("private response", str(result))

    def test_out_of_stock_html_keeps_price_but_blocks_alert_by_default(self):
        html = (FIXTURES / "json_ld.html").read_text(encoding="utf-8").replace("InStock", "OutOfStock")
        reading = extract(html, "https://shop.pe/product")
        result = self.validate(reading, last_valid_price=reading.price)
        self.assertTrue(result.accepted)
        self.assertFalse(result.alert_allowed)
        self.assertEqual(result.reading.price, reading.price)
        self.assertTrue(result.warnings)
        override = self.validate(reading, last_valid_price=reading.price, suppress_unavailable_alerts=False)
        self.assertTrue(override.accepted)
        self.assertTrue(override.alert_allowed)

    def test_either_reading_out_of_stock_blocks_confirmed_jump(self):
        for first_stock, second_stock in (("InStock", "OutOfStock"), ("OutOfStock", "InStock")):
            with self.subTest(first=first_stock, second=second_stock):
                first = replace(self.reading, price=Decimal("900"), availability=first_stock)
                self.reread.return_value = replace(first, availability=second_stock)
                result = self.validate(first)
                self.assertTrue(result.accepted)
                self.assertFalse(result.alert_allowed)

    def test_stock_labels_and_unknown_optional_availability(self):
        for label in ("https://schema.org/OutOfStock", "http://schema.org/SoldOut", "schema:ignored#Discontinued", "out_of_stock", "sold out", "agotado", "SIN STOCK", "no disponible"):
            with self.subTest(label=label):
                self.assertTrue(is_unavailable(label))
        for label in (None, "", "InStock", "PreOrder", "BackOrder", "unknown"):
            with self.subTest(label=label):
                self.assertFalse(is_unavailable(label))
                self.assertTrue(self.validate(replace(self.reading, availability=label)).alert_allowed)

    def test_configuration_changes_threshold_and_delay(self):
        reading = replace(self.reading, price=Decimal("1700"))
        self.reread.return_value = reading
        result = self.validate(reading, max_change_percent=Decimal("10"), confirmation_delay_seconds=5)
        self.assertTrue(result.accepted)
        self.reread.assert_called_once_with()
        self.sleep.assert_called_once_with(5)

    def test_invalid_configuration_fails_before_network_or_sleep(self):
        cases = [dict(last_valid_price=p) for p in (Decimal("0"), Decimal("-1"), Decimal("NaN"), Decimal("Infinity"))]
        cases += [dict(max_change_percent=p) for p in (Decimal("-1"), Decimal("NaN"), Decimal("Infinity"))]
        cases += [dict(confirmation_delay_seconds=p) for p in (0, -1, float("nan"), float("inf"))]
        cases += [dict(registered_currency=p) for p in ("", "pen")]
        for options in cases:
            with self.subTest(options=options), self.assertRaises(ValueError):
                self.validate(**options)
        self.reread.assert_not_called()
        self.sleep.assert_not_called()


if __name__ == "__main__":
    unittest.main()

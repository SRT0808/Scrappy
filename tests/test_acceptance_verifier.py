import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    "verify_acceptance", Path(__file__).resolve().parents[1] / "scripts/verify_acceptance.py")
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)


class AcceptanceVerifierTests(unittest.TestCase):
    def test_github_completion_second_is_half_open(self):
        start, end = "2026-10-13T00:31:14Z", "2026-10-13T00:31:20Z"
        self.assertTrue(verifier.within("2026-10-13 00:31:20.999999+00", start, end, github_seconds=True))
        self.assertFalse(verifier.within("2026-10-13T00:31:21Z", start, end, github_seconds=True))
        self.assertFalse(verifier.within("2026-10-13T00:31:13.999999Z", start, end, github_seconds=True))

    def test_database_microseconds_are_inclusive_and_exact(self):
        start, end = "2026-10-13 00:31:15.060109+00", "2026-10-13 00:31:20.711561+00"
        self.assertTrue(verifier.within(end, start, end))
        self.assertTrue(verifier.within("2026-10-12T19:31:15.060109-05:00", start, end))
        self.assertFalse(verifier.within("2026-10-13T00:31:20.711562Z", start, end))
        self.assertFalse(verifier.within("2026-10-13T00:31:15.060108Z", start, end))
        with self.assertRaises(ValueError):
            verifier.timestamp("2026-10-13T00:31:15")

    def snapshot(self):
        return {"id": "snapshot", "complete": True, "item_count": 1, "valid_count": 1,
                "stale_count": 0, "unavailable_count": 0, "missing_count": 0, "fx_missing_count": 0,
                "currency": "PEN", "reference_total": "97.80", "current_total": "68.46",
                "savings": "29.34", "savings_percent": "30.00",
                "lines": [{"valid": True, "stale": False, "unavailable": False, "currency": "PEN",
                           "conversion": None, "quantity": 1, "reference_price": 97.8, "last_price": 68.46}]}

    def test_decimal_subtraction_matches_saved_cents(self):
        self.assertNotEqual(97.8 - 68.46, 29.34)
        self.assertEqual(verifier.verify_snapshot(self.snapshot())["savings"], "29.34")

    def test_wrong_cent_and_subcent_are_rejected(self):
        for value in ("29.35", "29.340001", "NaN", "Infinity"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                snapshot = self.snapshot()
                snapshot["savings"] = value
                verifier.verify_snapshot(snapshot)

    def test_decimal_quantity_rounds_half_up(self):
        snapshot = self.snapshot()
        snapshot["lines"][0].update(reference_price="1.005", last_price="0.505", quantity="3")
        snapshot.update(reference_total="3.02", current_total="1.52", savings="1.50", savings_percent="49.67")
        self.assertEqual(verifier.verify_snapshot(snapshot)["savings"], "1.50")

    def test_historical_mutation_and_duplicate_ids_are_rejected(self):
        before = [{"id": "old", "price": "10.00"}]
        after = copy.deepcopy(before) + [{"id": "new", "price": "12.00"}]
        self.assertEqual(verifier.additions(before, after), after[1:])
        after[0]["price"] = "10.01"
        with self.assertRaises(ValueError):
            verifier.additions(before, after)
        with self.assertRaises(ValueError):
            verifier.additions(before, before + before)

    def test_incomplete_or_converted_snapshot_is_not_silently_accepted(self):
        snapshot = self.snapshot()
        snapshot["complete"] = False
        with self.assertRaises(ValueError):
            verifier.verify_snapshot(snapshot)
        snapshot = self.snapshot()
        snapshot["lines"][0]["conversion"] = {"rate": "3.45"}
        with self.assertRaises(ValueError):
            verifier.verify_snapshot(snapshot)


if __name__ == "__main__":
    unittest.main()

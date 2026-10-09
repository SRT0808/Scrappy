"""Alert transitions, exact decimal boundaries and persisted-review gating."""

from datetime import timedelta
from decimal import Decimal
import unittest
from unittest.mock import Mock, patch

from scrappy.alerts import goal_event, process_alerts, target_price
from scrappy.extract import Extraction
from scrappy.run import review_product
from scrappy.persistence import Database
from scrappy.validation import ReviewValidation
from test_run import PRODUCT, NOW


class AlertTests(unittest.TestCase):
    def setUp(self):
        self.product = {**PRODUCT, "target_price": "100", "name": "Monitor"}
        self.database = Mock()
        self.database.last_failure_notification.return_value = None
        self.notify = Mock(return_value=True)

    def process(self, price="100", *, accepted=True, allowed=True, product=None):
        reading = Extraction(price=Decimal(price), currency="PEN", confidence=1)
        result = ReviewValidation(reading, accepted, allowed)
        process_alerts(self.database, product or self.product, result, NOW, notify=self.notify)

    def test_price_and_percentage_targets_are_inclusive_without_rounding(self):
        percent = {**self.product, "target_type": "percent", "reference_price": "123.45", "target_percent": "20"}
        self.assertEqual(target_price(percent), Decimal("98.760"))
        for product in (self.product, percent):
            target = target_price(product)
            for delta, expected in (("-0.0001", "goal_reached"), ("0", "goal_reached"), ("0.0001", None)):
                with self.subTest(product=product, delta=delta):
                    self.assertEqual(goal_event(product, target + Decimal(delta)), expected)
        self.assertIsNone(goal_event({**percent, "target_percent": "100"}, Decimal("0.01")))

    def test_triggered_does_not_repeat_and_drop_is_inclusive(self):
        product = {**self.product, "alert_state": "triggered", "last_alert_price": "90"}
        for price, expected in (("90", None), ("85.5001", None), ("85.50", "dropped_further"), ("85.49", "dropped_further")):
            self.assertEqual(goal_event(product, Decimal(price)), expected)
        self.assertIsNone(goal_event({**product, "target_price": "84"}, Decimal("85.50")))

    def test_rearm_is_strictly_above_three_percent(self):
        product = {**self.product, "alert_state": "triggered", "last_alert_price": "90"}
        for price, expected in (("102.9999", None), ("103", None), ("103.0001", "rearm")):
            self.assertEqual(goal_event(product, Decimal(price)), expected)
        self.process("103.01", product=product)
        self.notify.assert_not_called()
        self.database.save_alert_state.assert_called_once_with(product, NOW, {"alert_state": "armed"})

    def test_complete_armed_triggered_rearmed_cycle(self):
        self.process()
        changes = self.database.save_alert_state.call_args.args[2]
        self.assertEqual(changes, {"alert_state": "triggered", "last_alert_price": "100", "last_alert_at": NOW.isoformat()})
        product = {**self.product, **changes}
        self.process("100", product=product)
        self.assertEqual(self.notify.call_count, 1)
        self.process("104", product=product)
        product = {**product, **self.database.save_alert_state.call_args.args[2]}
        self.process("100", product=product)
        self.assertEqual(self.notify.call_count, 2)

    def test_both_channels_failed_retry_without_changing_state(self):
        self.notify.return_value = False
        self.process()
        self.process()
        self.assertEqual(self.notify.call_count, 2)
        self.database.save_alert_state.assert_not_called()
        product = {**self.product, "alert_state": "triggered", "last_alert_price": "100"}
        self.process("95", product=product)
        self.database.save_alert_state.assert_not_called()
        self.notify.return_value = True
        self.process("95", product=product)
        self.assertEqual(self.database.save_alert_state.call_args.args[2]["last_alert_price"], "95")

    def test_rejected_and_unavailable_readings_never_send_goal(self):
        self.process("50", accepted=False, allowed=False)
        self.process("50", allowed=False)
        self.notify.assert_not_called()
        self.database.save_alert_state.assert_not_called()

    def test_failure_threshold_and_weekly_reminder_boundary(self):
        for count, age, expected in ((1, None, 0), (2, None, 1), (3, timedelta(days=7) - timedelta(microseconds=1), 0), (3, timedelta(days=7), 1), (4, timedelta(days=8), 1)):
            with self.subTest(count=count, age=age):
                self.notify.reset_mock()
                self.database.last_failure_notification.return_value = {"sent_at": (NOW-age).isoformat()} if age else None
                self.process(accepted=False, allowed=False, product={**self.product, "consecutive_failures": count})
                self.assertEqual(self.notify.call_count, expected)
                if expected:
                    self.assertEqual(self.notify.call_args.args[2], "extraction_failed")
        self.database.save_alert_state.assert_not_called()

    def test_review_sends_only_after_persistence_and_reports_confirmed_jump(self):
        events = []
        self.database.save_review.side_effect = lambda *args: events.append("saved")
        def alerts(*args, **kwargs):
            events.append("alerts")
            self.assertEqual(kwargs["suspicious_price"], Decimal("40"))
            process_alerts(*args, **kwargs, notify=self.notify)
        reading = Extraction(name="Monitor", price=Decimal("40"), currency="PEN", confidence=1)
        result = review_product(self.database, self.product, {}, read=Mock(return_value=reading), now=lambda: NOW, sleep=Mock(), alerts=alerts)
        self.assertTrue(result.accepted)
        self.assertEqual(events, ["saved", "alerts"])
        self.assertEqual([call.args[2] for call in self.notify.call_args_list], ["suspicious_change", "goal_reached"])
        self.database.save_review.side_effect = RuntimeError("DB down")
        blocked = Mock()
        with self.assertRaises(RuntimeError):
            review_product(self.database, self.product, {}, read=Mock(return_value=reading), now=lambda: NOW, sleep=Mock(), alerts=blocked)
        blocked.assert_not_called()


class AlertPersistenceTests(unittest.TestCase):
    def setUp(self):
        env = patch.dict("os.environ", {"SUPABASE_URL": "https://example.supabase.co", "SUPABASE_SERVICE_ROLE_KEY": "private-key"}, clear=True)
        env.start()
        self.addCleanup(env.stop)
        self.database = Database()

    def test_state_write_compares_saved_review_and_previous_alert(self):
        with patch.object(self.database, "request", return_value=[PRODUCT]) as request:
            self.database.save_alert_state(PRODUCT, NOW, {"alert_state": "triggered"})
        path = request.call_args.args[1]
        self.assertIn("last_checked_at=eq.2026-10-08T00%3A00%3A00%2B00%3A00", path)
        self.assertIn("alert_state=eq.armed", path)
        self.assertIn("last_alert_price=is.null", path)
        self.assertIn("last_alert_at=is.null", path)
        with patch.object(self.database, "request", return_value=[]):
            with self.assertRaises(RuntimeError):
                self.database.save_alert_state(PRODUCT, NOW, {"alert_state": "armed"})

    def test_failure_reminders_use_attempts_since_last_success(self):
        with patch.object(self.database, "request", return_value=[]) as request:
            self.assertIsNone(self.database.last_failure_notification({**PRODUCT, "last_success_at": NOW.isoformat()}))
        path = request.call_args.args[1]
        self.assertIn("type=eq.extraction_failed", path)
        self.assertIn("sent_at=gt.", path)
        self.assertIn("order=sent_at.desc&limit=1", path)
        self.assertNotIn("status=eq.sent", path)


if __name__ == "__main__":
    unittest.main()

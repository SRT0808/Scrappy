"""Aggregate delivery is isolated from product state and only consumes new claims."""

from unittest import TestCase
from unittest.mock import Mock, patch

from scrappy.baskets import process_baskets
from scrappy.notifications import deliver
from scrappy.run import execute_reviews
from test_run import NOW, PRODUCT, RUN_ID

EVENT = {"id": RUN_ID, "list_id": PRODUCT["list_id"], "name": "Tecnología",
         "budget": "100.10", "currency": "PEN", "total": "100.10"}


class BasketTests(TestCase):
    def test_exact_goal_delivery_and_repeated_run_only_consume_new_claim(self):
        database = Mock()
        database.claim_basket_events.side_effect = [[EVENT], []]
        notify = Mock(return_value=True)
        process_baskets(database, NOW, notify=notify)
        process_baskets(database, NOW, notify=notify)
        notify.assert_called_once()
        args, kwargs = notify.call_args
        self.assertIsNone(args[1])
        self.assertEqual(args[2], "basket_goal_reached")
        self.assertIn("S/ 100.10", args[3]["message"])
        self.assertEqual(kwargs["audit_context"]["basket_event_id"], RUN_ID)
        database.finish_basket_event.assert_called_once_with(RUN_ID, True)
        database.save_alert_state.assert_not_called()

    def test_failed_delivery_records_failure_without_reclaiming(self):
        database = Mock()
        database.claim_basket_events.return_value = [EVENT]
        with self.assertRaisesRegex(RuntimeError, "canasta"):
            process_baskets(database, NOW, notify=Mock(return_value=False))
        database.finish_basket_event.assert_called_once_with(RUN_ID, False)
        database.claim_basket_events.assert_called_once_with(None)

    def test_ambiguous_receipt_does_not_prevent_other_claimed_deliveries(self):
        database = Mock()
        database.claim_basket_events.return_value = [EVENT, {**EVENT, "id": PRODUCT["id"]}]
        notify = Mock(side_effect=[RuntimeError("ambiguous"), True])
        with self.assertRaises(RuntimeError):
            process_baskets(database, NOW, notify=notify)
        self.assertEqual(notify.call_count, 2)
        database.finish_basket_event.assert_called_once_with(PRODUCT["id"], True)

    def test_context_is_audited_but_never_sent_to_channels(self):
        database = Mock()
        channel = Mock()
        payload = {"title": "Canasta", "message": "Total"}
        self.assertTrue(deliver(database, None, "basket_goal_reached", payload, NOW,
                                channels={"ntfy": channel}, audit_context={"basket_event_id": RUN_ID}))
        channel.assert_called_once_with(payload)
        self.assertEqual(database.request.call_args.args[2]["payload"]["basket_event_id"], RUN_ID)

    def test_conversion_crossing_explains_provenance_and_savings(self):
        database = Mock()
        database.claim_basket_events.return_value = [{**EVENT, "savings": "20", "savings_percent": "16.65",
            "cause": "conversion", "exchange_rates": [{"from": "USD", "to": "PEN", "rate": "3.5",
                "date": "2026-10-11", "source": "BCRPData:PD04638PD"}]}]
        notify = Mock(return_value=True)
        process_baskets(database, NOW, notify=notify)
        message = notify.call_args.args[3]["message"]
        for value in ["Ahorro S/ 20.00", "16.65%", "USD/PEN: 3.5", "2026-10-11", "BCRPData", "cambio de conversión"]:
            self.assertIn(value, message)

    def test_finish_uses_atomic_receipt_rpc(self):
        from scrappy.persistence import Database
        database = object.__new__(Database)
        database.request = Mock(return_value=None)
        database.finish_basket_event(RUN_ID, True)
        database.request.assert_called_once_with("POST", "rpc/finish_basket_event", {"p_id": RUN_ID, "p_sent": True})

    def test_aggregate_runs_after_individual_reviews_without_obsolete_membership(self):
        database = Mock()
        database.claim_product_group_events.return_value = []
        database.request.side_effect = [[{"id": RUN_ID}], [], [], None]
        database.due_products.return_value = [{key: value for key, value in PRODUCT.items() if key != "list_id"}]
        order = []
        with patch("scrappy.run.review_product", side_effect=lambda *a, **k: order.append("individual") or Mock(accepted=True)), \
             patch("scrappy.run.refresh_exchange_rate", side_effect=lambda *a: order.append("fx")), \
             patch("scrappy.run.process_baskets", side_effect=lambda *a: order.append("basket")) as baskets, \
             patch("scrappy.run.process_product_groups"):
            self.assertEqual(execute_reviews(database, PRODUCT["id"], now=lambda: NOW)["checked"], 1)
        self.assertEqual(order, ["fx", "individual", "basket"])
        baskets.assert_called_once_with(database, NOW)

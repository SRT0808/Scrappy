"""Group delivery uses one durable claim and keeps receipts attributable."""
import unittest
from unittest.mock import Mock, patch
from datetime import datetime, timezone
from decimal import Decimal
from scrappy.groups import process_product_groups
from scrappy.alerts import process_alerts
from scrappy.validation import ReviewValidation
from scrappy.extract import Extraction

NOW = datetime(2026,10,22,tzinfo=timezone.utc)
EVENT = {"id":"00000000-0000-4000-8000-000000000001","group_id":"00000000-0000-4000-8000-000000000002","version":1,"kind":"goal_reached",
 "snapshot":{"name":"Limpiador","currency":"PEN","target":"41.94","price":"40","excluded":1,
 "offer":{"domain":"shop.pe","url":"https://shop.pe/item","checked_at":NOW.isoformat()}}}
class GroupTests(unittest.TestCase):
 def setUp(self):
  self.db=Mock();self.db.claim_product_group_events.return_value=[EVENT]
  self.patch=patch.dict('os.environ',{"PURCHASE_APP_ORIGIN":"https://scrappy.example"});self.patch.start();self.addCleanup(self.patch.stop)
 def test_delivery_has_deep_link_and_original_offer_without_replay(self):
  notify=Mock(return_value=True);process_product_groups(self.db,NOW,notify=notify)
  payload=notify.call_args.args[3]
  self.assertIn('group_event=',payload['click']);self.assertIn('S/ 40.00',payload['message']);self.assertIn('excluidas: 1',payload['message'])
  self.db.finish_product_group_event.assert_called_once_with(EVENT['id'],True)
  self.assertEqual(notify.call_args.kwargs['audit_context']['group_version'],1)
 def test_failed_and_ambiguous_delivery_do_not_retry(self):
  for outcome in (False,RuntimeError('lost receipt')):
   with self.subTest(outcome=outcome):
    notify=Mock(side_effect=outcome) if isinstance(outcome,Exception) else Mock(return_value=outcome)
    with self.assertRaises(RuntimeError):process_product_groups(self.db,NOW,notify=notify)
    self.assertEqual(notify.call_count,1)
 def test_grouped_offer_suppresses_only_goal_delivery(self):
  self.db.has_product_group.return_value=True;notify=Mock()
  result=ReviewValidation(Extraction(price=Decimal('40'),currency='PEN',confidence=1),True,True)
  process_alerts(self.db,{'id':EVENT['id']},result,NOW,notify=notify)
  notify.assert_not_called();self.db.save_alert_state.assert_not_called()
 def test_bad_origin_prevents_claim(self):
  with patch.dict('os.environ',{'PURCHASE_APP_ORIGIN':'http://evil.test'}):
   with self.assertRaises(ValueError):process_product_groups(self.db,NOW)
  self.db.claim_product_group_events.assert_not_called()
 def test_membership_winning_the_delivery_race_suppresses_notice(self):
  self.db.has_product_group.return_value=False
  self.db.begin_product_goal_delivery.return_value=None
  notify=Mock()
  result=ReviewValidation(Extraction(price=Decimal('40'),currency='PEN',confidence=1),True,True)
  product={'id':EVENT['id'],'target_type':'price','target_price':'50','alert_state':'armed'}
  process_alerts(self.db,product,result,NOW,notify=notify)
  notify.assert_not_called();self.db.save_alert_state.assert_not_called()
 def test_failed_individual_send_releases_reservation_without_advancing_state(self):
  self.db.has_product_group.return_value=False
  self.db.begin_product_goal_delivery.return_value='token'
  result=ReviewValidation(Extraction(price=Decimal('40'),currency='PEN',confidence=1),True,True)
  product={'id':EVENT['id'],'target_type':'price','target_price':'50','alert_state':'armed','url':'https://shop.pe/item','domain':'shop.pe','currency':'PEN'}
  process_alerts(self.db,product,result,NOW,notify=Mock(return_value=False))
  self.db.save_alert_state.assert_not_called()
  self.db.finish_product_goal_delivery.assert_called_once_with(EVENT['id'],'token')

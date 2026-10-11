"""Provider parsing and persistence without remote services or synthetic fallback."""

from datetime import date, datetime, timezone
from decimal import Decimal
import json
from pathlib import Path
from unittest import TestCase
from unittest.mock import Mock, patch

from scrappy.exchange_rates import fetch_rate, latest_rate, refresh_exchange_rate, SOURCE, URL
from scrappy.persistence import Database

# Published BCRPData PD04638PD observations, copied from URL on 2026-10-11.
PAYLOAD = json.loads((Path(__file__).parent / "fixtures/bcrp_daily.json").read_text(encoding="utf-8"))
NOW = datetime(2026, 10, 11, tzinfo=timezone.utc)


class ExchangeRateTests(TestCase):
    def test_actual_response_preserves_decimal_date_and_source(self):
        rate = latest_rate(PAYLOAD, date(2026, 10, 11))
        self.assertEqual(Decimal(rate["rate"]), Decimal("3.44978571428571"))
        self.assertEqual(rate["rate_date"], "2026-10-07")
        self.assertEqual(rate["source"], SOURCE)
        self.assertEqual((rate["from_currency"], rate["to_currency"]), ("USD", "PEN"))

    def test_missing_future_invalid_and_nonfinite_periods_are_never_filled(self):
        for value in ("n.d.", "", "0", "-1", "NaN", "Infinity", "1000"):
            with self.subTest(value=value):
                payload = {"periods": [*reversed(PAYLOAD["periods"]),
                    {"name": "08.Oct.26", "values": [value]},
                    {"name": "12.Oct.26", "values": ["3.7"]},
                    {"name": "31.Feb.26", "values": ["3.7"]}]}
                self.assertEqual(latest_rate(payload, date(2026, 10, 11))["rate_date"], "2026-10-07")
        for payload in ({}, None, {"periods": []}, {"periods": [{"name": "07.Oct.26", "values": ["n.d."]}]}):
            with self.assertRaises(ValueError):
                latest_rate(payload, date(2026, 10, 11))

    def test_spanish_months_and_unsorted_periods(self):
        payload = {"periods": [{"name": "01.Set.26", "values": ["3.36585714285714"]},
                               {"name": "03.Ago.26", "values": ["3.39585714285714"]}]}
        self.assertEqual(latest_rate(payload, date(2026, 10, 11))["rate_date"], "2026-09-01")

    def test_fetch_uses_fixed_official_url_timeout_and_bounded_response(self):
        response = Mock()
        response.read.return_value = json.dumps(PAYLOAD).encode()
        with patch("scrappy.exchange_rates.urlopen") as open_url:
            open_url.return_value.__enter__.return_value = response
            self.assertEqual(fetch_rate(date(2026, 10, 11))["rate_date"], "2026-10-07")
        self.assertEqual(open_url.call_args.args[0].full_url, URL)
        self.assertEqual(open_url.call_args.kwargs["timeout"], 15)
        response.read.assert_called_once_with(2_000_000)

    def test_provider_failure_keeps_cache_and_lima_calendar_date(self):
        database = Mock()
        fetch = Mock(side_effect=TimeoutError())
        self.assertFalse(refresh_exchange_rate(database, NOW, fetch=fetch))
        fetch.assert_called_once_with(date(2026, 10, 10))
        database.save_exchange_rate.assert_not_called()
        self.assertFalse(refresh_exchange_rate(database, NOW, fetch=Mock(side_effect=ValueError())))

    def test_refresh_writes_exact_observation_and_db_failures_are_visible(self):
        database = Mock()
        rate = latest_rate(PAYLOAD, date(2026, 10, 11))
        self.assertTrue(refresh_exchange_rate(database, NOW, fetch=Mock(return_value=rate)))
        database.save_exchange_rate.assert_called_once_with({**rate, "fetched_at": NOW.isoformat()})
        database.save_exchange_rate.side_effect = RuntimeError("DB failure")
        with self.assertRaises(RuntimeError):
            refresh_exchange_rate(database, NOW, fetch=Mock(return_value=rate))

    def test_database_transport_is_server_rpc(self):
        database = object.__new__(Database)
        database.request = Mock()
        rate = latest_rate(PAYLOAD, date(2026, 10, 11))
        database.save_exchange_rate(rate)
        database.request.assert_called_once_with("POST", "rpc/cache_exchange_rate", {"p_rate": rate})

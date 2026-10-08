"""Tests for the phase-zero Supabase connection."""

from contextlib import redirect_stderr
import io
import json
import unittest
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError, URLError

from scrappy.run import main, record_empty_run


class EmptyRunTests(unittest.TestCase):
    def setUp(self) -> None:
        self.env = patch.dict(
            "os.environ",
            {"SUPABASE_URL": "https://example.supabase.co/", "SUPABASE_SERVICE_ROLE_KEY": "private-key"},
            clear=True,
        )
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_records_zero_checks_and_event_trigger(self) -> None:
        for event, trigger in (("schedule", "cron"), ("workflow_dispatch", "dispatch"), ("", "local")):
            with self.subTest(event=event), patch.dict("os.environ", {"GITHUB_EVENT_NAME": event}), patch(
                "scrappy.run.urlopen", return_value=MagicMock()
            ) as open_url:
                record_empty_run()
                request = open_url.call_args.args[0]
                payload = json.loads(request.data)
                self.assertEqual(request.full_url, "https://example.supabase.co/rest/v1/runs")
                self.assertEqual(request.method, "POST")
                self.assertEqual(request.get_header("Apikey"), "private-key")
                self.assertEqual(request.get_header("Authorization"), "Bearer private-key")
                self.assertEqual(open_url.call_args.kwargs["timeout"], 15)
                self.assertEqual(payload["trigger"], trigger)
                self.assertEqual((payload["checked"], payload["ok_count"], payload["fail_count"]), (0, 0, 0))
                self.assertGreaterEqual(payload["finished_at"], payload["started_at"])

    def test_missing_credentials_do_not_send_a_request(self) -> None:
        for name in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"):
            with self.subTest(name=name), patch.dict("os.environ", {name: ""}), patch("scrappy.run.urlopen") as open_url:
                with self.assertRaisesRegex(ValueError, "Faltan"):
                    record_empty_run()
                open_url.assert_not_called()

    def test_invalid_url_does_not_send_credentials(self) -> None:
        for url in ("http://example.supabase.co", "https://user@example.supabase.co", "https://example.supabase.co/rest", "https://example.supabase.co?key=private-key"):
            with self.subTest(url=url), patch.dict("os.environ", {"SUPABASE_URL": url}), patch("scrappy.run.urlopen") as open_url:
                with self.assertRaises(ValueError):
                    record_empty_run()
                open_url.assert_not_called()

    def test_http_error_omits_response_body_and_credentials(self) -> None:
        error = HTTPError("https://example.supabase.co/rest/v1/runs", 401, "private-key", {}, io.BytesIO(b"private-key"))
        with patch("scrappy.run.urlopen", side_effect=error):
            with self.assertRaisesRegex(RuntimeError, "HTTP 401") as caught:
                record_empty_run()
            self.assertNotIn("private-key", str(caught.exception))

    def test_network_failure_is_reported_without_secrets(self) -> None:
        for error in (URLError("private-key"), TimeoutError("private-key")):
            with self.subTest(error=type(error).__name__), patch("scrappy.run.urlopen", side_effect=error):
                with self.assertRaisesRegex(RuntimeError, "No se pudo conectar") as caught:
                    record_empty_run()
                self.assertNotIn("private-key", str(caught.exception))

    def test_cli_failure_exits_nonzero(self) -> None:
        stderr = io.StringIO()
        with patch("sys.argv", ["scrappy.run"]), patch("scrappy.run.record_empty_run", side_effect=RuntimeError("Sin conexión")), redirect_stderr(stderr):
            with self.assertRaises(SystemExit) as caught:
                main()
        self.assertEqual(caught.exception.code, 1)
        self.assertIn("Sin conexión", stderr.getvalue())

    def test_product_mode_requires_id_before_database_access(self) -> None:
        with patch("sys.argv", ["scrappy.run", "--mode", "product"]), patch("scrappy.run.record_empty_run") as record, redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as caught:
                main()
        self.assertEqual(caught.exception.code, 2)
        record.assert_not_called()


if __name__ == "__main__":
    unittest.main()

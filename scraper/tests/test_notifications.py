"""Mocked transports: independent channels, receipts, redaction and MIME."""

import json
import unittest
from unittest.mock import Mock, patch

from scrappy.notifications import deliver, send_email, send_ntfy, test_notification as send_test
from test_run import PRODUCT, NOW

PAYLOAD = {"title": "🔥 Monitor", "message": "Ahora S/ 90 · tu meta S/ 100", "priority": 4, "tags": ["moneybag"], "click": PRODUCT["url"]}


class NotificationTests(unittest.TestCase):
    def test_each_channel_is_attempted_and_recorded_independently(self):
        for failed in ((), ("ntfy",), ("email",), ("ntfy", "email")):
            with self.subTest(failed=failed):
                database = Mock()
                channels = {name: Mock(side_effect=RuntimeError("private-secret") if name in failed else None) for name in ("ntfy", "email")}
                self.assertEqual(deliver(database, PRODUCT["id"], "goal_reached", PAYLOAD, NOW, channels=channels), len(failed) < 2)
                for name, sender in channels.items():
                    sender.assert_called_once_with(PAYLOAD)
                rows = [call.args[2] for call in database.request.call_args_list]
                self.assertEqual([row["channel"] for row in rows], ["ntfy", "email"])
                self.assertEqual([row["status"] for row in rows], ["failed" if name in failed else "sent" for name in channels])
                self.assertNotIn("private-secret", str(rows))

    def test_audit_failure_still_attempts_other_channel_and_fails_run(self):
        database = Mock()
        database.request.side_effect = [RuntimeError("private-secret"), []]
        channels = {"ntfy": Mock(), "email": Mock()}
        with self.assertRaisesRegex(RuntimeError, "registrar"):
            deliver(database, PRODUCT["id"], "goal_reached", PAYLOAD, NOW, channels=channels)
        channels["email"].assert_called_once()
        self.assertEqual(database.request.call_count, 2)

    def test_ntfy_json_root_utf8_and_confirmation(self):
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock()
        response.read.return_value = b'{"id":"receipt", "event":"message"}'
        with patch.dict("os.environ", {"NTFY_TOPIC": "a" * 24}), patch("scrappy.notifications.urlopen", return_value=response) as open_url:
            send_ntfy(PAYLOAD)
            request = open_url.call_args.args[0]
            self.assertEqual(request.full_url, "https://ntfy.sh/")
            self.assertEqual(request.method, "POST")
            self.assertEqual(json.loads(request.data), {"topic": "a" * 24, **PAYLOAD})
            self.assertIn("🔥".encode(), request.data)
            self.assertEqual(open_url.call_args.kwargs["timeout"], 15)
            response.read.return_value = b'{}'
            with self.assertRaises(RuntimeError):
                send_ntfy(PAYLOAD)

    def test_invalid_topics_do_not_publish(self):
        for topic in ("", "a" * 23, "secret/topic" + "a" * 24):
            with self.subTest(topic=topic), patch.dict("os.environ", {"NTFY_TOPIC": topic}), patch("scrappy.notifications.urlopen") as open_url:
                with self.assertRaises(ValueError):
                    send_ntfy(PAYLOAD)
                open_url.assert_not_called()

    def test_gmail_ssl_multipart_and_html_escaping(self):
        smtp = Mock()
        smtp.__enter__ = Mock(return_value=smtp)
        smtp.__exit__ = Mock(return_value=False)
        smtp.send_message.return_value = {}
        env = {"GMAIL_USER": "owner@gmail.com", "GMAIL_APP_PASSWORD": "private-secret", "NOTIFY_EMAIL_TO": "owner@gmail.com"}
        with patch.dict("os.environ", env), patch("scrappy.notifications.smtplib.SMTP_SSL", return_value=smtp) as connect:
            send_email({**PAYLOAD, "message": "<Monitor> & oferta"})
            self.assertEqual(connect.call_args.args, ("smtp.gmail.com", 465))
            smtp.login.assert_called_once_with(env["GMAIL_USER"], env["GMAIL_APP_PASSWORD"])
            message = smtp.send_message.call_args.args[0]
            self.assertIn("<Monitor>", message.get_body(preferencelist=("plain",)).get_content())
            self.assertIn("&lt;Monitor&gt; &amp; oferta", message.get_body(preferencelist=("html",)).get_content())
            self.assertIn(PRODUCT["url"], message.as_string())
            self.assertNotIn("private-secret", message.as_string())
            smtp.send_message.return_value = {"owner@gmail.com": (550, b"rejected")}
            with self.assertRaises(RuntimeError):
                send_email(PAYLOAD)

    def test_missing_email_settings_are_logged_as_failure(self):
        with patch.dict("os.environ", {}, clear=True), patch("scrappy.notifications.smtplib.SMTP_SSL") as connect:
            with self.assertRaises(ValueError):
                send_email(PAYLOAD)
            connect.assert_not_called()

    def test_test_notification_has_null_product_and_fails_if_both_fail(self):
        database = Mock()
        channels = {"ntfy": Mock(side_effect=TimeoutError()), "email": Mock(side_effect=TimeoutError())}
        with self.assertRaises(RuntimeError):
            send_test(database, NOW, channels=channels)
        for call in database.request.call_args_list:
            self.assertIsNone(call.args[2]["product_id"])
            self.assertEqual(call.args[2]["type"], "test")


if __name__ == "__main__":
    unittest.main()

"""SSRF protection with mocked DNS/connectors and localhost-only proxy fixtures."""

from contextlib import contextmanager
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import socket
from threading import Thread
import unittest
from unittest.mock import patch

from scrappy.network import open_public, public_destination, public_proxy
from scrappy.probe import fetch


def address(ip, port=80):
    return (socket.AF_INET6 if ":" in ip else socket.AF_INET, socket.SOCK_STREAM, 6, "",
            (ip, port, 0, 0) if ":" in ip else (ip, port))


class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        self.server.requests.append((self.path, dict(self.headers)))
        body = b"public fixture"
        self.send_response(302 if self.path == "/redirect" else 200)
        if self.path == "/redirect":
            self.send_header("Location", "http://127.0.0.1/private")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


@contextmanager
def fixture():
    with ThreadingHTTPServer(("127.0.0.1", 0), Fixture) as server:
        server.requests = []
        worker = Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        worker.start()
        try:
            yield server
        finally:
            server.shutdown()
            worker.join()


class NetworkTests(unittest.TestCase):
    def test_rejects_private_mixed_dns_and_non_http_destinations_before_connect(self):
        for ip in ("127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1", "::1", "fc00::1", "::ffff:127.0.0.1"):
            with self.subTest(ip=ip), patch("scrappy.network.socket.getaddrinfo", return_value=[address("8.8.8.8"), address(ip)]), patch("scrappy.network.socket.socket") as connection:
                with self.assertRaises(ValueError):
                    open_public("https://shop.example/product", 1)
                connection.assert_not_called()
        for url in ("file:///private", "https://user:pass@shop.example", "http://shop.example:8080"):
            with self.subTest(url=url), patch("scrappy.network.socket.socket") as connection:
                with self.assertRaises(ValueError):
                    open_public(url, 1)
                connection.assert_not_called()

    def test_uses_validated_numeric_ip_without_second_hostname_resolution(self):
        with patch("scrappy.network.socket.getaddrinfo", return_value=[address("8.8.8.8", 443)]) as dns, patch("scrappy.network.socket.socket") as factory:
            _, connection = open_public("https://shop.example/product", 2)
            dns.assert_called_once_with("shop.example", 443, type=socket.SOCK_STREAM)
            connection.connect.assert_called_once_with(("8.8.8.8", 443))
            self.assertEqual(connection, factory.return_value)

    def test_empty_dns_and_failed_connections_fail_closed(self):
        with patch("scrappy.network.socket.getaddrinfo", return_value=[]):
            with self.assertRaises(ValueError):
                open_public("https://shop.example", 1)
        with patch("scrappy.network.socket.getaddrinfo", return_value=[address("8.8.8.8")]), patch("scrappy.network.socket.socket") as factory:
            factory.return_value.connect.side_effect = OSError("private error detail")
            with self.assertRaisesRegex(OSError, "tienda pública"):
                open_public("http://shop.example", 1)
            factory.return_value.close.assert_called_once()

    def test_http_proxy_redirects_and_connect_tunnels_reject_private_destinations(self):
        with fixture() as upstream, public_proxy(2) as proxy:
            def dns(host, port, **_):
                return [address("8.8.8.8" if host == "shop.example" else "127.0.0.1", port)]

            def connect(url, timeout):
                # Only validated public requests reach this localhost fixture.
                with patch("scrappy.network.socket.getaddrinfo", side_effect=dns):
                    parsed, _, _ = public_destination(url)
                return parsed, socket.create_connection(upstream.server_address, timeout)

            from urllib.parse import urlsplit
            proxy_url = urlsplit(proxy)
            with patch("scrappy.network.open_public", side_effect=connect):
                for target, status in (("http://shop.example/redirect", 302), ("http://127.0.0.1/private", 403), ("http://internal.example/private", 403)):
                    client = HTTPConnection(proxy_url.hostname, proxy_url.port, timeout=3)
                    client.request("GET", target, headers={"Proxy-Authorization": "private-proxy-key"})
                    response = client.getresponse()
                    self.assertEqual(response.status, status)
                    self.assertNotIn(b"private-proxy-key", response.read())
                    client.close()
                for host, expected in (("shop.example", 200), ("127.0.0.1", 403), ("internal.example", 403)):
                    client = HTTPConnection(proxy_url.hostname, proxy_url.port, timeout=3)
                    client.set_tunnel(host, 443)
                    if expected == 403:
                        with self.assertRaisesRegex(OSError, "403"):
                            client.request("GET", "/tunnel")
                    else:
                        client.request("GET", "/tunnel")
                        response = client.getresponse()
                        self.assertEqual(response.status, 200)
                        self.assertEqual(response.read(), b"public fixture")
                    client.close()
            self.assertEqual(len(upstream.requests), 2)
            self.assertNotIn("Proxy-Authorization", upstream.requests[0][1])

    def test_all_fetch_modes_validate_initial_url_and_browsers_use_proxy_without_bypass(self):
        for mode in ("http", "dynamic", "stealth"):
            with self.subTest(mode=mode), patch("scrappy.probe.public_url", side_effect=ValueError("private")), patch("scrappy.probe.Fetcher.get") as http, patch("scrappy.probe.DynamicFetcher.fetch") as dynamic, patch("scrappy.probe.StealthyFetcher.fetch") as stealth:
                with self.assertRaises(ValueError):
                    fetch("http://127.0.0.1", mode, 1)
                for transport in (http, dynamic, stealth):
                    transport.assert_not_called()
        for mode, name in (("dynamic", "DynamicFetcher"), ("stealth", "StealthyFetcher")):
            with self.subTest(mode=mode), patch("scrappy.probe.public_url"), patch(f"scrappy.probe.{name}.fetch") as browser:
                fetch("https://shop.example", mode, 1)
                options = browser.call_args.kwargs
                self.assertTrue(options["proxy"].startswith("http://127.0.0.1:"))
                self.assertIn("--proxy-bypass-list=<-loopback>", options["extra_flags"])
                self.assertIn("--force-webrtc-ip-handling-policy=disable_non_proxied_udp", options["extra_flags"])
                # Validate the pinned library's launch options without starting a browser.
                from scrapling.engines._browsers._controllers import DynamicSession
                from scrapling.engines._browsers._stealth import StealthySession
                session = (DynamicSession if mode == "dynamic" else StealthySession)(**options)
                self.assertEqual(session._context_options["proxy"]["server"], options["proxy"])
                self.assertIn("--proxy-bypass-list=<-loopback>", session._browser_options["args"])


if __name__ == "__main__":
    unittest.main()

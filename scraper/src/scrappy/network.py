"""Public destinations only; browser proxy connects to the validated numeric IP."""

from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from ipaddress import ip_address
from select import select
import socket
from threading import Thread
from urllib.parse import urlsplit


def public_destination(url):
    parsed = urlsplit(url)
    if (parsed.scheme not in ("https", "http") or not parsed.hostname
            or parsed.username or parsed.password or parsed.port not in (None, 80, 443)):
        raise ValueError("La URL debe ser HTTP(S) pública y sin credenciales.")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    addresses = socket.getaddrinfo(parsed.hostname, port, type=socket.SOCK_STREAM)
    if not addresses or any(not ip_address(item[4][0]).is_global for item in addresses):
        raise ValueError("La tienda debe tener una dirección pública.")
    return parsed, port, addresses


def public_url(url):
    public_destination(url)


def open_public(url, timeout):
    parsed, port, addresses = public_destination(url)
    # Never resolve the hostname again between validation and connection.
    for family, kind, protocol, _, address in addresses:
        connection = socket.socket(family, kind, protocol)
        try:
            connection.settimeout(timeout)
            connection.connect(address)
            return parsed, connection
        except OSError:
            connection.close()
    raise OSError("No se pudo conectar con la tienda pública.")


def relay(client, upstream, timeout):
    while True:
        readable, _, _ = select([client, upstream], [], [], timeout)
        if not readable:
            return
        for source in readable:
            data = source.recv(65536)
            if not data:
                return
            (upstream if source is client else client).sendall(data)


class PublicProxy(BaseHTTPRequestHandler):
    rbufsize = 0

    def log_message(self, *_):
        pass

    def handle(self):
        self.connection.settimeout(self.server.network_timeout)
        super().handle()

    def forward(self):
        upstream = None
        established = False
        try:
            tunnel = self.command == "CONNECT"
            url = f"https://{self.path}" if tunnel else self.path
            parsed, upstream = open_public(url, self.server.network_timeout)
            if tunnel:
                self.send_response(200, "Connection established")
                self.end_headers()
            else:
                if parsed.scheme != "http":
                    raise ValueError("HTTPS requires CONNECT")
                path = parsed.path or "/"
                if parsed.query:
                    path += "?" + parsed.query
                # One upstream connection per request; no proxy credentials leave localhost.
                ignored = {"host", "connection", "proxy-connection", "proxy-authorization"}
                headers = "".join(f"{key}: {value}\r\n" for key, value in self.headers.items() if key.lower() not in ignored)
                upstream.sendall((f"{self.command} {path} HTTP/1.1\r\nHost: {parsed.netloc}\r\n"
                                  + headers + "Connection: close\r\n\r\n").encode("latin-1"))
            established = True
            relay(self.connection, upstream, self.server.network_timeout)
        except (ValueError, OSError):
            if not established:
                self.send_error(403, "Public destination required")
        finally:
            if upstream is not None:
                upstream.close()
            self.close_connection = True

    do_CONNECT = do_GET = do_HEAD = do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = forward


@contextmanager
def public_proxy(timeout):
    with ThreadingHTTPServer(("127.0.0.1", 0), PublicProxy) as server:
        server.daemon_threads = True
        server.network_timeout = timeout
        worker = Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        worker.start()
        try:
            yield f"http://127.0.0.1:{server.server_port}"
        finally:
            server.shutdown()
            worker.join()

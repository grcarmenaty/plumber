"""
Tests of plumber-gui's HTTP server: static files, the protections, and the proxy to Plumber.

A stub Plumber records what it receives and answers as each test tells it to.
Run with:
    PYTHONPATH=src python -m pytest tests/plumbergui/test_server.py
"""

import hashlib
import http.client
import json
import logging
import socket
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from plumbergui import main as gui_main


# Stub Plumber -----------------------------------------------------------------
class Stub:
    def __init__(self) -> None:
        self.seen: list[dict] = []
        self.reply = (200, {"Content-Type": "application/json"}, b'{"ok":true}')
        self.delay = 0.0
        self.truncate = False  # Announce a Content-Length but close after a few bytes
        self.hangup = False  # Read the request, then close without answering


def _stub_handler(stub: Stub):
    class StubHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):
            return

        def _any(self):
            length = int(self.headers.get("Content-Length", "0") or "0")
            body = self.rfile.read(length) if length else b""
            stub.seen.append({"method": self.command, "path": self.path, "headers": dict(self.headers), "body": body})
            if stub.delay:
                time.sleep(stub.delay)
            if stub.hangup:
                self.close_connection = True
                return
            status, headers, payload = stub.reply
            self.send_response(status)
            for name, value in headers.items():
                self.send_header(name, value)
            if stub.truncate:
                self.send_header("Content-Length", str(len(payload) + 1000))
                self.end_headers()
                self.wfile.write(payload)
                self.wfile.flush()
                self.close_connection = True
                return
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        do_GET = do_POST = do_PUT = do_DELETE = _any

    return StubHandler


@pytest.fixture
def stub(monkeypatch):
    state = Stub()
    server = ThreadingHTTPServer(("127.0.0.1", 0), _stub_handler(state))
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
    thread.start()
    monkeypatch.setattr(gui_main, "PLUMBER_URL", f"http://127.0.0.1:{server.server_port}")
    yield state
    server.shutdown()
    server.server_close()


@pytest.fixture
def gui(stub):
    server = ThreadingHTTPServer(("127.0.0.1", 0), gui_main.Handler)
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
    thread.start()
    yield server.server_port
    server.shutdown()
    server.server_close()


# Helpers ----------------------------------------------------------------------
def request(port, method, path, *, host="127.0.0.1", headers=None, body=None, api=True):
    """
    One request through http.client with an explicit Host. Returns (status, headers, body).
    """

    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    conn.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
    if host is not None:
        conn.putheader("Host", host)
    sent = {"X-Plumber-GUI": "1"} if api else {}
    sent.update(headers or {})
    for name, value in sent.items():
        conn.putheader(name, value)
    if body is not None:
        conn.putheader("Content-Length", str(len(body)))
    conn.endheaders(body)
    response = conn.getresponse()
    data = response.read()
    conn.close()
    return response.status, response.headers, data


def raw(port, data: bytes, timeout: float = 5) -> bytes:
    """
    Send raw bytes and read until the server closes the connection or the timeout passes
    """

    with socket.create_connection(("127.0.0.1", port), timeout=timeout) as sock:
        sock.sendall(data)
        chunks = []
        try:
            while True:
                chunk = sock.recv(65536)
                if not chunk:
                    break
                chunks.append(chunk)
        except socket.timeout:
            chunks.append(b"<timeout>")
        return b"".join(chunks)


def detail(body: bytes) -> dict:
    return json.loads(body)


# Static files -----------------------------------------------------------------
def test_page_and_security_headers(gui):
    status, headers, body = request(gui, "GET", "/", api=False)
    assert status == 200
    assert headers["Content-Type"] == "text/html; charset=utf-8"
    assert b"<html" in body
    assert "script-src 'self'" in headers["Content-Security-Policy"]
    assert "frame-ancestors 'none'" in headers["Content-Security-Policy"]
    assert "require-trusted-types-for 'script'" in headers["Content-Security-Policy"]
    assert headers["X-Content-Type-Options"] == "nosniff"
    assert headers["X-Frame-Options"] == "DENY"
    assert headers["Referrer-Policy"] == "no-referrer"
    assert headers["Cache-Control"] == "no-cache"


def test_static_files_and_types(gui):
    for path, content_type in (("/app.js", "text/javascript; charset=utf-8"), ("/app.css", "text/css; charset=utf-8")):
        status, headers, _ = request(gui, "GET", path, api=False)
        assert status == 200
        assert headers["Content-Type"] == content_type


@pytest.mark.parametrize("path", ["/main.py", "/static/app.js", "/../main.py", "/%2e%2e/main.py", "/docs", "/openapi.json", "/station/list"])
def test_unknown_paths_are_404(gui, stub, path):
    status, headers, body = request(gui, "GET", path, api=False)
    assert status == 404
    assert detail(body)["source"] == "plumber-gui"
    assert "Content-Security-Policy" in headers
    assert stub.seen == []


def test_static_file_only_for_get(gui):
    status, _, _ = request(gui, "POST", "/app.js", api=False, body=b"")
    assert status == 404


# Host check -------------------------------------------------------------------
@pytest.mark.parametrize("host", ["localhost:8510", "localhost", "127.0.0.1", "127.0.0.1:510", "[::1]:1", "10.1.2.3", "plumber.localhost:510"])
def test_allowed_hosts(gui, host):
    status, _, _ = request(gui, "GET", "/", host=host, api=False)
    assert status == 200


@pytest.mark.parametrize("host", ["evil.example", "127.0.0.1.evil.com", "0x7f000001", "127.0.0.1@evil.com", "localhost.evil.com", "evil.localhost.example", ""])
def test_refused_hosts(gui, stub, host):
    status, _, body = request(gui, "GET", "/api/station/list", host=host)
    assert status == 403
    assert "Host not allowed" in detail(body)["detail"]
    assert stub.seen == []


def test_missing_host_is_refused(gui):
    reply = raw(gui, b"GET / HTTP/1.0\r\n\r\n")
    assert reply.startswith(b"HTTP/1.1 403")


# Header check -----------------------------------------------------------------
@pytest.mark.parametrize("method", ["GET", "POST", "PUT", "DELETE"])
def test_api_needs_the_header(gui, stub, method):
    status, _, body = request(gui, method, "/api/station/list", api=False, body=b"" if method in ("POST", "PUT") else None)
    assert status == 403
    assert detail(body) == {"detail": "Missing the X-Plumber-GUI header", "source": "plumber-gui"}
    assert stub.seen == []


def test_gui_endpoints_need_the_header(gui):
    status, _, _ = request(gui, "GET", "/gui/schedule/list", api=False)
    assert status == 403


def test_preflight_is_refused(gui):
    reply = raw(gui, b"OPTIONS /api/station/list HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://evil.example\r\n"
                     b"Access-Control-Request-Method: POST\r\nAccess-Control-Request-Headers: x-plumber-gui\r\n\r\n")
    assert reply.startswith(b"HTTP/1.1 501")
    assert b"access-control" not in reply.lower()
    assert b"Content-Security-Policy" in reply


def test_head_is_not_supported(gui):
    assert raw(gui, b"HEAD / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").startswith(b"HTTP/1.1 501")


def test_absolute_target_is_refused(gui, stub):
    reply = raw(gui, b"GET http://127.0.0.1:509/station/list HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Plumber-GUI: 1\r\n\r\n")
    assert reply.startswith(b"HTTP/1.1 400")
    assert stub.seen == []


# Proxy ------------------------------------------------------------------------
def test_get_is_forwarded_without_the_prefix(gui, stub):
    stub.reply = (200, {"Content-Type": "application/json"}, b'[{"name":"lab"}]')
    status, headers, body = request(gui, "GET", "/api/run/pipeline/demo/chatty?station=a%2Bb%26c")
    assert status == 200
    assert body == b'[{"name":"lab"}]'
    assert headers["Cache-Control"] == "no-store"
    seen = stub.seen[0]
    assert seen["method"] == "GET"
    assert seen["path"] == "/run/pipeline/demo/chatty?station=a%2Bb%26c"
    assert seen["body"] == b""


def test_post_body_and_content_type_are_forwarded(gui, stub):
    payload = b"--b\r\nContent-Disposition: form-data; name=\"file\"; filename=\"p.zip\"\r\n\r\nPK\x03\x04\r\n--b--\r\n"
    status, _, _ = request(gui, "POST", "/api/project/register", body=payload, headers={
        "Content-Type": "multipart/form-data; boundary=b",
        "Cookie": "session=secret",
        "Authorization": "Bearer secret",
    })
    assert status == 200
    seen = stub.seen[0]
    assert seen["body"] == payload
    assert seen["headers"]["Content-Type"] == "multipart/form-data; boundary=b"
    lowered = {name.lower() for name in seen["headers"]}
    assert "cookie" not in lowered
    assert "authorization" not in lowered
    assert "x-plumber-gui" not in lowered


def test_empty_post_and_bodiless_delete(gui, stub):
    assert request(gui, "POST", "/api/run/system/demo/nightly?station=lab", body=b"")[0] == 200
    assert stub.seen[0]["body"] == b""
    assert request(gui, "DELETE", "/api/run/pipeline/lab/demo/stream/3")[0] == 200
    assert stub.seen[1]["method"] == "DELETE"
    assert stub.seen[1]["body"] == b""


@pytest.mark.parametrize("status", [404, 409, 422, 500])
def test_plumber_errors_pass_through(gui, stub, status):
    stub.reply = (status, {"Content-Type": "application/json"}, b'{"detail":"Run 3 is not running"}')
    got, headers, body = request(gui, "DELETE", "/api/run/pipeline/lab/demo/stream/3")
    assert got == status
    assert body == b'{"detail":"Run 3 is not running"}'
    assert headers["Content-Type"] == "application/json"


def test_plain_text_passes_through(gui, stub):
    stub.reply = (200, {"Content-Type": "text/plain; charset=utf-8"}, "log línea\n".encode())
    status, headers, body = request(gui, "GET", "/api/logs/pipeline/lab/demo/chatty/1")
    assert status == 200
    assert headers["Content-Type"] == "text/plain; charset=utf-8"
    assert body == "log línea\n".encode()


def test_large_reply_is_streamed_intact(gui, stub):
    payload = bytes(range(256)) * (10 * 1024 * 1024 // 256 + 7)
    stub.reply = (200, {"Content-Type": "text/plain"}, payload)
    status, _, body = request(gui, "GET", "/api/logs/pipeline/lab/demo/flood/1")
    assert status == 200
    assert hashlib.sha256(body).hexdigest() == hashlib.sha256(payload).hexdigest()


def test_truncated_reply_closes_the_connection(gui, stub):
    stub.reply = (200, {"Content-Type": "text/plain"}, b"0123456789")
    stub.truncate = True
    reply = raw(gui, b"GET /api/logs/pipeline/lab/demo/chatty/1 HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Plumber-GUI: 1\r\n\r\n")
    assert reply.startswith(b"HTTP/1.1 200")
    assert b"Content-Length: 1010" in reply
    assert reply.endswith(b"0123456789")  # Closed, not left hanging (raw() would add <timeout>)


def test_plumber_down_is_502(gui, monkeypatch):
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        free = sock.getsockname()[1]
    monkeypatch.setattr(gui_main, "PLUMBER_URL", f"http://127.0.0.1:{free}")
    status, _, body = request(gui, "GET", "/api/station/list")
    assert status == 502
    assert detail(body)["source"] == "plumber-gui"
    assert "did not respond" in detail(body)["detail"]


def test_plumber_hanging_up_after_the_request_may_have_acted(gui, stub):
    stub.hangup = True
    status, _, body = request(gui, "POST", "/api/run/pipeline/demo/chatty?station=lab", body=b"")
    assert status == 502
    assert detail(body)["source"] == "plumber-gui"
    assert "may have acted on the request" in detail(body)["detail"]
    assert stub.seen[-1]["path"] == "/run/pipeline/demo/chatty?station=lab"  # Plumber had it


def test_slow_plumber_is_504(gui, stub, monkeypatch):
    monkeypatch.setattr(gui_main, "PROXY_TIMEOUT", 0.3)
    stub.delay = 1.0
    status, _, body = request(gui, "GET", "/api/registry/pipelines")
    assert status == 504
    assert detail(body)["source"] == "plumber-gui"


def test_proxy_settings_are_ignored(gui, stub, monkeypatch):
    # Station tokens and vault files must not go through a configured proxy on their way to Plumber
    for name in ("http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY"):
        monkeypatch.setenv(name, "http://127.0.0.1:9")
    for name in ("no_proxy", "NO_PROXY"):
        monkeypatch.delenv(name, raising=False)
    urllib.request.install_opener(None)  # A plain urlopen() would now read these settings afresh
    status, _, _ = request(gui, "GET", "/api/station/list")
    assert status == 200
    assert stub.seen[-1]["path"] == "/station/list"


# Request bodies ---------------------------------------------------------------
def test_chunked_body_is_refused(gui, stub):
    reply = raw(gui, b"POST /api/station/add HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Plumber-GUI: 1\r\n"
                     b"Transfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n")
    assert reply.startswith(b"HTTP/1.1 411")
    assert b"Connection: close" in reply
    assert stub.seen == []


@pytest.mark.parametrize("length", [b"abc", b"-1", b"+5"])
def test_bad_content_length_is_refused(gui, stub, length):
    reply = raw(gui, b"POST /api/station/add HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Plumber-GUI: 1\r\nContent-Length: " + length + b"\r\n\r\n{}")
    assert reply.startswith(b"HTTP/1.1 400")
    assert stub.seen == []


def test_duplicate_content_length_is_refused(gui, stub):
    reply = raw(gui, b"POST /api/station/add HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Plumber-GUI: 1\r\n"
                     b"Content-Length: 2\r\nContent-Length: 40\r\n\r\n{}")
    assert reply.startswith(b"HTTP/1.1 400")
    assert stub.seen == []


def test_oversize_body_is_refused(gui, stub, monkeypatch):
    monkeypatch.setattr(gui_main, "MAX_BODY", 10)
    status, _, _ = request(gui, "PUT", "/api/vault/catalog/lab", body=b"x" * 11)
    assert status == 413
    assert stub.seen == []


def test_connection_closes_after_a_body(gui, stub):
    # A short Content-Length followed by a smuggled second request: the rest must never be parsed
    smuggled = b"GET /api/station/remove/lab HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Plumber-GUI: 1\r\n\r\n"
    reply = raw(gui, b"POST /api/station/add HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Plumber-GUI: 1\r\n"
                     b"Content-Type: application/json\r\nContent-Length: 2\r\n\r\n{}" + smuggled)
    assert reply.count(b"HTTP/1.1 ") == 1
    assert b"Connection: close" in reply
    assert [seen["path"] for seen in stub.seen] == ["/station/add"]


def test_keep_alive_without_a_body(gui, stub):
    one = b"GET /api/station/list HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Plumber-GUI: 1\r\n\r\n"
    reply = raw(gui, one + one, timeout=1)
    assert reply.count(b"HTTP/1.1 200") == 2


# plumber-gui's own endpoints --------------------------------------------------
def test_gui_without_scheduler_is_404(gui, monkeypatch):
    monkeypatch.setattr(gui_main, "SCHEDULER", None)
    status, _, body = request(gui, "GET", "/gui/schedule/list")
    assert status == 404
    assert detail(body)["source"] == "plumber-gui"


def test_gui_dispatches_to_the_scheduler(gui, monkeypatch):
    calls = []

    class FakeScheduler:
        def handle(self, method, path, query, body):
            calls.append((method, path, query, body))
            return 409, {"detail": "Schedule 'x' already exists"}

    monkeypatch.setattr(gui_main, "SCHEDULER", FakeScheduler())
    status, headers, body = request(gui, "POST", "/gui/schedule/add?x=1", body=b'{"name":"x"}', headers={"Content-Type": "application/json"})
    assert status == 409
    assert headers["Cache-Control"] == "no-store"
    assert detail(body) == {"detail": "Schedule 'x' already exists"}
    assert calls == [("POST", "/schedule/add", "x=1", b'{"name":"x"}')]


def test_gui_body_limit(gui, monkeypatch):
    class FakeScheduler:
        def handle(self, method, path, query, body):
            return 200, {}

    monkeypatch.setattr(gui_main, "SCHEDULER", FakeScheduler())
    status, _, _ = request(gui, "POST", "/gui/schedule/add", body=b"x" * (gui_main.MAX_GUI_BODY + 1))
    assert status == 413


def test_handler_exception_is_500(gui, monkeypatch):
    class BrokenScheduler:
        def handle(self, method, path, query, body):
            raise RuntimeError("boom")

    monkeypatch.setattr(gui_main, "SCHEDULER", BrokenScheduler())
    status, _, body = request(gui, "GET", "/gui/schedule/list")
    assert status == 500
    assert detail(body) == {"detail": "plumber-gui failed; see its log", "source": "plumber-gui"}


def test_gui_dispatches_run_times_to_the_watch(gui, monkeypatch):
    class FakeWatch:
        def handle(self, method, path, query, body):
            return 200, {"now": "2026-10-09T10:00:00+02:00", "runs": [], "path": path}

    monkeypatch.setattr(gui_main, "RUNWATCH", FakeWatch())
    status, _, body = request(gui, "GET", "/gui/runs/times")
    assert status == 200
    assert detail(body)["path"] == "/runs/times"
    monkeypatch.setattr(gui_main, "RUNWATCH", None)
    assert request(gui, "GET", "/gui/runs/times")[0] == 404


def test_gui_log_is_plumber_guis_own_log(gui, monkeypatch, tmp_path):
    log_file = tmp_path / "plumbergui.log"
    log_file.write_text("2026-10-09 10:00:00,000 - plumbergui: [INFO]: Run started: pipeline 'x'\n")
    monkeypatch.setattr(gui_main, "LOG_FILE", log_file)
    status, headers, body = request(gui, "GET", "/gui/log")
    assert status == 200
    assert headers["Content-Type"].startswith("text/plain")
    assert body == log_file.read_bytes()
    assert request(gui, "POST", "/gui/log", body=b"")[0] == 405
    assert request(gui, "GET", "/gui/log", api=False)[0] == 403  # The header check covers it too
    log_file.unlink()
    assert request(gui, "GET", "/gui/log")[:3:2] == (200, b"")
    monkeypatch.setattr(gui_main, "LOG_FILE", None)  # The file could not be opened
    assert request(gui, "GET", "/gui/log")[0] == 404


def test_a_start_or_stop_asks_for_a_read_of_the_run_lists(gui, stub, monkeypatch):
    nudges = []

    class FakeWatch:
        def nudge(self):
            nudges.append(True)

    monkeypatch.setattr(gui_main, "RUNWATCH", FakeWatch())
    request(gui, "POST", "/api/run/pipeline/demo/chatty?station=lab", body=b"")
    request(gui, "DELETE", "/api/run/pipeline/lab/demo/chatty/4")
    request(gui, "GET", "/api/logs/pipelines")
    stub.reply = (409, {"Content-Type": "application/json"}, b'{"detail":"Run 4 is not running"}')
    request(gui, "DELETE", "/api/run/pipeline/lab/demo/chatty/4")
    assert len(nudges) == 2  # Not for a read, nor for a refused stop


def test_actions_are_logged_without_their_bodies(gui, stub, caplog):
    with caplog.at_level(logging.INFO, logger="plumbergui"):
        request(gui, "POST", "/api/station/add", body=b'{"name":"lab","connection":"http://x","token":"SECRET-TOKEN"}',
                headers={"Content-Type": "application/json"})
        request(gui, "GET", "/api/station/list")
        stub.reply = (404, {"Content-Type": "application/json"}, b'{"detail":"Station \'x\' not found"}')
        request(gui, "DELETE", "/api/station/remove/x")
    logged = [(record.levelno, record.getMessage()) for record in caplog.records]
    assert logged == [(logging.INFO, "POST /station/add -> 200"), (logging.WARNING, "DELETE /station/remove/x -> 404")]
    assert "SECRET-TOKEN" not in caplog.text


def test_host_allowed_function():
    assert gui_main.host_allowed("LOCALHOST:1")
    assert gui_main.host_allowed("[::1]")
    assert not gui_main.host_allowed(None)
    assert not gui_main.host_allowed("[::1")
    assert not gui_main.host_allowed("localhost.")

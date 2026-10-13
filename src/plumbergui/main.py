"""
Plumber GUI: a web interface for a Plumber control plane.

The GUI talks to Plumber over HTTP and does not import it. The browser's /api/* requests are
forwarded to the control plane, /gui/* requests are plumber-gui's own (its cron schedules, the run
times it keeps, and its log), and everything else is one of the static files.
Run with:
    plumber-gui
"""

import ipaddress
import json
import logging
import os
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from logging.handlers import RotatingFileHandler
from pathlib import Path
from urllib.parse import urlsplit

from plumbergui.runwatch import RunWatch
from plumbergui.scheduler import Scheduler

log = logging.getLogger("plumbergui")

PLUMBER_URL = os.environ.get("PLUMBER_URL", "http://127.0.0.1:509").rstrip("/")
STATIC_DIR = Path(__file__).resolve().parent / "static"
PROXY_TIMEOUT = 1800  # Seconds. Pushing projects or loading the registry and catalog views can take a while.
MAX_BODY = 128 * 1024 * 1024  # Bytes. Project zips and vault files are far smaller.
MAX_GUI_BODY = 64 * 1024  # Bytes, for plumber-gui's own JSON endpoints
CHUNK = 64 * 1024  # Bytes relayed at a time, so a large log never sits in memory twice
LOG_FORMAT = "%(asctime)s - %(name)s: [%(levelname)s]: %(message)s"  # Canonada's, so the log viewer reads it
LOG_BYTES = 4 * 1024 * 1024  # plumbergui.log is rotated to plumbergui.log.1 at this size

FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/ui.js": ("ui.js", "text/javascript; charset=utf-8"),
    "/runs.js": ("runs.js", "text/javascript; charset=utf-8"),
    "/search.js": ("search.js", "text/javascript; charset=utf-8"),
    "/theme.js": ("theme.js", "text/javascript; charset=utf-8"),
    "/logparse.js": ("logparse.js", "text/javascript; charset=utf-8"),
    "/app.css": ("app.css", "text/css; charset=utf-8"),
    "/favicon.svg": ("favicon.svg", "image/svg+xml"),
}

# Sent with every reply. The page only loads its own files, can't be framed, and the browser
# refuses to turn strings into HTML or script (Trusted Types), so a log line or a TOML file can't run code.
SECURITY_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; "
        "base-uri 'none'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'"
    ),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
}

SCHEDULER = None  # Set by main() once the schedules are loaded
RUNWATCH = None  # Set by main() once the run times are loaded
LOG_FILE = None  # plumbergui.log, set by main() when it could be opened

# Straight to Plumber, ignoring http_proxy and friends: the requests carry station tokens, deploy keys
# and vault credentials, and urllib would send even a 127.0.0.1 URL through a configured proxy
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

plumber_down = False  # Whether the last request found Plumber unreachable, so loss and recovery are logged once


def host_allowed(host: str | None) -> bool:
    """
    Whether a Host header names this machine the way a local browser, an SSH tunnel, or a proxy that
    sends a loopback or IP Host does: localhost, a *.localhost name, or an IP address, on any port.
    A DNS-rebinding page sends its own domain name instead, so it is refused.
    """

    if not host:
        return False
    try:
        name = urlsplit("//" + host).hostname
    except ValueError:
        return False
    if not name:
        return False
    if name == "localhost" or name.endswith(".localhost"):
        return True
    try:
        ipaddress.ip_address(name)
    except ValueError:
        return False
    return True


def _is_loopback(host: str) -> bool:
    """
    Whether the address plumber-gui binds to is only reachable from this machine
    """

    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:
        return

    def send_response(self, code: int, message: str | None = None) -> None:
        self.answered = True
        self.connection_sent = False
        super().send_response(code, message)

    def send_header(self, keyword: str, value: str) -> None:
        if keyword.lower() == "connection":
            self.connection_sent = True
        super().send_header(keyword, value)

    def end_headers(self) -> None:
        # Every reply carries them, including the ones http.server writes itself (400, 501)
        for name, value in SECURITY_HEADERS.items():
            self.send_header(name, value)
        if self.close_connection and not self.connection_sent:
            self.send_header("Connection", "close")
        super().end_headers()

    def do_GET(self) -> None:
        self._handle()

    def do_POST(self) -> None:
        self._handle()

    def do_PUT(self) -> None:
        self._handle()

    def do_DELETE(self) -> None:
        self._handle()

    # No do_OPTIONS or do_HEAD: a CORS preflight gets 501 without Access-Control headers, so other
    # sites can't send the X-Plumber-GUI header

    def _handle(self) -> None:
        self.answered = False
        try:
            self._route()
        except (BrokenPipeError, ConnectionResetError):  # The browser went away
            self.close_connection = True
        except Exception:
            log.exception(f"{self.command} {self.path} failed")
            self.close_connection = True
            if not self.answered:
                self._error(500, "plumber-gui failed; see its log")

    def _route(self) -> None:
        if not self.path.startswith("/"):  # An absolute-form target, as a proxy would get
            self.close_connection = True
            self._error(400, "Bad request target")
            return
        if not host_allowed(self.headers.get("Host")):
            self.close_connection = True
            self._error(
                403,
                "Host not allowed: open plumber-gui through localhost or an IP address (an SSH tunnel works), "
                "or put it behind an authenticating reverse proxy that sends Host: localhost (plumber-gui has no login)",
            )
            return

        split = urlsplit(self.path)
        if split.path.startswith(("/api/", "/gui/")):
            # Browsers only send this header from plumber-gui's own page: a form or a cross-site
            # request can't set it without a CORS preflight, which is refused
            if self.headers.get("X-Plumber-GUI") != "1":
                self.close_connection = True
                self._error(403, "Missing the X-Plumber-GUI header")
                return
            if split.path.startswith("/api/"):
                body = self._body(MAX_BODY)
                if body is not None:
                    self._proxy(self.path[len("/api"):], body)
            else:
                body = self._body(MAX_GUI_BODY)
                if body is not None:
                    self._gui(split.path[len("/gui"):], split.query, body)
            return

        if self.command == "GET" and split.path in FILES:
            name, content_type = FILES[split.path]
            self._send(200, (STATIC_DIR / name).read_bytes(), content_type, "no-cache")
            return
        self._error(404, "Not found")

    def _body(self, limit: int) -> bytes | None:
        """
        The request body, or None once an error has been answered. A missing Content-Length is an
        empty body. A connection that carried a body is closed after the reply, so bytes beyond a
        short Content-Length can never be read as a second request.
        """

        if self.headers.get("Transfer-Encoding"):
            self.close_connection = True
            self._error(411, "Send a Content-Length instead of Transfer-Encoding")
            return None
        lengths = self.headers.get_all("Content-Length") or ["0"]
        if len(lengths) > 1 or not lengths[0].isdigit():
            self.close_connection = True
            self._error(400, "Bad Content-Length")
            return None
        length = int(lengths[0])
        if length > limit:
            self.close_connection = True
            self._error(413, f"Request body over {limit} bytes")
            return None
        if not length:
            return b""
        self.close_connection = True
        body = self.rfile.read(length)
        if len(body) < length:  # The browser hung up mid-upload
            return None
        return body

    def _proxy(self, target: str, body: bytes) -> None:
        """
        Forward the request to Plumber and stream its reply back. Only the body and its Content-Type
        go along; cookies, credentials and the Host header do not.
        """

        global plumber_down
        headers = {}
        if self.headers.get("Content-Type"):
            headers["Content-Type"] = self.headers["Content-Type"]
        data = body if body or self.command in ("POST", "PUT") else None
        request = urllib.request.Request(PLUMBER_URL + target, data=data, headers=headers, method=self.command)
        try:
            response = OPENER.open(request, timeout=PROXY_TIMEOUT)
        except urllib.error.HTTPError as e:
            response = e
        except (urllib.error.URLError, OSError) as e:
            # urllib wraps what goes wrong while connecting and sending in URLError; an error after
            # that comes as it is, once Plumber has the whole request and may have acted on it
            sent = not isinstance(e, urllib.error.URLError)
            reason = e.reason if isinstance(e, urllib.error.URLError) else e
            if isinstance(reason, TimeoutError):
                self._error(
                    504,
                    f"Plumber did not answer within {PROXY_TIMEOUT} s. The action may still be running "
                    "or may have finished; refresh to check.",
                )
                return
            if not plumber_down:
                log.warning(f"Plumber did not respond at {PLUMBER_URL}")
                plumber_down = True
            if sent:
                self._error(502, f"Plumber closed the connection at {PLUMBER_URL} before answering; it may have acted on the request")
            else:
                self._error(502, f"Plumber did not respond at {PLUMBER_URL}")
            return
        if plumber_down:
            log.info(f"Plumber answers again at {PLUMBER_URL}")
            plumber_down = False
        status = response.code if isinstance(response, urllib.error.HTTPError) else response.status
        if self.command != "GET":  # What was done through the GUI; bodies (tokens, keys) are never logged
            log.log(logging.INFO if status < 400 else logging.WARNING, f"{self.command} {target} -> {status}")
        if RUNWATCH is not None and status == 200 and target.startswith("/run/"):
            RUNWATCH.nudge()  # Note the run's start or end now, not at the next read
        with response:
            self._relay(response)

    def _relay(self, response) -> None:
        """
        Send Plumber's status, Content-Type and body. The body is streamed when Plumber gave its
        length; if Plumber's reply ends early the connection is dropped instead of left short.
        """

        status = response.code if isinstance(response, urllib.error.HTTPError) else response.status
        length = response.headers.get("Content-Length")
        self.send_response(status)
        self.send_header("Content-Type", response.headers.get("Content-Type", "application/json"))
        self.send_header("Cache-Control", "no-store")
        if length is None or not length.isdigit():
            body = response.read()
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_header("Content-Length", length)
        self.end_headers()
        remaining = int(length)
        while remaining:
            try:
                chunk = response.read(min(CHUNK, remaining))
            except OSError:
                chunk = b""
            if not chunk:
                self.close_connection = True
                return
            self.wfile.write(chunk)
            remaining -= len(chunk)

    def _gui(self, path: str, query: str, body: bytes) -> None:
        """
        plumber-gui's own endpoints: the cron schedules, the run times, and its log
        """

        if path == "/log" and LOG_FILE is not None:
            if self.command != "GET":
                self._error(405, "Method not allowed")
                return
            try:
                text = LOG_FILE.read_bytes()
            except FileNotFoundError:
                text = b""
            self._send(200, text, "text/plain; charset=utf-8")
            return
        handler = SCHEDULER if path.startswith("/schedule/") else RUNWATCH if path.startswith("/runs/") else None
        if handler is None:
            self._error(404, "Not found")
            return
        status, payload = handler.handle(self.command, path, query, body)
        if self.command != "GET":
            log.log(logging.INFO if status < 400 else logging.WARNING, f"{self.command} /gui{path} -> {status}")
        self._send(status, json.dumps(payload).encode(), "application/json")

    def _send(self, status: int, body: bytes, content_type: str, cache: str = "no-store") -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status: int, detail: str) -> None:
        """
        An error plumber-gui makes itself. "source" tells the page it isn't Plumber's answer.
        """

        self._send(status, json.dumps({"detail": detail, "source": "plumber-gui"}).encode(), "application/json")


def main() -> None:
    """
    Serve the GUI, forward the browser's API calls to the Plumber control plane, fire the cron
    schedules kept in schedules.toml, and note when runs start and end in runs.jsonl. Its log goes
    to the terminal and to plumbergui.log. All three files are in the working directory.
    """

    global SCHEDULER, RUNWATCH, LOG_FILE
    logging.basicConfig(format=LOG_FORMAT, level=logging.INFO)
    try:
        file_log = RotatingFileHandler(Path("plumbergui.log").resolve(), maxBytes=LOG_BYTES, backupCount=1, encoding="utf-8")
    except OSError as e:
        log.warning(f"Could not open plumbergui.log, so the GUI can't show this log: {e}")
    else:
        file_log.setFormatter(logging.Formatter(LOG_FORMAT))
        logging.getLogger().addHandler(file_log)
        LOG_FILE = Path(file_log.baseFilename)
    host = os.environ.get("PLUMBERGUI_HOST", "127.0.0.1")
    port = int(os.environ.get("PLUMBERGUI_PORT", "510"))
    runwatch = RunWatch(Path("runs.jsonl").resolve(), PLUMBER_URL)
    runwatch.load()
    scheduler = Scheduler(Path("schedules.toml").resolve(), PLUMBER_URL, on_start=runwatch.nudge)
    scheduler.load()  # Exits when schedules.toml can't be read
    # Bind before the scheduler starts: a second plumber-gui on this port stops here, before it fires anything
    try:
        httpd = ThreadingHTTPServer((host, port), Handler)
    except OSError as e:
        log.error(f"Could not listen on {host}:{port}: {e}")
        sys.exit(1)
    SCHEDULER, RUNWATCH = scheduler, runwatch
    scheduler.start()
    runwatch.start()
    if not _is_loopback(host):
        log.warning(
            "plumber-gui has no login: anyone who can reach it controls every station. Keep it on 127.0.0.1 "
            "and use an SSH tunnel or an authenticating reverse proxy."
        )
    log.info(f"Plumber GUI on http://{host}:{port}, control plane at {PLUMBER_URL}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        scheduler.stop()
        runwatch.stop()


if __name__ == "__main__":
    main()

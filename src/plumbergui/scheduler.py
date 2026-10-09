"""
Cron schedules for plumber-gui

Schedules are kept in schedules.toml in plumber-gui's working directory. While plumber-gui runs, a
thread checks them at every minute of the local wall clock and starts each due pipeline or system
through Plumber's run API, unless the same target is still running on that station. Plumber itself
knows nothing about schedules.
"""

import json
import logging
import os
import re
import sys
import tempfile
import threading
import time
import tomllib
import urllib.error
import urllib.request
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from itertools import islice
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlencode

FIELDS = (("minute", 0, 59), ("hour", 0, 23), ("day-of-month", 1, 31), ("month", 1, 12), ("day-of-week", 0, 7))
ITEM = re.compile(r"(\*|([0-9]+)(?:-([0-9]+))?)(?:/([0-9]+))?")  # *, a, or a-b, each with an optional /n
CRON_LENGTH = 100  # Characters
HORIZON_DAYS = 5 * 366  # How far ahead a cron expression is searched for its next fire
CATCH_UP = timedelta(minutes=60)  # After a longer gap between checks, only this much is made up
CLOCKS_FORWARD = timedelta(minutes=61)  # The gap between two checks across the clocks going forward
KEYS = ("name", "project", "pipeline", "system", "station", "cron", "enabled")  # In schedules.toml order
NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
ROUTES = {"list": "GET", "add": "POST", "update": "PUT", "remove": "DELETE", "preview": "GET"}
NEVER_FIRES = "cron '{}' never fires within 5 years"

Call = Callable[[str, str, bytes | None, float], tuple[int, bytes]]  # (method, url, body, timeout) -> (status, body)

log = logging.getLogger("plumbergui")


# Cron -------------------------------------------------------------------------
@dataclass(frozen=True)
class Cron:
    """
    A parsed cron expression

    A day field is restricted unless its text starts with '*'. When both day fields are restricted,
    a day matches if either one does; otherwise it must match both (as in Vixie cron and cronie).
    """

    text: str  # The five fields, separated by single spaces
    minutes: tuple[int, ...]
    hours: tuple[int, ...]
    days: frozenset[int]
    months: frozenset[int]
    weekdays: frozenset[int]  # 0 is Sunday
    days_restricted: bool
    weekdays_restricted: bool

    def on_day(self, day: date) -> bool:
        """
        Whether the month and the two day fields allow this date
        """

        if day.month not in self.months:
            return False
        by_day = day.day in self.days
        by_weekday = day.isoweekday() % 7 in self.weekdays
        if self.days_restricted and self.weekdays_restricted:
            return by_day or by_weekday
        return by_day and by_weekday

    def matches(self, t: datetime) -> bool:
        """
        Whether the expression fires at the minute of t
        """

        return t.minute in self.minutes and t.hour in self.hours and self.on_day(t.date())


def _field_values(text: str, field: str, low: int, high: int) -> set[int]:
    """
    The values one comma-separated cron field allows. Raises ValueError naming the field.
    """

    values: set[int] = set()
    for item in text.split(","):
        if not item:
            raise ValueError(f"{field}: '{text}' has an empty item")
        match = ITEM.fullmatch(item)
        if match is None:
            numbers = f"the numbers {low}-{high}" + (" (0 and 7 are Sunday)" if field == "day-of-week" else "")
            if re.search(r"[A-Za-z]{3}", item):
                raise ValueError(f"{field}: names like '{item}' are not supported; use {numbers}")
            raise ValueError(f"{field}: '{item}' is not supported; use {numbers} with *, -, / and ,")
        base, first, last, step = match.groups()
        start, end = (low, high) if base == "*" else (int(first), int(last or first))
        for value in (start, end):
            if not low <= value <= high:
                raise ValueError(f"{field}: {value} is outside {low}-{high}")
        if step is not None and int(step) == 0:
            raise ValueError(f"{field}: the step in '{item}' must be at least 1")
        if step is not None and base != "*" and last is None:
            raise ValueError(f"{field}: '{item}' needs a range; write {start}-{high}/{int(step)}")
        if end < start:
            raise ValueError(f"{field}: the range {start}-{end} goes backwards; write it from low to high")
        values.update(range(start, end + 1, int(step or 1)))
    return values


def parse_cron(expr: str) -> Cron:
    """
    Parse the five numeric fields minute hour day-of-month month day-of-week, separated by spaces
    or tabs. Day-of-week 0 and 7 are both Sunday. Raises ValueError naming the field at fault.
    """

    if not isinstance(expr, str):
        raise ValueError("cron must be a string such as '0 2 * * *'")
    if len(expr) > CRON_LENGTH:
        raise ValueError(f"cron must be at most {CRON_LENGTH} characters")
    if expr.strip(" \t").startswith("@"):
        raise ValueError("Macros like @daily are not supported; write the five fields, such as 0 0 * * *")
    fields = [field for field in re.split(r"[ \t]+", expr) if field]
    if len(fields) != 5:
        raise ValueError("expected 5 fields: minute hour day-of-month month day-of-week")
    minutes, hours, days, months, weekdays = (_field_values(text, *spec) for text, spec in zip(fields, FIELDS))
    return Cron(
        text=" ".join(fields),
        minutes=tuple(sorted(minutes)),
        hours=tuple(sorted(hours)),
        days=frozenset(days),
        months=frozenset(months),
        weekdays=frozenset(value % 7 for value in weekdays),  # 7 is Sunday too
        days_restricted=not fields[2].startswith("*"),
        weekdays_restricted=not fields[4].startswith("*"),
    )


def _fire_times(cron: Cron, after: datetime, days: int) -> Iterator[datetime]:
    """
    Matching minutes in order, strictly after 'after' and within 'days' days counted from its date
    """

    day = after.date()
    for _ in range(days):
        if cron.on_day(day):
            for hour in cron.hours:
                for minute in cron.minutes:
                    fire = datetime(day.year, day.month, day.day, hour, minute)
                    if fire > after:
                        yield fire
        day += timedelta(days=1)


def next_fires(cron: Cron, after: datetime, count: int) -> list[datetime]:
    """
    The next count fires strictly after the naive datetime 'after', searching at most 5 years ahead.
    An expression that does not fire in that time, such as 0 0 30 2 *, gives an empty list.
    """

    return list(islice(_fire_times(cron, after, HORIZON_DAYS), max(count, 0)))


def _fires_between(cron: Cron, after: datetime, until: datetime) -> bool:
    """
    Whether the expression matches a minute m with after < m <= until
    """

    days = min((until.date() - after.date()).days + 1, HORIZON_DAYS)
    fire = next(_fire_times(cron, after, days), None)
    return fire is not None and fire <= until


# Records ----------------------------------------------------------------------
def _target_name(value: object, what: str) -> str:
    """
    A project, pipeline, system, or station name. It has to come back unchanged from json.dumps
    into TOML and tomllib, which rules out control characters and surrogate escapes.
    """

    if not isinstance(value, str) or not value or len(value) > 200:
        raise ValueError(f"{what} must be a non-empty string of at most 200 characters")
    if value != Path(value).name or value.startswith("."):
        raise ValueError(f"{what} must be a single path segment and must not start with '.'")
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise ValueError(f"{what} must not contain control characters")
    if any(ord(char) > 0xFFFF or 0xD800 <= ord(char) <= 0xDFFF for char in value):
        raise ValueError(f"{what} must not contain emoji or other characters beyond U+FFFF")
    return value


def _schedule_fields(body: object) -> dict:
    """
    check_schedule without the check that the expression fires within 5 years
    """

    if not isinstance(body, dict):
        raise ValueError("A schedule must be an object with name, project, pipeline or system, station, and cron")
    unknown = set(body) - set(KEYS)
    if unknown:
        raise ValueError(f"Unknown field '{sorted(unknown)[0]}'")
    name = body.get("name")
    if not isinstance(name, str) or not NAME.fullmatch(name):
        raise ValueError("Schedule name must be 1-64 letters, digits, '.', '_' or '-', starting with a letter or digit")
    if "pipeline" in body and "system" in body:
        raise ValueError("Give a pipeline or a system, not both")
    if "pipeline" not in body and "system" not in body:
        raise ValueError("Give the pipeline or system to run")
    kind = "pipeline" if "pipeline" in body else "system"
    record = {
        "name": name,
        "project": _target_name(body.get("project"), "Project name"),
        kind: _target_name(body[kind], f"{kind.capitalize()} name"),
        "station": _target_name(body.get("station"), "Station name"),
        "cron": parse_cron(body.get("cron")).text,
        "enabled": body.get("enabled", True),
    }
    if not isinstance(record["enabled"], bool):
        raise ValueError("enabled must be true or false")
    return record


def check_schedule(body: object, now: datetime | None = None) -> dict:
    """
    One schedule from a request body or a schedules.toml table, with its keys in file order and its
    cron fields separated by single spaces. Raises ValueError when it is unusable, including when
    its expression would not fire within 5 years of now (the local wall clock by default).
    """

    record = _schedule_fields(body)
    if not next_fires(parse_cron(record["cron"]), now if now is not None else datetime.now(), 1):
        raise ValueError(NEVER_FIRES.format(record["cron"]))
    return record


def _schedules_from_config(config: dict) -> list[dict]:
    """
    The schedule list from a parsed schedules.toml. A missing schedules key is an empty list.
    Raises ValueError when a schedule is unusable, or when a name is repeated.
    """

    raw = config.get("schedules", [])
    if not isinstance(raw, list):
        raise ValueError("'schedules' must be a list of tables")
    parsed: list[dict] = []
    for index, entry in enumerate(raw, start=1):
        try:
            record = _schedule_fields(entry)
        except ValueError as e:
            raise ValueError(f"schedule {index}: {e}") from e
        if any(current["name"] == record["name"] for current in parsed):
            raise ValueError(f"Schedule name '{record['name']}' is used more than once")
        parsed.append(record)
    return parsed


def _render_schedules(records: list[dict]) -> str:
    """
    schedules.toml text for a schedule list
    """

    lines = [
        "# Cron schedules of plumber-gui, in the local time of the machine it runs on. They fire only",
        "# while plumber-gui is running, and a fire is skipped while the same pipeline or system is",
        "# still running on that station. cron is minute hour day-of-month month day-of-week.",
        "# plumber-gui rewrites this file on every change: edit it only while plumber-gui is stopped.",
        "",
    ]
    if not records:
        lines.append("schedules = []")
        lines.append("")
    for record in records:
        lines.append("[[schedules]]")
        for key, value in record.items():
            lines.append(f"{key} = {json.dumps(value)}")
        lines.append("")
    return "\n".join(lines)


# HTTP -------------------------------------------------------------------------
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # Straight to Plumber, ignoring http_proxy


def _http(method: str, url: str, body: bytes | None, timeout: float) -> tuple[int, bytes]:
    """
    One request to Plumber. Returns the status and body of any HTTP answer, errors included.
    Raises TimeoutError when the answer is late, and OSError when Plumber can't be reached.
    """

    request = urllib.request.Request(url, data=body, method=method)
    try:
        with OPENER.open(request, timeout=timeout) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def _json(body: bytes) -> object:
    """
    A parsed JSON body, or None when it is empty or not JSON
    """

    try:
        return json.loads(body) if body else None
    except (ValueError, RecursionError):
        return None


def _detail(payload: object, fallback: str) -> str:
    """
    The detail string of an error body, or fallback
    """

    if isinstance(payload, dict) and isinstance(payload.get("detail"), str):
        return payload["detail"]
    return fallback


def _iso(t: datetime) -> str:
    """
    A naive local time as ISO 8601 with its UTC offset, to the minute
    """

    return t.astimezone().isoformat(timespec="minutes")


# Scheduler --------------------------------------------------------------------
class Scheduler:
    """
    The schedules of one plumber-gui: kept in schedules.toml, served under /gui/schedule, and fired
    through Plumber's run API by a thread that checks the local wall clock once a minute
    """

    def __init__(
        self,
        path: Path,
        plumber_url: str,
        *,
        call: Call | None = None,
        clock: Callable[[], datetime] | None = None,
        timeout: float = 300,
        on_start: Callable[[], None] | None = None,
    ) -> None:
        """
        path is schedules.toml. call returns the status and body of any HTTP answer, and raises
        TimeoutError or OSError like urllib does. clock returns the naive local time. Both default
        to the real ones. on_start is called after a fire started a run.
        """

        self.path = Path(path)
        self.plumber_url = plumber_url.rstrip("/")
        self.timeout = timeout  # Seconds for each call to Plumber
        self._call = call or _http
        self._on_start = on_start
        # The naive local wall clock, never an aware one: DST handling depends on matching cron fields
        # against it. Minutes skipped by the clocks going forward are made up at the jump, and a
        # repeated hour fires nothing because its minutes are not after the last one checked.
        self._clock = clock or datetime.now
        self._lock = threading.Lock()  # Guards the schedule list, the last outcomes, and the fires in flight
        self._schedules: list[dict] = []
        self._outcomes: dict[str, dict] = {}  # The last outcome of each schedule, by name
        self._in_flight: set[str] = set()  # Schedules whose fire is queued or waiting for Plumber
        self._orphans: set[str] = set()  # Of those, the ones removed since: their fire keeps no outcome
        self._slots = threading.BoundedSemaphore(4)  # Fires waiting for Plumber at once
        self._stopping = threading.Event()
        self._thread: threading.Thread | None = None
        self._started = self._clock()
        # The last minute checked. It begins as the start minute, which is itself never checked.
        self.last = self._started.replace(second=0, microsecond=0)

    def load(self) -> None:
        """
        Read schedules.toml. A missing file means no schedules. Logs an error and exits if the file
        can't be read, or if a schedule fails its check.
        """

        try:
            with self.path.open("rb") as f:
                loaded = tomllib.load(f)
        except FileNotFoundError:
            loaded = {}
        except (OSError, ValueError, RecursionError) as e:  # Bad TOML or UTF-8, or nesting too deep for tomllib
            log.error(f"{self.path}: {e}")
            sys.exit(1)
        try:
            # Records are not refused for firing too rarely here: a schedule accepted years ago
            # must not keep plumber-gui from starting.
            records = _schedules_from_config(loaded)
        except ValueError as e:
            log.error(f"{self.path}: {e}")
            sys.exit(1)
        with self._lock:
            self._schedules = records

    def start(self) -> None:
        """
        Start the thread that checks the schedules once a minute. Calling it again does nothing.
        """

        with self._lock:
            if self._thread is not None:
                return
            self._thread = threading.Thread(target=self._loop, name="plumbergui-scheduler", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        """
        End the thread and drop the fires still waiting for a slot. A fire already waiting for Plumber
        is not waited for; fire threads are daemons, so it never holds up plumber-gui's exit either.
        """

        self._stopping.set()
        if self._thread is not None:
            self._thread.join()

    def _loop(self) -> None:
        """
        Wake half a second after each minute boundary and check that minute. The wait is measured
        with time.time(), which does not jump when the clocks change.
        """

        while not self._stopping.wait(60 - time.time() % 60 + 0.5):
            try:
                self.tick(self._clock().replace(second=0, microsecond=0))
            except Exception:
                log.exception("Checking the schedules failed")

    def tick(self, now: datetime) -> None:
        """
        Check the naive local wall-clock minute 'now'. Each enabled schedule fires once if it matches
        any minute since the last check. After a longer gap (plumber-gui stalled, or the machine
        slept) only the last 60 minutes are made up, and one warning says what was dropped.
        """

        if now <= self.last:
            return  # The clocks went back, or were set back: wait until they pass the last minute checked
        # The check right after the clocks go forward comes 61 wall-clock minutes after the one
        # before. That gap is checked in full, so a fire in the skipped hour happens at the jump.
        since = self.last if now - self.last <= CLOCKS_FORWARD else now - CATCH_UP
        with self._lock:
            snapshot = [dict(record) for record in self._schedules if record["enabled"]]
        dropped = []
        for record in snapshot:
            cron = parse_cron(record["cron"])
            if since > self.last and _fires_between(cron, self.last, since):
                dropped.append(f"'{record['name']}'")
            if not _fires_between(cron, since, now):
                continue
            with self._lock:
                busy = record["name"] in self._in_flight
                self._in_flight.add(record["name"])
            if busy:
                detail = "the previous fire is still waiting for Plumber"
                self._note(record, {"at": _iso(now), "outcome": "skipped", "detail": detail}, finished=False)
            else:
                threading.Thread(target=self._fire, args=(record, now), name="plumbergui-fire", daemon=True).start()
        if dropped:
            log.warning(
                f"plumber-gui was not checking schedules between {self.last:%Y-%m-%d %H:%M} and "
                f"{since:%Y-%m-%d %H:%M}; fires of {', '.join(dropped)} in that time were dropped"
            )
        self.last = now

    # Fires --------------------------------------------------------------------
    def _fire(self, record: dict, at: datetime) -> None:
        """
        Start one schedule's pipeline or system and keep the outcome. Runs in its own thread, once
        one of the slots is free; dropped when plumber-gui stops before then.
        """

        with self._slots:
            if self._stopping.is_set():
                return
            try:
                result = self._start_run(record)
            except Exception as e:  # Whatever happens, the schedule must not stay in flight
                log.exception(f"Schedule '{record['name']}' could not fire")
                result = {"outcome": "failed", "detail": f"Unexpected error: {e}"}
            self._note(record, {"at": _iso(at), **result}, finished=True)
            if result["outcome"] == "started" and self._on_start:
                self._on_start()

    def _start_run(self, record: dict) -> dict:
        """
        Skip the fire while the target is running on the station, otherwise ask Plumber to start it.
        Returns the outcome without its time. Nothing is retried.
        """

        kind = "pipeline" if "pipeline" in record else "system"
        project, target, station = record["project"], record[kind], record["station"]
        try:
            status, body = self._call("GET", f"{self.plumber_url}/logs/{kind}s", None, self.timeout)
        except OSError:  # A timeout too: nothing was started either way
            return {"outcome": "failed", "detail": "Plumber did not respond"}
        listing = _json(body)
        if status != 200 or not isinstance(listing, list):
            reason = _detail(listing, f"HTTP {status}")
            return {"outcome": "failed", "detail": f"Plumber did not list the runs: {reason}"}
        entry = next((item for item in listing if isinstance(item, dict) and item.get("station") == station), None)
        if entry is None:
            return {"outcome": "failed", "detail": f"Station '{station}' is not configured in Plumber"}
        if "error" in entry:
            return {"outcome": "failed", "detail": f"Could not check runs on {station}: {entry['error']}"}
        runs = [run for run in entry.get("runs") or [] if isinstance(run, dict)]
        same = [run for run in runs if (run.get("project"), run.get(kind)) == (project, target)]
        running = [run.get("run") for run in same if run.get("status") == "running"]
        if running:
            return {"outcome": "skipped", "detail": f"run #{running[-1]} is still running"}

        url = (
            f"{self.plumber_url}/run/{kind}/{quote(project, safe='')}/{quote(target, safe='')}"
            f"?{urlencode({'station': station})}"
        )
        try:
            status, body = self._call("POST", url, b"", self.timeout)
        except TimeoutError:
            detail = f"No answer from Plumber within {self.timeout:g} s; the run may have started"
            return {"outcome": "unknown", "detail": detail}
        except OSError:
            return {"outcome": "failed", "detail": "Plumber did not respond"}
        payload = _json(body)
        if status == 200:
            result = {"outcome": "started"}
            if isinstance(payload, dict):
                result.update({key: payload[key] for key in ("run", "sent") if key in payload})
            return result
        detail = _detail(payload, f"HTTP {status}")
        if status == 502 and "did not respond" in detail:
            return {"outcome": "unknown", "detail": f"{detail}; the run may have started"}
        return {"outcome": "failed", "detail": detail}

    def _note(self, record: dict, outcome: dict, *, finished: bool) -> None:
        """
        Log a schedule's latest outcome, then keep it. finished ends its fire in flight. A schedule
        removed in the meantime keeps nothing, even when a new one has its name by then.
        """

        name = record["name"]
        kind = "pipeline" if "pipeline" in record else "system"
        target = f"{kind} '{record[kind]}' of '{record['project']}' on '{record['station']}'"
        try:  # Logged while still in flight, so a fire seen as finished has its line out already
            if outcome["outcome"] == "started":
                run = f" as run #{outcome['run']}" if "run" in outcome else ""
                log.info(f"Schedule '{name}' started {target}{run}")
            else:
                log.warning(f"Schedule '{name}' for {target} {outcome['outcome']}: {outcome['detail']}")
        finally:  # Even if logging fails, the schedule must not stay in flight
            with self._lock:
                removed = finished and name in self._orphans
                if finished:
                    self._in_flight.discard(name)
                    self._orphans.discard(name)
                if not removed and any(current["name"] == name for current in self._schedules):
                    self._outcomes[name] = outcome

    # Requests -----------------------------------------------------------------
    def handle(self, method: str, path: str, query: str, body: bytes) -> tuple[int, object]:
        """
        Answer one request. path is the URL path after /gui, query the raw query string. Returns the
        HTTP status and a JSON payload; errors are {"detail": "..."}.

        GET /schedule/list, POST /schedule/add, PUT /schedule/update/{name} (the full record; renaming
        is not supported), DELETE /schedule/remove/{name}, GET /schedule/preview?cron=EXPR (next 3 fires)
        """

        parts = path.split("/")
        action = parts[2] if len(parts) > 2 and parts[:2] == ["", "schedule"] else ""
        named = action in ("update", "remove")
        if action not in ROUTES or len(parts) != (4 if named else 3) or (named and not parts[3]):
            return 404, {"detail": "Not found"}
        if method != ROUTES[action]:
            return 405, {"detail": "Method not allowed"}
        try:
            if action == "list":
                return 200, self._listing()
            if action == "preview":
                return self._preview(query)
            if action == "add":
                return self._add(body)
            if action == "update":
                return self._update(unquote(parts[3]), body)
            return self._remove(unquote(parts[3]))
        except ValueError as e:
            return 400, {"detail": str(e)}

    def _listing(self) -> dict:
        """
        The schedules sorted by name, with the clock they are matched against
        """

        now = self._clock()
        with self._lock:
            records = [dict(record) for record in self._schedules]
            outcomes = dict(self._outcomes)
            in_flight = set(self._in_flight)
        schedules = []
        for record in sorted(records, key=lambda item: item["name"]):
            fires = next_fires(parse_cron(record["cron"]), now, 1) if record["enabled"] else []
            schedules.append({
                **record,
                "next": _iso(fires[0]) if fires else None,
                "last": outcomes.get(record["name"]),
                "firing": record["name"] in in_flight,
            })
        stamp = _iso(now)
        return {
            "now": stamp,
            "timezone": now.astimezone().tzname(),
            "utc_offset": stamp[16:],  # What follows YYYY-MM-DDTHH:MM
            "started": _iso(self._started),
            "schedules": schedules,
        }

    def _preview(self, query: str) -> tuple[int, object]:
        """
        The next 3 fires of the expression in ?cron=
        """

        expr = parse_qs(query).get("cron")
        if not expr:
            raise ValueError("Give the expression to preview as ?cron=...")
        cron = parse_cron(expr[0])
        fires = next_fires(cron, self._clock(), 3)
        if not fires:
            raise ValueError(NEVER_FIRES.format(cron.text))
        return 200, {"next": [_iso(fire) for fire in fires]}

    def _add(self, body: bytes) -> tuple[int, object]:
        """
        Add a schedule and write schedules.toml
        """

        record = check_schedule(_json(body), self._clock())
        with self._lock:
            if any(current["name"] == record["name"] for current in self._schedules):
                return 409, {"detail": f"Schedule '{record['name']}' already exists"}
            failed = self._commit([*self._schedules, record])
        return failed or (200, {"name": record["name"], "added": True})

    def _update(self, name: str, body: bytes) -> tuple[int, object]:
        """
        Replace a schedule with the full record in the body. Its last outcome is kept.
        """

        payload = _json(body)
        if isinstance(payload, dict):
            if payload.get("name", name) != name:
                raise ValueError(f"Renaming is not supported; remove '{name}' and add it under the new name")
            payload = {**payload, "name": name}
        record = check_schedule(payload, self._clock())
        with self._lock:
            if not any(current["name"] == name for current in self._schedules):
                return 404, {"detail": f"Schedule '{name}' not found"}
            failed = self._commit([record if current["name"] == name else current for current in self._schedules])
        return failed or (200, {"name": name, "updated": True})

    def _remove(self, name: str) -> tuple[int, object]:
        """
        Remove a schedule and its last outcome. A fire still in flight keeps the name busy until it
        ends, but its outcome is only logged.
        """

        with self._lock:
            if not any(current["name"] == name for current in self._schedules):
                return 404, {"detail": f"Schedule '{name}' not found"}
            failed = self._commit([current for current in self._schedules if current["name"] != name])
            if not failed:
                self._outcomes.pop(name, None)
                if name in self._in_flight:
                    self._orphans.add(name)
        return failed or (200, {"name": name, "removed": True})

    def _commit(self, updated: list[dict]) -> tuple[int, object] | None:
        """
        Write updated to schedules.toml, then make it the schedule list. Call it with the lock held.
        A failed write changes neither and returns the 500 answer.
        """

        try:
            self._write(updated)
        except OSError as e:
            return 500, {"detail": f"Could not write {self.path}: {e}"}
        self._schedules = updated
        return None

    def _write(self, records: list[dict]) -> None:
        """
        Replace schedules.toml with records. The write is replaced into place so a crash cannot
        leave a half-written file.
        """

        fd, tmp_name = tempfile.mkstemp(prefix=".schedules-", suffix=".toml", dir=self.path.parent)
        tmp = Path(tmp_name)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(_render_schedules(records))
            os.replace(tmp, self.path)
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise

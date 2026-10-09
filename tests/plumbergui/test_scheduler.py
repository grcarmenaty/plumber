"""
Tests for plumbergui.scheduler: the cron grammar, the minute checks across DST and stalls, schedule
records and schedules.toml, the /gui/schedule requests, and every fire outcome

Plumber and the clock are fakes, and tick() is called directly. Run from the repository root with:
    PYTHONPATH=src python -m pytest -q tests/plumbergui/test_scheduler.py
"""

import json
import logging
import re
import socket
import threading
import time
import tomllib
import urllib.error
from collections.abc import Callable
from datetime import datetime, timedelta
from urllib.parse import unquote, urlsplit

import pytest

from plumbergui import scheduler as scheduler_module
from plumbergui.scheduler import Scheduler, check_schedule, next_fires, parse_cron

PLUMBER = "http://plumber.test"
START = datetime(2026, 10, 9, 10, 0)  # A Friday. Each fake clock starts here unless a test says otherwise.
STARTED = {"station": "lab", "sent": False, "project": "widget", "pipeline": "nightly", "run": 1, "status": "running"}


# Fakes ------------------------------------------------------------------------
class FakeClock:
    """
    A naive local wall clock that the test sets by hand
    """

    def __init__(self, now: datetime) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now


class FakePlumber:
    """
    Plumber's /logs and /run routes, with every call recorded

    stations maps a station name to its runs, or to an error string. logs replaces the whole /logs
    answer when set. answer is the run request's (status, payload), or an exception to raise. down
    makes every call fail as if Plumber were not running. gate, when set, holds every call until set.
    """

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, bytes | None, float]] = []
        self.stations: dict[str, list | str] = {"lab": []}
        self.logs: tuple[int, object] | None = None
        self.answer: tuple[int, object] | BaseException = (200, STARTED)
        self.down = False
        self.gate: threading.Event | None = None
        self.lock = threading.Lock()

    def __call__(self, method: str, url: str, body: bytes | None, timeout: float) -> tuple[int, bytes]:
        with self.lock:
            self.calls.append((method, url, body, timeout))
        if self.gate is not None and not self.gate.wait(5):
            raise AssertionError("The test never opened the gate")
        if self.down:
            raise urllib.error.URLError(ConnectionRefusedError(111, "Connection refused"))
        if method == "GET":
            entries = [
                {"station": name, "error": runs} if isinstance(runs, str) else {"station": name, "runs": runs}
                for name, runs in self.stations.items()
            ]
            return self._encode(self.logs or (200, entries))
        if isinstance(self.answer, BaseException):
            raise self.answer
        return self._encode(self.answer)

    @staticmethod
    def _encode(answer: tuple[int, object]) -> tuple[int, bytes]:
        status, payload = answer
        return status, payload if isinstance(payload, bytes) else json.dumps(payload).encode()

    def started(self) -> list[str]:
        """
        The pipeline or system named by each run request, in order
        """

        with self.lock:
            posts = [urlsplit(url).path for method, url, _, _ in self.calls if method == "POST"]
        return [unquote(path.rsplit("/", 1)[1]) for path in posts]


# Helpers ----------------------------------------------------------------------
@pytest.fixture
def make(tmp_path):
    """
    A factory for a Scheduler on tmp_path/schedules.toml, a FakePlumber, and a FakeClock, with the
    given schedules added through the API. Every scheduler made is stopped afterwards.
    """

    made = []

    def factory(*schedules: dict, start: datetime = START, **kwargs) -> tuple[Scheduler, FakePlumber, FakeClock]:
        clock = FakeClock(start)
        plumber = FakePlumber()
        scheduler = Scheduler(tmp_path / "schedules.toml", PLUMBER, call=plumber, clock=clock, **kwargs)
        made.append(scheduler)
        for body in schedules:
            assert request(scheduler, "POST", "/schedule/add", body) == (200, {"name": body["name"], "added": True})
        return scheduler, plumber, clock

    yield factory
    for scheduler in made:
        scheduler.stop()


def schedule(name: str, cron: str = "* * * * *", *, kind: str = "pipeline", target: str = "", **fields) -> dict:
    """
    A schedule body. It runs the pipeline (or system) named like the schedule, of project widget on lab.
    """

    return {"name": name, "project": "widget", kind: target or name, "station": "lab", "cron": cron, **fields}


def request(scheduler: Scheduler, method: str, path: str, body: object = None, query: str = "") -> tuple[int, object]:
    """
    scheduler.handle() with body sent as JSON, unless it is bytes already
    """

    raw = body if isinstance(body, bytes) else b"" if body is None else json.dumps(body).encode()
    return scheduler.handle(method, path, query, raw)


def listing(scheduler: Scheduler) -> dict:
    """
    The GET /schedule/list payload
    """

    status, payload = request(scheduler, "GET", "/schedule/list")
    assert status == 200
    return payload


def entry(scheduler: Scheduler, name: str) -> dict:
    """
    One schedule from the listing
    """

    return next(item for item in listing(scheduler)["schedules"] if item["name"] == name)


def wait_until(condition: Callable[[], object], what: str) -> None:
    """
    Poll condition every millisecond until it holds. Fails with 'what' after 5 seconds.
    """

    deadline = time.monotonic() + 5
    while not condition():
        assert time.monotonic() < deadline, what
        time.sleep(0.001)


def settle(scheduler: Scheduler) -> None:
    """
    Wait until no fire is in flight. tick() marks a fire in flight before it returns, and a fire
    logs its outcome before it keeps it and clears the mark, so nothing slips past this.
    """

    wait_until(lambda: not any(item["firing"] for item in listing(scheduler)["schedules"]), "A fire did not finish")


def iso(t: datetime) -> str:
    """
    A naive local time the way the scheduler shows it
    """

    return t.astimezone().isoformat(timespec="minutes")


def minutes(first: datetime, last: datetime) -> list[datetime]:
    """
    Every minute from first to last, both included
    """

    return [first + timedelta(minutes=i) for i in range(int((last - first).total_seconds()) // 60 + 1)]


def fires_by_tick(scheduler: Scheduler, plumber: FakePlumber, ticks: list[datetime]) -> list[tuple[str, list[str]]]:
    """
    tick() each minute in turn and note what each tick started, as ("HH:MM", sorted names)
    """

    seen = []
    for minute in ticks:
        before = len(plumber.started())
        scheduler.tick(minute)
        settle(scheduler)
        started = plumber.started()[before:]
        if started:
            seen.append((f"{minute:%H:%M}", sorted(started)))
    return seen


def fire(scheduler: Scheduler, name: str = "nightly") -> dict:
    """
    Check the minute after START, wait for the fire, and return the schedule's last outcome
    """

    scheduler.tick(START + timedelta(minutes=1))
    settle(scheduler)
    return entry(scheduler, name)["last"]


def messages(caplog, level: int) -> list[str]:
    """
    The messages logged at exactly this level
    """

    return [record.getMessage() for record in caplog.records if record.levelno == level]


# Cron grammar -----------------------------------------------------------------
@pytest.mark.parametrize(
    ("expr", "field", "values"),
    [
        ("* * * * *", "minutes", set(range(60))),
        ("*/15 * * * *", "minutes", {0, 15, 30, 45}),
        ("5-59/15 * * * *", "minutes", {5, 20, 35, 50}),
        ("1,2,10-12 * * * *", "minutes", {1, 2, 10, 11, 12}),
        ("0 9-17/4 * * *", "hours", {9, 13, 17}),
        ("00 07 * * *", "hours", {7}),
        ("0 0 */10 * *", "days", {1, 11, 21, 31}),
        ("0 0 * 3-5,11 *", "months", {3, 4, 5, 11}),
        ("0 0 * * 1-5", "weekdays", {1, 2, 3, 4, 5}),
        ("0 0 * * 5-7", "weekdays", {5, 6, 0}),
        ("0 0 * * */2", "weekdays", {0, 2, 4, 6}),
        ("0 0 * * 0-7", "weekdays", set(range(7))),
    ],
)
def test_cron_fields(expr, field, values):
    assert set(getattr(parse_cron(expr), field)) == values


def test_cron_text_is_normalised_to_single_spaces():
    assert parse_cron(" 0\t2   * *\t\t* ").text == "0 2 * * *"
    assert parse_cron("0" + " " * 92 + "0 * * *").text == "0 0 * * *"  # Exactly 100 characters


@pytest.mark.parametrize(
    ("expr", "message"),
    [
        ("", "expected 5 fields: minute hour day-of-month month day-of-week"),
        ("* * * *", "expected 5 fields: minute hour day-of-month month day-of-week"),
        ("* * * * * *", "expected 5 fields"),
        ("@daily", "Macros like @daily are not supported"),
        (" @reboot", "Macros like @daily are not supported"),
        ("0 0 * JAN *", "month: names like 'JAN' are not supported; use the numbers 1-12"),
        ("0 0 * * MON", "day-of-week: names like 'MON' are not supported; use the numbers 0-7 (0 and 7 are Sunday)"),
        ("0 0 * * mon-fri", "day-of-week: names like 'mon-fri'"),
        ("0 0 ? * *", "day-of-month: '?' is not supported"),
        ("0 0 L * *", "day-of-month: 'L' is not supported"),
        ("0 0 15W * *", "day-of-month: '15W' is not supported"),
        ("0 0 * * 5#3", "day-of-week: '5#3' is not supported"),
        ("5/15 * * * *", "minute: '5/15' needs a range; write 5-59/15"),
        ("0 2/6 * * *", "hour: '2/6' needs a range; write 2-23/6"),
        ("*/0 * * * *", "minute: the step in '*/0' must be at least 1"),
        ("0 0 1-31/0 * *", "day-of-month: the step in '1-31/0' must be at least 1"),
        ("0 17-9 * * *", "hour: the range 17-9 goes backwards"),
        ("60 * * * *", "minute: 60 is outside 0-59"),
        ("0 24 * * *", "hour: 24 is outside 0-23"),
        ("0 0 0 * *", "day-of-month: 0 is outside 1-31"),
        ("0 0 32 * *", "day-of-month: 32 is outside 1-31"),
        ("0 0 * 0 *", "month: 0 is outside 1-12"),
        ("0 0 * 13 *", "month: 13 is outside 1-12"),
        ("0 0 * * 8", "day-of-week: 8 is outside 0-7"),
        ("0 0 * * 1-9", "day-of-week: 9 is outside 0-7"),
        ("1,,2 * * * *", "minute: '1,,2' has an empty item"),
        ("0 1, * * *", "hour: '1,' has an empty item"),
        ("1.5 * * * *", "minute: '1.5' is not supported"),
        ("-1 * * * *", "minute: '-1' is not supported"),
        ("+1 * * * *", "minute: '+1' is not supported"),
        ("*/x * * * *", "minute: '*/x' is not supported"),
        ("0 0 1-*/2 * *", "day-of-month: '1-*/2' is not supported"),
        ("\u0663 * * * *", "minute: '\u0663' is not supported"),  # An Arabic-Indic 3 is not a cron number
        ("0 0 * * *\n", "day-of-week: "),  # Only spaces and tabs separate fields
        ("0 0 * * * " + "0" * 100, "cron must be at most 100 characters"),
    ],
)
def test_cron_errors_name_the_field(expr, message):
    with pytest.raises(ValueError) as error:
        parse_cron(expr)
    assert message in str(error.value)


def test_cron_must_be_a_string():
    with pytest.raises(ValueError, match="cron must be a string"):
        parse_cron(None)


def test_day_of_week_7_is_sunday_like_0():
    sunday = datetime(2026, 10, 11, 0, 0)
    seven, zero = parse_cron("0 0 * * 7"), parse_cron("0 0 * * 0")
    assert seven.weekdays == zero.weekdays == frozenset({0})
    assert seven.matches(sunday) and zero.matches(sunday)
    assert not seven.matches(sunday + timedelta(days=1))
    sundays = [datetime(2026, 10, 11), datetime(2026, 10, 18), datetime(2026, 10, 25)]
    assert next_fires(seven, START, 3) == next_fires(zero, START, 3) == sundays


def october_days(expr: str) -> list[int]:
    """
    The days of October 2026 an expression that fires at midnight fires on
    """

    fires = next_fires(parse_cron(expr), datetime(2026, 9, 30, 23, 59), 31)
    return [fire.day for fire in fires if (fire.year, fire.month) == (2026, 10)]


@pytest.mark.parametrize(
    ("expr", "days"),
    [
        ("0 0 1,15 * 1", [1, 5, 12, 15, 19, 26]),  # Both restricted: the 1st, the 15th, and every Monday
        ("0 0 */2 * 1", [5, 19]),  # '*/2' is not restricted: odd-numbered days that are Mondays
        ("0 0 1-7 * 1", [1, 2, 3, 4, 5, 6, 7, 12, 19, 26]),  # Days 1-7 or Mondays
        ("0 0 * * 1", [5, 12, 19, 26]),
        ("0 0 1,15 * *", [1, 15]),
        ("0 0 13 * */7", []),  # The 13th, when it is a Sunday (not in October 2026)
    ],
)
def test_day_of_month_and_day_of_week_combine_like_vixie_cron(expr, days):
    assert october_days(expr) == days  # In October 2026 the 1st is a Thursday, Mondays are 5, 12, 19 and 26


def test_cron_matches_minute_hour_day_and_month():
    cron = parse_cron("30 2 * 3 *")
    assert cron.matches(datetime(2026, 3, 29, 2, 30, 45))
    assert not cron.matches(datetime(2026, 3, 29, 2, 31))
    assert not cron.matches(datetime(2026, 3, 29, 3, 30))
    assert not cron.matches(datetime(2026, 4, 1, 2, 30))


@pytest.mark.parametrize(
    ("expr", "after", "expected"),
    [
        ("0 0 1 * *", datetime(2026, 1, 31, 12, 0), [datetime(2026, 2, 1), datetime(2026, 3, 1), datetime(2026, 4, 1)]),
        (
            "30 6 31 * *",
            datetime(2027, 1, 31, 6, 30),  # Strictly after: the 31st of January itself is not included
            [datetime(2027, 3, 31, 6, 30), datetime(2027, 5, 31, 6, 30), datetime(2027, 7, 31, 6, 30)],
        ),
        (
            "0 0 28-29 2 *",
            datetime(2027, 2, 28, 0, 0),
            [datetime(2028, 2, 28), datetime(2028, 2, 29), datetime(2029, 2, 28)],
        ),
        ("0 12 29 2 *", START, [datetime(2028, 2, 29, 12, 0)]),  # 29 February 2032 is more than 5 years away
        (
            "59 23 31 12 *",
            datetime(2026, 12, 31, 23, 59),
            [datetime(2027, 12, 31, 23, 59), datetime(2028, 12, 31, 23, 59), datetime(2029, 12, 31, 23, 59)],
        ),
        (
            "*/15 * * * *",
            datetime(2026, 10, 31, 23, 30),
            [datetime(2026, 10, 31, 23, 45), datetime(2026, 11, 1, 0, 0), datetime(2026, 11, 1, 0, 15)],
        ),
        (
            "* * * * *",
            datetime(2026, 10, 9, 10, 0, 30),
            [datetime(2026, 10, 9, 10, 1), datetime(2026, 10, 9, 10, 2), datetime(2026, 10, 9, 10, 3)],
        ),
        (
            "0 0 30 2 1",  # 30 February never comes, but both day fields are restricted: Mondays in February
            START,
            [datetime(2027, 2, 1), datetime(2027, 2, 8), datetime(2027, 2, 15)],
        ),
    ],
)
def test_next_fires(expr, after, expected):
    assert next_fires(parse_cron(expr), after, 3) == expected


@pytest.mark.parametrize("expr", ["0 0 30 2 *", "0 0 31 4,6,9,11 *", "0 0 31 2 */7"])
def test_expressions_that_never_fire(expr):
    assert next_fires(parse_cron(expr), START, 3) == []
    with pytest.raises(ValueError, match="never fires within 5 years"):
        check_schedule(schedule("never", expr), START)


def test_never_fires_is_judged_from_now():
    leap = schedule("leap", "0 0 29 2 *")
    assert check_schedule(leap, START)["cron"] == "0 0 29 2 *"
    with pytest.raises(ValueError, match="never fires within 5 years"):
        check_schedule(leap, datetime(2097, 3, 1))  # 2100 is not a leap year; the next 29 February is in 2104


# Preview ----------------------------------------------------------------------
def test_preview(make):
    scheduler, _, clock = make()
    clock.now = datetime(2026, 10, 9, 10, 7, 30)
    quarters = [datetime(2026, 10, 9, 10, 15), datetime(2026, 10, 9, 10, 30), datetime(2026, 10, 9, 10, 45)]
    assert request(scheduler, "GET", "/schedule/preview", query="cron=*/15+*+*+*+*") == (
        200,
        {"next": [iso(t) for t in quarters]},
    )
    nights = [datetime(2026, 10, 10, 2, 0), datetime(2026, 10, 11, 2, 0), datetime(2026, 10, 12, 2, 0)]
    assert request(scheduler, "GET", "/schedule/preview", query="cron=0%202%20*%20*%20*") == (
        200,
        {"next": [iso(t) for t in nights]},
    )
    assert request(scheduler, "GET", "/schedule/preview", query="cron=0+24+*+*+*") == (
        400,
        {"detail": "hour: 24 is outside 0-23"},
    )
    status, payload = request(scheduler, "GET", "/schedule/preview", query="cron=0+0+30+2+*")
    assert status == 400 and "never fires" in payload["detail"]
    assert request(scheduler, "GET", "/schedule/preview")[0] == 400
    assert request(scheduler, "GET", "/schedule/preview", query="cron=")[0] == 400
    assert request(scheduler, "POST", "/schedule/preview", query="cron=*+*+*+*+*")[0] == 405


# Minute checks ----------------------------------------------------------------
def test_spring_forward_fires_the_skipped_hour_once_at_the_jump(make):
    day = datetime(2026, 3, 29)  # Clocks go forward from 02:00 to 03:00 in much of Europe
    scheduler, plumber, _ = make(
        schedule("at-0200", "0 2 * * *"),
        schedule("at-0230", "30 2 * * *"),
        schedule("quarter", "*/15 * * * *"),
        start=day.replace(hour=1),
    )
    ticks = minutes(day.replace(hour=1, minute=1), day.replace(hour=1, minute=59))
    ticks += minutes(day.replace(hour=3), day.replace(hour=3, minute=20))  # 02:00-02:59 never show on the clock
    assert fires_by_tick(scheduler, plumber, ticks) == [
        ("01:15", ["quarter"]),
        ("01:30", ["quarter"]),
        ("01:45", ["quarter"]),
        ("03:00", ["at-0200", "at-0230", "quarter"]),
        ("03:15", ["quarter"]),
    ]


def test_fall_back_fires_nothing_twice(make):
    day = datetime(2026, 10, 25)  # Clocks go back from 03:00 to 02:00
    scheduler, plumber, _ = make(
        schedule("at-0230", "30 2 * * *"),
        schedule("quarter", "*/15 * * * *"),
        start=day.replace(hour=1),
    )
    first_pass = minutes(day.replace(hour=1, minute=1), day.replace(hour=2, minute=59))
    repeated = minutes(day.replace(hour=2), day.replace(hour=2, minute=59))
    after = minutes(day.replace(hour=3), day.replace(hour=3, minute=15))
    assert fires_by_tick(scheduler, plumber, first_pass + repeated + after) == [
        ("01:15", ["quarter"]),
        ("01:30", ["quarter"]),
        ("01:45", ["quarter"]),
        ("02:00", ["quarter"]),
        ("02:15", ["quarter"]),
        ("02:30", ["at-0230", "quarter"]),
        ("02:45", ["quarter"]),
        ("03:00", ["quarter"]),  # Nothing during the repeated hour
        ("03:15", ["quarter"]),
    ]


def test_a_two_hour_stall_makes_up_only_the_last_hour(make, caplog):
    scheduler, plumber, _ = make(
        schedule("at-1130", "30 11 * * *"),
        schedule("at-1100", "0 11 * * *"),
        schedule("every-5", "*/5 * * * *"),
    )
    with caplog.at_level(logging.INFO, logger="plumbergui"):
        scheduler.tick(datetime(2026, 10, 9, 12, 0))
        settle(scheduler)
    assert sorted(plumber.started()) == ["at-1130", "every-5"]  # every-5 once, not 24 times
    warnings = messages(caplog, logging.WARNING)
    assert len(warnings) == 1
    assert "plumber-gui was not checking schedules between 2026-10-09 10:00 and 2026-10-09 11:00" in warnings[0]
    assert "'at-1100'" in warnings[0] and "'at-1130'" not in warnings[0]


def test_a_gap_of_up_to_61_minutes_is_made_up_in_full(make, caplog):
    scheduler, plumber, _ = make(schedule("at-1001", "1 10 * * *"), schedule("every-5", "*/5 * * * *"))
    with caplog.at_level(logging.WARNING, logger="plumbergui"):
        scheduler.tick(START + timedelta(minutes=61))  # The gap of one check across clocks going forward
        settle(scheduler)
    assert sorted(plumber.started()) == ["at-1001", "every-5"]
    assert messages(caplog, logging.WARNING) == []


def test_each_minute_is_checked_once_and_the_start_minute_not_at_all(make):
    scheduler, plumber, _ = make(
        schedule("at-1000", "0 10 * * *"),
        schedule("at-1003", "3 10 * * *"),
        schedule("off", enabled=False),
    )
    ticks = [START, START + timedelta(minutes=1), START + timedelta(minutes=3)]
    ticks += minutes(START + timedelta(minutes=1), START + timedelta(minutes=4))  # The clock was set back by hand
    assert fires_by_tick(scheduler, plumber, ticks) == [("10:03", ["at-1003"])]


# Fires ------------------------------------------------------------------------
def test_fire_started(make, caplog):
    scheduler, plumber, _ = make(schedule("nightly", target="slow"))
    plumber.answer = (200, {**STARTED, "pipeline": "slow", "sent": True, "run": 4})
    with caplog.at_level(logging.INFO, logger="plumbergui"):
        outcome = fire(scheduler)
    assert outcome == {"at": iso(START + timedelta(minutes=1)), "outcome": "started", "run": 4, "sent": True}
    assert plumber.calls == [
        ("GET", f"{PLUMBER}/logs/pipelines", None, 300),
        ("POST", f"{PLUMBER}/run/pipeline/widget/slow?station=lab", b"", 300),
    ]
    assert messages(caplog, logging.INFO) == [
        "Schedule 'nightly' started pipeline 'slow' of 'widget' on 'lab' as run #4"
    ]


def test_a_fire_logs_its_outcome_before_it_stops_being_in_flight(make, caplog):
    scheduler, _, _ = make(schedule("nightly"))
    seen = []

    class Probe(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            # Read without the lock: a fire that logged while holding it would deadlock here instead of failing
            seen.append(("nightly" in scheduler._in_flight, "nightly" in scheduler._outcomes))

    probe = Probe()
    logging.getLogger("plumbergui").addHandler(probe)
    try:
        with caplog.at_level(logging.INFO, logger="plumbergui"):
            fire(scheduler)
    finally:
        logging.getLogger("plumbergui").removeHandler(probe)
    assert seen == [(True, False)]  # Still in flight, outcome not kept yet: settle() relies on this order


def test_a_fire_does_not_stay_in_flight_when_logging_fails(make, caplog, monkeypatch):
    scheduler, _, _ = make(schedule("nightly"))
    raised: list[BaseException] = []
    monkeypatch.setattr(threading, "excepthook", lambda args: raised.append(args.exc_value))

    class Broken(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            raise RuntimeError("broken handler")

    broken = Broken()
    logging.getLogger("plumbergui").addHandler(broken)
    try:
        with caplog.at_level(logging.INFO, logger="plumbergui"):
            outcome = fire(scheduler)  # Its settle() fails if the schedule stays in flight
    finally:
        logging.getLogger("plumbergui").removeHandler(broken)
    assert outcome["outcome"] == "started"
    # The error still ends the fire's thread, where the thread hook reports it
    wait_until(lambda: raised, "The logging error never reached the thread hook")
    assert isinstance(raised[0], RuntimeError)


def test_fire_skipped_while_the_target_runs(make, caplog):
    scheduler, plumber, _ = make(schedule("nightly", target="slow"))
    plumber.stations = {
        "lab": [
            {"project": "widget", "pipeline": "slow", "run": 6, "status": "finished"},
            {"project": "widget", "pipeline": "slow", "run": 8, "status": "errored"},
            {"project": "widget", "pipeline": "other", "run": 1, "status": "running"},
            {"project": "gadget", "pipeline": "slow", "run": 2, "status": "running"},
        ],
        "bench": [{"project": "widget", "pipeline": "slow", "run": 9, "status": "running"}],
    }
    # Only "running" counts: not finished or errored runs, nor other targets, projects, or stations
    assert fire(scheduler)["outcome"] == "started"

    plumber.stations["lab"].append({"project": "widget", "pipeline": "slow", "run": 7, "status": "running"})
    with caplog.at_level(logging.WARNING, logger="plumbergui"):
        scheduler.tick(START + timedelta(minutes=2))
        settle(scheduler)
    assert entry(scheduler, "nightly")["last"] == {
        "at": iso(START + timedelta(minutes=2)),
        "outcome": "skipped",
        "detail": "run #7 is still running",
    }
    assert plumber.started() == ["slow"]
    assert messages(caplog, logging.WARNING) == [
        "Schedule 'nightly' for pipeline 'slow' of 'widget' on 'lab' skipped: run #7 is still running"
    ]


def test_fire_skipped_while_the_previous_fire_waits_for_plumber(make, caplog):
    scheduler, plumber, _ = make(schedule("nightly"))
    plumber.gate = threading.Event()
    try:
        scheduler.tick(START + timedelta(minutes=1))
        assert entry(scheduler, "nightly")["firing"] is True
        with caplog.at_level(logging.WARNING, logger="plumbergui"):
            scheduler.tick(START + timedelta(minutes=2))
        waiting = entry(scheduler, "nightly")
        assert waiting["firing"] is True
        assert waiting["last"] == {
            "at": iso(START + timedelta(minutes=2)),
            "outcome": "skipped",
            "detail": "the previous fire is still waiting for Plumber",
        }
        assert messages(caplog, logging.WARNING) == [
            "Schedule 'nightly' for pipeline 'nightly' of 'widget' on 'lab' skipped: "
            "the previous fire is still waiting for Plumber"
        ]
    finally:
        plumber.gate.set()
    settle(scheduler)
    done = entry(scheduler, "nightly")
    assert done["firing"] is False
    assert done["last"]["outcome"] == "started" and done["last"]["at"] == iso(START + timedelta(minutes=1))
    assert plumber.started() == ["nightly"]


@pytest.mark.parametrize(
    ("stations", "logs", "detail"),
    [
        ({"lab": "Station 'lab' did not respond"}, None, "Could not check runs on lab: Station 'lab' did not respond"),
        ({"bench": []}, None, "Station 'lab' is not configured in Plumber"),
        ({"lab": []}, (500, b"Internal Server Error"), "Plumber did not list the runs: HTTP 500"),
    ],
)
def test_fire_failed_on_the_run_check(make, stations, logs, detail):
    scheduler, plumber, _ = make(schedule("nightly"))
    plumber.stations = stations
    plumber.logs = logs
    assert fire(scheduler) == {"at": iso(START + timedelta(minutes=1)), "outcome": "failed", "detail": detail}
    assert plumber.started() == []


def test_fire_failed_when_plumber_is_down(make):
    scheduler, plumber, _ = make(schedule("nightly"))
    plumber.down = True
    assert fire(scheduler) == {
        "at": iso(START + timedelta(minutes=1)),
        "outcome": "failed",
        "detail": "Plumber did not respond",
    }


@pytest.mark.parametrize(
    ("answer", "outcome", "detail"),
    [
        ((404, {"detail": "Project 'widget' not found"}), "failed", "Project 'widget' not found"),
        ((404, {"detail": "Station 'lab' not found"}), "failed", "Station 'lab' not found"),
        ((502, {"detail": "Station 'lab' did not start the run"}), "failed", "Station 'lab' did not start the run"),
        ((500, b"Internal Server Error"), "failed", "HTTP 500"),
        (
            (502, {"detail": "Station 'lab' did not respond"}),
            "unknown",
            "Station 'lab' did not respond; the run may have started",
        ),
        (TimeoutError("timed out"), "unknown", "No answer from Plumber within 300 s; the run may have started"),
        (socket.timeout("timed out"), "unknown", "No answer from Plumber within 300 s; the run may have started"),
        (ConnectionResetError(104, "Connection reset by peer"), "failed", "Plumber did not respond"),
        (urllib.error.URLError("Connection refused"), "failed", "Plumber did not respond"),
    ],
)
def test_fire_outcome_of_the_run_request(make, caplog, answer, outcome, detail):
    scheduler, plumber, _ = make(schedule("nightly"))
    plumber.answer = answer
    with caplog.at_level(logging.INFO, logger="plumbergui"):
        assert fire(scheduler) == {"at": iso(START + timedelta(minutes=1)), "outcome": outcome, "detail": detail}
    assert plumber.started() == ["nightly"]  # Sent once, never retried
    assert messages(caplog, logging.WARNING) == [
        f"Schedule 'nightly' for pipeline 'nightly' of 'widget' on 'lab' {outcome}: {detail}"
    ]


def test_the_timeout_is_passed_on_and_reported(make):
    scheduler, plumber, _ = make(schedule("nightly"), timeout=7)
    plumber.answer = TimeoutError("timed out")
    assert fire(scheduler)["detail"] == "No answer from Plumber within 7 s; the run may have started"
    assert {call[3] for call in plumber.calls} == {7}


def test_names_are_encoded_in_the_run_request(make):
    scheduler, plumber, _ = make(schedule("nightly", project="my project", target="ñandú", station="a+b&c"))
    plumber.stations = {"a+b&c": []}
    assert fire(scheduler)["outcome"] == "started"
    assert plumber.calls[-1][:2] == ("POST", f"{PLUMBER}/run/pipeline/my%20project/%C3%B1and%C3%BA?station=a%2Bb%26c")


def test_a_system_schedule_uses_the_system_routes(make):
    scheduler, plumber, _ = make(schedule("nightly", kind="system", target="daily"))
    plumber.stations = {"lab": [{"project": "widget", "system": "daily", "run": 3, "status": "running"}]}
    assert fire(scheduler)["detail"] == "run #3 is still running"
    assert plumber.calls == [("GET", f"{PLUMBER}/logs/systems", None, 300)]

    plumber.stations = {"lab": [{"project": "widget", "system": "daily", "run": 3, "status": "finished"}]}
    scheduler.tick(START + timedelta(minutes=2))
    settle(scheduler)
    assert entry(scheduler, "nightly")["last"]["outcome"] == "started"
    assert plumber.calls[-1][:2] == ("POST", f"{PLUMBER}/run/system/widget/daily?station=lab")


# Records ----------------------------------------------------------------------
def test_check_schedule_normalises_the_record():
    body = {"enabled": False, "cron": " 0  2\t* * 1-5 ", "station": "lab", "system": "daily", "project": "w"}
    body["name"] = "n"  # Last, so the key order really changes
    record = check_schedule(body)
    assert list(record) == ["name", "project", "system", "station", "cron", "enabled"]
    assert record == {**body, "cron": "0 2 * * 1-5"}
    record = check_schedule(schedule("n"))
    assert list(record) == ["name", "project", "pipeline", "station", "cron", "enabled"]
    assert record["enabled"] is True


@pytest.mark.parametrize(
    ("body", "message"),
    [
        (None, "A schedule must be an object"),
        ([], "A schedule must be an object"),
        ("nightly", "A schedule must be an object"),
        (schedule("n", colour="blue"), "Unknown field 'colour'"),
        (schedule("n", system="daily"), "Give a pipeline or a system, not both"),
        ({"name": "n", "project": "w", "station": "lab", "cron": "* * * * *"}, "Give the pipeline or system to run"),
        ({**schedule("n"), "cron": None}, "cron must be a string"),
        ({key: value for key, value in schedule("n").items() if key != "cron"}, "cron must be a string"),
        (schedule("n", "0 24 * * *"), "hour: 24 is outside 0-23"),
        (schedule("n", enabled=1), "enabled must be true or false"),
        (schedule("n", enabled=0), "enabled must be true or false"),
        (schedule("n", enabled="true"), "enabled must be true or false"),
        (schedule("n", enabled=None), "enabled must be true or false"),
    ],
)
def test_check_schedule_refuses(body, message):
    with pytest.raises(ValueError) as error:
        check_schedule(body)
    assert message in str(error.value)


@pytest.mark.parametrize("name", ["", "-lead", ".dot", "_under", "a b", "a/b", "x" * 65, "ñu", "a\n", 5, None])
def test_bad_schedule_names(name):
    with pytest.raises(ValueError, match="Schedule name must be 1-64"):
        check_schedule({**schedule("n"), "name": name})


@pytest.mark.parametrize("name", ["a", "7", "A1._-z", "x" * 64])
def test_good_schedule_names(name):
    assert check_schedule({**schedule("n"), "name": name})["name"] == name


@pytest.mark.parametrize("field", ["project", "pipeline", "station"])
@pytest.mark.parametrize(
    ("value", "message"),
    [
        ("", "must be a non-empty string of at most 200 characters"),
        (5, "must be a non-empty string"),
        (None, "must be a non-empty string"),
        ("x" * 201, "of at most 200 characters"),
        ("a/b", "must be a single path segment and must not start with '.'"),
        ("lab/", "must be a single path segment"),
        (".hidden", "must not start with '.'"),
        ("..", "must not start with '.'"),
        ("a\x00b", "must not contain control characters"),
        ("tab\there", "must not contain control characters"),
        ("a\x7fb", "must not contain control characters"),
        ("rocket-\U0001F680", "must not contain emoji or other characters beyond U+FFFF"),
        ("lone-\ud800", "must not contain emoji or other characters beyond U+FFFF"),
    ],
)
def test_bad_target_names(field, value, message):
    with pytest.raises(ValueError) as error:
        check_schedule({**schedule("n"), field: value})
    assert str(error.value).startswith(f"{field.capitalize()} name ") and message in str(error.value)


@pytest.mark.parametrize("value", ["x" * 200, "café €uro", "a b", "a+b&c", "we\"ird\\name"])
def test_good_target_names(value):
    assert check_schedule({**schedule("n"), "project": value, "station": value})["station"] == value


# Requests ---------------------------------------------------------------------
def test_list(make):
    scheduler, _, clock = make(schedule("b-nightly", "0 2 * * *"), schedule("a-off", "0 3 * * *", enabled=False))
    clock.now = START + timedelta(minutes=5, seconds=30)
    payload = listing(scheduler)
    assert set(payload) == {"now", "timezone", "utc_offset", "started", "schedules"}
    assert payload["now"] == iso(clock.now)
    assert payload["started"] == iso(START)
    assert re.fullmatch(r"[+-]\d\d:\d\d", payload["utc_offset"]) and payload["now"].endswith(payload["utc_offset"])
    assert isinstance(payload["timezone"], str) and payload["timezone"]
    assert payload["schedules"] == [
        {
            "name": "a-off",
            "project": "widget",
            "pipeline": "a-off",
            "station": "lab",
            "cron": "0 3 * * *",
            "enabled": False,
            "next": None,
            "last": None,
            "firing": False,
        },
        {
            "name": "b-nightly",
            "project": "widget",
            "pipeline": "b-nightly",
            "station": "lab",
            "cron": "0 2 * * *",
            "enabled": True,
            "next": iso(datetime(2026, 10, 10, 2, 0)),
            "last": None,
            "firing": False,
        },
    ]


def test_add(make):
    scheduler, _, _ = make()
    assert request(scheduler, "POST", "/schedule/add", schedule("nightly")) == (200, {"name": "nightly", "added": True})
    assert request(scheduler, "POST", "/schedule/add", schedule("nightly", "0 3 * * *")) == (
        409,
        {"detail": "Schedule 'nightly' already exists"},
    )
    assert request(scheduler, "POST", "/schedule/add", b"{not json") == (
        400,
        {"detail": "A schedule must be an object with name, project, pipeline or system, station, and cron"},
    )
    assert request(scheduler, "POST", "/schedule/add", b"")[0] == 400
    assert request(scheduler, "POST", "/schedule/add", b"\xff\xfe\xfd")[0] == 400
    assert request(scheduler, "POST", "/schedule/add", [schedule("other")])[0] == 400
    assert request(scheduler, "POST", "/schedule/add", schedule("other", "0 24 * * *")) == (
        400,
        {"detail": "hour: 24 is outside 0-23"},
    )
    assert [item["name"] for item in listing(scheduler)["schedules"]] == ["nightly"]


def test_update_keeps_the_last_outcome(make):
    scheduler, _, _ = make(schedule("nightly"))
    first = fire(scheduler)
    changed = {key: value for key, value in schedule("nightly", "30 4 * * 1-5", enabled=False).items() if key != "name"}
    assert request(scheduler, "PUT", "/schedule/update/nightly", changed) == (200, {"name": "nightly", "updated": True})
    current = entry(scheduler, "nightly")
    assert (current["cron"], current["enabled"], current["last"]) == ("30 4 * * 1-5", False, first)
    assert request(scheduler, "PUT", "/schedule/update/nightly", schedule("nightly", "0 5 * * *"))[0] == 200

    status, payload = request(scheduler, "PUT", "/schedule/update/nightly", schedule("renamed"))
    assert status == 400 and "Renaming is not supported" in payload["detail"]
    assert request(scheduler, "PUT", "/schedule/update/missing", schedule("missing")) == (
        404,
        {"detail": "Schedule 'missing' not found"},
    )
    assert request(scheduler, "PUT", "/schedule/update/nightly", {"cron": "0 5 * * *"})[0] == 400
    assert request(scheduler, "PUT", "/schedule/update/nightly", b"[")[0] == 400
    assert entry(scheduler, "nightly")["cron"] == "0 5 * * *"


def test_remove_drops_the_last_outcome(make):
    scheduler, _, _ = make(schedule("nightly-run.v2"))
    assert fire(scheduler, "nightly-run.v2")["outcome"] == "started"
    assert request(scheduler, "DELETE", "/schedule/remove/nightly%2Drun.v2") == (
        200,
        {"name": "nightly-run.v2", "removed": True},
    )
    assert request(scheduler, "DELETE", "/schedule/remove/nightly-run.v2") == (
        404,
        {"detail": "Schedule 'nightly-run.v2' not found"},
    )
    assert request(scheduler, "POST", "/schedule/add", schedule("nightly-run.v2"))[0] == 200
    assert entry(scheduler, "nightly-run.v2")["last"] is None
    scheduler.tick(START + timedelta(minutes=2))
    settle(scheduler)
    assert entry(scheduler, "nightly-run.v2")["last"]["at"] == iso(START + timedelta(minutes=2))


def test_a_fire_waiting_when_its_schedule_is_removed_keeps_no_outcome(make, caplog):
    scheduler, plumber, _ = make(schedule("nightly"))
    plumber.gate = threading.Event()
    with caplog.at_level(logging.INFO, logger="plumbergui"):
        try:
            scheduler.tick(START + timedelta(minutes=1))
            assert request(scheduler, "DELETE", "/schedule/remove/nightly")[0] == 200
            assert request(scheduler, "POST", "/schedule/add", schedule("nightly"))[0] == 200
            assert entry(scheduler, "nightly")["firing"] is True  # The old fire keeps the name busy
        finally:
            plumber.gate.set()
        settle(scheduler)
    assert entry(scheduler, "nightly")["last"] is None  # The old fire's outcome is only logged
    assert messages(caplog, logging.INFO) == [
        "Schedule 'nightly' started pipeline 'nightly' of 'widget' on 'lab' as run #1"
    ]
    scheduler.tick(START + timedelta(minutes=2))  # The schedule added again keeps the outcome of its own fire
    settle(scheduler)
    assert entry(scheduler, "nightly")["last"]["at"] == iso(START + timedelta(minutes=2))


def test_a_schedule_removed_during_a_tick_keeps_no_outcome(make, monkeypatch):
    scheduler, plumber, _ = make(schedule("nightly"))
    plumber.gate = threading.Event()
    check = scheduler_module._fires_between

    def removed_meanwhile(*args):
        assert request(scheduler, "DELETE", "/schedule/remove/nightly")[0] == 200
        return check(*args)

    try:
        scheduler.tick(START + timedelta(minutes=1))  # This fire waits for Plumber
        monkeypatch.setattr(scheduler_module, "_fires_between", removed_meanwhile)
        scheduler.tick(START + timedelta(minutes=2))  # Removed after this tick's snapshot: its skip is dropped
        monkeypatch.undo()
        assert request(scheduler, "POST", "/schedule/add", schedule("nightly"))[0] == 200
        assert entry(scheduler, "nightly")["last"] is None
    finally:
        plumber.gate.set()
    settle(scheduler)
    assert entry(scheduler, "nightly")["last"] is None


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", ""),
        ("GET", "/"),
        ("GET", "/schedule"),
        ("GET", "/schedule/"),
        ("GET", "/schedules/list"),
        ("GET", "/schedule/list/"),
        ("GET", "/schedule/nope"),
        ("PUT", "/schedule/update"),
        ("PUT", "/schedule/update/"),
        ("DELETE", "/schedule/remove/a/b"),
    ],
)
def test_unknown_paths(make, method, path):
    scheduler, _, _ = make()
    assert request(scheduler, method, path) == (404, {"detail": "Not found"})


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("POST", "/schedule/list"),
        ("GET", "/schedule/add"),
        ("GET", "/schedule/update/nightly"),
        ("PUT", "/schedule/remove/nightly"),
        ("DELETE", "/schedule/preview"),
    ],
)
def test_wrong_methods(make, method, path):
    scheduler, _, _ = make()
    assert request(scheduler, method, path) == (405, {"detail": "Method not allowed"})


# Store ------------------------------------------------------------------------
def test_store_round_trip(make, tmp_path):
    bodies = [
        schedule("nightly", "0  2 * * *", project='we"ird\\ name é€', station="a+b&c"),
        schedule("weekly", "30 4 * * 1", kind="system", target="daily", enabled=False),
    ]
    scheduler, _, _ = make(*bodies)
    path = tmp_path / "schedules.toml"
    text = path.read_text(encoding="utf-8")
    assert text.startswith("# Cron schedules of plumber-gui")
    assert "edit it only while plumber-gui is stopped" in text
    assert tomllib.loads(text) == {"schedules": [check_schedule(body) for body in bodies]}
    keys = [line.split(" = ")[0] for line in text.splitlines() if line and not line.startswith(("#", "["))]
    assert keys == ["name", "project", "pipeline", "station", "cron", "enabled"] + [
        "name", "project", "system", "station", "cron", "enabled"
    ]

    again = Scheduler(path, PLUMBER, call=FakePlumber(), clock=FakeClock(START))
    again.load()
    assert listing(again)["schedules"] == listing(scheduler)["schedules"]
    again.stop()


def test_an_empty_list_is_written_as_an_empty_array(make, tmp_path):
    scheduler, _, _ = make(schedule("nightly"))
    assert request(scheduler, "DELETE", "/schedule/remove/nightly")[0] == 200
    text = (tmp_path / "schedules.toml").read_text(encoding="utf-8")
    assert "schedules = []" in text
    assert tomllib.loads(text) == {"schedules": []}


def test_writes_leave_no_temporary_files(make, tmp_path):
    scheduler, _, _ = make(schedule("a"), schedule("b"))
    assert request(scheduler, "PUT", "/schedule/update/a", schedule("a", "0 1 * * *"))[0] == 200
    assert request(scheduler, "DELETE", "/schedule/remove/b")[0] == 200
    assert [path.name for path in tmp_path.iterdir()] == ["schedules.toml"]


def test_a_failed_write_answers_500_and_changes_nothing(make, tmp_path, monkeypatch):
    scheduler, _, _ = make(schedule("nightly"))
    path = tmp_path / "schedules.toml"
    text = path.read_text(encoding="utf-8")
    before = listing(scheduler)["schedules"]

    def refuse(source, destination):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(scheduler_module.os, "replace", refuse)
    for method, route, body in [
        ("POST", "/schedule/add", schedule("weekly")),
        ("PUT", "/schedule/update/nightly", schedule("nightly", "0 5 * * *")),
        ("DELETE", "/schedule/remove/nightly", None),
    ]:
        status, payload = request(scheduler, method, route, body)
        assert status == 500
        assert payload["detail"] == f"Could not write {path}: [Errno 28] No space left on device"
    monkeypatch.undo()
    assert listing(scheduler)["schedules"] == before
    assert path.read_text(encoding="utf-8") == text
    assert [item.name for item in tmp_path.iterdir()] == ["schedules.toml"]


def test_a_missing_file_means_no_schedules(tmp_path):
    scheduler = Scheduler(tmp_path / "schedules.toml", PLUMBER, call=FakePlumber(), clock=FakeClock(START))
    scheduler.load()
    assert listing(scheduler)["schedules"] == []
    assert list(tmp_path.iterdir()) == []


RECORD = '[[schedules]]\nname = "nightly"\nproject = "w"\npipeline = "p"\nstation = "lab"\ncron = "* * * * *"\n'
DUPLICATE = RECORD * 2


@pytest.mark.parametrize(
    ("content", "reason"),
    [
        (b"schedules = [", "Invalid value"),
        (b"\xff\xfe", "can't decode byte 0xff"),
        (b"schedules = 5", "'schedules' must be a list of tables"),
        (b"schedules = [1]", "schedule 1: A schedule must be an object"),
        (b'[[schedules]]\nname = "nightly"\n', "schedule 1: Give the pipeline or system to run"),
        (DUPLICATE.encode(), "Schedule name 'nightly' is used more than once"),
        (DUPLICATE.replace('"lab"', '"lab"\ncolour = "blue"', 1).encode(), "schedule 1: Unknown field 'colour'"),
        (DUPLICATE.replace('"* * * * *"', '"* * * * *"\nenabled = 1', 1).encode(), "enabled must be true or false"),
        (DUPLICATE.replace('"* * * * *"', '"0 24 * * *"', 1).encode(), "schedule 1: hour: 24 is outside 0-23"),
    ],
)
def test_an_unusable_file_stops_plumber_gui(tmp_path, caplog, content, reason):
    path = tmp_path / "schedules.toml"
    path.write_bytes(content)
    scheduler = Scheduler(path, PLUMBER, call=FakePlumber(), clock=FakeClock(START))
    with caplog.at_level(logging.ERROR, logger="plumbergui"), pytest.raises(SystemExit) as stopped:
        scheduler.load()
    assert stopped.value.code == 1
    errors = messages(caplog, logging.ERROR)
    assert len(errors) == 1 and errors[0].startswith(f"{path}: ") and reason in errors[0]


def test_a_directory_in_place_of_the_file_stops_plumber_gui(tmp_path):
    path = tmp_path / "schedules.toml"
    path.mkdir()
    scheduler = Scheduler(path, PLUMBER, call=FakePlumber(), clock=FakeClock(START))
    with pytest.raises(SystemExit) as stopped:
        scheduler.load()
    assert stopped.value.code == 1


def test_a_file_nested_too_deeply_stops_plumber_gui(tmp_path, caplog):
    path = tmp_path / "schedules.toml"
    path.write_text("schedules = " + "[" * 100_000 + "]" * 100_000, encoding="utf-8")  # tomllib recurses into each [
    scheduler = Scheduler(path, PLUMBER, call=FakePlumber(), clock=FakeClock(START))
    with caplog.at_level(logging.ERROR, logger="plumbergui"), pytest.raises(SystemExit) as stopped:
        scheduler.load()
    assert stopped.value.code == 1
    errors = messages(caplog, logging.ERROR)
    assert len(errors) == 1 and errors[0].startswith(f"{path}: ")


def test_load_keeps_a_schedule_that_no_longer_fires_within_5_years(tmp_path):
    path = tmp_path / "schedules.toml"
    path.write_text(RECORD.replace("* * * * *", "0 0 30 2 *"), encoding="utf-8")  # The API refuses this one
    scheduler = Scheduler(path, PLUMBER, call=FakePlumber(), clock=FakeClock(START))
    scheduler.load()
    assert entry(scheduler, "nightly")["next"] is None


def test_concurrent_adds_and_updates_keep_the_file_equal_to_memory(make, tmp_path):
    scheduler, _, _ = make()
    barrier = threading.Barrier(8)
    statuses: list[int] = []
    lock = threading.Lock()

    def worker(index: int) -> None:
        name = f"job-{index}"
        barrier.wait()
        results = [request(scheduler, "POST", "/schedule/add", schedule(name, f"{index} * * * *"))[0]]
        for step in range(5):
            body = schedule(name, f"{index} {step} * * *", enabled=step % 2 == 0)
            results.append(request(scheduler, "PUT", f"/schedule/update/{name}", body)[0])
        with lock:
            statuses.extend(results)

    threads = [threading.Thread(target=worker, args=(index,)) for index in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert statuses == [200] * 48
    with (tmp_path / "schedules.toml").open("rb") as handle:
        on_disk = sorted(tomllib.load(handle)["schedules"], key=lambda record: record["name"])
    in_memory = [
        {key: value for key, value in item.items() if key not in ("next", "last", "firing")}
        for item in listing(scheduler)["schedules"]
    ]
    assert on_disk == in_memory == [check_schedule(schedule(f"job-{index}", f"{index} 4 * * *")) for index in range(8)]


# Thread -----------------------------------------------------------------------
def test_start_is_idempotent_and_stop_ends_the_thread(make):
    scheduler, _, _ = make()

    def loops() -> list[threading.Thread]:
        return [thread for thread in threading.enumerate() if thread.name == "plumbergui-scheduler"]

    before = len(loops())
    scheduler.start()
    scheduler.start()
    assert len(loops()) == before + 1
    assert all(thread.daemon for thread in loops())
    scheduler.stop()
    assert len(loops()) == before


def test_stop_returns_while_a_fire_waits_for_plumber(tmp_path):
    plumber = FakePlumber()
    plumber.gate = threading.Event()
    callers: list[threading.Thread] = []

    def call(method: str, url: str, body: bytes | None, timeout: float) -> tuple[int, bytes]:
        callers.append(threading.current_thread())
        return plumber(method, url, body, timeout)

    scheduler = Scheduler(tmp_path / "schedules.toml", PLUMBER, call=call, clock=FakeClock(START))
    assert request(scheduler, "POST", "/schedule/add", schedule("nightly"))[0] == 200
    try:
        scheduler.tick(START + timedelta(minutes=1))
        wait_until(lambda: callers, "The fire never called Plumber")  # Running, so stop() can't cancel it
        scheduler.stop()
        assert entry(scheduler, "nightly")["firing"] is True  # stop() returned without waiting for it
    finally:
        plumber.gate.set()
    settle(scheduler)
    assert entry(scheduler, "nightly")["last"]["outcome"] == "started"  # It still ended normally
    assert callers[0].daemon is True  # So a hung Plumber can't hold up plumber-gui's exit

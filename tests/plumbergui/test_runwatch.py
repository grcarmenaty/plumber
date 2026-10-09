"""
Tests for plumbergui.runwatch: when runs are seen starting and ending, what is logged, runs.jsonl,
and GET /gui/runs/times

Plumber and the clock are fakes, and read() is called directly. Run from the repository root with:
    PYTHONPATH=src python -m pytest -q tests/plumbergui/test_runwatch.py
"""

import json
import logging
import threading
import time
import urllib.error
from datetime import datetime, timedelta, timezone

import pytest

from plumbergui import runwatch as runwatch_module
from plumbergui.runwatch import RunWatch

PLUMBER = "http://plumber.test"
START = datetime(2026, 10, 9, 10, 0, tzinfo=timezone(timedelta(hours=2)))


# Fakes ------------------------------------------------------------------------
class FakeClock:
    def __init__(self) -> None:
        self.now = START

    def __call__(self) -> datetime:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += timedelta(seconds=seconds)


class FakePlumber:
    """
    Plumber's two run lists. stations maps a station to its pipeline runs, or to an error string;
    systems does the same for system runs. down makes every call fail as if Plumber were not running.
    """

    def __init__(self) -> None:
        self.stations: dict[str, list | str] = {"lab": []}
        self.systems: dict[str, list | str] = {}
        self.down = False
        self.calls = 0

    def __call__(self, method: str, url: str, body: bytes | None, timeout: float) -> tuple[int, bytes]:
        self.calls += 1
        if self.down:
            raise urllib.error.URLError(ConnectionRefusedError(111, "Connection refused"))
        source = self.stations if url.endswith("/logs/pipelines") else self.systems
        entries = [
            {"station": name, "error": runs} if isinstance(runs, str) else {"station": name, "runs": runs}
            for name, runs in source.items()
        ]
        return 200, json.dumps(entries).encode()


@pytest.fixture
def make(tmp_path):
    def build() -> tuple[RunWatch, FakePlumber, FakeClock]:
        plumber, clock = FakePlumber(), FakeClock()
        watch = RunWatch(tmp_path / "runs.jsonl", PLUMBER, call=plumber, clock=clock)
        watch.load()
        return watch, plumber, clock

    return build


def run(number: int, status: str = "running", name: str = "stream", project: str = "demo") -> dict:
    return {"project": project, "pipeline": name, "run": number, "status": status}


def times(watch: RunWatch) -> dict[tuple, dict]:
    status, payload = watch.handle("GET", "/runs/times", "", b"")
    assert status == 200
    return {(r["station"], r["kind"], r["project"], r["name"], r["run"]): r for r in payload["runs"]}


def stamp(seconds: float) -> str:
    return (START + timedelta(seconds=seconds)).isoformat(timespec="seconds")


def messages(caplog, level: int) -> list[str]:
    return [record.getMessage() for record in caplog.records if record.levelno == level]


# Seeing runs ------------------------------------------------------------------
def test_the_first_look_marks_running_runs_as_started_before_and_skips_ended_ones(make, caplog):
    watch, plumber, _ = make()
    plumber.stations = {"lab": [run(1, "finished"), run(2, "errored"), run(3)]}
    with caplog.at_level(logging.INFO, logger="plumbergui"):
        watch.read()
    known = times(watch)
    assert list(known) == [("lab", "pipeline", "demo", "stream", 3)]
    assert known[("lab", "pipeline", "demo", "stream", 3)] | {} == {
        "station": "lab", "kind": "pipeline", "project": "demo", "name": "stream", "run": 3, "status": "running",
        "started": stamp(0), "started_by": True, "ended": None, "ended_by": False,
    }
    assert messages(caplog, logging.INFO) == ["Run going: pipeline 'stream' of 'demo' #3 on 'lab'"]


def test_a_run_seen_starting_and_ending_gets_both_times(make, caplog):
    watch, plumber, clock = make()
    watch.read()
    clock.advance(10)
    plumber.stations = {"lab": [run(1)]}
    with caplog.at_level(logging.INFO, logger="plumbergui"):
        watch.read()
        for _ in range(42):  # Read every 10 s, as while a run is going
            clock.advance(10)
            watch.read()
        plumber.stations = {"lab": [run(1, "finished")]}
        watch.read()
    record = times(watch)[("lab", "pipeline", "demo", "stream", 1)]
    assert (record["started"], record["started_by"], record["ended"], record["ended_by"]) == (stamp(10), False, stamp(430), False)
    assert record["status"] == "finished"
    assert messages(caplog, logging.INFO) == [
        "Run started: pipeline 'stream' of 'demo' #1 on 'lab'",
        "Run finished: pipeline 'stream' of 'demo' #1 on 'lab' after 7 min",
    ]


def test_an_errored_run_is_a_warning(make, caplog):
    watch, plumber, clock = make()
    watch.read()
    plumber.stations = {"lab": [run(1)]}
    watch.read()
    clock.advance(45)
    plumber.stations = {"lab": [run(1, "errored")]}
    with caplog.at_level(logging.INFO, logger="plumbergui"):
        watch.read()
    assert messages(caplog, logging.WARNING) == ["Run errored: pipeline 'stream' of 'demo' #1 on 'lab' after 45 s"]


def test_a_run_over_between_two_reads_gets_an_end_by_time_only(make, caplog):
    watch, plumber, clock = make()
    watch.read()
    clock.advance(10)
    plumber.stations = {"lab": [run(1, "finished")]}
    with caplog.at_level(logging.INFO, logger="plumbergui"):
        watch.read()
    record = times(watch)[("lab", "pipeline", "demo", "stream", 1)]
    assert (record["started"], record["ended"], record["ended_by"]) == (None, stamp(10), True)
    assert messages(caplog, logging.INFO) == ["Run finished: pipeline 'stream' of 'demo' #1 on 'lab', briefly"]


def test_changes_after_a_long_gap_only_get_by_times(make):
    watch, plumber, clock = make()
    plumber.stations = {"lab": [run(1)]}
    watch.read()
    clock.advance(30)
    plumber.stations = {"lab": [run(1), run(2)]}
    watch.read()  # Run 2 is seen starting, within a normal gap
    plumber.stations = {"lab": "Station 'lab' did not respond"}
    for _ in range(10):  # Ten minutes without an answer
        clock.advance(60)
        watch.read()
    plumber.stations = {"lab": [run(1, "finished"), run(2), run(3)]}
    watch.read()
    known = times(watch)
    assert (known[("lab", "pipeline", "demo", "stream", 1)]["ended"], known[("lab", "pipeline", "demo", "stream", 1)]["ended_by"]) == (stamp(630), True)
    assert (known[("lab", "pipeline", "demo", "stream", 3)]["started"], known[("lab", "pipeline", "demo", "stream", 3)]["started_by"]) == (stamp(630), True)
    assert (known[("lab", "pipeline", "demo", "stream", 2)]["started"], known[("lab", "pipeline", "demo", "stream", 2)]["started_by"]) == (stamp(30), False)


def test_a_station_first_seen_late_starts_with_a_first_look(make):
    watch, plumber, clock = make()
    plumber.stations = {"lab": [], "edge": "Station 'edge' did not respond"}
    watch.read()
    clock.advance(600)
    plumber.stations = {"lab": [], "edge": [run(4, "finished"), run(5)]}
    watch.read()
    known = times(watch)
    assert list(known) == [("edge", "pipeline", "demo", "stream", 5)]  # Run 4 was over before anyone looked
    assert known[("edge", "pipeline", "demo", "stream", 5)]["started_by"] is True


def test_system_runs_are_watched_too(make):
    watch, plumber, clock = make()
    plumber.systems = {"lab": []}
    watch.read()
    plumber.systems = {"lab": [{"project": "demo", "system": "nightly", "run": 1, "status": "running"}]}
    clock.advance(5)
    watch.read()
    assert ("lab", "system", "demo", "nightly", 1) in times(watch)


def test_unusable_entries_are_ignored(make):
    watch, plumber, _ = make()
    plumber.stations = {"lab": [{"project": "demo"}, {"project": "demo", "pipeline": "x", "run": "1", "status": "running"},
                                "junk", {"project": "demo", "pipeline": "x", "run": True, "status": "running"}]}
    watch.read()
    watch.read()
    assert times(watch) == {}


# Log --------------------------------------------------------------------------
def test_stations_and_plumber_that_stop_answering_are_logged_once_each_way(make, caplog):
    watch, plumber, _ = make()
    with caplog.at_level(logging.INFO, logger="plumbergui"):
        watch.read()
        plumber.stations = {"lab": "Station 'lab' did not respond"}
        watch.read()
        watch.read()
        plumber.stations = {"lab": []}
        watch.read()
        plumber.down = True
        watch.read()
        watch.read()
        plumber.down = False
        watch.read()
    assert messages(caplog, logging.WARNING) == [
        "Station 'lab' did not list its runs: \"Station 'lab' did not respond\"",
        "Plumber did not respond; run times wait until it does",
    ]
    assert messages(caplog, logging.INFO) == ["Station 'lab' lists its runs again", "Plumber lists the runs again"]


def test_names_cannot_forge_log_lines(make, caplog):
    watch, plumber, clock = make()
    watch.read()
    plumber.stations = {"lab": [run(1, name="evil\n2026-10-09 10:00:00,000 - plumbergui: [ERROR]: forged")]}
    clock.advance(5)
    with caplog.at_level(logging.INFO, logger="plumbergui"):
        watch.read()
    assert all("\n" not in message for message in messages(caplog, logging.INFO))


# runs.jsonl -------------------------------------------------------------------
def test_times_survive_a_restart(make, tmp_path):
    watch, plumber, clock = make()
    watch.read()
    plumber.stations = {"lab": [run(1)]}
    clock.advance(5)
    watch.read()
    again = RunWatch(tmp_path / "runs.jsonl", PLUMBER, call=plumber, clock=clock)
    again.load()
    assert times(again) == times(watch)
    clock.advance(60)
    plumber.stations = {"lab": [run(1, "finished")]}
    again.read()  # Its first look: the run ended while nobody was looking
    record = times(again)[("lab", "pipeline", "demo", "stream", 1)]
    assert (record["started"], record["started_by"], record["ended"], record["ended_by"]) == (stamp(5), False, stamp(65), True)


def test_only_the_newest_runs_of_each_target_are_kept(make, tmp_path, monkeypatch):
    monkeypatch.setattr(runwatch_module, "KEEP", 3)
    watch, plumber, clock = make()
    watch.read()
    for number in range(1, 7):
        clock.advance(5)
        plumber.stations = {"lab": [run(n, "finished") for n in range(1, number)] + [run(number)]}
        watch.read()
    again = RunWatch(tmp_path / "runs.jsonl", PLUMBER, call=plumber, clock=clock)
    again.load()
    assert sorted(key[4] for key in times(again)) == [4, 5, 6]
    lines = (tmp_path / "runs.jsonl").read_text().splitlines()
    assert len(lines) == 3  # load() rewrote the file with what it keeps
    assert not list(tmp_path.glob(".runs-*"))


def test_bad_lines_in_the_file_are_skipped(tmp_path):
    good = {"station": "lab", "kind": "pipeline", "project": "demo", "name": "stream", "run": 2, "status": "finished",
            "started": stamp(0), "started_by": False, "ended": stamp(9), "ended_by": False}
    (tmp_path / "runs.jsonl").write_text("not json\n" + json.dumps({"station": "lab"}) + "\n" + json.dumps(good) + "\n")
    watch = RunWatch(tmp_path / "runs.jsonl", PLUMBER, call=FakePlumber(), clock=FakeClock())
    watch.load()
    assert list(times(watch).values()) == [good]


def test_an_unwritable_file_is_logged_and_the_times_kept_in_memory(make, tmp_path, caplog):
    watch, plumber, clock = make()
    watch.path = tmp_path / "missing-directory" / "runs.jsonl"
    watch.read()
    plumber.stations = {"lab": [run(1)]}
    clock.advance(5)
    with caplog.at_level(logging.WARNING, logger="plumbergui"):
        watch.read()
    assert ("lab", "pipeline", "demo", "stream", 1) in times(watch)
    assert any("Could not write" in message for message in messages(caplog, logging.WARNING))


# Requests and the thread ------------------------------------------------------
def test_requests(make):
    watch, _, _ = make()
    assert watch.handle("GET", "/runs/times", "", b"")[1] == {"now": stamp(0), "runs": []}
    assert watch.handle("POST", "/runs/times", "", b"")[0] == 405
    assert watch.handle("GET", "/runs/other", "", b"")[0] == 404


def test_a_nudge_reads_at_once(tmp_path, monkeypatch):
    monkeypatch.setattr(runwatch_module, "IDLE_EVERY", 60)
    plumber = FakePlumber()
    watch = RunWatch(tmp_path / "runs.jsonl", PLUMBER, call=plumber, clock=FakeClock())
    watch.start()
    try:
        deadline = time.monotonic() + 5
        while plumber.calls < 2 and time.monotonic() < deadline:  # The first read, both kinds
            time.sleep(0.005)
        watch.nudge()
        while plumber.calls < 4 and time.monotonic() < deadline:
            time.sleep(0.005)
        assert plumber.calls == 4
    finally:
        watch.stop()
    assert not [thread for thread in threading.enumerate() if thread.name == "plumbergui-runwatch"]

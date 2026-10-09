"""
Run times for plumber-gui

Plumber lists each run with its status, but not when it started or ended. While plumber-gui runs, a
thread reads those lists and notes when each run is first seen running and when it is seen ended:
within a read of the real times, and at once for starts and stops made through plumber-gui, which
ask for a read right away. The times are kept in runs.jsonl in plumber-gui's working directory, and
every start and end is also written to plumber-gui's log, as are stations that stop or start answering.
"""

import json
import logging
import os
import tempfile
import threading
from collections.abc import Callable
from datetime import datetime
from pathlib import Path

from plumbergui.scheduler import Call, _http, _json

BUSY_EVERY = 10  # Seconds between reads while a run is going
IDLE_EVERY = 30  # Seconds between reads otherwise
BLIND = 120  # Seconds: a change seen after a longer gap between reads only gets a "by" time
KEEP = 50  # Runs kept per station and pipeline or system, the newest ones, as the run list shows them
KINDS = ("pipeline", "system")

log = logging.getLogger("plumbergui")


def _now() -> datetime:
    return datetime.now().astimezone()


def _iso(t: datetime) -> str:
    return t.isoformat(timespec="seconds")


def _span(seconds: float) -> str:
    """
    A duration in words: "45 s", "12 min", "3 h 5 min"
    """

    if seconds < 60:
        return f"{round(seconds)} s"
    minutes = round(seconds / 60)
    if minutes < 60:
        return f"{minutes} min"
    return f"{minutes // 60} h" + (f" {minutes % 60} min" if minutes % 60 else "")


def _describe(record: dict) -> str:
    # repr() quotes the names and escapes any control character, so a name can't forge a log line
    return f"{record['kind']} {record['name']!r} of {record['project']!r} #{record['run']} on {record['station']!r}"


class RunWatch:
    """
    When each run started and ended, as seen by reading Plumber's run lists. A record is
    {station, kind, project, name, run, status, started, started_by, ended, ended_by}. started is
    when the run was first seen running, ended when it was first seen ended (ISO times, or null).
    A "_by" flag means it happened by that time, but after the read before: plumber-gui was not
    looking (it had just started, or a station or Plumber did not answer for a while).
    """

    def __init__(
        self,
        path: Path,
        plumber_url: str,
        *,
        call: Call | None = None,
        clock: Callable[[], datetime] | None = None,
        timeout: float = 60,
    ) -> None:
        """
        path is runs.jsonl. call is like the scheduler's. clock returns an aware local time.
        """

        self.path = Path(path)
        self.plumber_url = plumber_url.rstrip("/")
        self.timeout = timeout  # Seconds for each read of a run list
        self._call = call or _http
        self._clock = clock or _now
        self._lock = threading.Lock()  # Guards _runs; the rest is only used by the reading thread
        self._runs: dict[tuple, dict] = {}  # (station, kind, project, name, run) -> record
        self._seen: set[tuple] = set()  # Runs that had ended before plumber-gui first looked: no times
        self._looked: dict[tuple[str, str], datetime] = {}  # (station, kind) -> its last list read
        self._down: set[str] = set()  # Stations that did not answer at the last read, and "" for Plumber
        self._lines = 0  # Lines in runs.jsonl
        self._wake = threading.Event()
        self._stopping = threading.Event()
        self._thread: threading.Thread | None = None

    def load(self) -> None:
        """
        Read runs.jsonl. A missing file means no times yet. Unreadable lines are skipped.
        """

        try:
            lines = self.path.read_text(encoding="utf-8").splitlines()
        except FileNotFoundError:
            return
        except (OSError, UnicodeDecodeError) as e:
            log.warning(f"{self.path}: {e}; run times start afresh")
            return
        for line in lines:
            record = _json(line.encode())
            key = _key(record) if isinstance(record, dict) else None
            if key is not None:
                self._runs[key] = record
        self._lines = len(lines)
        self._trim()

    def start(self) -> None:
        """
        Start the thread that reads the run lists. Calling it again does nothing.
        """

        if self._thread is None:
            self._thread = threading.Thread(target=self._loop, name="plumbergui-runwatch", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._stopping.set()
        self._wake.set()
        if self._thread is not None:
            self._thread.join()

    def nudge(self) -> None:
        """
        Read the run lists now: a run was just started or stopped
        """

        self._wake.set()

    def _loop(self) -> None:
        while not self._stopping.is_set():
            try:
                self.read()
            except Exception:
                log.exception("Reading the run lists failed")
            with self._lock:
                busy = any(record["status"] == "running" for record in self._runs.values())
            self._wake.wait(BUSY_EVERY if busy else IDLE_EVERY)
            self._wake.clear()

    # Reading ------------------------------------------------------------------
    def read(self) -> None:
        """
        Read both run lists once and note what changed
        """

        for kind in KINDS:
            try:
                status, body = self._call("GET", f"{self.plumber_url}/logs/{kind}s", None, self.timeout)
            except OSError:
                self._answers("", False, "Plumber did not respond; run times wait until it does")
                return
            listing = _json(body)
            if status != 200 or not isinstance(listing, list):
                self._answers("", False, f"Plumber did not list the {kind} runs (HTTP {status}); run times wait")
                return
            self._answers("", True, "Plumber lists the runs again")
            now = self._clock()
            for entry in listing:
                if isinstance(entry, dict) and isinstance(entry.get("station"), str):
                    self._station_runs(kind, entry, now)

    def _station_runs(self, kind: str, entry: dict, now: datetime) -> None:
        """
        Note the changes in one station's list of runs of one kind
        """

        station = entry["station"]
        if "error" in entry:
            self._answers(station, False, f"Station {station!r} did not list its runs: {entry['error']!r}")
            return
        self._answers(station, True, f"Station {station!r} lists its runs again")
        looked = self._looked.get((station, kind))
        blind = looked is None or (now - looked).total_seconds() > BLIND
        for run in entry.get("runs") or []:
            record = {
                "station": station,
                "kind": kind,
                "project": run.get("project") if isinstance(run, dict) else None,
                "name": run.get(kind) if isinstance(run, dict) else None,
                "run": run.get("run") if isinstance(run, dict) else None,
                "status": run.get("status") if isinstance(run, dict) else None,
            }
            key = _key(record)
            if key is not None and isinstance(record["status"], str):
                self._note(key, record, now, first=looked is None, blind=blind)
        self._looked[(station, kind)] = now

    def _note(self, key: tuple, seen: dict, now: datetime, *, first: bool, blind: bool) -> None:
        """
        Compare one listed run with what was known about it
        """

        status = seen["status"]
        with self._lock:
            known = self._runs.get(key)
            if known is None:
                if key in self._seen:
                    return
                if status == "running":
                    known = {**seen, "started": _iso(now), "started_by": blind, "ended": None, "ended_by": False}
                    message = f"Run started: {_describe(known)}" if not first else f"Run going: {_describe(known)}"
                elif first:  # Over before plumber-gui first looked at this station
                    self._seen.add(key)
                    return
                else:  # Started and ended between two reads
                    known = {**seen, "started": None, "started_by": False, "ended": _iso(now), "ended_by": True}
                    message = f"Run {status}: {_describe(known)}, briefly"
                self._runs[key] = known
            elif known["status"] == "running" and status != "running":
                known.update(status=status, ended=_iso(now), ended_by=blind)
                message = f"Run {status}: {_describe(known)}"
                if known["started"] and not known["started_by"] and not blind:
                    took = (now - datetime.fromisoformat(known["started"])).total_seconds()
                    message += f" after {_span(took)}"
            elif known["status"] != status:
                known["status"] = status
                message = ""
            else:
                return
            self._append(known)
        if message:
            log.log(logging.WARNING if status == "errored" else logging.INFO, message)

    def _answers(self, who: str, ok: bool, message: str) -> None:
        """
        Log a station or Plumber ("") that stopped or started answering, once per change
        """

        if ok == (who not in self._down):
            return
        if ok:
            self._down.discard(who)
            log.info(message)
        else:
            self._down.add(who)
            log.warning(message)

    # File ---------------------------------------------------------------------
    def _append(self, record: dict) -> None:
        """
        Add a record's latest state to runs.jsonl. Call it with the lock held. Once most of the file
        is out of date, it is rewritten with what is kept.
        """

        try:
            with self.path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(record) + "\n")
            self._lines += 1
            if self._lines > 2 * len(self._runs) + 1000:
                self._trim()
        except OSError as e:
            log.warning(f"Could not write {self.path}: {e}")

    def _trim(self) -> None:
        """
        Keep the newest KEEP runs of each station and pipeline or system, and rewrite runs.jsonl
        with them. The write is replaced into place so a crash cannot leave a half-written file.
        """

        groups: dict[tuple, list[tuple]] = {}
        for key in self._runs:
            groups.setdefault(key[:4], []).append(key)
        for keys in groups.values():
            for key in sorted(keys, key=lambda item: item[4])[:-KEEP]:
                del self._runs[key]
        if self._lines <= len(self._runs):
            return
        fd, tmp_name = tempfile.mkstemp(prefix=".runs-", suffix=".jsonl", dir=self.path.parent)
        tmp = Path(tmp_name)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.writelines(json.dumps(record) + "\n" for record in self._runs.values())
            os.replace(tmp, self.path)
        except OSError as e:
            tmp.unlink(missing_ok=True)
            log.warning(f"Could not rewrite {self.path}: {e}")
            return
        self._lines = len(self._runs)

    # Requests -----------------------------------------------------------------
    def handle(self, method: str, path: str, query: str, body: bytes) -> tuple[int, object]:
        """
        GET /runs/times: every kept record, and the time now
        """

        if path != "/runs/times":
            return 404, {"detail": "Not found"}
        if method != "GET":
            return 405, {"detail": "Method not allowed"}
        with self._lock:
            runs = [dict(record) for record in self._runs.values()]
        return 200, {"now": _iso(self._clock()), "runs": runs}


def _key(record: dict) -> tuple | None:
    """
    The (station, kind, project, name, run) of a record, or None when it is not a usable one
    """

    parts = (record.get("station"), record.get("kind"), record.get("project"), record.get("name"))
    if not all(isinstance(part, str) and part for part in parts) or parts[1] not in KINDS:
        return None
    run = record.get("run")
    if not isinstance(run, int) or isinstance(run, bool):
        return None
    return (*parts, run)

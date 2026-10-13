"""
Local test setup for plumber-gui: two ValveStations, Plumber and plumber-gui on high ports

Run it with a Python that has Plumber's and ValveStation's requirements and Canonada installed:
    python tests/plumbergui/devstack.py          # start, add the demo data, serve until Ctrl+C
    python tests/plumbergui/devstack.py --check  # start, add the demo data, run the smoke checks, stop

Everything lives in a new temporary directory that is removed on exit (--keep leaves it), after the
runs still going are stopped. Tokens are random and only written to that directory's config files. The demo data:
    demo       the zip of tests/plumbergui/demo_project
    demo-git   the same project, renamed and registered from a local git repository (branch main)
    demo-fast  a variant of demo that uses the vault files catalog "fast", parameters "short" and
               credentials "dummy"
"""

import argparse
import io
import json
import os
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
DEMO = HERE / "demo_project"

STATIONS = {"lab": 15081, "bench": 15082}
PLUMBER_PORT = 15090
GUI_PORT = 15100
PLUMBER = f"http://127.0.0.1:{PLUMBER_PORT}"
GUI = f"http://127.0.0.1:{GUI_PORT}"
GUI_API = GUI + "/api"  # Where the browser reaches Plumber through plumber-gui
GUI_HEADERS = {"X-Plumber-GUI": "1"}  # The header plumber-gui requires on those requests

# Straight to the local servers, ignoring http_proxy: the requests carry station tokens
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

VAULT = {
    ("catalog", "fast"): '[ticks]\ntype = "demo.ticker"\nkeys = []\ninterval = 0.1\n',
    ("parameters", "short"): "[chatty]\nlines = 2\n\n[flood]\nmegabytes = 1\n",
    ("credentials", "dummy"): '[service]\nuser = "demo"\npassword = "not-a-real-password"\n',
}


# HTTP -------------------------------------------------------------------------
def call(method: str, url: str, *, json_body: object = None, fields: dict | None = None,
         files: dict | None = None, headers: dict | None = None, timeout: float = 300) -> tuple[int, bytes, str]:
    """
    One HTTP request. Returns the status, the body, and the Content-Type. Never raises on HTTP errors.
    fields and files make a multipart body; files maps a field name to (filename, bytes).
    """

    data = None
    sent_headers = dict(headers or {})
    if json_body is not None:
        data = json.dumps(json_body).encode()
        sent_headers["Content-Type"] = "application/json"
    elif fields is not None or files is not None:
        data, sent_headers["Content-Type"] = _multipart(fields or {}, files or {})
    elif method in ("POST", "PUT"):
        data = b""
    request = urllib.request.Request(url, data=data, headers=sent_headers, method=method)
    try:
        with OPENER.open(request, timeout=timeout) as response:
            return response.status, response.read(), response.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers.get("Content-Type", "")


def call_json(method: str, url: str, **kwargs) -> tuple[int, object]:
    """
    call() with the body parsed as JSON (None when it isn't JSON)
    """

    status, body, _ = call(method, url, **kwargs)
    try:
        return status, json.loads(body) if body else None
    except json.JSONDecodeError:
        return status, None


def _multipart(fields: dict, files: dict) -> tuple[bytes, str]:
    """
    A multipart/form-data body and its Content-Type
    """

    boundary = "devstack" + secrets.token_hex(8)
    parts = []
    for name, value in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    for name, (filename, payload) in files.items():
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
            "Content-Type: application/octet-stream\r\n\r\n".encode()
            + payload
            + b"\r\n"
        )
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


# Processes --------------------------------------------------------------------
def _port_in_use(port: int) -> bool:
    with socket.socket() as sock:
        return sock.connect_ex(("127.0.0.1", port)) == 0


def _start(name: str, module: str, cwd: Path, env: dict, logs: Path) -> subprocess.Popen:
    """
    Start a server module in its own session, with its output in logs/{name}.log
    """

    output = (logs / f"{name}.log").open("w")
    return subprocess.Popen(
        [sys.executable, "-m", module],
        cwd=cwd,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1", **env},
        stdin=subprocess.DEVNULL,
        stdout=output,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )


def _stop(procs: dict[str, subprocess.Popen]) -> None:
    """
    Stop every server and the processes it started (each runs in its own session)
    """

    for proc in procs.values():
        if proc.poll() is None:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    for proc in procs.values():
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait()


def _stop_runs() -> None:
    """
    Stop the runs still going, through Plumber while it is up. ValveStation starts each run in its
    own session and leaves it running when it exits, so a never-ending demo pipeline would go on in
    the deleted directory.
    """

    for kind in ("pipeline", "system"):
        try:
            _, listed = call_json("GET", f"{PLUMBER}/logs/{kind}s", timeout=35)
        except (urllib.error.URLError, OSError):
            return
        for entry in listed if isinstance(listed, list) else []:
            for record in entry.get("runs", []):
                if record.get("status") == "running":
                    parts = (kind, entry.get("station"), record.get("project"), record.get(kind), record.get("run"))
                    try:
                        call("DELETE", f"{PLUMBER}/run/" + "/".join(urllib.parse.quote(str(part), safe="") for part in parts), timeout=35)
                    except (urllib.error.URLError, OSError):
                        pass


def _kill_leftover_runs(root: Path) -> None:
    """
    Kill any Canonada run still working inside root, with the workers in its session: the runs
    _stop_runs() could not reach because Plumber was already down
    """

    for proc_dir in Path("/proc").glob("[0-9]*"):
        try:
            command = (proc_dir / "cmdline").read_bytes().split(b"\0")
            if b"canonada.cli" in command and Path(os.readlink(proc_dir / "cwd")).is_relative_to(root):
                os.killpg(os.getpgid(int(proc_dir.name)), signal.SIGKILL)
        except (OSError, ValueError):
            pass


def _wait_up(name: str, url: str, proc: subprocess.Popen, logs: Path, headers: dict | None = None) -> None:
    """
    Wait until url answers 200. Exits with the server's log tail if it dies or stays down.
    """

    deadline = time.time() + 30
    while time.time() < deadline:
        if proc.poll() is not None:
            break
        try:
            if call("GET", url, headers=headers, timeout=2)[0] == 200:
                return
        except (urllib.error.URLError, OSError):
            pass
        time.sleep(0.3)
    tail = (logs / f"{name}.log").read_text(errors="replace")[-2000:]
    raise SystemExit(f"{name} did not start. Last lines of its log:\n{tail}")


# Demo data --------------------------------------------------------------------
def _zip(directory: Path) -> bytes:
    """
    A zip of a project directory with canonada.toml at its root, without __pycache__
    """

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for path in sorted(directory.rglob("*")):
            relative = path.relative_to(directory)
            if path.is_file() and "__pycache__" not in relative.parts:
                archive.write(path, relative.as_posix())
    return buffer.getvalue()


def _git_repository(root: Path) -> Path:
    """
    A bare git repository whose main branch holds the demo project renamed to demo-git
    """

    work, bare = root / "demo-git-work", root / "demo-git.git"
    shutil.copytree(DEMO, work, ignore=shutil.ignore_patterns("__pycache__"))
    toml = work / "canonada.toml"
    toml.write_text(toml.read_text().replace('name = "demo"', 'name = "demo-git"', 1))
    git = ["git", "-c", "user.name=devstack", "-c", "user.email=devstack@localhost", "-c", "init.defaultBranch=main"]
    for args in (["init", "-q", "-b", "main", str(work)], ["-C", str(work), "add", "-A"],
                 ["-C", str(work), "commit", "-q", "-m", "demo-git"], ["clone", "-q", "--bare", str(work), str(bare)]):
        subprocess.run(git + args, check=True, stdout=subprocess.DEVNULL)
    shutil.rmtree(work)
    return bare


def add_demo_data(root: Path) -> None:
    """
    Register demo (zip) and demo-git (git), store the vault files, and add the variant demo-fast.
    Talks to Plumber directly, so it does not depend on plumber-gui.
    """

    steps = [
        ("register demo (zip)", lambda: call_json("POST", f"{PLUMBER}/project/register",
                                                  files={"file": ("demo.zip", _zip(DEMO))})),
        ("register demo-git (git)", lambda: call_json("POST", f"{PLUMBER}/project/register",
                                                      fields={"repository": str(_git_repository(root)), "branch": "main"})),
    ]
    for (category, name), text in VAULT.items():
        steps.append((f"vault {category} {name}", lambda c=category, n=name, t=text: call_json(
            "PUT", f"{PLUMBER}/vault/{c}/{n}", files={"file": (f"{n}.toml", t.encode())})))
    steps.append(("variant demo-fast", lambda: call_json("POST", f"{PLUMBER}/project/register/variant", json_body={
        "name": "demo-fast", "base": "demo", "catalog": "fast", "parameters": "short", "credentials": "dummy"})))
    for label, step in steps:
        status, payload = step()
        if status != 200:
            raise SystemExit(f"Could not {label}: {status} {payload}")


# Smoke checks -----------------------------------------------------------------
class Checks:
    def __init__(self) -> None:
        self.failed: list[str] = []
        self.count = 0

    def __call__(self, ok: object, label: str) -> bool:
        self.count += 1
        print(("PASS " if ok else "FAIL ") + label, flush=True)
        if not ok:
            self.failed.append(label)
        return bool(ok)


def gui(method: str, path: str, **kwargs) -> tuple[int, bytes, str]:
    """
    A request to Plumber through plumber-gui, the way the browser makes it
    """

    return call(method, GUI_API + path, headers=GUI_HEADERS, **kwargs)


def gui_json(method: str, path: str, **kwargs) -> tuple[int, object]:
    status, body, _ = gui(method, path, **kwargs)
    try:
        return status, json.loads(body) if body else None
    except json.JSONDecodeError:
        return status, None


def start_run(kind: str, project: str, name: str, station: str) -> dict:
    status, payload = gui_json("POST", f"/run/{kind}/{project}/{name}?" + urllib.parse.urlencode({"station": station}))
    if status != 200 or not isinstance(payload, dict):
        raise RuntimeError(f"start {kind} {name} on {station}: {status} {payload}")
    return payload


def run_status(kind: str, station: str, project: str, name: str, run: int) -> str | None:
    _, listed = gui_json("GET", f"/logs/{kind}s")
    for entry in listed if isinstance(listed, list) else []:
        if entry.get("station") != station:
            continue
        for record in entry.get("runs", []):
            if record.get("project") == project and record.get(kind) == name and record.get("run") == run:
                return record.get("status")
    return None


def wait_ended(kind: str, station: str, project: str, name: str, run: int, seconds: float = 120) -> str | None:
    deadline = time.time() + seconds
    status = None
    while time.time() < deadline:
        status = run_status(kind, station, project, name, run)
        if status in ("finished", "errored"):
            return status
        time.sleep(1)
    return status


def read_log(kind: str, station: str, project: str, name: str, run: int) -> tuple[int, str]:
    status, body, _ = gui("GET", f"/logs/{kind}/{station}/{project}/{name}/{run}")
    return status, body.decode("utf-8", errors="replace")


def run_times(station: str, kind: str, project: str, name: str, run: int, seconds: float = 30) -> dict:
    """
    plumber-gui's record of one run once it has seen the run end, or the last one seen
    """

    deadline = time.time() + seconds
    record: dict = {}
    while time.time() < deadline:
        _, payload = gui_own("GET", "/runs/times")
        for item in (payload or {}).get("runs", []):
            if (item["station"], item["kind"], item["project"], item["name"], item["run"]) == (station, kind, project, name, run):
                record = item
        if record.get("ended"):
            break
        time.sleep(1)
    return record


def gui_own(method: str, path: str, **kwargs) -> tuple[int, object]:
    """
    A request to plumber-gui's own endpoints (the schedules)
    """

    status, body, _ = call(method, GUI + "/gui" + path, headers=GUI_HEADERS, **kwargs)
    try:
        return status, json.loads(body) if body else None
    except json.JSONDecodeError:
        return status, None


def smoke(check: Checks, root: Path) -> None:
    """
    The flows the GUI relies on, through plumber-gui
    """

    for path, kind in (("/", "text/html"), ("/app.js", "javascript"), ("/ui.js", "javascript"), ("/runs.js", "javascript"),
                       ("/search.js", "javascript"), ("/theme.js", "javascript"), ("/logparse.js", "javascript"), ("/app.css", "text/css"),
                       ("/favicon.svg", "image/svg+xml")):
        status, body, content_type = call("GET", GUI + path)
        check(status == 200 and kind in content_type and body, f"GET {path} -> {status} {content_type}")
    with OPENER.open(GUI + "/", timeout=10) as response:
        csp = response.headers.get("Content-Security-Policy", "")
    check("script-src 'self'" in csp and "frame-ancestors 'none'" in csp, "security headers on the page")
    status, _, _ = call("GET", GUI + "/api/station/list")
    check(status == 403, f"API call without the header -> {status}")

    status, stations = gui_json("GET", "/station/list")
    online = {s["name"] for s in stations or [] if s.get("status") == "online"}
    check(status == 200 and online == set(STATIONS), f"stations online -> {sorted(online)}")

    status, projects = gui_json("GET", "/project/list")
    names = {p["name"] for p in projects or []}
    check(status == 200 and names == {"demo", "demo-git", "demo-fast"}, f"projects -> {sorted(names)}")

    status, registry = gui_json("GET", "/registry/pipelines")
    entries = registry.get("demo") if isinstance(registry, dict) else None
    demo = {p["name"] for p in entries} if isinstance(entries, list) else set()
    check(demo == {"chatty", "stream", "boom", "flood"}, f"registry of demo -> {sorted(demo) or entries}")

    run = start_run("pipeline", "demo", "chatty", "lab")
    ended = wait_ended("pipeline", "lab", "demo", "chatty", run["run"])
    check(ended == "finished", f"chatty on lab #{run['run']} -> {ended}")
    status, text = read_log("pipeline", "lab", "demo", "chatty", run["run"])
    check(status == 200 and "chatty line 1 of 5" in text and "Traceback (most recent call last):" in text
          and "chatty: plain print output" in text, f"chatty log -> {status}, {len(text)} chars")
    times = run_times("lab", "pipeline", "demo", "chatty", run["run"])
    check(times.get("status") == "finished" and times.get("ended") and times.get("started") and not times.get("started_by"),
          f"plumber-gui noted chatty's start and end -> {times}")
    status, body, _ = call("GET", GUI + "/gui/log", headers=GUI_HEADERS)
    text = body.decode("utf-8", errors="replace")
    check(status == 200 and "POST /run/pipeline/demo/chatty?station=lab -> 200" in text
          and f"Run started: pipeline 'chatty' of 'demo' #{run['run']} on 'lab'" in text, f"plumber-gui's log -> {status}, {len(text)} chars")

    run = start_run("pipeline", "demo-fast", "stream", "bench")
    time.sleep(3)
    check(run_status("pipeline", "bench", "demo-fast", "stream", run["run"]) == "running", f"stream on bench #{run['run']} runs")
    path = f"/run/pipeline/bench/demo-fast/stream/{run['run']}"
    status, stopped = gui_json("DELETE", path)
    check(status == 200 and isinstance(stopped, dict) and stopped.get("status") == "errored", f"stop stream -> {status} {stopped}")
    status, _ = gui_json("DELETE", path)
    check(status == 409, f"stop it again -> {status}")
    status, text = read_log("pipeline", "bench", "demo-fast", "stream", run["run"])
    check(status == 200 and "item 0: ok" in text and "ValveStation stopped this run" in text, f"stream log -> {status}, {len(text)} chars")

    run = start_run("pipeline", "demo", "boom", "lab")
    ended = wait_ended("pipeline", "lab", "demo", "boom", run["run"])
    check(ended == "errored", f"boom on lab #{run['run']} -> {ended}")

    run = start_run("system", "demo", "nightly", "bench")
    ended = wait_ended("system", "bench", "demo", "nightly", run["run"])
    status, text = read_log("system", "bench", "demo", "nightly", run["run"])
    check(ended == "errored" and "Running pipeline: chatty" in text and "boom: this pipeline always fails" in text,
          f"nightly on bench #{run['run']} -> {ended}, log {status}")

    status, missing = gui_json("GET", "/logs/pipeline/lab/demo/chatty/9999")
    check(status == 404, f"missing run log -> {status} {missing}")

    status, updated = gui_json("PUT", "/project/update/demo-git")
    check(status == 200 and isinstance(updated, dict) and updated.get("updated"), f"pull demo-git -> {status} {updated}")

    schedules(check, root)


def schedules(check: Checks, root: Path) -> None:
    """
    A schedule fires within two minutes, and one whose target is still running is skipped
    """

    stream = start_run("pipeline", "demo-fast", "stream", "bench")
    every_minute = [
        {"name": "chatty-every-minute", "project": "demo", "pipeline": "chatty", "station": "lab", "cron": "* * * * *"},
        {"name": "watch-stream", "project": "demo-fast", "pipeline": "stream", "station": "bench", "cron": "* * * * *"},
    ]
    for record in every_minute:
        status, payload = gui_own("POST", "/schedule/add", json_body=record)
        check(status == 200, f"add schedule {record['name']} -> {status} {payload}")
    status, payload = gui_own("POST", "/schedule/add", json_body={**every_minute[0], "name": "never-fires", "cron": "0 0 30 2 *"})
    check(status == 400 and "never fires" in (payload or {}).get("detail", ""), f"a schedule that never fires is refused -> {status} {payload}")
    status, preview = gui_own("GET", "/schedule/preview?cron=" + urllib.parse.quote("0 2 * * *"))
    check(status == 200 and len((preview or {}).get("next", [])) == 3, f"preview -> {status} {preview}")
    saved = (root / "gui" / "schedules.toml").read_text()
    check('name = "chatty-every-minute"' in saved and 'cron = "* * * * *"' in saved, "schedules.toml written")

    deadline = time.time() + 150
    outcomes: dict = {}
    while time.time() < deadline:
        _, listed = gui_own("GET", "/schedule/list")
        outcomes = {item["name"]: item.get("last") for item in (listed or {}).get("schedules", [])}
        if all(outcomes.get(record["name"]) for record in every_minute):
            break
        time.sleep(2)
    chatty = outcomes.get("chatty-every-minute") or {}
    watch = outcomes.get("watch-stream") or {}
    check(chatty.get("outcome") == "started" and isinstance(chatty.get("run"), int), f"chatty schedule fired -> {chatty}")
    check(watch.get("outcome") == "skipped" and "still running" in watch.get("detail", ""), f"stream schedule skipped while it runs -> {watch}")
    if chatty.get("run"):
        check(wait_ended("pipeline", "lab", "demo", "chatty", chatty["run"]) == "finished", "the scheduled chatty run finished")

    for record in every_minute:
        status, _ = gui_own("DELETE", "/schedule/remove/" + record["name"])
        check(status == 200, f"remove schedule {record['name']} -> {status}")
    gui_json("DELETE", f"/run/pipeline/bench/demo-fast/stream/{stream['run']}")
    check("schedules = []" in (root / "gui" / "schedules.toml").read_text(), "schedules.toml empty again")


# Main -------------------------------------------------------------------------
def main() -> None:
    parser = argparse.ArgumentParser(description="Local test setup for plumber-gui")
    parser.add_argument("--check", action="store_true", help="run the smoke checks, then stop")
    parser.add_argument("--keep", action="store_true", help="keep the temporary directory")
    parser.add_argument("--valvestation-src", type=Path, default=REPO.parent / "valvestation" / "src",
                        help="ValveStation's src directory (default: a sibling checkout)")
    args = parser.parse_args()

    if not (args.valvestation_src / "valvestation" / "main.py").is_file():
        raise SystemExit(f"No ValveStation at {args.valvestation_src}; pass --valvestation-src")
    busy = [port for port in (*STATIONS.values(), PLUMBER_PORT, GUI_PORT) if _port_in_use(port)]
    if busy:
        raise SystemExit(f"Ports already in use: {busy}")

    root = Path(tempfile.mkdtemp(prefix="plumbergui-devstack-"))
    logs = root / "logs"
    logs.mkdir()
    procs: dict[str, subprocess.Popen] = {}
    for sig in (signal.SIGTERM, signal.SIGHUP):  # Clean up through the finally below, also when the terminal closes
        signal.signal(sig, lambda *_: sys.exit(1))
    check = Checks()
    try:
        plumber_config = []
        for name, port in STATIONS.items():
            token = secrets.token_urlsafe(24)
            station = root / name
            (station / "projects").mkdir(parents=True)
            (station / "config.toml").write_text(f'token = "{token}"\ncanonada_timeout = 60\n')
            plumber_config.append(f'[[stations]]\nname = "{name}"\nconnection = "http://127.0.0.1:{port}"\ntoken = "{token}"\n')
            procs[name] = _start(name, "valvestation", station, {
                "PYTHONPATH": str(args.valvestation_src), "VALVESTATION_HOST": "127.0.0.1", "VALVESTATION_PORT": str(port),
            }, logs)
            _wait_up(name, f"http://127.0.0.1:{port}/health", procs[name], logs, {"Authorization": f"Bearer {token}"})

        (root / "plumber").mkdir()
        (root / "plumber" / "config.toml").write_text("\n".join(plumber_config))
        procs["plumber"] = _start("plumber", "plumber", root / "plumber", {
            "PYTHONPATH": str(REPO / "src"), "PLUMBER_HOST": "127.0.0.1", "PLUMBER_PORT": str(PLUMBER_PORT),
        }, logs)
        _wait_up("plumber", f"{PLUMBER}/version", procs["plumber"], logs)

        (root / "gui").mkdir()
        procs["plumber-gui"] = _start("plumber-gui", "plumbergui", root / "gui", {
            "PYTHONPATH": str(REPO / "src"), "PLUMBER_URL": PLUMBER,
            "PLUMBERGUI_HOST": "127.0.0.1", "PLUMBERGUI_PORT": str(GUI_PORT),
        }, logs)
        _wait_up("plumber-gui", f"{GUI}/", procs["plumber-gui"], logs)

        add_demo_data(root)

        if args.check:
            smoke(check, root)
            print(f"\n{check.count - len(check.failed)}/{check.count} checks passed")
            if check.failed:
                raise SystemExit(1)  # After the finally below has stopped everything
            return

        print(f"plumber-gui  {GUI}")
        print(f"Plumber      {PLUMBER}")
        print("Stations     " + ", ".join(f"{name} http://127.0.0.1:{port}" for name, port in STATIONS.items()))
        print(f"Directory    {root} (server output in logs/)")
        print("Projects     demo (zip), demo-git (git), demo-fast (variant of demo)")
        print("Press Ctrl+C to stop.", flush=True)
        while all(proc.poll() is None for proc in procs.values()):
            time.sleep(1)
        dead = [name for name, proc in procs.items() if proc.poll() is not None]
        print(f"Stopped because {', '.join(dead)} exited; see {logs}")
    except KeyboardInterrupt:
        print()
    finally:
        if "plumber" in procs and procs["plumber"].poll() is None:
            print("Stopping the runs still going…", flush=True)
            try:
                _stop_runs()
            except KeyboardInterrupt:  # Impatient: the sweep below kills them instead
                pass
        _stop(procs)
        _kill_leftover_runs(root)
        if args.keep:
            print(f"Kept {root}")
        else:
            shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    main()

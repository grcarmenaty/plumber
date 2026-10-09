# Plumber
## API Endpoints

The valve station config will accept connection strings with pre-shared keys with the stations.

### Stations
- GET <prefix>/list: List all configured stations and their status (online/offline)
- POST <prefix>/add: Add a new station to the control plane. Accept a body with a connection string that already has a given name that will be used to id the station by Plumber.
- DELETE <prefix>/remove/{name}: Remove a ValveStation by name.
- PUT <prefix>/update/: Make sure that all online stations' projects are updated to the latest version dictated by the control plane.

### Vault
- GET <prefix>/vault/catalog/list: List all available catalog files in the vault
- GET <prefix>/vault/catalog/{name}: View a catalog file in the vault
- PUT <prefix>/vault/catalog/{name}: Upload a catalog file to the vault
- DELETE <prefix>/vault/catalog/{name}: Delete a catalog file from the vault
- GET <prefix>/vault/parameters/list: List all available parameters files in the vault
- GET <prefix>/vault/parameters/{name}: View a parameters file in the vault
- PUT <prefix>/vault/parameters/{name}: Upload a parameters file to the vault
- DELETE <prefix>/vault/parameters/{name}: Delete a parameters file from the vault
- GET <prefix>/vault/credentials/list: List all available credentials files in the vault
- GET <prefix>/vault/credentials/{name}: View a credentials file in the vault
- PUT <prefix>/vault/credentials/{name}: Upload a credentials file to the vault
- DELETE <prefix>/vault/credentials/{name}: Delete a credentials file from the vault

### Project
- GET <prefix>/list: List all registered projects and variants. For a variant it will show the variant name, base project name and the used vault files (if any).
- POST <prefix>/register: Register a new project. Provide a repository, the branch to track, and a deploy key (if needed). Optionally allow an upload of a zip file that contains a project.
- PUT <prefix>/update/{name}: Update the registered project {name} by pulling from its repository or by uploading a zip file. The zip's canonada.toml must use that same name.
- POST <prefix>/register/variant: Register a project variant based on an existing project. Caller needs to provide the variant name and any vault files that need to be overridden (will alter canonada project name). A variant will update its base project files when a registered project is updated. Deleting the base project will delete all variants. (Variant names are treated as project names for the API endpoints; relations are only kept for project management and update purposes.)
- DELETE <prefix>/remove/{project}: Remove a Canonada project or variant. (By project name)

### Catalog
- GET <prefix>/view/catalog: View catalog entries available in each project and station. Actually asks each station, does not use the vault.
- GET <prefix>/view/parameters: View parameters available in each project and station. Actually asks each station, does not use the vault.

### Registry
- GET <prefix>/pipelines: List available pipelines and their descriptions (per project, not variant)
- GET <prefix>/systems: List available systems and their descriptions (per project, not variant)

### View
- GET <prefix>/pipeline/{project}/{pipeline}: View a pipeline's internal makeup (nodes and IO)
- GET <prefix>/system/{project}/{system}: View a system internal makeup (list of sequential pipeline)

### Run
- POST <prefix>/pipeline/{project}/{pipeline}: Run a pipeline on the station named by the station query parameter. If that station does not already have the same project files, the project is sent first.
- POST <prefix>/system/{project}/{system}: Run a system on the station named by the station query parameter. If that station does not already have the same project files, the project is sent first.
- DELETE <prefix>/pipeline/{station}/{project}/{pipeline}/{run}: Stop that pipeline run on the named station. A missing run is 404. A run that is not running is 409.
- DELETE <prefix>/system/{station}/{project}/{system}/{run}: Stop that system run on the named station. A missing run is 404. A run that is not running is 409.

### Logs
- GET <prefix>/pipelines: Read/List pipeline execution status for all stations (running/errored/finished)
- GET <prefix>/systems: Read/List system execution status (running/errored/finished)
- GET <prefix>/pipeline/{station}/{project}/{pipeline}/{run}: Read that pipeline run's log on the named station. A missing run is 404.
- GET <prefix>/system/{station}/{project}/{system}/{run}: Read that system run's log on the named station. A missing run is 404.

### Misc
- GET /version
- GET /health

## GUI (⚠️ FULL AI CODE)

`plumber-gui` is a web interface for a Plumber control plane. It talks to Plumber over HTTP, keeps its own cron schedules, and has four tabs:

- **Projects:** register projects from git or a zip, pull or upload updates, make and edit variants from vault files, and manage the vault.
- **Stations:** status, add, edit, remove, push projects, and what each station has deployed.
- **Pipelines:** the pipelines and systems of each project, starting them on stations, and schedules.
- **Runs & logs:** every run on every station with when it started and how long it took, stop and run again, each run's log with level filters, search and a live tail, a search across the logs of many runs, and plumber-gui's own log.

Start it in the directory that should hold its files, `schedules.toml`, `runs.jsonl` and `plumbergui.log` (the control plane's directory is a good place):

```bash
plumber-gui
```

It listens on `127.0.0.1:510` and expects Plumber at `http://127.0.0.1:509`. `PLUMBERGUI_HOST`, `PLUMBERGUI_PORT` and `PLUMBER_URL` override them. The page follows the browser's light or dark theme; the button at the top right switches between Auto, Light and Dark, and the browser remembers the choice.

### Access and security

plumber-gui has no login: anyone who can reach it controls every station. Keep it on `127.0.0.1` and reach it through an SSH tunnel:

```bash
ssh -N -L 8510:127.0.0.1:510 user@control-plane-host
```

Then open `http://localhost:8510`. An authenticating reverse proxy works too, as long as it sends a `Host` header of `localhost` or an IP address. plumber-gui refuses other host names, so a DNS-rebinding page can't reach it.

It also refuses API calls without its `X-Plumber-GUI` header, which other sites can't send, and serves a strict Content-Security-Policy. These protect plumber-gui's port only. Plumber's own port has no login and no such checks, so keep it on loopback and don't browse untrusted sites on the Plumber host.

### Schedules

A schedule starts one pipeline or system on one station when its cron expression matches. The expression has 5 numeric fields: minute, hour, day of month, month and day of week (0 and 7 are Sunday). It uses the local time of the machine running plumber-gui. As in cron, when both day fields are set, either one matching is enough.

- **Schedules fire only while plumber-gui runs.** Fires missed while it was stopped are not made up. Run one plumber-gui per `schedules.toml`.
- **A fire is skipped while the same pipeline or system is still running on that station.** So `*/5 * * * *` restarts a long-running pipeline after it stops.
- **Plumber sends the project first if the station's copy differs,** which stops that project's running runs there.
- **Each schedule shows only its last outcome** in the GUI. Every outcome is also written to plumber-gui's log.
- **Edit `schedules.toml` by hand only while plumber-gui is stopped.**

### Run times and plumber-gui's log

Plumber's run lists don't say when a run started or ended, so plumber-gui notes it. It reads the lists every 10 s while a run is going and every 30 s otherwise, and at once after a start or stop made through the GUI or by a schedule. The times are kept in `runs.jsonl` (the newest 50 runs of each pipeline or system on each station), so they survive a restart. A run that was already going when plumber-gui started, or that ended while a station didn't answer, gets a "before" or "by" time instead.

plumber-gui's own log goes to the terminal and to `plumbergui.log`, which is rotated to `plumbergui.log.1` at 4 MiB. It records run starts and ends, schedule fires, everything done through the GUI (the request and Plumber's answer, never request bodies), and stations or Plumber that stop or start answering. Runs & logs shows it under **Plumber**, with the same level filters and search as run logs.

### Searching logs

**Search logs** in Runs & logs searches the runs the list shows: the last 1, 3 or 10 runs of each pipeline and system, or all of them. Plumber returns one run's log at a time, so the GUI downloads each log, three at a time, and lists the matching lines per run; **Open log** shows that run's log with the search filled in. Only the last 4 MiB of each log is searched, and logs over 64 MiB are skipped.

### Stations and secrets

- **Plumber keeps station tokens and deploy keys as plain text** in its `config.toml` and `projects.toml`. The GUI sends them once and never shows them again.
- **Credentials files from the vault travel with the projects that use them.** A start sends the project only to the station that runs it, when that station's copy differs. Push projects is the general update: it sends every project and variant to every online station.
- **Editing a station removes every project from it,** which stops its runs there; Plumber sends the ones it registered again at the next start or push, and any others are gone for good. Its token has to be entered again, since Plumber never shows it. **Editing a variant stops its runs on every station.** Names can't be changed.
- **A station that doesn't answer can't be edited or removed from the GUI,** because Plumber first deletes every project on it. Stop Plumber, change or delete the station's `[[stations]]` entry in its `config.toml`, and start Plumber again. Likewise, a variant can only be edited or removed while every station answers.

### Limitations

What the GUI can't do with Plumber's current API:

- **Logs are read whole.** The live tail re-reads the whole log each time, so it slows down as the log grows and pauses above 32 MiB.
- **"Offline" can mean unreachable or a wrong token.**
- **Listing pipelines is slow.** Plumber imports each base project with Canonada, one after another.

### Tests

```bash
PYTHONPATH=src python -m pytest tests/plumbergui
node --test "tests/plumbergui/*.test.mjs"
python tests/plumbergui/devstack.py --check
```

`devstack.py` needs a Python with Plumber's and ValveStation's requirements and Canonada installed, `git`, and a ValveStation checkout next to this repository (or pass `--valvestation-src`). It runs two ValveStations, Plumber and plumber-gui on high ports with demo projects. Without `--check` it keeps them running until Ctrl+C, so you can try the GUI at `http://127.0.0.1:15100`.

"""
Plumber: an HTTP control plane for ValveStation nodes

Configuration is read from config.toml in the working directory. Projects are recorded in
projects.toml, and vault files live under vault/catalog, vault/parameters, and vault/credentials.
Install a control plane with:
    plumber install
Run with:
    plumber
"""

import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import tomllib
import urllib.error
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlsplit

import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import PlainTextResponse

CONFIG_PATH = Path("config.toml").resolve()
PROJECTS_FILE = CONFIG_PATH.parent / "projects.toml"  # Registered projects and variants
PROJECTS_DIR = CONFIG_PATH.parent / "projects"  # One directory per project, holding its files
VAULT_DIR = CONFIG_PATH.parent / "vault"  # catalog/, parameters/, and credentials/
VAULT_CATEGORIES = ("catalog", "parameters", "credentials")
HEALTH_TIMEOUT = 3  # Seconds to wait for a station's /health before calling it offline

log = logging.getLogger("plumber")

stations_lock = threading.Lock()  # Serialises changes to the station list and config.toml
projects_lock = threading.Lock()  # Serialises changes to projects.toml and project directories
vault_lock = threading.Lock()  # Serialises changes to vault files
stations: list[dict[str, str]] = []  # ValveStation nodes from config.toml
projects: list[dict[str, str]] = []  # Registered projects and variants from projects.toml

app = FastAPI()


def install() -> None:
    """
    Copy the packaged template config.toml into the working directory.
    An existing config.toml is left unchanged.
    """

    dest = Path("config.toml").resolve()
    if dest.is_file():
        log.info(f"Config already present at {dest}")
    else:
        template = Path(__file__).resolve().parent / "templates" / "config.toml"
        if not template.is_file():
            log.error(f"No config template found at {template}")
            sys.exit(1)
        shutil.copyfile(template, dest)
        log.info(f"Wrote config to {dest}. Set each station's token in it before starting")
    _ensure_storage()
    if not PROJECTS_FILE.is_file():
        _write_projects([])
        log.info(f"Wrote {PROJECTS_FILE}")


def check_install() -> None:
    """
    Plumber runs from a directory holding config.toml. Logs an error and exits if it is missing.
    """

    if not CONFIG_PATH.is_file():
        log.error(f"No config found at {CONFIG_PATH}")
        sys.exit(1)


def _station_from_mapping(entry: object) -> dict[str, str]:
    """
    One station from a config table or a request body. Raises ValueError when a field is unusable.

    name is the id, a single path segment that does not start with '.'.
    connection is an http or https base URL, without userinfo, query, or fragment.
    token is the non-empty pre-shared bearer token, with no line breaks.
    """

    if not isinstance(entry, dict):
        raise ValueError("Each station needs a name, connection, and token")

    name = entry.get("name")
    connection = entry.get("connection")
    token = entry.get("token")
    if not isinstance(name, str) or not name or name != Path(name).name or name.startswith("."):
        raise ValueError("Station name must be a single path segment and must not start with '.'")
    if not isinstance(connection, str) or not connection:
        raise ValueError("Station connection must be an http or https URL")
    parsed = urlsplit(connection)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError("Station connection must be an http or https URL")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("Station connection must not include a username or password; the token is a separate field")
    if parsed.query or parsed.fragment:
        raise ValueError("Station connection must be a base URL without a query or fragment")
    if not isinstance(token, str) or not token or any(char in token for char in "\r\n"):
        raise ValueError("Station token must be a non-empty string without line breaks")
    return {"name": name, "connection": connection.rstrip("/"), "token": token}


def _stations_from_config(config: dict) -> list[dict[str, str]]:
    """
    The station list from a parsed config. A missing stations key is an empty list.
    Raises ValueError when the list or any station is unusable, or when a name is repeated.
    """

    raw = config.get("stations", [])
    if not isinstance(raw, list):
        raise ValueError("'stations' must be a list of stations")
    parsed = []
    seen: set[str] = set()
    for entry in raw:
        station = _station_from_mapping(entry)
        if station["name"] in seen:
            raise ValueError(f"Station name '{station['name']}' is used more than once")
        seen.add(station["name"])
        parsed.append(station)
    return parsed


def load_config() -> list[dict[str, str]]:
    """
    Read config.toml and return its stations. Logs an error and exits if the file can't be
    parsed, or if a station fails its check.
    """

    try:
        with CONFIG_PATH.open("rb") as f:
            loaded = tomllib.load(f)
    except (OSError, tomllib.TOMLDecodeError) as e:
        log.error(f"Could not read {CONFIG_PATH}: {e}")
        sys.exit(1)
    try:
        return _stations_from_config(loaded)
    except ValueError as e:
        log.error(f"{CONFIG_PATH}: {e}")
        sys.exit(1)


def _render_stations(entries: list[dict[str, str]]) -> str:
    """
    config.toml text for a station list
    """

    lines = [
        "# ValveStation nodes Plumber connects to. name is the id used for that station.",
        "# connection is the station's base URL. token is the pre-shared bearer token that",
        '# station expects as "Authorization: Bearer <token>".',
        "",
    ]
    if not entries:
        lines.append("stations = []")
        lines.append("")
    for station in entries:
        lines.append("[[stations]]")
        lines.append(f"name = {json.dumps(station['name'])}")
        lines.append(f"connection = {json.dumps(station['connection'])}")
        lines.append(f"token = {json.dumps(station['token'])}")
        lines.append("")
    return "\n".join(lines)


def _write_stations(entries: list[dict[str, str]]) -> None:
    """
    Replace config.toml with entries. The write is replaced into place so a crash
    cannot leave an empty config.
    """

    fd, tmp_name = tempfile.mkstemp(prefix=".config-", suffix=".toml", dir=CONFIG_PATH.parent)
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(_render_stations(entries))
        os.replace(tmp, CONFIG_PATH)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def _station_status(station: dict[str, str]) -> str:
    """
    online when the station's /health answers 200 with its token, offline otherwise
    """

    request = urllib.request.Request(
        station["connection"] + "/health",
        headers={"Authorization": f"Bearer {station['token']}"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=HEALTH_TIMEOUT) as response:
            if response.status == 200:
                return "online"
    except (urllib.error.URLError, TimeoutError, OSError):
        return "offline"
    return "offline"


def _entry_name(name: object, what: str) -> str:
    """
    A name that is a single path segment and does not start with '.'. Raises ValueError otherwise.
    """

    if not isinstance(name, str) or not name or name != Path(name).name or name.startswith("."):
        raise ValueError(f"{what} must be a single path segment and must not start with '.'")
    return name


def _ensure_storage() -> None:
    """
    Create the project directory and the three vault categories
    """

    PROJECTS_DIR.mkdir(exist_ok=True)
    for category in VAULT_CATEGORIES:
        (VAULT_DIR / category).mkdir(parents=True, exist_ok=True)


def _vault_path(category: str, name: str) -> Path:
    """
    Path of one vault file. The name is the id; the file is stored as {name}.toml.
    """

    if category not in VAULT_CATEGORIES:
        raise HTTPException(404, f"Vault category '{category}' not found")
    try:
        checked = _entry_name(name, "Vault file name")
    except ValueError as e:
        raise HTTPException(400, str(e))
    if checked == "list":
        raise HTTPException(400, "Vault file name 'list' is reserved")
    return VAULT_DIR / category / f"{checked}.toml"


def _write_vault(path: Path, text: str) -> None:
    """
    Replace a vault file. The write is replaced into place so a crash cannot leave it empty.
    """

    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=".vault-", suffix=".toml", dir=path.parent)
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def _projects_from_config(config: dict) -> list[dict[str, str]]:
    """
    The project list from a parsed projects.toml. A missing projects key is an empty list.
    A variant has base set to another project's name. Raises ValueError when a record is unusable.
    """

    raw = config.get("projects", [])
    if not isinstance(raw, list):
        raise ValueError("'projects' must be a list of projects")
    parsed: list[dict[str, str]] = []
    seen: set[str] = set()
    for entry in raw:
        if not isinstance(entry, dict):
            raise ValueError("Each project needs a name")
        name = _entry_name(entry.get("name"), "Project name")
        if name in seen:
            raise ValueError(f"Project name '{name}' is used more than once")
        seen.add(name)
        if "base" in entry:
            record = {"name": name, "base": _entry_name(entry.get("base"), "Base project name")}
            for key in VAULT_CATEGORIES:
                if entry.get(key) not in (None, ""):
                    record[key] = _entry_name(entry.get(key), f"Vault {key} name")
            if entry.get("repository") or entry.get("branch") or entry.get("deploy_key"):
                raise ValueError(f"Variant '{name}' cannot set a repository, branch, or deploy key")
            parsed.append(record)
            continue
        record = {"name": name}
        repository = entry.get("repository", "")
        if repository:
            if not isinstance(repository, str) or any(char in repository for char in "\r\n"):
                raise ValueError(f"Project '{name}' repository must be a git URL without line breaks")
            record["repository"] = repository
            try:
                record["branch"] = _branch_name(entry.get("branch", ""))
            except ValueError as e:
                raise ValueError(f"Project '{name}' {e}") from e
        elif entry.get("branch"):
            raise ValueError(f"Project '{name}' has a branch but no repository")
        deploy_key = entry.get("deploy_key", "")
        if deploy_key:
            if not isinstance(deploy_key, str) or "\x00" in deploy_key:
                raise ValueError(f"Project '{name}' deploy_key must be a string")
            if "repository" not in record:
                raise ValueError(f"Project '{name}' has a deploy key but no repository")
            record["deploy_key"] = deploy_key
        parsed.append(record)
    base_names = {project["name"] for project in parsed if "base" not in project}
    for project in parsed:
        if "base" in project and project["base"] not in base_names:
            raise ValueError(f"Variant '{project['name']}' bases on unknown project '{project['base']}'")
    return parsed


def load_projects() -> list[dict[str, str]]:
    """
    Read projects.toml. A missing file is an empty list and is created. Logs an error and exits
    if the file can't be parsed, or if a project fails its check.
    """

    if not PROJECTS_FILE.is_file():
        _write_projects([])
        return []
    try:
        with PROJECTS_FILE.open("rb") as f:
            loaded = tomllib.load(f)
    except (OSError, tomllib.TOMLDecodeError) as e:
        log.error(f"Could not read {PROJECTS_FILE}: {e}")
        sys.exit(1)
    try:
        return _projects_from_config(loaded)
    except ValueError as e:
        log.error(f"{PROJECTS_FILE}: {e}")
        sys.exit(1)


def _render_projects(entries: list[dict[str, str]]) -> str:
    """
    projects.toml text for a project list
    """

    lines = [
        "# Registered Canonada projects. name is the id Plumber uses.",
        "# A variant sets base to another project's name and names the vault files that override its config.",
        "",
    ]
    if not entries:
        lines.append("projects = []")
        lines.append("")
    for project in entries:
        lines.append("[[projects]]")
        for key in ("name", "repository", "branch", "deploy_key", "base", *VAULT_CATEGORIES):
            if project.get(key):
                lines.append(f"{key} = {json.dumps(project[key])}")
        lines.append("")
    return "\n".join(lines)


def _write_projects(entries: list[dict[str, str]]) -> None:
    """
    Replace projects.toml with entries. The write is replaced into place so a crash
    cannot leave an empty file.
    """

    PROJECTS_FILE.parent.mkdir(exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=".projects-", suffix=".toml", dir=PROJECTS_FILE.parent)
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(_render_projects(entries))
        os.replace(tmp, PROJECTS_FILE)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def _public_project(record: dict[str, str]) -> dict[str, str]:
    """
    The fields a client sees for one project. The deploy key is left out.
    """

    if "base" in record:
        shown = {"name": record["name"], "base": record["base"]}
        for key in VAULT_CATEGORIES:
            if record.get(key):
                shown[key] = record[key]
        return shown
    shown = {"name": record["name"]}
    if record.get("repository"):
        shown["repository"] = record["repository"]
        shown["branch"] = record["branch"]
    return shown


def _require_canonada(directory: Path) -> str:
    """
    Return the project name from canonada.toml at the directory root
    """

    path = directory / "canonada.toml"
    if not path.is_file():
        raise HTTPException(400, "The project has no canonada.toml at its root")
    try:
        with path.open("rb") as f:
            data = tomllib.load(f)
    except (OSError, tomllib.TOMLDecodeError) as e:
        raise HTTPException(400, f"Could not read canonada.toml: {e}")
    project = data.get("project")
    name = project.get("name") if isinstance(project, dict) else None
    try:
        return _entry_name(name, "canonada.toml [project] name")
    except ValueError as e:
        raise HTTPException(400, str(e))


def _set_canonada_name(directory: Path, name: str) -> None:
    """
    Set the [project] name in canonada.toml, leaving the rest of the file as it was
    """

    path = directory / "canonada.toml"
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines(keepends=True)
    in_project = False
    replaced = False
    rewritten = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            in_project = stripped == "[project]"
        elif in_project and not replaced and stripped.startswith("name") and "=" in stripped:
            indent = line[: len(line) - len(line.lstrip())]
            newline = "\n" if line.endswith("\n") else ""
            line = f"{indent}name = {json.dumps(name)}{newline}"
            replaced = True
        rewritten.append(line)
    if not replaced:
        raise HTTPException(400, "canonada.toml needs a [project] name")
    path.write_text("".join(rewritten), encoding="utf-8")


def _extract_zip(archive: Path, dest: Path) -> None:
    """
    Unpack a zip archive into dest, refusing members that would land outside of it
    """

    if not zipfile.is_zipfile(archive):
        raise HTTPException(400, "Not a zip archive")
    dest.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as zf:
        root = dest.resolve()
        for member in zf.namelist():
            if not (root / member).resolve().is_relative_to(root):
                raise HTTPException(400, f"Member '{member}' points outside the archive")
        zf.extractall(dest)
    _require_canonada(dest)


def _branch_name(branch: object) -> str:
    """
    A git branch name. Raises ValueError when it is empty, has spaces, or starts with '-'.
    """

    if not isinstance(branch, str) or not branch or branch.startswith("-") or any(char.isspace() for char in branch):
        raise ValueError("branch must be a branch name without spaces")
    return branch


def _run_git(args: list[str], deploy_key: str) -> None:
    """
    Run git. A deploy key is given to ssh for that command only, then removed.
    """

    key_file: Path | None = None
    env = os.environ.copy()
    try:
        if deploy_key:
            fd, key_name = tempfile.mkstemp(prefix=".deploy-key-")
            key_file = Path(key_name)
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(deploy_key)
                if not deploy_key.endswith("\n"):
                    handle.write("\n")
            env["GIT_SSH_COMMAND"] = f"ssh -i {key_file} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
        try:
            result = subprocess.run(args, env=env, capture_output=True, text=True)
        except FileNotFoundError:
            raise HTTPException(500, "git is not installed")
        if result.returncode != 0:
            detail = result.stderr.strip().splitlines()
            reason = f": {detail[-1]}" if detail else ""
            raise HTTPException(500, f"git failed{reason}")
    finally:
        if key_file is not None:
            key_file.unlink(missing_ok=True)


def _swap_tree(src: Path, dest: Path) -> None:
    """
    Put the directory src where dest is. The previous dest is removed only after the swap.
    """

    backup = dest.with_name(f".old-{dest.name}")
    if backup.exists():
        shutil.rmtree(backup)
    if dest.exists():
        dest.rename(backup)
    try:
        src.rename(dest)
    except OSError:
        if backup.exists() and not dest.exists():
            backup.rename(dest)
        raise
    if backup.exists():
        shutil.rmtree(backup)


def _apply_vault(directory: Path, variant: dict[str, str]) -> None:
    """
    Copy the variant's vault files over config/catalog.toml, parameters.toml, and credentials.toml
    """

    config_dir = directory / "config"
    config_dir.mkdir(exist_ok=True)
    filenames = {"catalog": "catalog.toml", "parameters": "parameters.toml", "credentials": "credentials.toml"}
    for category in VAULT_CATEGORIES:
        vault_name = variant.get(category)
        if not vault_name:
            continue
        source = _vault_path(category, vault_name)
        if not source.is_file():
            raise HTTPException(404, f"Vault {category} '{vault_name}' not found")
        shutil.copyfile(source, config_dir / filenames[category])


def _materialise_variant(variant: dict[str, str]) -> None:
    """
    Rebuild a variant's directory from its base project, then set its Canonada name and vault files
    """

    staging = Path(tempfile.mkdtemp(prefix=".staging-", dir=PROJECTS_DIR))
    try:
        tree = staging / "tree"
        shutil.copytree(PROJECTS_DIR / variant["base"], tree, ignore=shutil.ignore_patterns(".git"))
        _set_canonada_name(tree, variant["name"])
        _apply_vault(tree, variant)
        _swap_tree(tree, PROJECTS_DIR / variant["name"])
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def _variants_of(base: str) -> list[dict[str, str]]:
    """
    Variants whose base is this project, in list order
    """

    return [project for project in projects if project.get("base") == base]


# Stations ---------------------------------------------------------------------
@app.get("/station/list")
def list_stations() -> dict:
    """
    Configured stations and whether each is online or offline. Tokens are not included.
    """

    with stations_lock:
        snapshot = list(stations)
    if not snapshot:
        return {"stations": []}
    workers = min(32, len(snapshot))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        statuses = list(pool.map(_station_status, snapshot))
    return {
        "stations": [
            {"name": station["name"], "connection": station["connection"], "status": status}
            for station, status in zip(snapshot, statuses)
        ]
    }


@app.post("/station/add")
async def add_station(request: Request) -> dict:
    """
    Add a ValveStation. The JSON body gives the name Plumber will use as its id, the station's
    base URL, and its pre-shared token. The station is written to config.toml.

    {"name": "lab", "connection": "http://127.0.0.1:508", "token": "secret"}
    """

    try:
        body = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise HTTPException(400, "Request body must be a JSON object with name, connection, and token")
    try:
        station = _station_from_mapping(body)
    except ValueError as e:
        raise HTTPException(400, str(e))

    with stations_lock:
        if any(current["name"] == station["name"] for current in stations):
            raise HTTPException(409, f"Station '{station['name']}' already exists")
        updated = [*stations, station]
        try:
            _write_stations(updated)
        except OSError as e:
            raise HTTPException(500, f"Could not write {CONFIG_PATH}: {e}")
        stations[:] = updated
    return {"name": station["name"], "added": True}


@app.delete("/station/remove/{name}")
def remove_station(name: str) -> dict:
    """
    Remove a ValveStation by the name Plumber uses for it
    """

    # TODO: Stop all runs of the project before removing the station (do it by deleting all projects)

    with stations_lock:
        if not any(current["name"] == name for current in stations):
            raise HTTPException(404, f"Station '{name}' not found")
        updated = [current for current in stations if current["name"] != name]
        try:
            _write_stations(updated)
        except OSError as e:
            raise HTTPException(500, f"Could not write {CONFIG_PATH}: {e}")
        stations[:] = updated
    return {"name": name, "removed": True}


# Vault ------------------------------------------------------------------------
@app.get("/vault/{category}/list")
def list_vault(category: str) -> dict:
    """
    Names of the files stored in one vault category
    """

    if category not in VAULT_CATEGORIES:
        raise HTTPException(404, f"Vault category '{category}' not found")
    directory = VAULT_DIR / category
    files = sorted(path.stem for path in directory.glob("*.toml") if path.is_file() and not path.stem.startswith("."))
    return {"files": files}


@app.get("/vault/{category}/{name}")
def view_vault(category: str, name: str) -> PlainTextResponse:
    """
    The text of one vault file
    """

    path = _vault_path(category, name)
    if not path.is_file():
        raise HTTPException(404, f"Vault {category} '{name}' not found")
    return PlainTextResponse(path.read_text(encoding="utf-8"))


@app.put("/vault/{category}/{name}")
def put_vault(category: str, name: str, file: UploadFile) -> dict:
    """
    Store a TOML file in the vault. Send the file as multipart field 'file'.

    PUT /vault/catalog/lab
    file: catalog.toml
    """

    path = _vault_path(category, name)
    text = file.file.read()
    try:
        decoded = text.decode("utf-8")
        tomllib.loads(decoded)
    except (UnicodeDecodeError, tomllib.TOMLDecodeError) as e:
        raise HTTPException(400, f"Could not read the TOML file: {e}")
    with vault_lock:
        replaced = path.is_file()
        try:
            _write_vault(path, decoded)
        except OSError as e:
            raise HTTPException(500, f"Could not write {path}: {e}")
    return {"name": name, "replaced": replaced}


@app.delete("/vault/{category}/{name}")
def delete_vault(category: str, name: str) -> dict:
    """
    Delete a vault file. A file a variant still uses is left in place.
    """

    path = _vault_path(category, name)
    with projects_lock:
        used = next((project["name"] for project in projects if project.get(category) == name and "base" in project), None)
        if used:
            raise HTTPException(409, f"Vault {category} '{name}' is used by variant '{used}'")
        with vault_lock:
            try:
                path.unlink()
            except FileNotFoundError:
                raise HTTPException(404, f"Vault {category} '{name}' not found")
    return {"name": name, "removed": True}


# Project ----------------------------------------------------------------------
@app.get("/project/list")
def list_projects() -> dict:
    """
    Registered projects and variants. A variant includes its base project and the vault files it uses.
    """

    with projects_lock:
        return {"projects": [_public_project(project) for project in projects]}


@app.put("/project/register")
def register_project(
    repository: str = Form(""),
    branch: str = Form(""),
    deploy_key: str = Form(""),
    file: UploadFile | None = File(None),
) -> dict:
    """
    Register a Canonada project and record it in projects.toml. Its name is read from
    canonada.toml. Send either a repository and the branch to track (plus a deploy_key, when the
    repository needs one), or a zip file whose root contains canonada.toml.

    repository=https://example.com/widget.git
    branch=main
    """

    repository = repository.strip()
    branch = branch.strip()
    has_file = file is not None and bool(file.filename)
    if has_file == bool(repository):
        raise HTTPException(400, "Send a repository or a zip file")
    if branch and not repository:
        raise HTTPException(400, "A branch needs a repository")
    if deploy_key and not repository:
        raise HTTPException(400, "A deploy key needs a repository")
    if repository and any(char in repository for char in "\r\n"):
        raise HTTPException(400, "repository must be a git URL without line breaks")
    if repository:
        try:
            branch = _branch_name(branch)
        except ValueError as e:
            raise HTTPException(400, str(e))
    if deploy_key and "\x00" in deploy_key:
        raise HTTPException(400, "deploy_key must be a string")

    with projects_lock:
        PROJECTS_DIR.mkdir(exist_ok=True)
        staging = Path(tempfile.mkdtemp(prefix=".staging-", dir=PROJECTS_DIR))
        try:
            tree = staging / "tree"
            if has_file:
                archive = staging / "upload.zip"
                assert file is not None
                with archive.open("wb") as handle:
                    shutil.copyfileobj(file.file, handle)
                _extract_zip(archive, tree)
                checked = _require_canonada(tree)
            else:
                _run_git(["git", "clone", "--branch", branch, repository, str(tree)], deploy_key)
                checked = _require_canonada(tree)
            if any(project["name"] == checked for project in projects) or (PROJECTS_DIR / checked).exists():
                raise HTTPException(409, f"Project '{checked}' already exists")
            record = {"name": checked}
            if repository:
                record["repository"] = repository
                record["branch"] = branch
            if deploy_key:
                record["deploy_key"] = deploy_key
            _swap_tree(tree, PROJECTS_DIR / checked)
            updated = [*projects, record]
            try:
                _write_projects(updated)
            except OSError as e:
                shutil.rmtree(PROJECTS_DIR / checked, ignore_errors=True)
                raise HTTPException(500, f"Could not write {PROJECTS_FILE}: {e}")
        finally:
            shutil.rmtree(staging, ignore_errors=True)
        projects[:] = updated
    return {"name": checked, "added": True}


@app.put("/project/update/{name}")
def update_project(name: str, file: UploadFile | None = File(None)) -> dict:
    """
    Update the registered project identified by the name in its canonada.toml. Send a zip to
    replace its files; the zip's canonada.toml must use this same name. With no zip, the
    project's repository is pulled. Variants of the project are rebuilt from the new files.

    PUT /project/update/widget
    """

    try:
        checked = _entry_name(name, "Project name")
    except ValueError as e:
        raise HTTPException(400, str(e))
    has_file = file is not None and bool(file.filename)

    with projects_lock:
        record = next((project for project in projects if project["name"] == checked), None)
        if record is None:
            raise HTTPException(404, f"Project '{checked}' not found")
        if "base" in record:
            raise HTTPException(400, f"Project '{checked}' is a variant; update '{record['base']}' instead")
        if not has_file and not record.get("repository"):
            raise HTTPException(400, f"Project '{checked}' has no repository to pull")
        for variant in _variants_of(checked):
            for category in VAULT_CATEGORIES:
                vault_name = variant.get(category)
                if vault_name and not _vault_path(category, vault_name).is_file():
                    raise HTTPException(404, f"Vault {category} '{vault_name}' not found")

        PROJECTS_DIR.mkdir(exist_ok=True)
        directory = PROJECTS_DIR / checked
        if has_file:
            staging = Path(tempfile.mkdtemp(prefix=".staging-", dir=PROJECTS_DIR))
            try:
                archive = staging / "upload.zip"
                tree = staging / "tree"
                assert file is not None
                with archive.open("wb") as handle:
                    shutil.copyfileobj(file.file, handle)
                _extract_zip(archive, tree)
                archive_name = _require_canonada(tree)
                if archive_name != checked:
                    raise HTTPException(400, f"canonada.toml names this project '{archive_name}'")
                _swap_tree(tree, directory)
            finally:
                shutil.rmtree(staging, ignore_errors=True)
        elif (directory / ".git").is_dir():
            _run_git(["git", "-C", str(directory), "checkout", record["branch"]], record.get("deploy_key", ""))
            _run_git(
                ["git", "-C", str(directory), "pull", "--ff-only", "origin", record["branch"]],
                record.get("deploy_key", ""),
            )
            pulled_name = _require_canonada(directory)
            if pulled_name != checked:
                raise HTTPException(400, f"canonada.toml names this project '{pulled_name}'")
        else:
            staging = Path(tempfile.mkdtemp(prefix=".staging-", dir=PROJECTS_DIR))
            try:
                tree = staging / "tree"
                _run_git(
                    ["git", "clone", "--branch", record["branch"], record["repository"], str(tree)],
                    record.get("deploy_key", ""),
                )
                cloned_name = _require_canonada(tree)
                if cloned_name != checked:
                    raise HTTPException(400, f"canonada.toml names this project '{cloned_name}'")
                _swap_tree(tree, directory)
            finally:
                shutil.rmtree(staging, ignore_errors=True)
        for variant in _variants_of(checked):
            _materialise_variant(variant)
    return {"name": checked, "updated": True}


@app.put("/project/register/variant")
async def register_variant(request: Request) -> dict:
    """
    Register a variant of an existing project. The variant gets its own name, a copy of the base
    project's files, and any vault files named here. Those files replace the project's config,
    and the Canonada project name becomes the variant name. Updating or deleting the base project
    does the same to its variants.

    {"name": "widget-lab", "base": "widget", "catalog": "lab"}
    """

    try:
        body = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise HTTPException(400, "Request body must be a JSON object with name and base")
    if not isinstance(body, dict):
        raise HTTPException(400, "Request body must be a JSON object with name and base")
    unknown = set(body) - {"name", "base", *VAULT_CATEGORIES}
    if unknown:
        raise HTTPException(400, f"Unknown field '{sorted(unknown)[0]}'")
    try:
        checked = _entry_name(body.get("name"), "Variant name")
        base = _entry_name(body.get("base"), "Base project name")
        record = {"name": checked, "base": base}
        for category in VAULT_CATEGORIES:
            if body.get(category) not in (None, ""):
                record[category] = _entry_name(body.get(category), f"Vault {category} name")
    except ValueError as e:
        raise HTTPException(400, str(e))

    with projects_lock:
        if any(project["name"] == checked for project in projects) or (PROJECTS_DIR / checked).exists():
            raise HTTPException(409, f"Project '{checked}' already exists")
        base_record = next((project for project in projects if project["name"] == base), None)
        if base_record is None:
            raise HTTPException(404, f"Project '{base}' not found")
        if "base" in base_record:
            raise HTTPException(400, f"Project '{base}' is a variant of '{base_record['base']}'")
        if not (PROJECTS_DIR / base).is_dir():
            raise HTTPException(404, f"Project '{base}' has no files")
        for category in VAULT_CATEGORIES:
            vault_name = record.get(category)
            if vault_name and not _vault_path(category, vault_name).is_file():
                raise HTTPException(404, f"Vault {category} '{vault_name}' not found")
        try:
            _materialise_variant(record)
        except OSError as e:
            shutil.rmtree(PROJECTS_DIR / checked, ignore_errors=True)
            raise HTTPException(500, f"Could not write the variant: {e}")
        updated = [*projects, record]
        try:
            _write_projects(updated)
        except OSError as e:
            shutil.rmtree(PROJECTS_DIR / checked, ignore_errors=True)
            raise HTTPException(500, f"Could not write {PROJECTS_FILE}: {e}")
        projects[:] = updated
    return {"name": checked, "added": True}


@app.delete("/project/remove/{project}")
def remove_project(project: str) -> dict:
    """
    Remove a project or variant by name. Removing a base project also removes its variants.
    """

    with projects_lock:
        if not any(current["name"] == project for current in projects):
            raise HTTPException(404, f"Project '{project}' not found")
        doomed = [current["name"] for current in projects if current["name"] == project or current.get("base") == project]
        updated = [current for current in projects if current["name"] not in doomed]
        try:
            _write_projects(updated)
        except OSError as e:
            raise HTTPException(500, f"Could not write {PROJECTS_FILE}: {e}")
        projects[:] = updated
        for doomed_name in doomed:
            shutil.rmtree(PROJECTS_DIR / doomed_name, ignore_errors=True)
    return {"project": project, "removed": True}


# API --------------------------------------------------------------------------
def api() -> None:
    """
    Install a control plane directory, or start the server in the working directory
    """

    installing = len(sys.argv) > 1 and sys.argv[1] == "install"
    logging.basicConfig(
        format="%(asctime)s - %(name)s: [%(levelname)s]: %(message)s",
        level=logging.INFO if installing else logging.WARNING,
    )
    if installing:
        install()
        return

    check_install()  # First thing at boot
    _ensure_storage()
    global stations, projects
    stations = load_config()
    projects = load_projects()

    host = os.environ.get("PLUMBER_HOST", "127.0.0.1")
    port = int(os.environ.get("PLUMBER_PORT", "509"))
    uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    api()

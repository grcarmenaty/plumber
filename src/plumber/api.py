"""
Plumber: an HTTP control plane for ValveStation nodes

Configuration is read from config.toml in the working directory. Projects are recorded in
projects.toml, and vault files live under vault/catalog, vault/parameters, and vault/credentials.
Install a control plane with:
    plumber install
Run with:
    plumber
"""

import hashlib
import io
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
from urllib.parse import quote, urlsplit

import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import PlainTextResponse

CONFIG_PATH = Path("config.toml").resolve()
PROJECTS_FILE = CONFIG_PATH.parent / "projects.toml"  # Registered projects and variants
PROJECTS_DIR = CONFIG_PATH.parent / "projects"  # One directory per project, holding its files
VAULT_DIR = CONFIG_PATH.parent / "vault"  # catalog/, parameters/, and credentials/
VAULT_CATEGORIES = ("catalog", "parameters", "credentials")
HEALTH_TIMEOUT = 3  # Seconds to wait for a station's /health before calling it offline
STATION_TIMEOUT = 30  # Seconds for a station call that may stop running projects
CANONADA_TIMEOUT = 60  # Seconds Canonada may take to load a project

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


def _stations_snapshot() -> list[dict[str, str]]:
    """
    A copy of the configured stations
    """

    with stations_lock:
        return [dict(station) for station in stations]


def _station_named(name: str) -> dict[str, str]:
    """
    One configured station. Raises 404 when the name is unknown.
    """

    station = next((item for item in _stations_snapshot() if item["name"] == name), None)
    if station is None:
        raise HTTPException(404, f"Station '{name}' not found")
    return station


def _call_station(
    station: dict[str, str],
    method: str,
    path: str,
    data: bytes | None = None,
    content_type: str | None = None,
) -> tuple[int, bytes]:
    """
    Call one path on a station with its bearer token and return the status and body
    """

    headers = {"Authorization": f"Bearer {station['token']}"}
    if content_type:
        headers["Content-Type"] = content_type
    request = urllib.request.Request(station["connection"] + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=STATION_TIMEOUT) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except (urllib.error.URLError, TimeoutError, OSError):
        raise HTTPException(502, f"Station '{station['name']}' did not respond")


def _station_json(
    station: dict[str, str],
    method: str,
    path: str,
    data: bytes | None = None,
    content_type: str | None = None,
) -> tuple[int, object]:
    """
    Call a station and parse a JSON body. An empty or non-JSON body is None.
    """

    status, body = _call_station(station, method, path, data, content_type)
    if not body:
        return status, None
    try:
        return status, json.loads(body)
    except json.JSONDecodeError:
        return status, None


def _error_detail(payload: object, fallback: str) -> str:
    """
    The detail string from a station's error body, or fallback
    """

    if isinstance(payload, dict) and isinstance(payload.get("detail"), str):
        return payload["detail"]
    return fallback


def _delete_station_projects(station: dict[str, str]) -> None:
    """
    Delete every project on a station. ValveStation stops that project's runs before removing its files.
    """

    status, payload = _station_json(station, "GET", "/registry/projects")
    projects_on_station = payload.get("projects") if isinstance(payload, dict) else None
    if status != 200 or not isinstance(projects_on_station, list):
        raise HTTPException(502, f"Station '{station['name']}' did not list its projects")
    for project in projects_on_station:
        if not isinstance(project, str) or not project:
            raise HTTPException(502, f"Station '{station['name']}' did not list its projects")
        code, _ = _call_station(station, "DELETE", "/project/remove/" + quote(project, safe=""))
        if code not in (200, 404):
            raise HTTPException(502, f"Station '{station['name']}' did not remove project '{project}'")


def _delete_project_on_stations(names: list[str]) -> None:
    """
    Delete these projects on every station. ValveStation stops a project's runs when it is removed.
    A station that does not have the project is left as it is.
    """

    for station in _stations_snapshot():
        for project in names:
            code, _ = _call_station(station, "DELETE", "/project/remove/" + quote(project, safe=""))
            if code not in (200, 404):
                raise HTTPException(502, f"Station '{station['name']}' did not remove project '{project}'")


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


def _project_files(directory: Path) -> list[tuple[str, Path]]:
    """
    Project files in path order, named with '/'. Directories named .git or __pycache__ are skipped.
    """

    found = []
    for path in directory.rglob("*"):
        if not path.is_file():
            continue
        relative = path.relative_to(directory)
        if ".git" in relative.parts or "__pycache__" in relative.parts:
            continue
        found.append((relative.as_posix(), path))
    found.sort()
    return found


def _project_fingerprint(directory: Path) -> tuple[str, str]:
    """
    The version from canonada.toml and a sha256 of the project files. Paths are relative,
    sorted, and use '/'. Directories named .git or __pycache__ are skipped.
    """

    with (directory / "canonada.toml").open("rb") as handle:
        data = tomllib.load(handle)
    project = data.get("project") if isinstance(data, dict) else None
    version = project.get("version") if isinstance(project, dict) else None
    if not isinstance(version, str):
        version = ""
    digest = hashlib.sha256()
    for relative, path in _project_files(directory):
        payload = path.read_bytes()
        digest.update(relative.encode())
        digest.update(b"\0")
        digest.update(str(len(payload)).encode())
        digest.update(b"\0")
        digest.update(payload)
    return version, digest.hexdigest()


def _zip_project(directory: Path) -> bytes:
    """
    A zip of the project with canonada.toml at its root, using the same files as the fingerprint
    """

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for relative, path in _project_files(directory):
            archive.writestr(relative, path.read_bytes())
    return buffer.getvalue()


def _send_project(station: dict[str, str], directory: Path) -> None:
    """
    Upload a project zip to a station. The field name is the one ValveStation expects.
    """

    boundary = "plumberboundary"
    body = b"".join([
        f"--{boundary}\r\n".encode(),
        b'Content-Disposition: form-data; name="file"; filename="project.zip"\r\n',
        b"Content-Type: application/zip\r\n\r\n",
        _zip_project(directory),
        f"\r\n--{boundary}--\r\n".encode(),
    ])
    code, _ = _station_json(
        station,
        "PUT",
        "/project/add",
        body,
        f"multipart/form-data; boundary={boundary}",
    )
    if code != 200:
        raise HTTPException(502, f"Station '{station['name']}' did not accept the project")


def _ensure_project(station: dict[str, str], project: str, directory: Path) -> bool:
    """
    Send the project when the station does not have this exact file set. Returns whether it was sent.
    """

    _, digest = _project_fingerprint(directory)
    code, payload = _station_json(station, "GET", "/project/version/" + quote(project, safe=""))
    if code == 200 and isinstance(payload, dict) and payload.get("sha256") == digest:
        return False
    if code not in (200, 404):
        raise HTTPException(502, f"Station '{station['name']}' did not report the project version")
    _send_project(station, directory)
    return True


def _over_stations(fetch) -> list[dict]:
    """
    Ask every station. One station that does not respond becomes an error entry, not a failed request.
    """

    snapshot = _stations_snapshot()
    if not snapshot:
        return []

    def guarded(station: dict[str, str]) -> dict:
        try:
            return fetch(station)
        except HTTPException as e:
            detail = e.detail if isinstance(e.detail, str) else f"Station '{station['name']}' did not respond"
            return {"station": station["name"], "error": detail}

    with ThreadPoolExecutor(max_workers=min(32, len(snapshot))) as pool:
        return list(pool.map(guarded, snapshot))


def _projects_on(station: dict[str, str]) -> list[str]:
    """
    Project names reported by a station
    """

    code, payload = _station_json(station, "GET", "/registry/projects")
    names = payload.get("projects") if isinstance(payload, dict) else None
    if code != 200 or not isinstance(names, list) or not all(isinstance(name, str) for name in names):
        raise HTTPException(502, f"Station '{station['name']}' did not list its projects")
    return names


def _view_configs(kind: str) -> list:
    """
    Catalog or parameters for every project on every station. kind is 'catalog' or 'parameters'.
    """

    def one(station: dict[str, str]) -> dict:
        entries = []
        for project in _projects_on(station):
            code, payload = _station_json(station, "GET", f"/catalog/projects/{quote(project, safe='')}/{kind}")
            if code == 200:
                entries.append({"project": project, kind: payload})
            elif code == 404:
                entries.append({"project": project, kind: None})
            else:
                entries.append({"project": project, "error": _error_detail(payload, f"did not return {kind}")})
        return {"station": station["name"], "projects": entries}

    return _over_stations(one)


def _canonada_registry(project: str, kind: str) -> list | dict:
    """
    Pipelines or systems of one local project, read by Canonada. kind is 'pipelines' or 'systems'.
    A load failure is {"error": "..."}.
    """

    # Canonada is imported before the project is on the path, so the project can't shadow it.
    if kind == "pipelines":
        script = """\
import json
import os
import sys

from canonada.pipeline import Pipeline

sys.path.append(os.getcwd())
from pipelines import *
from systems import *

entries = [
    {
        "name": p.name,
        "description": p.description,
        "nodes": [node.name for node in p.nodes],
        "max_workers": p.max_workers,
        "multiprocessing": p.multiprocessing,
        "error_tolerant": p.error_tolerant,
    }
    for p in Pipeline.registry
]
sys.stdout.write("\\n")
json.dump(entries, sys.stdout)
sys.stdout.write("\\n")
"""
    else:
        script = """\
import json
import os
import sys

from canonada.system import System

sys.path.append(os.getcwd())
from pipelines import *
from systems import *

entries = [
    {
        "name": s.name,
        "description": s.description,
        "pipelines": [p.name for p in s.pipeline],
    }
    for s in System.registry
]
sys.stdout.write("\\n")
json.dump(entries, sys.stdout)
sys.stdout.write("\\n")
"""

    directory = PROJECTS_DIR / project
    if not directory.is_dir():
        return {"error": f"Project '{project}' not found"}
    try:
        result = subprocess.run(
            [sys.executable, "-P", "-c", script],
            cwd=directory,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=CANONADA_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        return {"error": f"Canonada timed out loading project '{project}'"}

    if result.returncode != 0:
        detail = result.stderr.strip().splitlines()
        reason = f": {detail[-1]}" if detail else ""
        return {"error": f"Canonada can't load project '{project}'{reason}"}
    try:
        entries = json.loads(result.stdout.rsplit("\n", 2)[-2])
    except (json.JSONDecodeError, IndexError):
        return {"error": f"Canonada returned no JSON for project '{project}'"}
    if not isinstance(entries, list) or not all(isinstance(item, dict) for item in entries):
        return {"error": f"Canonada returned no JSON for project '{project}'"}
    return entries


def _view_makeups(kind: str, project: str, name: str) -> list:
    """
    A pipeline or system view from every station that has the project
    """

    route = "pipelines" if kind == "pipeline" else "systems"

    def one(station: dict[str, str]) -> dict:
        if project not in _projects_on(station):
            return {"station": station["name"], "error": f"Project '{project}' not found"}
        code, payload = _station_json(
            station,
            "GET",
            f"/view/projects/{quote(project, safe='')}/{route}/{quote(name, safe='')}",
        )
        if code == 200 and isinstance(payload, dict):
            return {"station": station["name"], "view": payload}
        return {"station": station["name"], "error": _error_detail(payload, f"'{name}' not found")}

    return _over_stations(one)


def _run(kind: str, project: str, name: str, station_name: str) -> dict:
    """
    Run a pipeline or system on one station, sending the project first when its files differ
    """

    station = _station_named(station_name)
    directory = PROJECTS_DIR / project
    with projects_lock:
        known = any(item["name"] == project for item in projects)
    if not known or not directory.is_dir():
        raise HTTPException(404, f"Project '{project}' not found")
    try:
        sent = _ensure_project(station, project, directory)
    except (OSError, tomllib.TOMLDecodeError) as e:
        raise HTTPException(400, f"Could not read project '{project}': {e}")
    route = "pipelines" if kind == "pipelines" else "systems"
    code, payload = _station_json(
        station,
        "POST",
        f"/run/projects/{quote(project, safe='')}/{route}/{quote(name, safe='')}",
        b"",
    )
    if code == 404:
        raise HTTPException(404, _error_detail(payload, f"'{name}' not found"))
    if code != 200 or not isinstance(payload, dict):
        raise HTTPException(502, f"Station '{station['name']}' did not start the run")
    return {"station": station["name"], "sent": sent, **payload}


def _list_runs(kind: str) -> list:
    """
    Pipeline or system runs reported by every station
    """

    def one(station: dict[str, str]) -> dict:
        code, payload = _station_json(station, "GET", f"/logs/{kind}")
        if code != 200 or not isinstance(payload, list):
            raise HTTPException(502, f"Station '{station['name']}' did not list its runs")
        return {"station": station["name"], "runs": payload}

    return _over_stations(one)


def _read_logs(kind: str, project: str, name: str) -> list:
    """
    The latest log of a pipeline or system from every station
    """

    route = "pipelines" if kind == "pipeline" else "systems"

    def one(station: dict[str, str]) -> dict:
        code, body = _call_station(
            station,
            "GET",
            f"/logs/projects/{quote(project, safe='')}/{route}/{quote(name, safe='')}",
        )
        if code == 200:
            return {"station": station["name"], "log": body.decode("utf-8", errors="replace")}
        detail = body.decode("utf-8", errors="replace")
        try:
            parsed = json.loads(detail) if detail else None
        except json.JSONDecodeError:
            parsed = None
        return {"station": station["name"], "error": _error_detail(parsed, f"No log for '{name}'")}

    return _over_stations(one)


# Stations ---------------------------------------------------------------------
@app.get("/station/list")
def list_stations() -> list:
    """
    Configured stations and whether each is online or offline. Tokens are not included.
    """

    with stations_lock:
        snapshot = list(stations)
    if not snapshot:
        return []
    workers = min(32, len(snapshot))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        statuses = list(pool.map(_station_status, snapshot))
    return [
        {"name": station["name"], "connection": station["connection"], "status": status}
        for station, status in zip(snapshot, statuses)
    ]


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
    Remove a ValveStation by the name Plumber uses for it. Projects on that station are deleted
    first, which stops any runs still going there.
    """

    with stations_lock:
        station = next((current for current in stations if current["name"] == name), None)
        if station is None:
            raise HTTPException(404, f"Station '{name}' not found")
        station = dict(station)
    _delete_station_projects(station)
    with stations_lock:
        updated = [current for current in stations if current["name"] != name]
        try:
            _write_stations(updated)
        except OSError as e:
            raise HTTPException(500, f"Could not write {CONFIG_PATH}: {e}")
        stations[:] = updated
    return {"name": name, "removed": True}


@app.put("/station/update")
def update_stations() -> list:
    """
    Send each registered project to every online station whose files do not match.
    A matching checksum is left as it is. Offline stations are skipped.

    PUT /station/update
    """

    snapshot = _stations_snapshot()
    with projects_lock:
        names = [project["name"] for project in projects]
    if not snapshot:
        return []

    def one(station: dict[str, str]) -> dict:
        if _station_status(station) != "online":
            return {"station": station["name"], "status": "offline"}
        entries = []
        for name in names:
            directory = PROJECTS_DIR / name
            if not directory.is_dir():
                entries.append({"project": name, "error": f"Project '{name}' not found"})
                continue
            try:
                sent = _ensure_project(station, name, directory)
            except HTTPException as e:
                detail = e.detail if isinstance(e.detail, str) else f"Station '{station['name']}' did not respond"
                entries.append({"project": name, "error": detail})
            except (OSError, tomllib.TOMLDecodeError) as e:
                entries.append({"project": name, "error": f"Could not read project '{name}': {e}"})
            else:
                entries.append({"project": name, "sent": sent})
        return {"station": station["name"], "status": "online", "projects": entries}

    with ThreadPoolExecutor(max_workers=min(32, len(snapshot))) as pool:
        return list(pool.map(one, snapshot))


# Vault ------------------------------------------------------------------------
@app.get("/vault/{category}/list")
def list_vault(category: str) -> list:
    """
    Names of the files stored in one vault category
    """

    if category not in VAULT_CATEGORIES:
        raise HTTPException(404, f"Vault category '{category}' not found")
    directory = VAULT_DIR / category
    files = sorted(path.stem for path in directory.glob("*.toml") if path.is_file() and not path.stem.startswith("."))
    return files


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
def list_projects() -> list:
    """
    Registered projects and variants. A variant includes its base project and the vault files it uses.
    """

    with projects_lock:
        return [_public_project(project) for project in projects]


@app.post("/project/register")
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


@app.post("/project/register/variant")
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
    Remove a project or variant by name. It is deleted on every station first, which stops any
    runs still going. Removing a base project also removes its variants.
    """

    with projects_lock:
        if not any(current["name"] == project for current in projects):
            raise HTTPException(404, f"Project '{project}' not found")
        doomed = [current["name"] for current in projects if current["name"] == project or current.get("base") == project]
        _delete_project_on_stations(doomed)
        updated = [current for current in projects if current["name"] not in doomed]
        try:
            _write_projects(updated)
        except OSError as e:
            raise HTTPException(500, f"Could not write {PROJECTS_FILE}: {e}")
        projects[:] = updated
        for doomed_name in doomed:
            shutil.rmtree(PROJECTS_DIR / doomed_name, ignore_errors=True)
    return {"project": project, "removed": True}


# Catalog ----------------------------------------------------------------------
@app.get("/catalog/view/catalog")
def view_catalogs() -> list:
    """
    Catalog entries of each project on each station
    """

    return _view_configs("catalog")


@app.get("/catalog/view/parameters")
def view_parameters() -> list:
    """
    Parameters of each project on each station
    """

    return _view_configs("parameters")


# Registry ---------------------------------------------------------------------
@app.get("/registry/pipelines")
def list_pipelines() -> dict:
    """
    Pipelines of each registered base project, read with Canonada and keyed by project name.
    Variants are not listed.

    {"widget": [{"name": "slow", "description": "", "nodes": ["read"]}]}
    """

    with projects_lock:
        names = [project["name"] for project in projects if "base" not in project]
    return {name: _canonada_registry(name, "pipelines") for name in names}


@app.get("/registry/systems")
def list_systems() -> dict:
    """
    Systems of each registered base project, read with Canonada and keyed by project name.
    Variants are not listed.

    {"widget": [{"name": "nightly", "description": "", "pipelines": ["slow"]}]}
    """

    with projects_lock:
        names = [project["name"] for project in projects if "base" not in project]
    return {name: _canonada_registry(name, "systems") for name in names}


# View -------------------------------------------------------------------------
@app.get("/view/pipeline/{project}/{pipeline}")
def view_pipeline(project: str, pipeline: str) -> list:
    """
    A pipeline's nodes and inputs and outputs, from each station that has the project
    """

    return _view_makeups("pipeline", project, pipeline)


@app.get("/view/system/{project}/{system}")
def view_system(project: str, system: str) -> list:
    """
    A system's pipelines in run order, from each station that has the project
    """

    return _view_makeups("system", project, system)


# Run --------------------------------------------------------------------------
@app.post("/run/pipeline/{project}/{pipeline}")
def run_pipeline(project: str, pipeline: str, station: str) -> dict:
    """
    Run a pipeline on a station. The project is sent first when the station does not already
    have the same files. station is the station name.

    POST /run/pipeline/widget/slow?station=lab
    """

    return _run("pipelines", project, pipeline, station)


@app.post("/run/system/{project}/{system}")
def run_system(project: str, system: str, station: str) -> dict:
    """
    Run a system on a station. The project is sent first when the station does not already
    have the same files. station is the station name.

    POST /run/system/widget/nightly?station=lab
    """

    return _run("systems", project, system, station)


# Logs -------------------------------------------------------------------------
@app.get("/logs/pipelines")
def list_pipeline_runs() -> list:
    """
    Pipeline runs on every station, and whether each is running, finished, or errored
    """

    return _list_runs("pipelines")


@app.get("/logs/systems")
def list_system_runs() -> list:
    """
    System runs on every station, and whether each is running, finished, or errored
    """

    return _list_runs("systems")


@app.get("/logs/pipeline/{project}/{pipeline}")
def read_pipeline_logs(project: str, pipeline: str) -> list:
    """
    The latest pipeline log from every station
    """

    return _read_logs("pipeline", project, pipeline)


@app.get("/logs/system/{project}/{system}")
def read_system_logs(project: str, system: str) -> list:
    """
    The latest system log from every station
    """

    return _read_logs("system", project, system)


# Misc -------------------------------------------------------------------------
@app.get("/version")
def get_version() -> dict:
    """
    The version of the server
    """

    from plumber._version import __version__
    return {"version": __version__}


@app.get("/health")
def get_health() -> dict:
    """
    idle when no station is configured or online, online when one is
    """

    snapshot = _stations_snapshot()
    if not snapshot:
        return {"health": "idle"}
    with ThreadPoolExecutor(max_workers=min(32, len(snapshot))) as pool:
        live = any(status == "online" for status in pool.map(_station_status, snapshot))
    return {"health": "online" if live else "idle"}


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

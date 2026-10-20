// Environments: install the projects' requirements, and run shell commands, on Plumber's machine and on
// the stations, through Plumber's POST /environment and POST /environment/{station}. A command runs in the
// machine's own Python environment: the one that loads and runs project code there.

import {
  api, badge, busy, button, confirmDialog, emptyState, errorBox, h, loading, plural, projects, redraw, safeFilename,
  saveText, seg, stations, table, toast,
} from "./ui.js";

const EOF = "PLUMBER_REQUIREMENTS_EOF"; // Ends the requirements sent to a station in a here-document

// Kept while plumber-gui's page is open, so leaving the tab neither loses nor stops them
let install = null; // The last install: { targets, projects, cells: Map, running, stopped }
let commandRun = null; // The last command: { station, command, running, result | error }
const unticked = { projects: new Set(), targets: new Set() }; // Left out of the next install; new ones start ticked
const listeners = new Set(); // The tab on screen, redrawn as installs and commands go

function changed() {
  for (const fn of listeners) fn();
}

/** text as one shell word, in single quotes */
export function shellQuote(text) {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/** A command that prints a project's requirements.txt on Plumber's machine, and nothing when it has none */
export function readCommand(project) {
  const file = `projects/${shellQuote(project)}/requirements.txt`;
  return `if [ -f ${file} ]; then cat ${file}; fi`;
}

/** Whether requirements text gives pip anything: a line that is neither blank nor a comment */
export function listsRequirements(text) {
  return text.split(/\r?\n/).some((line) => line.trim() && !line.trim().startsWith("#"));
}

/**
 * The command that installs a project's requirements. On Plumber's machine (station null) pip reads the
 * project's own file, so lines that point at other files (-r, -e, ./path) work. A station doesn't have the
 * project yet, so its lines, read on Plumber, go in a here-document. null when they hold the end line.
 */
export function installCommand(project, station, text) {
  if (station === null) return `cd projects/${shellQuote(project)} && python -m pip install -r requirements.txt`;
  if (text.split(/\r?\n/).includes(EOF)) return null;
  return `python -m pip install -r /dev/stdin <<'${EOF}'\n${text.endsWith("\n") ? text : text + "\n"}${EOF}`;
}

/** Run a command on Plumber's machine (station null) or on a station */
function runOn(station, command) {
  return station === null
    ? api("POST", "/environment", { json: { command } })
    : api("POST", seg`/environment/${station}`, { json: { command } });
}

function targetName(station) {
  return station === null ? "Plumber" : station;
}

function failure(error) {
  return error.status === 409 ? "Another command is running there. Try again when it ends." : error.message;
}

function resultBadge(result) {
  if (result.timed_out) return badge("skipped", "timed out");
  return result.exit_code === 0 ? badge("finished", "exit 0") : badge("errored", `exit ${result.exit_code}`);
}

/** A command's outcome: its exit, Download, the command, and its output (or the error that kept it from running) */
function outcome({ command, result, error }, filename) {
  return [
    error ? h("p", { class: "error-text" }, error)
      : h("div", { class: "env-result-head" }, [resultBadge(result), button("Download", () => saveText(result.output, filename), "quiet small")]),
    command ? h("details", { class: "env-command" }, [h("summary", null, "Command"), h("pre", { class: "env-output" }, command)]) : null,
    result ? h("pre", { class: "env-output" }, result.output || h("span", { class: "muted" }, "(no output)")) : null,
  ];
}

/** A cell's outcome in a dialog, closed with its button or Escape */
function outcomeDialog(title, cell, filename) {
  const close = h("button", { type: "button", class: "btn primary", onclick: () => finish() }, "Close");
  const dialog = h("dialog", { class: "dialog wide" }, h("div", { class: "dialog-form" }, [
    h("h2", { class: "dialog-title" }, title),
    h("div", { class: "dialog-body" }, outcome(cell, filename)),
    h("div", { class: "dialog-actions" }, close),
  ]));
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    finish();
  });
  document.body.append(dialog);
  dialog.showModal();
  close.focus();

  function finish() {
    dialog.close();
    dialog.remove();
  }
}

function cellKey(station, project) {
  return JSON.stringify([station, project]);
}

/**
 * Install the requirements of each project on each target (null is Plumber's machine). Every project's
 * requirements.txt is read on Plumber first: Plumber runs one command at a time, and its own installs come
 * next. Then the targets go at once, each through its projects one after another.
 */
async function installRequirements(targets, names) {
  const cells = new Map();
  for (const station of targets) for (const project of names) cells.set(cellKey(station, project), { state: "waiting" });
  const run = { targets, projects: names, cells, running: true, stopped: false };
  install = run;
  changed();
  const read = new Map();
  for (const project of names) {
    if (run.stopped) break;
    for (const station of targets) cells.get(cellKey(station, project)).state = "reading";
    changed();
    try {
      const result = await runOn(null, readCommand(project));
      read.set(project, result.exit_code === 0 && !result.timed_out ? { text: result.output }
        : { error: `Reading projects/${project}/requirements.txt on Plumber failed: ${result.output.trim() || `exit ${result.exit_code}`}` });
    } catch (error) {
      read.set(project, { error: `Could not read projects/${project}/requirements.txt on Plumber: ${failure(error)}` });
    }
    for (const station of targets) cells.get(cellKey(station, project)).state = "waiting";
  }
  await Promise.all(targets.map(async (station) => {
    for (const project of names) {
      const cell = cells.get(cellKey(station, project));
      const got = read.get(project);
      if (run.stopped || !got) {
        cell.state = "skipped";
      } else if (got.error) {
        Object.assign(cell, { state: "error", error: got.error });
      } else if (!listsRequirements(got.text)) {
        cell.state = "none";
      } else {
        const command = installCommand(project, station, got.text);
        if (command === null) {
          Object.assign(cell, { state: "error", error: `Its requirements.txt has a line ${EOF}, which ends the lines sent to a station.` });
        } else {
          Object.assign(cell, { state: "installing", command });
          changed();
          try {
            cell.result = await runOn(station, command);
            cell.state = cell.result.timed_out ? "timed out" : cell.result.exit_code === 0 ? "installed" : "failed";
          } catch (error) {
            Object.assign(cell, { state: "error", error: failure(error) });
          }
        }
      }
      changed();
    }
  }));
  run.running = false;
  changed();
  const states = [...cells.values()].map((cell) => cell.state);
  const bad = states.filter((state) => ["failed", "timed out", "error"].includes(state)).length;
  toast(bad ? `Install requirements: ${plural(bad, "install")} failed. Select a cell to see why.`
    : `Install requirements: done${run.stopped ? " (stopped)" : ""}.`, { kind: bad ? "error" : "ok", sticky: bad > 0 });
}

const CELLS = {
  reading: () => badge("running", "reading…"),
  waiting: () => badge("disabled", "waiting"),
  installing: () => badge("running", "installing…"),
  installed: () => badge("finished", "installed"),
  none: () => badge("disabled", "nothing to install"),
  failed: (cell) => badge("errored", `failed, exit ${cell.result.exit_code}`),
  "timed out": () => badge("skipped", "timed out"),
  error: () => badge("error", "error"),
  skipped: () => badge("disabled", "skipped"),
};

async function runCommand(station, command) {
  commandRun = { station, command, running: true };
  changed();
  try {
    commandRun.result = await runOn(station, command);
  } catch (error) {
    commandRun.error = failure(error);
  }
  commandRun.running = false;
  changed();
}

// Tab ----------------------------------------------------------------------------

export function renderEnvironments(params, ctx) {
  const installBody = h("div");
  const resultArea = h("div", { class: "env-result", "aria-live": "polite" });
  const targetSelect = h("select", { name: "target", "aria-label": "Where to run it" });
  const commandBox = h("textarea", {
    name: "command", class: "code", rows: 4, spellcheck: "false", autocomplete: "off",
    placeholder: "python -m pip install pandas==2.2.3", "aria-label": "Command", value: commandRun?.command || "",
  });
  const runButton = button("Run", () => {
    if (!commandBox.value.trim()) {
      toast("Type a command to run.", { kind: "warn" });
      return;
    }
    busy(runButton, () => runCommand(targetSelect.value === "" ? null : targetSelect.value, commandBox.value));
  }, "primary");
  commandBox.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      runButton.click();
    }
  });

  const node = h("section", { class: "page" }, [
    h("div", { class: "page-head" }, h("h1", null, "Environments")),
    h("p", { class: "muted" }, "Commands run in each machine's own Python environment: on Plumber's machine, the one Plumber loads projects with "
      + "to list their pipelines, and on a station, the one its runs use. Install a project's requirements on a station before the project is "
      + "first sent there: a station refuses a project Canonada can't load. Installed packages last until the container or machine is rebuilt."),
    h("section", { class: "panel" }, [
      h("div", { class: "panel-head" }, h("h2", null, "Install requirements")),
      h("div", { class: "panel-body" }, installBody),
    ]),
    h("section", { class: "panel" }, [
      h("div", { class: "panel-head" }, h("h2", null, "Run a command")),
      h("div", { class: "panel-body env-command-form" }, [
        h("div", { class: "row" }, [h("span", { class: "field-label" }, "On"), targetSelect, runButton]),
        commandBox,
        h("p", { class: "muted small" }, "Runs in Plumber's or the station's working directory, and python is that machine's own interpreter. "
          + "One command runs at a time on each machine, for at most 15 minutes on Plumber (a station's config.toml sets its own limit), "
          + "and whatever it leaves running is stopped. Ctrl+Enter runs it."),
        resultArea,
      ]),
    ]),
  ]);

  listeners.add(draw);
  ctx.scope.cleanup(() => listeners.delete(draw));
  ctx.scope.cleanup(stations.listen(draw));
  ctx.scope.cleanup(projects.listen(draw));
  projects.load().catch(() => {});
  stations.ensure().catch(() => {});
  draw();
  return node;

  function draw() {
    drawInstall();
    drawTargets();
    drawResult();
  }

  /** The targets in order: Plumber's machine (null), then each station, with whether it can be chosen now */
  function targets() {
    return [{ station: null, online: true }, ...(stations.data || []).map((item) => ({ station: item.name, online: item.status === "online" }))];
  }

  function drawTargets() {
    const options = targets().map(({ station, online }) => [station ?? "", targetName(station) + (online ? "" : " (offline)")]);
    if (JSON.stringify(options) === targetSelect.dataset.options) return;
    const chosen = targetSelect.options.length ? targetSelect.value : (commandRun?.station ?? "");
    targetSelect.replaceChildren(...options.map(([value, label]) => h("option", { value }, label)));
    targetSelect.dataset.options = JSON.stringify(options);
    targetSelect.value = options.some(([value]) => value === chosen) ? chosen : "";
  }

  function drawResult() {
    const run = commandRun;
    const signature = JSON.stringify(run && [run.station, run.command, run.running, run.result, run.error]);
    redraw(resultArea, signature, () => {
      if (!run) return null;
      const where = targetName(run.station);
      if (run.running) return loading(`Running on ${where}…`);
      return [h("p", { class: "muted small" }, `On ${where}:`),
        outcome({ result: run.result, error: run.error }, safeFilename("command", where) + ".log")];
    });
  }

  function drawInstall() {
    if (projects.error && !projects.data) {
      redraw(installBody, "error:" + projects.error.message, () => errorBox(projects.error, () => projects.load().catch(() => {})));
      return;
    }
    if (!projects.data) {
      redraw(installBody, "loading", () => loading("Loading projects…"));
      return;
    }
    const bases = projects.data.filter((project) => !project.base).map((project) => project.name);
    if (!bases.length) {
      redraw(installBody, "empty", () => emptyState("No projects", "Register a project on the Projects tab first."));
      return;
    }
    const all = targets();
    const run = install;
    const running = Boolean(run?.running);
    const cells = run ? [...run.cells].map(([key, cell]) => [key, cell.state, Boolean(cell.result || cell.error)]) : null;
    const signature = JSON.stringify([bases, all, [...unticked.projects], [...unticked.targets], cells, running, Boolean(run?.stopped)]);
    redraw(installBody, signature, () => {
      const chosenTargets = all.filter(({ station, online }) => online && !unticked.targets.has(station ?? "")).map(({ station }) => station);
      const chosenProjects = bases.filter((name) => !unticked.projects.has(name));
      const tick = (set, key, label, disabled, focus) => {
        const box = h("input", { type: "checkbox", checked: !disabled && !set.has(key), disabled: disabled || running, "data-focus": focus });
        box.addEventListener("change", () => {
          if (box.checked) set.delete(key);
          else set.add(key);
          drawInstall();
        });
        return h("label", { class: "check" }, [box, label]);
      };
      const headers = ["Project", ...all.map(({ station, online }) => tick(unticked.targets, station ?? "",
        [targetName(station), online ? null : h("span", { class: "muted" }, " (offline)")], !online, `target:${station ?? ""}`))];
      const rows = bases.map((project) => ({
        key: project,
        cells: [
          tick(unticked.projects, project, h("strong", null, project), false, `project:${project}`),
          ...all.map(({ station }) => {
            const cell = run?.cells.get(cellKey(station, project));
            if (!cell) return h("span", { class: "muted" }, "–");
            const shown = CELLS[cell.state](cell);
            if (!cell.result && !cell.error) return shown;
            return h("button", {
              type: "button", class: "env-cell", "data-focus": `cell:${cellKey(station, project)}`,
              title: "Show the output", "aria-label": `${project} on ${targetName(station)}: show the output`,
              onclick: () => outcomeDialog(`${project} on ${targetName(station)}`, cell, safeFilename("requirements", project, targetName(station)) + ".log"),
            }, shown);
          }),
        ],
      }));
      const start = button("Install requirements…", () => confirmInstall(chosenTargets, chosenProjects), "primary");
      start.disabled = running || !chosenTargets.length || !chosenProjects.length;
      start.setAttribute("data-focus", "install");
      const stop = running ? button(run.stopped ? "Stopping…" : "Stop", () => {
        run.stopped = true;
        changed();
      }) : null;
      if (stop) {
        stop.disabled = run.stopped;
        stop.setAttribute("data-focus", "stop");
      }
      return [
        table(headers, rows, { className: "matrix env-matrix" }),
        h("div", { class: "row env-actions" }, [start, stop,
          running ? h("span", { class: "muted small" }, run.stopped ? "Stopping after the installs under way." : "Installing. Leaving the tab doesn't stop it.") : null]),
        h("p", { class: "muted small" }, "Plumber installs from the project's own requirements.txt. A station doesn't have the project yet, "
          + "so it gets the file's lines in the command, and lines that point at other files (-r, -e, ./path) only work on Plumber. "
          + "Variants share their base project's requirements."),
      ];
    });
  }

  async function confirmInstall(chosenTargets, chosenProjects) {
    const ok = await confirmDialog({
      title: "Install requirements?",
      body: [
        h("p", null, `On ${chosenTargets.map(targetName).join(", ")}: python -m pip install -r requirements.txt for `
          + `${chosenProjects.join(", ")}, one project after another on each machine, all machines at once.`),
        h("p", { class: "warn-text" }, "Each install changes that machine's whole Python environment: it can upgrade or downgrade packages "
          + "other projects use, and runs going on there may notice."),
      ],
      confirmLabel: "Install",
    });
    if (ok) installRequirements(chosenTargets, chosenProjects);
  }
}

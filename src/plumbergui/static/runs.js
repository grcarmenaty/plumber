// Runs: the run store, the Start and Stop dialogs, run chips, and the Runs & logs tab: the run list with
// plumber-gui's run times, a log viewer for a run's log or plumber-gui's own, and Search logs (search.js).
// Pipelines and Stations use the same dialogs and link here; only this tab fetches logs.

import {
  api, badge, button, confirmDialog, emptyState, errorBox, field, fmtBytes, fmtClock, fmtServerTime, formDialog, gui,
  h, loading, plural, projectTree, projects, redraw, relTime, routeHash, runHref, safeFilename, saveText, schedules,
  scope as newScope, seg, segmented, select, stations, store, textInput, toast,
} from "./ui.js";
import { cleanText, filterRecords, parseLog, tailStart } from "./logparse.js";
import { LEVELS, highlight, logSearch, rankClass } from "./search.js";

const KEEP = 4 * 1024 * 1024; // Characters of a log that are parsed and drawn; Download saves all of it
const PAUSE_LIVE = 32 * 1024 * 1024; // Live refresh pauses above this: every refresh fetches the whole log
const ASK_ABOVE = 64 * 1024 * 1024; // Bytes above which the viewer asks before reading a log
const SHOWN = 2000; // Records drawn at first, and added by "Show earlier"
const SHOWN_MAX = 10000;

// Run store --------------------------------------------------------------------

export const runs = store(async () => {
  const [pipelines, systems] = await Promise.all([api("GET", "/logs/pipelines"), api("GET", "/logs/systems")]);
  return normalizeRuns(pipelines, systems);
});

/**
 * Plumber's two run lists as one: { runs: [{ station, kind, project, name, run, status }], errors: [{ station, error }] }
 */
export function normalizeRuns(pipelines, systems) {
  const list = [];
  const errors = new Map();
  for (const [kind, entries] of [["pipeline", pipelines], ["system", systems]]) {
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (entry.error) {
        errors.set(entry.station, entry.error);
        continue;
      }
      for (const run of entry.runs || []) {
        list.push({ station: entry.station, kind, project: run.project, name: run[kind], run: run.run, status: run.status });
      }
    }
  }
  return { runs: list, errors: [...errors].map(([station, error]) => ({ station, error })) };
}

/**
 * One group per (station, kind, project, name), newest run first. Groups with a running run come
 * first, then those whose latest run errored, then finished ones.
 */
export function groupRuns(list) {
  const groups = new Map();
  for (const run of list) {
    const key = JSON.stringify([run.station, run.kind, run.project, run.name]);
    if (!groups.has(key)) groups.set(key, { key, station: run.station, kind: run.kind, project: run.project, name: run.name, runs: [] });
    groups.get(key).runs.push(run);
  }
  const order = { running: 0, errored: 1, finished: 2 };
  const result = [...groups.values()];
  for (const group of result) {
    group.runs.sort((a, b) => b.run - a.run);
    group.running = group.runs.filter((run) => run.status === "running");
    group.latest = group.running[0] || group.runs[0];
    group.state = group.running.length ? "running" : group.runs[0].status;
  }
  return result.sort((a, b) => (order[a.state] ?? 3) - (order[b.state] ?? 3)
    || a.project.localeCompare(b.project) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)
    || a.station.localeCompare(b.station));
}

/** Runs of one project that are running on one station. */
export function runningOn(list, station, project) {
  return list.filter((run) => run.station === station && run.project === project && run.status === "running");
}

export function describe(run) {
  return `${run.kind} ${run.name} #${run.run}`;
}

/**
 * One chip per station for a pipeline or system: its running run, or else its latest. Each links to that run's log.
 */
export function runChips(list, kind, project, name) {
  const groups = groupRuns(list.filter((run) => run.kind === kind && run.project === project && run.name === name));
  if (!groups.length) return h("span", { class: "muted" }, "Not run yet");
  return h("span", { class: "chips" }, groups.map((group) => h("a", {
    class: "run-chip", href: runHref(group.latest), title: `${group.station}: run #${group.latest.run} ${group.latest.status}`,
  }, badge(group.state, `${group.station} #${group.latest.run}`))));
}

// Start and Stop ---------------------------------------------------------------

/** What a failed start means: { message, maybe }, where maybe says the run may have started all the same. */
function startFailure(error, project) {
  const detail = error.message.replace(/\.?$/, ".");
  // The browser lost plumber-gui: nearly always before the start got through, but a connection lost
  // mid-request looks the same, hence "most likely"
  if (error.status === 0) return { message: `${detail} Most likely nothing was sent or started; check the run list before starting it again.` };
  // plumber-gui refused the request or could not reach Plumber. A connection Plumber closed once it had
  // the request ("may have acted"), and plumber-gui's 500 and 504, can come after Plumber acted.
  if (error.source === "plumber-gui" && !/may have acted/.test(detail) && error.status !== 500 && error.status !== 504) {
    return { message: `${detail} Nothing was sent or started.` };
  }
  if (error.status === 502 && /did not respond|may have acted/.test(detail)) {
    return {
      message: `${detail} The run may have started, and Plumber may already have sent ${project} there, which stops its running runs. The run list will show both.`,
      maybe: true,
    };
  }
  if (error.status === 404 && /^(Station|Project) '/.test(detail)) return { message: detail }; // Plumber checks these before it sends anything
  return { message: `${detail} Plumber may already have sent ${project} there, which stops its running runs.` };
}

/**
 * Start a pipeline or system on one or more stations. It shows what runs there now, because Plumber
 * sends the project first when a station's copy differs, and that stops the project's runs there.
 * nameEditable: the name is typed, for a project whose registry Plumber can't load.
 */
export async function startDialog({ kind = "pipeline", project, name = "", station = "", nameEditable = false }) {
  runs.load().catch(() => {});
  let stationList;
  let projectList;
  try {
    [stationList, projectList] = await Promise.all([stations.ensure(), projects.ensure()]);
  } catch (error) {
    toast(error.message, { kind: "error" });
    return null;
  }
  const family = projectTree(projectList).find((node) => node.base.name === project || node.variants.some((variant) => variant.name === project));
  const projectOptions = family ? [family.base.name, ...family.variants.map((variant) => variant.name)] : [project];

  let chosenKind = kind;
  const projectSelect = select("project", projectOptions.map((option) => ({
    value: option,
    label: family && option !== family.base.name ? `${option} (variant of ${family.base.name})` : option,
  })), project);
  const nameInput = textInput("name", { value: name, required: true, list: "start-names" });
  const names = h("datalist", { id: "start-names" });
  const online = stationList.filter((item) => item.status === "online");
  const preselect = station || (online.length === 1 ? online[0].name : "");
  const boxes = stationList.map((item) => h("input", {
    type: "checkbox", name: "station", value: item.name,
    checked: item.name === preselect && item.status === "online", disabled: item.status !== "online",
  }));
  const running = h("div", { class: "consequence", "aria-live": "polite" });
  const chosenStations = () => boxes.filter((box) => box.checked).map((box) => box.value);

  const refresh = () => {
    const target = nameInput.value.trim();
    const all = runs.data?.runs || [];
    names.replaceChildren(...[...new Set(all.filter((run) => run.kind === chosenKind && projectOptions.includes(run.project)).map((run) => run.name))]
      .map((value) => h("option", { value })));
    const lines = [];
    for (const stationName of chosenStations()) {
      const now = runningOn(all, stationName, projectSelect.value);
      const same = now.filter((run) => run.kind === chosenKind && run.name === target);
      if (same.length) {
        lines.push(h("p", { class: "warn-text" }, `${target} already runs on ${stationName} as #${same.map((run) => run.run).join(", #")}. `
          + `Starting it again runs a second copy, unless Plumber sends ${projectSelect.value} first, which stops it.`));
      }
      if (now.length) lines.push(h("p", null, `Running on ${stationName} now: ${now.map(describe).join(", ")}.`));
    }
    running.replaceChildren(...lines, h("p", { class: "muted" },
      `If a station's copy of ${projectSelect.value} differs from Plumber's, Plumber sends it first, which stops every running run of ${projectSelect.value} there.`));
  };
  const unlisten = runs.listen(refresh);
  projectSelect.addEventListener("change", refresh);
  nameInput.addEventListener("input", refresh);
  for (const box of boxes) box.addEventListener("change", refresh);
  refresh();

  const results = await formDialog({
    title: nameEditable ? "Start a pipeline or system" : `Start ${kind} ${name}`,
    body: [
      nameEditable
        ? field("Runs", h("div", { class: "row" }, [
          segmented([{ value: "pipeline", label: "Pipeline" }, { value: "system", label: "System" }], chosenKind, (value) => { chosenKind = value; refresh(); }, "Kind"),
          nameInput, names,
        ]), "Plumber's registry can't load this project, so type the name. The station checks it.")
        : h("p", { class: "lead" }, [kind === "system" ? "System " : "Pipeline ", h("strong", null, name)]),
      field("Project", projectSelect),
      field("Stations", h("div", { class: "checks" }, stationList.length
        ? stationList.map((item, i) => h("label", { class: "check" }, [boxes[i], item.name, item.status === "online" ? null : h("span", { class: "muted" }, " (offline)")]))
        : h("span", { class: "muted" }, "No stations configured."))),
      running,
    ],
    submitLabel: "Start",
    onSubmit: async () => {
      const target = nameInput.value.trim();
      const chosen = chosenStations();
      if (!target) throw new Error("Name the pipeline or system to start.");
      if (!chosen.length) throw new Error("Choose at least one online station.");
      const outcome = [];
      for (const stationName of chosen) {
        try {
          const result = await api("POST", seg`/run/${chosenKind}/${projectSelect.value}/${target}` + "?station=" + encodeURIComponent(stationName));
          outcome.push({ station: stationName, ok: true, result });
        } catch (error) {
          outcome.push({ station: stationName, ok: false, ...startFailure(error, projectSelect.value) });
        }
      }
      if (outcome.every((item) => !item.ok)) throw new Error(outcome.map((item) => `${item.station}: ${item.message}`).join(" "));
      return { kind: chosenKind, project: projectSelect.value, name: target, outcome };
    },
  });
  unlisten();
  if (!results) return null;
  const runOf = (item) => ({ station: item.station, kind: results.kind, project: results.project, name: results.name, run: item.result.run });
  const started = (item) => `Started ${results.name} run #${item.result.run} on ${item.station}.${item.result.sent ? ` Plumber sent ${results.project} first.` : ""}`;
  if (results.outcome.length === 1) {
    const [item] = results.outcome; // It started: onSubmit throws when every station failed
    toast(started(item), { action: { label: "Open log", onClick: () => { location.hash = runHref(runOf(item)); } } });
  } else {
    // One toast with a line per station, so no result pushes another out; it stays when any failed
    const failed = results.outcome.filter((item) => !item.ok);
    toast(results.outcome.map((item) => h("div", null, item.ok
      ? [started(item), " ", h("a", { href: runHref(runOf(item)) }, "Open log")]
      : `${item.station}: ${item.message}`)), {
      kind: !failed.length ? "ok" : failed.every((item) => item.maybe) ? "warn" : "error",
      sticky: failed.length > 0,
    });
  }
  runs.load().catch(() => {});
  return results;
}

function scheduleFor(station, kind, project, name) {
  return (schedules.data?.schedules || []).find((item) => item.enabled && item.station === station && item.project === project && item[kind] === name);
}

/** Ask, then stop one run. Returns true when a stop was sent. */
export async function stopDialog({ station, kind, project, name, run }) {
  const schedule = scheduleFor(station, kind, project, name);
  const ok = await confirmDialog({
    title: `Stop run #${run} of ${kind} ${name} on ${station}?`,
    body: [
      h("p", null, "ValveStation stops the run (SIGTERM, then SIGKILL if its main process hasn't exited within 5 s). It ends as errored; other runs keep going."),
      schedule ? h("p", { class: "warn-text" }, `Schedule ${schedule.name} (${schedule.cron}) starts it again${schedule.next ? ` at ${fmtServerTime(schedule.next)}` : ""}.`) : null,
    ],
    confirmLabel: "Stop run",
    danger: true,
  });
  if (!ok) return false;
  try {
    await api("DELETE", seg`/run/${kind}/${station}/${project}/${name}/${run}`);
    toast(`Stopped ${kind} ${name} #${run} on ${station}.`);
  } catch (error) {
    if (error.status === 404) toast(`Run #${run} is no longer listed on ${station}.`, { kind: "warn" });
    else if (error.status === 409) toast(`Run #${run} had already ended.`, { kind: "warn" });
    else toast(error.message, { kind: "error" });
  }
  runs.load().catch(() => {});
  return true;
}

// Run times --------------------------------------------------------------------

// When plumber-gui saw each run start and end (runwatch.py). An older plumber-gui has none, and a failed
// load keeps the ones there were, so the GUI shows the times it has, or none.
const times = store(async () => {
  const data = await gui("GET", "/runs/times");
  return { now: data.now, runs: new Map(data.runs.map((time) => [timeKey(time), time])) };
});

function timeKey(run) {
  return JSON.stringify([run.station, run.kind, run.project, run.name, run.run]);
}

/**
 * The run times and plumber-gui's clock: { runs, now, today }, or null before they load. now (ms) is
 * the time of its last answer plus the time since, and today the date on its wall clock: the browser's
 * clock and time zone play no part.
 */
function timesNow() {
  if (!times.data) return null;
  const { now, runs: byRun } = times.data;
  return { runs: byRun, now: Date.parse(now) + Date.now() - times.at, today: now.slice(0, 10) };
}

/** A plumber-gui time on its wall clock: "18:46", with the date when it is not on day ("Thu 8 Oct 18:46"), seconds if asked. */
function wallTime(iso, day, seconds) {
  return (iso.slice(0, 10) === day ? iso.slice(11, 16) : fmtServerTime(iso)) + (seconds ? iso.slice(16, 19) : "");
}

/** A duration to the minute, as the times are only good to about 10 s. over: at least that, so rounded down ("" under a minute). */
function took(ms, over) {
  if (ms < 60000) return over ? "" : "under a minute";
  return over ? `over ${relTime(Math.floor(ms / 60000) * 60000)}` : relTime(ms);
}

/**
 * When a run ran, for the run list: "started 18:46 · running 7 min", "18:46–18:53 · 7 min",
 * "18:46 – by 18:53" or "ended by 18:53". "before" and "by": plumber-gui was not looking when it
 * started or ended (runwatch.py). A start has its date when it is not today, an end when it is not on
 * the start's day. The list's status counts, as plumber-gui's own reads can trail it. "" without times.
 */
function listTime(run, clock) {
  const time = clock?.runs.get(timeKey(run));
  if (!time) return "";
  const { started, ended } = time;
  const start = started && (time.started_by ? "before " : "") + wallTime(started, clock.today);
  if (run.status === "running" || !ended) {
    if (!started) return "";
    if (run.status !== "running") return `started ${start}`; // plumber-gui has not seen it end yet
    const going = took(clock.now - Date.parse(started), time.started_by);
    return `started ${start} · running` + (going && ` ${going}`);
  }
  const end = wallTime(ended, started ? started.slice(0, 10) : clock.today);
  if (!started) return `ended ${time.ended_by ? "by " : ""}${end}`;
  if (time.ended_by) return `${start} – by ${end}`;
  const length = took(Date.parse(ended) - Date.parse(started), time.started_by);
  return (time.started_by ? `${start} – ${end}` : `${start}–${end}`) + (length && ` · ${length}`);
}

/** The same for the log viewer's head, with dates and seconds: "Started Fri 9 Oct 18:46:33 · ended 18:53:10 · took 7 min". */
function viewerTime(run, status, clock) {
  const time = clock?.runs.get(timeKey(run));
  if (!time) return "";
  const { started, ended } = time;
  const start = started && `Started ${time.started_by ? "before " : ""}${wallTime(started, null, true)}`;
  const listed = status || time.status; // The run store's, when it lists the run
  if (listed === "running" || !ended) {
    if (!started || listed !== "running") return start || "";
    const going = took(clock.now - Date.parse(started), time.started_by);
    return `${start} · running` + (going && ` for ${going}`);
  }
  const end = wallTime(ended, started ? started.slice(0, 10) : null, true);
  if (!started) return `Ended ${time.ended_by ? "by " : ""}${end}`;
  if (time.ended_by) return `${start} · ended by ${end}`;
  const length = took(Date.parse(ended) - Date.parse(started), time.started_by);
  return `${start} · ended ${end}` + (length && ` · took ${length}`);
}

// Runs & logs tab --------------------------------------------------------------

export function renderRuns(params, ctx) {
  const filters = { station: params.station || "", status: params.status || "", filter: params.filter || "" };
  let selection = params.kind && params.project && params.name && params.run && params.on
    ? { station: params.on, kind: params.kind, project: params.project, name: params.name, run: Number(params.run) }
    : null;
  // The right pane: the selected run's log ("run"), plumber-gui's own log ("log", route log=plumber),
  // Search logs ("find", route find=1), or a hint ("")
  let pane = selection ? "run" : params.log === "plumber" ? "log" : params.find === "1" ? "find" : "";
  let viewParams = { level: params.level || "", search: params.search || "" };
  let wide = params.wide === "1";
  const expanded = new Set();
  let viewer = null;
  let searchPanel = null; // Search logs (newSearchPanel()): kept while it shows and while a run opened from it does
  let listed = false; // This page's own run list came, or failed: the store may hold one from an earlier visit
  let timesFor = null; // The run list the run times were last loaded for
  let timesDue = 0; // When they are loaded again all the same

  const save = () => ctx.setParams({
    ...filters,
    wide: wide ? "1" : "",
    ...(selection ? { kind: selection.kind, project: selection.project, name: selection.name, run: selection.run, on: selection.station } : {}),
    log: pane === "log" ? "plumber" : "",
    find: pane === "find" ? "1" : "",
    ...viewParams,
  });

  const stationFilter = h("select", { name: "station", "aria-label": "Station" });
  stationFilter.addEventListener("change", () => { filters.station = stationFilter.value; save(); drawList(); });
  const statusFilter = segmented([{ value: "", label: "All" }, { value: "running", label: "Running" }, { value: "errored", label: "Errored" }, { value: "finished", label: "Finished" }],
    filters.status, (value) => { filters.status = value; save(); drawList(); }, "Status");
  const textFilter = h("input", { type: "search", placeholder: "Filter runs", value: filters.filter, "aria-label": "Filter runs by project or name" });
  textFilter.addEventListener("input", () => { filters.filter = textFilter.value; save(); drawList(); });
  const findButton = button("Search logs", () => choose("find"));
  const updated = h("span", { class: "updated muted" });
  const toggle = button(wide ? "Show list" : "Hide list", () => {
    wide = !wide;
    toggle.textContent = wide ? "Show list" : "Hide list";
    split.classList.toggle("wide", wide);
    save();
  }, "quiet");

  // plumber-gui's own log comes first, whatever the filters; the groups below it are redrawn
  const logEntry = h("button", { type: "button", class: pane === "log" ? "log-entry selected" : "log-entry", onclick: () => choose("log") }, [
    h("span", { class: "run-group-title" }, [
      h("strong", null, "Plumber"),
      h("span", { class: "run-meta" }, "plumber-gui's own log: run starts and ends, schedule fires, actions, stations that stop answering"),
    ]),
  ]);
  const groupList = h("div", null, loading("Asking every station for its runs…"));
  const list = h("div", { class: "pane run-list", "aria-label": "Runs" }, [logEntry, groupList]);
  const logPane = h("div", { class: "pane log-pane" });
  const split = h("div", { class: wide ? "split wide" : "split" }, [list, logPane]);
  const page = h("section", { class: "page runs-page" }, [
    h("div", { class: "page-head" }, [h("h1", null, "Runs & logs"), h("div", { class: "toolbar" }, [stationFilter, statusFilter, textFilter, findButton, updated, toggle])]),
    split,
  ]);

  const poll = ctx.scope.every(() => runs.load(), () => ((runs.data?.runs || []).some((run) => run.status === "running") ? 5000 : 15000));
  ctx.scope.cleanup(runs.listen(() => {
    listed = true;
    drawList(); // Also after Start and Stop reload the store, so they show at once
  }));
  ctx.scope.cleanup(runs.listen(loadTimes));
  ctx.scope.cleanup(times.listen(drawList));
  ctx.scope.cleanup(stations.listen(drawStations));
  stations.ensure().then(drawStations).catch(() => {});
  projects.load().then(drawList).catch(() => {});
  schedules.load().catch(() => {});
  ctx.scope.cleanup(() => viewer?.dispose());
  ctx.scope.cleanup(dropSearchPanel);

  function drawStations() {
    const names = (stations.data || []).map((item) => item.name);
    if (filters.station && !names.includes(filters.station)) names.push(filters.station);
    stationFilter.replaceChildren(h("option", { value: "" }, "All stations"), ...names.map((name) => h("option", { value: name }, name)));
    stationFilter.value = filters.station;
  }

  /** A choice in the list: "run" with its run, "log" for plumber-gui's log, or "find" for a new Search logs. */
  function choose(next, run = null) {
    dropSearchPanel(); // So a run chosen here has no way back to an earlier search
    show(next, run);
    // In one column the log is below the list, where a click would seem to do nothing
    if (typeof matchMedia === "function" && matchMedia("(max-width: 1000px)").matches) logPane.scrollIntoView?.({ block: "start" });
  }

  /** Show it in the right pane and in the route. */
  function show(next, run = null) {
    pane = next;
    selection = run && { station: run.station, kind: run.kind, project: run.project, name: run.name, run: run.run };
    save();
    openViewer();
    drawList();
  }

  /** The groups the list shows: the runs of every station, through the filters. */
  function listGroups() {
    const text = filters.filter.trim().toLowerCase();
    return groupRuns(runs.data?.runs || []).filter((group) => (!filters.station || group.station === filters.station)
      && (!filters.status || group.state === filters.status)
      && (!text || `${group.project} / ${group.name} ${group.kind} ${group.station}`.toLowerCase().includes(text)));
  }

  // plumber-gui notes a start or an end within one of its own reads (every 10 s while runs go), so a change
  // in the run list loads the run times at once and again a read later; otherwise, the page's first load
  // included, once a minute will do
  function loadTimes() {
    if (!runs.data) return;
    const content = JSON.stringify(runs.data.runs);
    if (content === timesFor && Date.now() < timesDue) return;
    timesDue = Date.now() + (timesFor !== null && content !== timesFor ? 12000 : 60000);
    timesFor = content;
    times.load().catch(() => {}); // Quietly: the list goes on without times, or with the last ones
  }

  function drawList() {
    logEntry.classList.toggle("selected", pane === "log");
    if (pane === "find" && !searchPanel && listed) openViewer(); // Search logs waited for this page's run list
    if (runs.error && !runs.data) {
      redraw(groupList, JSON.stringify(["error", runs.error.message]), () => errorBox(runs.error, () => poll.now()));
      return;
    }
    if (!runs.data) return;
    updated.textContent = runs.error ? `Refresh failed: ${runs.error.message}` : `Updated ${fmtClock(new Date(runs.at))}`;
    updated.classList.toggle("error-text", Boolean(runs.error));
    const registered = projects.data ? new Set(projects.data.map((project) => project.name)) : null;
    const groups = listGroups();
    const errors = runs.data.errors.filter((item) => !filters.station || item.station === filters.station);
    const noStations = Boolean(stations.data && !stations.data.length);
    const clock = timesNow();
    const shownTimes = groups.map((group) => (expanded.has(group.key) ? group.runs : [group.latest]).map((run) => listTime(run, clock)));
    // Everything the list shows: a poll that brings nothing new leaves it, the focus and a click in progress
    // alone. The run times change with the minute while a run goes.
    const signature = JSON.stringify([groups, errors, registered && [...registered], noStations, runs.data.runs.length, filters, selection, [...expanded], shownTimes]);
    redraw(groupList, signature, () => {
      let content;
      if (groups.length) {
        content = h("ul", { class: "run-groups" }, groups.map((group) => groupRow(group, registered, clock)));
      } else if (noStations) {
        content = emptyState("No stations yet", "Add a ValveStation on the Stations tab, then start pipelines on it.", h("a", { class: "btn", href: routeHash("stations", "", {}) }, "Open Stations"));
      } else if (!runs.data.runs.length) {
        content = emptyState("Nothing has run yet", "Start a pipeline or system from the Pipelines tab.", h("a", { class: "btn", href: routeHash("pipelines", "", {}) }, "Open Pipelines"));
      } else {
        content = emptyState("No runs match", "Change the station, status or text filter.");
      }
      return [content, errors.map((item) => h("p", { class: "station-error" }, [badge("error", item.station), ` ${item.error}. Its runs are not shown.`]))];
    });
    viewer?.update();
  }

  function groupRow(group, registered, clock) {
    const known = !registered || registered.has(group.project);
    const when = listTime(group.latest, clock);
    const isOpen = expanded.has(group.key);
    const selectedHere = selection && selection.station === group.station && selection.kind === group.kind
      && selection.project === group.project && selection.name === group.name;
    // data-focus: what gets the focus back when the list is redrawn (see redraw())
    const action = group.running.length
      ? h("button", {
        type: "button", class: "btn danger quiet small", "data-focus": "stop:" + group.key,
        onclick: (event) => { event.stopPropagation(); stopDialog(group.running[0]); },
      }, "Stop…")
      : h("button", {
        type: "button", class: "btn quiet small", "data-focus": "again:" + group.key, disabled: !known, title: known ? null : `${group.project} is not registered in Plumber`,
        onclick: (event) => { event.stopPropagation(); startDialog({ kind: group.kind, project: group.project, name: group.name, station: group.station }); },
      }, "Run again…");
    const toggleOpen = h("button", {
      type: "button", class: "btn icon quiet", "data-focus": "older:" + group.key, "aria-expanded": String(isOpen), "aria-label": isOpen ? "Hide older runs" : "Show older runs",
      onclick: (event) => {
        event.stopPropagation();
        if (expanded.has(group.key)) expanded.delete(group.key);
        else expanded.add(group.key);
        drawList();
      },
    }, isOpen ? "▾" : "▸");
    const head = h("div", {
      class: "run-group-head", role: "button", tabindex: "0", "data-focus": "head:" + group.key,
      onclick: () => choose("run", group.latest),
      onkeydown: (event) => {
        if (event.target !== event.currentTarget) return; // A key on one of its buttons is that button's
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          choose("run", group.latest);
        }
      },
    }, [
      badge(group.state),
      h("div", { class: "run-group-title" }, [
        h("span", { class: "run-name" }, [group.project, h("span", { class: "sep" }, " / "), h("strong", null, group.name)]),
        h("span", { class: "kind-tag" }, group.kind),
        known ? null : h("span", { class: "tag", title: `${group.project} is not registered in Plumber` }, "not registered"),
        h("span", { class: "run-meta" }, `${group.station} · #${group.latest.run} · ${plural(group.runs.length, "run")}` + (when && ` · ${when}`)),
      ]),
      h("div", { class: "run-group-actions" }, [action, toggleOpen]),
    ]);
    const item = h("li", { class: selectedHere ? "run-group selected" : "run-group" }, head);
    if (isOpen) item.append(runHistory(group, clock));
    return item;
  }

  function runHistory(group, clock) {
    const all = expanded.has(group.key + ":all");
    const shown = all ? group.runs : group.runs.slice(0, 50);
    const items = shown.map((run) => {
      const selected = selection && selection.station === run.station && selection.kind === run.kind && selection.project === run.project
        && selection.name === run.name && selection.run === run.run;
      return h("li", { class: selected ? "selected" : null }, [
        h("a", {
          href: runHref(run), title: listTime(run, clock) || null, "data-focus": `run:${group.key}#${run.run}`,
          onclick: (event) => { event.preventDefault(); choose("run", run); },
        }, badge(run.status, `#${run.run} ${run.status}`)),
        run.status === "running"
          ? h("button", { type: "button", class: "btn danger quiet small", "data-focus": `stop:${group.key}#${run.run}`, onclick: () => stopDialog(run) }, "Stop…")
          : null,
      ]);
    });
    if (group.runs.length > shown.length) {
      items.push(h("li", null, button(`Show ${group.runs.length - shown.length} older`, () => { expanded.add(group.key + ":all"); drawList(); }, "quiet small")));
    }
    return h("ul", { class: "run-history" }, items);
  }

  function openViewer() {
    viewer?.dispose();
    viewer = null;
    if (pane === "find") {
      // It searches the runs the list shows, so it waits for this page's run list, from the route too
      if (!searchPanel && listed && runs.data) searchPanel = newSearchPanel();
      if (!searchPanel) {
        logPane.replaceChildren(listed
          ? emptyState("No runs to search", "Search logs searches the runs in the list, which could not be read. It shows once the list loads.")
          : loading("Asking every station for its runs…"));
        return;
      }
      logPane.replaceChildren(searchPanel.node);
      // Back from a run it opened: a scroller taken off the page loses its place, and the focus left with it
      searchPanel.scroller.scrollTop = searchPanel.scroll;
      searchPanel.opener?.focus();
      return;
    }
    if (!pane) {
      logPane.replaceChildren(emptyState("Select a run to read its log", "Each log comes from its station through Plumber."));
      return;
    }
    // A run opened from Search logs has the way back to the same results, and the focus, as the Open log
    // that opened it went with the panel
    const back = pane === "run" && searchPanel ? button("← Search results", () => show("find"), "quiet small") : null;
    viewer = logViewer(pane === "log" ? plumberLog() : runLog(selection), viewParams, (next) => { viewParams = next; save(); }, back);
    logPane.replaceChildren(viewer.node);
    back?.focus();
  }

  /**
   * Search logs over the groups the list shows now: { node, controller, scroller, scroll, opener }, the last
   * two for the way back from a run it opened. Its searches stop when it is dropped or the page is left.
   */
  function newSearchPanel() {
    const panel = { controller: new AbortController(), scroll: 0, opener: null };
    panel.scroller = logSearch({
      groups: listGroups(),
      open: (run, { search, level }) => {
        panel.scroll = panel.scroller.scrollTop;
        panel.opener = panel.node.contains(document.activeElement) ? document.activeElement : null;
        viewParams = { level, search };
        show("run", run);
      },
      signal: panel.controller.signal,
    });
    panel.node = h("div", { class: "viewer" }, [h("div", { class: "viewer-head" }, h("h2", null, "Search logs")), panel.scroller]);
    return panel;
  }

  function dropSearchPanel() {
    searchPanel?.controller.abort();
    searchPanel = null;
  }

  drawStations();
  openViewer();
  return page;
}

// Log viewer -------------------------------------------------------------------

/** The line breaks in text from index from up to index to. */
function countLines(text, from, to = text.length) {
  let count = 0;
  for (let at = text.indexOf("\n", from); at !== -1 && at < to; at = text.indexOf("\n", at + 1)) count += 1;
  return count;
}

/** What the viewer shows of one run's log, read from its station through Plumber. */
function runLog(sel) {
  return {
    run: sel,
    title: [
      h("span", { class: "run-name" }, [sel.project, h("span", { class: "sep" }, " / "), h("strong", null, sel.name)]),
      h("span", { class: "kind-tag" }, sel.kind),
      h("span", { class: "run-meta" }, `${sel.station} · run #${sel.run}`),
    ],
    read: (options) => api("GET", seg`/logs/${sel.kind}/${sel.station}/${sel.project}/${sel.name}/${sel.run}`, options),
    from: sel.station,
    filename: safeFilename(sel.station, sel.project, `${sel.kind}-${sel.name}`, `run${sel.run}`) + ".log",
  };
}

/** plumber-gui's own log. It is no run: no status, times, Stop or Run again, and it is read live, as it keeps growing. */
function plumberLog() {
  return {
    run: null,
    title: h("span", { class: "run-name" }, [h("strong", null, "Plumber"), h("span", { class: "sep" }, " · "), "plumber-gui's log"]),
    read: (options) => gui("GET", "/log", options),
    from: "plumber-gui",
    filename: "plumbergui.log",
  };
}

/**
 * source: runLog() or plumberLog(). initial: { level, search }, and onParams gets them when they change.
 * back: a node shown first in the head (the way back to Search logs), or null.
 */
function logViewer(source, initial, onParams, back) {
  const sel = source.run;
  const view = newScope();
  const state = {
    level: LEVELS.some((level) => level.value === initial.level) ? initial.level : "",
    search: initial.search || "",
    text: "",
    parsed: null,
    cut: 0,
    cutLines: 0, // Lines before cut: a record's line in the whole log is cutLines + record.line
    shown: SHOWN,
    follow: true,
    paused: false,
    tooLarge: false, // "This log is large" waits for "Load anyway"
    allowLarge: false,
    missing: false, // plumber-gui answered 404 for its log: it opens its log file only when it starts
    lastFetch: 0,
    // From the run store: "running", "finished", "errored", null when the run isn't listed, or
    // undefined until the store has loaded; always "running" for plumber-gui's log. Taken now, so the
    // first read knows what it started under.
    status: statusFromStore(),
    readStatus: undefined, // The status when the last read started; undefined once one has failed, but for Load anyway
    loaded: false,
    again: false,
    unseen: 0,
    signature: "",
    foot: "", // The footer for the rows drawn
    expanded: new Set(), // Tracebacks the user opened, by their line in the whole log
  };

  const statusBadge = h("span");
  const endReason = h("span");
  const timesLine = h("span", { class: "run-meta", hidden: true });
  const stopButton = button("Stop…", () => stopDialog(sel), "danger");
  const againButton = button("Run again…", () => startDialog({ kind: sel.kind, project: sel.project, name: sel.name, station: sel.station }));
  const downloadButton = button("Download", () => saveText(state.text, source.filename));
  const counts = h("span", { class: "counts" });
  const matches = h("span", { class: "matches muted", "aria-live": "polite" });
  const search = h("input", { type: "search", placeholder: "Search this log", value: state.search, "aria-label": "Search this log" });
  let searchTimer = null;
  search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = search.value;
      state.shown = SHOWN;
      onParams({ level: state.level, search: state.search });
      draw(true);
    }, 200);
  });
  view.cleanup(() => clearTimeout(searchTimer));
  const levels = segmented(LEVELS.map(({ value, label }) => ({ value, label })), state.level, (value) => {
    state.level = value;
    state.shown = SHOWN;
    onParams({ level: state.level, search: state.search });
    draw(true);
  }, "Lowest level shown");
  const liveLabel = h("span", { class: "live muted" });
  const pauseButton = button("Pause", () => {
    state.paused = !state.paused;
    pauseButton.textContent = state.paused ? "Resume" : "Pause";
    if (!state.paused) reload();
    drawLive();
  }, "quiet small");
  const followBox = h("input", { type: "checkbox", checked: state.follow });
  followBox.addEventListener("change", () => {
    state.follow = followBox.checked;
    if (state.follow) draw(true);
  });
  const progress = h("div", { class: "log-progress", hidden: true });
  const notices = h("div", { class: "log-notices" });
  const body = h("div", { class: "log", role: "log", tabindex: "0", "aria-label": "Log" });
  const pill = h("button", { type: "button", class: "new-lines", hidden: true, onclick: () => { state.follow = true; followBox.checked = true; draw(true); } });
  const footer = h("div", { class: "log-foot muted" });
  let drawing = false;
  body.addEventListener("scroll", () => {
    if (drawing || !state.follow) return;
    if (body.scrollHeight - body.scrollTop - body.clientHeight > 40) {
      state.follow = false;
      followBox.checked = false;
    }
  });

  const node = h("div", { class: "viewer" }, [
    h("div", { class: "viewer-head" }, [
      back,
      // Only a run has a status, times, Stop and Run again
      h("div", { class: "viewer-title" }, [source.title, sel ? [statusBadge, endReason, timesLine] : null]),
      h("div", { class: "viewer-actions" }, [sel ? [stopButton, againButton] : null, downloadButton]),
    ]),
    h("div", { class: "viewer-tools" }, [
      levels, counts, search, matches,
      h("span", { class: "live-tools" }, [liveLabel, pauseButton, h("label", { class: "check" }, [followBox, "Follow"])]),
    ]),
    notices,
    progress,
    h("div", { class: "log-wrap" }, [body, pill]),
    footer,
  ]);
  body.replaceChildren(loading(sel ? "Reading the log from the station…" : "Reading plumber-gui's log…"));

  function statusFromStore() {
    if (!sel) return "running"; // plumber-gui's log keeps growing: it is read as a running run's is
    if (!runs.data) return undefined;
    const run = runs.data.runs.find((item) => item.station === sel.station && item.kind === sel.kind
      && item.project === sel.project && item.name === sel.name && item.run === sel.run);
    return run ? run.status : null;
  }

  function interval() {
    const bySize = Math.min(60000, Math.max(3000, (state.text.length / 100000) * 1000));
    return Math.max(bySize, 2 * state.lastFetch);
  }

  function live() {
    return state.status === "running" && !state.paused && !state.tooLarge && !state.missing && state.text.length <= PAUSE_LIVE;
  }

  // The first read, then re-reads while the run is running; after it ends, one last read (onRuns).
  // Until the store lists the run the timer ticks without reading, so live reads start once it does.
  const fetcher = view.every(async () => {
    if (state.loaded && !live() && !state.again) return;
    state.again = false;
    await load();
  }, () => (live() || state.status == null ? interval() : 3600000));

  function reload() {
    state.again = true;
    fetcher.now();
  }

  async function load() {
    const started = performance.now();
    state.readStatus = state.status;
    let text;
    try {
      text = await source.read({ signal: view.signal, maxBytes: state.allowLarge ? 0 : ASK_ABOVE });
    } catch (error) {
      if (error.name === "AbortError") throw error;
      state.loaded = true;
      if (error.source === "size") {
        state.tooLarge = true; // Live reads wait for the click too: each would fetch the whole log again
        drawLive();
        body.replaceChildren(h("div", { class: "empty" }, [
          h("h3", null, "This log is large"),
          h("p", null, `${error.message} Reading it fetches all of it from ${source.from}. Only the last ${fmtBytes(KEEP)} is shown; Download saves the rest.`),
          button("Load anyway", () => {
            state.allowLarge = true;
            state.tooLarge = false;
            drawLive();
            body.replaceChildren(loading("Reading the log…"));
            reload();
          }, "primary"),
        ]));
        return;
      }
      // So a run that has ended gets its last read again at the next poll (onRuns), unless "Load anyway"
      // asked for it: each of those fetches the whole log, so they wait for Retry
      if (!state.allowLarge) state.readStatus = undefined;
      if (state.parsed) {
        footer.textContent = `Refresh failed: ${error.message}`;
      } else if (!sel && error.status === 404) {
        state.missing = true; // Until plumber-gui restarts, so no more reads
        drawLive();
        body.replaceChildren(emptyState("No log file", "plumber-gui could not open plumbergui.log, so its log is only in the terminal where it runs."));
      } else {
        // The same failure again leaves its box: a new role=alert box is read out again, and takes Retry's focus
        redraw(body, JSON.stringify(["error", error.message]), () => errorBox(error, () => { body.replaceChildren(loading("Reading the log…")); reload(); }));
      }
      throw error;
    } finally {
      state.lastFetch = performance.now() - started;
    }
    state.loaded = true;
    state.tooLarge = false;
    text = typeof text === "string" ? text : "";
    const signature = text.length + ":" + text.slice(-200);
    if (signature === state.signature) {
      drawMeta();
      return;
    }
    state.signature = signature;
    const before = state.parsed ? state.parsed.records.length : 0;
    const from = state.text.length;
    // A shorter log started again (plumbergui.log is rotated at 4 MiB): nothing drawn is in it, so it is
    // drawn anew, Follow or not
    const restarted = text.length < from;
    if (restarted) state.expanded.clear();
    state.text = text;
    state.cut = tailStart(text, KEEP);
    state.cutLines = countLines(text, 0, state.cut);
    state.parsed = parseLog(state.cut ? text.slice(state.cut) : text);
    if (before && !state.follow && !restarted) {
      state.unseen += countLines(text, from); // The lines that came in: past 4 MiB the parsed records stop growing
      drawMeta();
      return;
    }
    draw(true);
  }

  function drawLive() {
    statusBadge.replaceChildren(state.status === undefined ? badge("unknown", "checking") : state.status ? badge(state.status) : badge("unknown", "not listed"));
    const time = sel ? viewerTime(sel, state.status, timesNow()) : "";
    if (timesLine.textContent !== time) timesLine.textContent = time; // Only when it changes: once a minute while the run goes
    timesLine.hidden = !time;
    stopButton.hidden = state.status !== "running";
    againButton.hidden = state.status === "running";
    pauseButton.hidden = state.status !== "running" || state.tooLarge || state.missing;
    if (state.status !== "running" || state.missing) liveLabel.textContent = "";
    else if (state.tooLarge) liveLabel.textContent = "Live refresh waits for “Load anyway”";
    else if (state.text.length > PAUSE_LIVE) liveLabel.textContent = `Live refresh paused: the log is ${fmtBytes(state.text.length)} and each refresh fetches all of it.`;
    else liveLabel.textContent = state.paused ? "Live refresh paused" : `Live, every ${Math.round(interval() / 1000)} s`;
  }

  function drawMeta() {
    const parsed = state.parsed;
    drawLive();
    endReason.replaceChildren(parsed && parsed.endReason ? h("span", { class: "tag warn" }, parsed.endReason) : "");
    counts.replaceChildren(...(parsed ? [
      h("span", { class: "count warning", title: "Warnings" }, `W ${parsed.counts.warning}`),
      h("span", { class: "count error", title: "Errors" }, `E ${parsed.counts.error}`),
    ] : []));
    pill.hidden = !state.unseen;
    pill.textContent = `${plural(state.unseen, "new line")} ↓`;
    footer.textContent = state.foot; // Also takes down a "Refresh failed" note once a read works again
    progress.hidden = !(parsed && parsed.progress && state.status === "running");
    progress.textContent = progress.hidden ? "" : cleanText(parsed.progress);
    notices.replaceChildren(...(state.cut ? [h("p", { class: "note" }, [
      `Showing the last ${fmtBytes(KEEP)} of ${fmtBytes(state.text.length)}; search covers what is shown. `,
      button("Download all", () => downloadButton.click(), "quiet small"),
    ])] : []));
  }

  function draw(scroll) {
    if (!state.parsed) return;
    state.unseen = 0;
    drawMeta();
    const minRank = LEVELS.find((level) => level.value === state.level)?.rank || 0;
    const query = state.search.trim();
    const matching = filterRecords(state.parsed.records, { minRank, search: query });
    const start = Math.max(0, matching.length - state.shown);
    const visible = matching.slice(start);
    matches.textContent = query ? plural(matching.length, "match", "matches") : "";
    const rows = [];
    if (start > 0) {
      rows.push(state.shown < SHOWN_MAX
        ? h("div", { class: "log-more" }, button(`Show ${Math.min(SHOWN, start)} earlier`, () => { state.shown += SHOWN; draw(false); }, "quiet small"))
        : h("div", { class: "log-more muted" }, `${start} earlier records are not drawn. Narrow with the level or search, or download the log.`));
    }
    let lastDate = null;
    for (const record of visible) {
      const date = record.ts ? record.ts.slice(0, 10) : null;
      if (date && date !== lastDate) {
        rows.push(h("div", { class: "log-date" }, date));
        lastDate = date;
      }
      rows.push(recordRow(record, query));
    }
    if (!state.parsed.records.length) rows.push(h("div", { class: "empty-row" }, "The log is empty so far."));
    else if (!visible.length) rows.push(h("div", { class: "empty-row" }, "No records match the level and search."));
    drawing = true;
    body.replaceChildren(...rows);
    state.foot = `${plural(state.parsed.records.length, "record")} · ${fmtBytes(state.text.length)}`
      + (start > 0 ? ` · showing the newest ${visible.length} of ${matching.length}` : "");
    footer.textContent = state.foot;
    if (scroll && state.follow) body.scrollTop = body.scrollHeight;
    requestAnimationFrame(() => { drawing = false; });
  }

  function recordRow(record, query) {
    if (record.kind === "notice") return h("div", { class: "rec notice" }, h("span", { class: "msg" }, highlight(record.message, query)));
    const row = h("div", { class: "rec " + rankClass(record) }, [
      h("span", { class: "t", title: record.ts || null }, record.ts ? record.ts.slice(11) : ""),
      h("span", { class: "lv" }, record.kind === "log" || record.kind === "traceback" ? record.level : ""),
      h("span", { class: "lg" }, record.logger || ""),
      h("span", { class: "msg" }, highlight(record.message, query)),
    ]);
    if (record.extra.length) {
      const extraText = record.extra.join("\n");
      if (record.summary) {
        const opened = Boolean(query) && extraText.toLowerCase().includes(query.toLowerCase());
        const line = state.cutLines + record.line;
        const details = h("details", { class: "trace", open: opened || state.expanded.has(line) }, [
          h("summary", null, [`Traceback, ${plural(record.extra.length, "line")}: `, h("span", { class: "trace-summary" }, highlight(record.summary, query))]),
          h("pre", null, highlight(extraText, query)),
        ]);
        // One the user opens stays open through redraws, and reading it stops Follow, as scrolling up
        // does. Drawing one open fires this too, which changes nothing.
        details.addEventListener("toggle", () => {
          if (!details.open) {
            state.expanded.delete(line);
          } else if (!opened && !state.expanded.has(line)) {
            state.expanded.add(line);
            state.follow = false;
            followBox.checked = false;
          }
        });
        row.append(details);
      } else {
        row.append(h("pre", { class: "extra" }, highlight(extraText, query)));
      }
    }
    return row;
  }

  function onRuns() {
    state.status = statusFromStore();
    // One last read once the run has ended, unless the last read started after the store said so and
    // worked: a failed one is tried again at each poll, but not one "Load anyway" asked for. A first read
    // made before the store listed the run (status undefined or null) gets one too. While "This log is
    // large" waits, "Load anyway" reads the final log itself.
    if ((state.status === "finished" || state.status === "errored") && state.readStatus !== state.status && !state.tooLarge) reload();
    drawLive();
  }

  view.cleanup(runs.listen(onRuns));
  onRuns();

  return {
    node,
    update: drawLive,
    dispose: () => view.dispose(),
  };
}

// plumber-gui: the router, the header, and the Projects, Stations and Pipelines tabs.
// Runs & logs and the Start and Stop dialogs are in runs.js; the helpers are in ui.js.

import {
  api, badge, baseOf, busy, button, chip, confirmDialog, emptyState, errorBox, field, fmtClock, fmtServerTime,
  formDialog, gui, h, loading, maskUrl, onReachability, parseRoute, plural, projectTree, projects, redraw, registry, relTime,
  routeHash, saveText, schedules, scope, screenName, seg, segmented, select, stations, table, textInput, toast,
  untilServerTime,
} from "./ui.js";
import { describe, groupRuns, renderRuns, runChips, runs, startDialog } from "./runs.js";

const main = document.querySelector("#main");
const CATEGORIES = ["catalog", "parameters", "credentials"];

// Router -----------------------------------------------------------------------

const TABS = {
  projects: { title: "Projects", views: { "": renderProjects, vault: renderVault } },
  stations: { title: "Stations", views: { "": renderStations } },
  pipelines: { title: "Pipelines", views: { "": renderBrowse, schedules: renderSchedules } },
  runs: { title: "Runs & logs", views: { "": renderRuns } },
};

let page = null; // The scope of the page on screen; disposed when you leave it

function render() {
  const { tab, view, params } = parseRoute(location.hash);
  // Own properties only, so "#/constructor" or "#/runs/toString" is an unknown route like any other
  const renderer = Object.hasOwn(TABS, tab) && Object.hasOwn(TABS[tab].views, view) ? TABS[tab].views[view] : null;
  if (!renderer) {
    location.replace(routeHash("runs", "", {}));
    return;
  }
  page?.dispose();
  page = scope();
  for (const link of document.querySelectorAll(".tabs a")) {
    if (link.dataset.tab === tab) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  document.title = `${TABS[tab].title} · Plumber`;
  // Filters and selections replace the URL without adding history, so Back leaves the tab
  const ctx = { scope: page, setParams: (next) => history.replaceState(null, "", routeHash(tab, view, next)) };
  try {
    main.replaceChildren(renderer(params, ctx));
  } catch (error) {
    main.replaceChildren(errorBox(error, render));
    console.error(error);
  }
  headerPoll.now();
}

function pageHead(title, tabs, actions) {
  return h("div", { class: "page-head" }, [h("h1", null, title), tabs || null, h("div", { class: "page-actions" }, actions || [])]);
}

function subTabs(tab, current, items) {
  return h("nav", { class: "subtabs", "aria-label": "Views" },
    items.map(([view, label]) => h("a", { href: routeHash(tab, view, {}), "aria-current": view === current ? "page" : null }, label)));
}

/** Give a control in a view drawn with redraw() the key that hands the focus to its replacement. */
function focusKey(node, key) {
  node.setAttribute("data-focus", key);
  return node;
}

/**
 * A button whose action waits before its dialog opens (the run list: up to 30 s with a slow station), busy
 * until the action ends. busy() marks only the clicked node, and a redraw of its table meanwhile would bring
 * back an enabled button that opens a second dialog. So pending, the page's Map of the keys under way, holds
 * the button on screen for each: one drawn meanwhile is drawn busy, and the end frees whichever is shown.
 */
function waitButton(pending, key, label, action, kind) {
  const node = button(label, async () => {
    if (pending.has(key)) return;
    pending.set(key, node);
    try {
      await busy(node, action);
    } finally {
      const shown = pending.get(key);
      pending.delete(key);
      shown.disabled = false;
      shown.removeAttribute("aria-busy");
    }
  }, kind);
  if (pending.has(key)) {
    pending.set(key, node);
    node.disabled = true;
    node.setAttribute("aria-busy", "true");
  }
  return node;
}

// Header -----------------------------------------------------------------------

const statusPill = document.querySelector("#status");
const banner = document.querySelector("#banner");
const versionLabel = document.querySelector("#version");
const reach = { plumber: true, gui: true, since: null };

function drawStatus() {
  if (!reach.gui) {
    statusPill.replaceChildren(badge("errored", "plumber-gui unreachable"));
  } else if (!reach.plumber) {
    statusPill.replaceChildren(badge("errored", "Plumber unreachable"));
  } else if (stations.data) {
    const online = stations.data.filter((item) => item.status === "online").length;
    const total = stations.data.length;
    statusPill.replaceChildren(total
      ? badge(online === total ? "online" : online ? "skipped" : "errored", `${online}/${total} stations online`)
      : badge("offline", "No stations"));
  } else {
    statusPill.textContent = "Checking stations…";
  }
}

function loadVersion() {
  api("GET", "/version").then((body) => { versionLabel.textContent = body.version || ""; }).catch(() => {});
}

onReachability((state) => {
  const wasDown = !reach.plumber || !reach.gui;
  Object.assign(reach, state);
  if (!state.gui) {
    banner.textContent = "plumber-gui is not responding: it stopped, or the SSH tunnel closed. Retrying.";
    banner.hidden = false;
  } else if (!state.plumber) {
    banner.textContent = `Plumber is not responding at the address plumber-gui uses (since ${fmtClock(state.since)}). Showing the last data. Retrying.`;
    banner.hidden = false;
  } else {
    banner.hidden = true;
    if (wasDown) loadVersion();
  }
  drawStatus();
});

// Theme: Auto follows the system; Light and Dark are kept in this browser. theme.js applies the
// choice before the page is drawn, so this only draws the button and follows the system's changes.
const THEME_KEY = "plumbergui-theme";
const THEMES = { auto: ["◐", "Auto"], light: ["☀", "Light"], dark: ["☾", "Dark"] };
const NEXT_THEME = { auto: "light", light: "dark", dark: "auto" };
const systemDark = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
let theme = "auto";
try {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === "light" || stored === "dark") theme = stored;
} catch {
  // Storage is blocked: Auto, and a choice lasts until the page is reloaded
}
const themeButton = h("button", { type: "button", class: "theme-toggle", onclick: () => setTheme(NEXT_THEME[theme]) });
document.querySelector(".app-header")?.append(themeButton);
systemDark?.addEventListener("change", drawTheme);
drawTheme();

function setTheme(value) {
  theme = value;
  try {
    if (value === "auto") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, value);
  } catch {
    // Not kept: see above
  }
  drawTheme();
}

function drawTheme() {
  const dark = theme === "dark" || (theme === "auto" && Boolean(systemDark?.matches));
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  const [icon, name] = THEMES[theme];
  const next = THEMES[NEXT_THEME[theme]][1];
  themeButton.replaceChildren(h("span", { "aria-hidden": "true" }, icon), h("span", { class: "theme-name" }, name));
  themeButton.title = theme === "auto" ? `Theme: Auto, following the system (${dark ? "dark" : "light"} now). Click for ${next}.` : `Theme: ${name}. Click for ${next}.`;
  themeButton.setAttribute("aria-label", `Theme: ${name}. Switch to ${next}`);
}

stations.listen(drawStatus);
const header = scope();
const headerPoll = header.every(() => stations.load(), () => (parseRoute(location.hash).tab === "stations" ? 15000 : 30000));

// Shared actions ---------------------------------------------------------------

async function vaultLists() {
  const lists = await Promise.all(CATEGORIES.map((category) => api("GET", `/vault/${category}/list`)));
  return Object.fromEntries(CATEGORIES.map((category, i) => [category, lists[i]]));
}

/**
 * A variant's vault file picker; "" is the base project's own file. value is offered even when it is no
 * longer in the vault: a select set to a missing option reads "" and would quietly drop the file.
 */
function vaultPicker(lists, category, value) {
  const names = value && !lists[category].includes(value) ? [...lists[category], value] : lists[category];
  return select(category, [{ value: "", label: "The base project's own file" }, ...names], value || "");
}

function running(projectNames, stationName) {
  return (runs.data?.runs || []).filter((run) => run.status === "running" && (!projectNames || projectNames.includes(run.project))
    && (!stationName || run.station === stationName));
}

/** Whether running() may miss runs: the run list couldn't be read just now, or a station (stationName, or any) didn't list its runs. */
function runsUnknown(stationName) {
  return !runs.data || Boolean(runs.error) || runs.data.errors.some((item) => !stationName || item.station === stationName);
}

function runningList(list) {
  return list.map((run) => `${describe(run)} of ${run.project} on ${run.station}`).join(", ");
}

/** A sticky "working" toast for actions that can take a while; returns its remover. */
function working(message) {
  const item = toast(message, { kind: "info", sticky: true });
  return () => item.remove();
}

/** A dialog that only explains, closed with its one button or Escape. */
function noticeDialog({ title, body }) {
  return new Promise((resolve) => {
    const close = h("button", { type: "button", class: "btn primary", onclick: () => finish() }, "Close");
    const dialog = h("dialog", { class: "dialog" }, h("div", { class: "dialog-form" }, [
      h("h2", { class: "dialog-title" }, title),
      h("div", { class: "dialog-body" }, body),
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
      resolve();
    }
  });
}

async function registerDialog() {
  let source = "git";
  const repository = textInput("repository", { placeholder: "git@git.example.com:group/project.git" });
  const branch = textInput("branch", { value: "main" });
  const deployKey = h("textarea", { name: "deploy_key", rows: 4, spellcheck: "false", autocomplete: "off", class: "code", placeholder: "Optional. An SSH private key with read access to the repository." });
  const file = h("input", { type: "file", name: "file", accept: ".zip,application/zip" });
  const gitFields = h("div", { class: "stack" }, [field("Repository", repository), field("Branch", branch),
    field("Deploy key", deployKey, "Plumber stores it in its projects.toml as plain text and never shows it again.")]);
  const zipFields = h("div", { class: "stack", hidden: true }, field("Zip file", file, "canonada.toml must be at the root of the zip."));
  const result = await formDialog({
    title: "Register a project",
    body: [
      field("Source", segmented([{ value: "git", label: "Git repository" }, { value: "zip", label: "Zip file" }], source, (value) => {
        source = value;
        gitFields.hidden = value !== "git";
        zipFields.hidden = value !== "zip";
      }, "Source")),
      gitFields, zipFields,
      h("p", { class: "muted" }, "Plumber names the project after the [project] name in its canonada.toml. Nothing is sent to stations yet. "
        + "Plumber runs the project's code on its own host when it lists pipelines, and stations run it when they receive it: register only code you trust."),
    ],
    submitLabel: "Register",
    onSubmit: async () => {
      const data = new FormData();
      if (source === "git") {
        if (!repository.value.trim()) throw new Error("Enter the repository's URL.");
        data.append("repository", repository.value.trim());
        data.append("branch", branch.value.trim());
        if (deployKey.value.trim()) data.append("deploy_key", deployKey.value);
      } else {
        if (!file.files.length) throw new Error("Choose a zip file.");
        data.append("file", file.files[0]);
      }
      return api("POST", "/project/register", { body: data });
    },
  });
  deployKey.value = "";
  if (!result) return null;
  toast(`Registered ${result.name}.`, { action: { label: "New variant…", onClick: () => variantDialog({ base: result.name }) } });
  registry.forget();
  projects.load().catch(() => {});
  // The list again, with the new project highlighted, unless you left the tab while it registered
  if (parseRoute(location.hash).tab === "projects") location.replace(routeHash("projects", "", { project: result.name }));
  return result;
}

/** Pull a git base project, or replace its files with a zip. Both rebuild its variants. */
async function updateDialog(base, mode) {
  try {
    await projects.ensure();
  } catch (error) {
    toast(error.message, { kind: "error" });
    return null;
  }
  await runs.load().catch(() => {});
  const variants = projects.data.filter((project) => project.base === base.name).map((project) => project.name);
  const now = running([base.name, ...variants]);
  const file = h("input", { type: "file", name: "file", accept: ".zip,application/zip" });
  const result = await formDialog({
    title: mode === "pull" ? `Pull ${base.name}` : `Upload a zip for ${base.name}`,
    body: [
      mode === "pull"
        ? h("p", null, `Plumber checks out ${base.branch} and pulls it from ${maskUrl(base.repository)} (fast-forward only).`)
        : field("Zip file", file, `Its canonada.toml must name the project ${base.name}.`),
      mode === "zip" && base.repository ? h("p", { class: "warn-text" }, `The next Pull replaces these files with a fresh clone of ${base.branch}.`) : null,
      h("p", null, `Then it rebuilds ${variants.length ? `its variants (${variants.join(", ")})` : "its variants (it has none)"} from the new files and the current vault files. `
        + "Nothing is sent to stations now: each project is sent the next time it starts on a station, or at the next push, and that send stops its running runs there."),
      now.length ? h("p", { class: "warn-text" }, `Running now: ${runningList(now)}.`) : null,
    ],
    submitLabel: mode === "pull" ? "Pull" : "Upload",
    onSubmit: async () => {
      if (mode === "pull") return api("PUT", seg`/project/update/${base.name}`);
      if (!file.files.length) throw new Error("Choose a zip file.");
      const data = new FormData();
      data.append("file", file.files[0]);
      return api("PUT", seg`/project/update/${base.name}`, { body: data });
    },
  });
  if (!result) return null;
  toast(`${base.name} updated${variants.length ? `; rebuilt ${variants.join(", ")}` : ""}. Stations get the new files at their next start or push.`,
    { action: { label: "Push projects…", onClick: pushDialog } });
  registry.forget();
  projects.load().catch(() => {});
  return result;
}

function updateBase(baseName) {
  const base = (projects.data || []).find((project) => project.name === baseName);
  if (base) updateDialog(base, base.repository ? "pull" : "zip");
}

async function variantDialog({ base, from }) {
  let lists;
  try {
    [lists] = await Promise.all([vaultLists(), projects.ensure()]);
  } catch (error) {
    toast(error.message, { kind: "error" });
    return null;
  }
  const bases = projects.data.filter((project) => !project.base).map((project) => project.name);
  const name = textInput("name", { required: true, placeholder: `${base}-plant` });
  const baseSelect = select("base", bases, base);
  const pickers = Object.fromEntries(CATEGORIES.map((category) => [category, vaultPicker(lists, category, from?.[category])]));
  const result = await formDialog({
    title: from ? `Duplicate ${from.name}` : `New variant of ${base}`,
    body: [
      field("Name", name, "Also its Canonada project name on stations."),
      field("Base project", baseSelect),
      field("Catalog", pickers.catalog),
      field("Parameters", pickers.parameters),
      field("Credentials", pickers.credentials),
      h("p", { class: "muted" }, "The variant is a copy of the base with these vault files written over config/catalog.toml, config/parameters.toml and "
        + "config/credentials.toml. Nothing is sent to stations yet. Later vault edits reach it when its base is updated or it is edited."),
    ],
    submitLabel: "Add variant",
    onSubmit: async () => {
      const problem = screenName(name.value.trim());
      if (problem) throw new Error(problem);
      const body = { name: name.value.trim(), base: baseSelect.value };
      for (const category of CATEGORIES) if (pickers[category].value) body[category] = pickers[category].value;
      return api("POST", "/project/register/variant", { json: body });
    },
  });
  if (!result) return null;
  toast(`Added variant ${result.name}.`);
  projects.load().catch(() => {});
  return result;
}

/** A variant as /project/register/variant takes it: its name, its base and the vault files it uses. */
function variantBody(variant) {
  const body = { name: variant.name, base: variant.base };
  for (const category of CATEGORIES) if (variant[category]) body[category] = variant[category];
  return body;
}

/**
 * Pick a variant's base and vault files again. Plumber can't edit a variant, so Save removes it and registers
 * it again under its name; if that fails once it is removed, the old record is registered back.
 */
async function editVariantDialog(record) {
  let lists;
  try {
    [lists] = await Promise.all([vaultLists(), projects.ensure(), runs.load().catch(() => {})]);
  } catch (error) {
    toast(error.message, { kind: "error" });
    return;
  }
  const bases = projects.data.filter((project) => !project.base).map((project) => project.name);
  const name = textInput("name", { value: record.name, readonly: true });
  const baseSelect = select("base", bases, record.base);
  const pickers = Object.fromEntries(CATEGORIES.map((category) => [category, vaultPicker(lists, category, record[category])]));
  const consequence = h("div", { class: "consequence", "aria-live": "polite" });
  const stops = () => running([record.name]).length > 0 || runsUnknown(); // Whether saving stops runs, or may
  const refresh = () => {
    const now = running([record.name]);
    consequence.replaceChildren(h("p", null, stops()
      ? `Saving stops ${record.name}'s running runs on every station; stations get its new files at their next start or push.`
      : "Stations get its new files at their next start or push."));
    if (now.length) consequence.append(h("p", { class: "warn-text" }, `Running now: ${runningList(now)}.`));
    if (runsUnknown()) consequence.append(h("p", { class: "warn-text" }, "Runs couldn't be read from every station, so the ones this stops may not all be listed."));
    // formDialog styles Save once, as it opens: this keeps it a danger button only while saving would, or may, stop runs
    const save = consequence.closest("form")?.querySelector("button[type=submit]");
    if (save) save.className = stops() ? "btn danger" : "btn primary";
  };
  refresh();
  const unlisten = runs.listen(refresh);
  const result = await formDialog({
    title: `Edit ${record.name}`,
    body: [
      field("Name", name, "Renaming isn't supported; duplicate it and remove this one."),
      field("Base project", baseSelect),
      field("Catalog", pickers.catalog),
      field("Parameters", pickers.parameters),
      field("Credentials", pickers.credentials),
      consequence,
    ],
    submitLabel: "Save",
    danger: stops(),
    onSubmit: async () => {
      const chosen = { name: record.name, base: baseSelect.value };
      for (const category of CATEGORIES) if (pickers[category].value) chosen[category] = pickers[category].value;
      if (JSON.stringify(chosen) === JSON.stringify(variantBody(record))) return null; // Nothing changed: closes as Cancel does
      // What Plumber needs to remove the variant and add it back, read afresh, so it is unlikely to be left removed.
      // Removal goes station by station: the stations before one that doesn't answer would already have stopped its runs.
      const [projectList, vault, stationList] = await Promise.all([projects.load(), vaultLists(), stations.load()]);
      const old = projectList.find((project) => project.name === record.name);
      if (!old) throw new Error(`${record.name} is no longer registered.`);
      const problems = [];
      const offline = stationList.filter((item) => item.status !== "online").map((item) => item.name);
      if (offline.length) problems.push(`Offline now: ${offline.join(", ")}. Plumber changes a variant only while every station answers.`);
      if (!projectList.some((project) => project.name === chosen.base && !project.base)) problems.push(`${chosen.base} is no longer a registered base project; choose another.`);
      for (const category of CATEGORIES) {
        if (chosen[category] && !vault[category].includes(chosen[category])) problems.push(`The ${category} file ${chosen[category]} is no longer in the vault; choose another.`);
      }
      if (problems.length) throw new Error(problems.join(" "));
      try {
        await api("DELETE", seg`/project/remove/${record.name}`);
      } catch (error) {
        // Plumber's own 502: a station didn't answer or didn't remove it. plumber-gui's 502 (Plumber is down) keeps its message.
        if (error.status !== 502 || error.source !== "plumber") throw error;
        // Plumber goes through the stations in stationList's order and stops at the one that failed
        const failed = stationList.findIndex((item) => error.message.startsWith(`Station '${item.name}' `));
        if (failed === 0) throw new Error(`${error.message}. Plumber changes a variant only while every station answers; nothing was changed.`);
        const before = failed > 0 ? stationList.slice(0, failed).map((item) => item.name).join(", ") : "the stations Plumber reached first";
        runs.load().catch(() => {});
        throw new Error(`${error.message}. Plumber changes a variant only while every station answers, so it kept ${record.name} as it was, `
          + `but it is already gone from ${before}, which stopped its runs there. Plumber sends it again at the next start or push.`);
      }
      try {
        return await api("POST", "/project/register/variant", { json: chosen });
      } catch (error) {
        try {
          await api("POST", "/project/register/variant", { json: variantBody(old) });
        } catch (again) {
          const files = CATEGORIES.filter((category) => old[category]).map((category) => `, ${category} ${old[category]}`).join("");
          return { lost: `${record.name} was removed but could not be saved (${error.message}) or put back (${again.message}). `
            + `Create it again with New variant: base ${old.base}${files}.` };
        }
        // Back with its old settings but the vault files' current contents, its runs stopped, and now last among its base's variants
        projects.load().catch(() => {});
        runs.load().catch(() => {});
        throw new Error(`Could not save: ${error.message}. ${record.name} is back with its old settings; its runs were stopped.`);
      }
    },
  });
  unlisten();
  if (!result) return;
  if (result.lost) toast(result.lost, { kind: "error" });
  else toast(`Saved ${record.name}.`, { action: { label: "Push projects…", onClick: pushDialog } });
  projects.load().catch(() => {});
  runs.load().catch(() => {});
}

async function removeProjectDialog(record) {
  await Promise.all([projects.ensure(), runs.load(), stations.ensure(), schedules.load()].map((p) => p.catch(() => {})));
  const variants = record.base ? [] : (projects.data || []).filter((project) => project.base === record.name).map((project) => project.name);
  const doomed = [record.name, ...variants];
  const now = running(doomed);
  const offline = (stations.data || []).filter((item) => item.status !== "online").map((item) => item.name);
  const scheduled = (schedules.data?.schedules || []).filter((item) => doomed.includes(item.project)).map((item) => item.name);
  const ok = await confirmDialog({
    title: `Remove ${record.name}?`,
    body: [
      h("p", null, `Plumber deletes ${record.name}${variants.length ? ` and its variants ${variants.join(", ")}` : ""} on every station, then forgets ${variants.length ? "them" : "it"}.`),
      now.length ? h("p", { class: "warn-text" }, `This stops ${plural(now.length, "running run")}: ${runningList(now)}.`) : h("p", { class: "muted" }, "Nothing of it is running now."),
      offline.length ? h("p", { class: "warn-text" }, `Offline now: ${offline.join(", ")}. Every station must answer: removal stops at the first that doesn't, `
        + `after the stations before it have deleted ${record.name}, and Plumber keeps it registered.`) : null,
      scheduled.length ? h("p", { class: "warn-text" }, `Schedules that start it will fail: ${scheduled.join(", ")}.`) : null,
      h("p", { class: "muted" }, record.base ? `Adding it again rebuilds it from ${record.base}.` : "Vault files and run logs on stations are kept. To use it again, register it again."),
    ],
    confirmLabel: `Remove ${record.name}`,
    danger: true,
    typeToConfirm: record.name,
  });
  if (!ok) return;
  const done = working(`Removing ${record.name} from every station…`);
  try {
    await api("DELETE", seg`/project/remove/${record.name}`);
    toast(`Removed ${record.name}.`);
  } catch (error) {
    toast(error.message, { kind: "error" });
  } finally {
    done();
  }
  registry.forget();
  projects.load().catch(() => {});
  runs.load().catch(() => {});
}

async function addStationDialog() {
  const name = textInput("name", { required: true, placeholder: "plant-3" });
  const connection = textInput("connection", { required: true, placeholder: "http://10.0.0.12:508" });
  // Not "new-password": browsers would offer a generated password, which can't match the station's token
  const token = textInput("token", { type: "password", required: true, autocomplete: "off" });
  const result = await formDialog({
    title: "Add a station",
    body: [
      field("Name", name, "The id Plumber uses for this station."),
      field("Connection", connection, "The ValveStation's base URL."),
      field("Token", token, "The token in that station's config.toml. Plumber stores it in its own config.toml as plain text and never shows it again."),
      h("p", { class: "muted" }, "Nothing is sent to the station until a pipeline starts there or you push projects."),
    ],
    submitLabel: "Add station",
    onSubmit: async () => {
      const problem = screenName(name.value.trim());
      if (problem) throw new Error(problem);
      return api("POST", "/station/add", { json: { name: name.value.trim(), connection: connection.value.trim(), token: token.value } });
    },
  });
  token.value = "";
  if (!result) return;
  // stations.load() shares a read already under way, which may predate the add: then read once more
  const find = async () => ((await stations.load().catch(() => null)) || []).find((item) => item.name === result.name);
  const added = (await find()) || (await find());
  if (!added) {
    toast(`${result.name} was added. Its status shows at the next check.`);
  } else if (added.status !== "online") {
    toast(`${result.name} was added but is offline: no answer from ${added.connection}/health with this token within 3 s. `
      + "Check the URL and port, that ValveStation runs there, the firewall, and the token.", { kind: "warn", sticky: true });
  } else {
    toast(`${result.name} added and online.`);
  }
}

/** Whether the browser's URL parser takes text as an absolute URL. */
function isUrl(text) {
  try {
    return Boolean(new URL(text));
  } catch {
    return false;
  }
}

/**
 * Why Plumber would refuse a station's connection or token, or "" when it takes them: the checks of
 * _station_from_mapping in Plumber's api.py, made before Edit removes a station so adding it back is unlikely to fail.
 * listed, the connection Plumber has for it, passed them already: unchanged, it isn't checked again.
 */
function stationProblem({ connection, token }, listed) {
  if (connection !== listed) {
    // The parts Python's urlsplit sees: http(s)://authority path ?query #fragment. Its host is what comes before
    // the authority's first ":" (or inside [ ] for IPv6), so an authority that is empty or starts with ":" or "[]" has none.
    const url = /^https?:\/\/(?<authority>[^/?#]*)[^?#]*(?:\?(?<query>[^#]*))?(?:#(?<fragment>.*))?$/i.exec(connection)?.groups;
    if (!url || /^(:|\[\]|$)/.test(url.authority)) return "The connection must be an http or https URL with a host, such as http://10.0.0.12:508.";
    if (url.authority.includes("@")) return "The connection can't include a user or password: the token is a separate field.";
    if (url.query || url.fragment) return "The connection must be a base URL, without a query or fragment.";
    // urlsplit also refuses stray brackets, a bad IPv6 address and look-alikes of : / ? # @ (a full-width colon, say).
    // So does the browser's URL parser, which refuses a few forms Plumber takes too (an IPv6 zone, port 99999), as long
    // as both read the same URL: the parser takes "\" for "/", and each drops control characters its own way.
    if (/[\x00-\x1f\x7f\\]/.test(connection) || !isUrl(connection)) return "The connection isn't a valid URL: check its host and port for stray brackets, spaces or full-width characters.";
  }
  if (!token) return "Enter the token.";
  if (/[\r\n]/.test(token)) return "The token can't contain line breaks.";
  return "";
}

/**
 * Change a station's connection or token. Plumber can't edit a station, so Save removes it, which deletes
 * every project on it, and adds it again under its name; if adding fails, it adds the old connection back.
 */
async function editStationDialog(item) {
  if (item.status !== "online") {
    // Removing it would fail: Plumber must reach a station to delete its projects
    await noticeDialog({
      title: `Edit ${item.name}`,
      body: h("p", null, `Plumber can only change a station that answers. To fix ${item.name}'s connection or token, stop Plumber, `
        + `edit ${item.name} in Plumber's config.toml, and start Plumber again.`),
    });
    return;
  }
  await runs.load().catch(() => {});
  const name = textInput("name", { value: item.name, readonly: true });
  const connection = textInput("connection", { value: item.connection, required: true, placeholder: "http://10.0.0.12:508" });
  const token = textInput("token", { type: "password", required: true, autocomplete: "off" }); // Not "new-password": see addStationDialog
  const consequence = h("div", { class: "consequence", "aria-live": "polite" });
  const refresh = () => {
    const now = running(null, item.name);
    consequence.replaceChildren(h("p", null, `Saving removes every project from ${item.name}, which stops its running runs; `
      + "Plumber sends them again at the next start or push. Projects on it that Plumber didn't register are deleted for good."));
    if (now.length) consequence.append(h("p", { class: "warn-text" }, `Running now: ${runningList(now)}.`));
    if (runsUnknown(item.name)) consequence.append(h("p", { class: "warn-text" }, `${item.name}'s runs couldn't be read, so the ones this stops may not all be listed.`));
  };
  refresh();
  const unlisten = runs.listen(refresh);
  const result = await formDialog({
    title: `Edit ${item.name}`,
    body: [
      field("Name", name, "Renaming isn't supported; remove it and add another."),
      field("Connection", connection, "The ValveStation's base URL."),
      field("Token", token, "Plumber never shows the token. Enter it again, or a new one."),
      consequence,
    ],
    submitLabel: "Save",
    danger: true,
    onSubmit: async () => {
      const station = { name: item.name, connection: connection.value.trim(), token: token.value };
      const problem = stationProblem(station, item.connection);
      if (problem) throw new Error(problem);
      try {
        await api("DELETE", seg`/station/remove/${item.name}`);
      } catch (error) {
        // Plumber's own 502: the station didn't answer, or didn't list or delete its projects. plumber-gui's 502 (Plumber is down) keeps its message.
        if (error.status !== 502 || error.source !== "plumber") throw error;
        // Plumber lists the station's projects, then deletes them one by one: only a failed list comes before any is deleted
        if (error.message.endsWith(" did not list its projects")) throw new Error(`${error.message}. Plumber can only change a station that answers; nothing was changed.`);
        runs.load().catch(() => {});
        throw new Error(`${error.message}. Plumber can only change a station that answers, so it kept ${item.name}'s connection and token, `
          + "but it may have deleted some of its projects first, stopping their runs.");
      }
      try {
        return await api("POST", "/station/add", { json: station });
      } catch (error) {
        try {
          await api("POST", "/station/add", { json: { ...station, connection: item.connection } });
        } catch (again) {
          const details = again.message === error.message ? error.message : `${error.message}; ${again.message}`;
          return { lost: `${item.name} was removed but could not be added again (${details}). Add it again with Add station: connection ${item.connection}.` };
        }
        // Back with its old connection and without its projects, so their runs stopped
        stations.load().catch(() => {});
        runs.load().catch(() => {});
        throw new Error(`Could not save: ${error.message}. ${item.name} is back with its old connection; its projects were removed and are sent again at the next start or push.`);
      }
    },
  });
  unlisten();
  token.value = "";
  if (!result) return;
  runs.load().catch(() => {});
  if (result.lost) {
    toast(result.lost, { kind: "error" });
    stations.load().catch(() => {});
    return;
  }
  // A read already under way may predate the save and show the old connection's status: let it end, then read again
  await stations.load().catch(() => {});
  const saved = ((await stations.load().catch(() => null)) || []).find((station) => station.name === item.name);
  if (!saved) {
    toast(`Saved ${item.name}. Its status shows at the next check.`);
  } else if (saved.status !== "online") {
    toast(`Saved ${item.name}, but it is offline: no answer from ${saved.connection}/health with this token within 3 s. `
      + "It is unreachable there, or the token doesn't match the one in the station's config.toml.", { kind: "warn", sticky: true });
  } else {
    toast(`Saved ${item.name}. It is online.`, { action: { label: "Push projects…", onClick: pushDialog } });
  }
}

async function removeStationDialog(item) {
  await Promise.all([runs.load(), schedules.load()].map((p) => p.catch(() => {})));
  const now = running(null, item.name);
  const scheduled = (schedules.data?.schedules || []).filter((schedule) => schedule.station === item.name).map((schedule) => schedule.name);
  const ok = await confirmDialog({
    title: `Remove station ${item.name}?`,
    body: [
      h("p", null, `Plumber first deletes every project on ${item.name}, including ones it didn't register there, which stops their running runs. `
        + `Then it removes ${item.name} and its token from its config.toml. Run logs stay on ${item.name}'s disk, but Plumber can't show them any more.`),
      now.length ? h("p", { class: "warn-text" }, `This stops ${plural(now.length, "running run")}: ${runningList(now)}.`) : null,
      item.status !== "online" ? h("p", { class: "warn-text" }, `${item.name} is offline, so removal will fail: Plumber must reach it to delete its projects. `
        + "To drop a station that is gone, stop Plumber, delete its [[stations]] entry from config.toml, and start Plumber again.") : null,
      scheduled.length ? h("p", { class: "warn-text" }, `Schedules that start runs on ${item.name} will fail: ${scheduled.join(", ")}.`) : null,
    ],
    confirmLabel: `Delete its projects and remove ${item.name}`,
    danger: true,
    typeToConfirm: item.name,
  });
  if (!ok) return;
  const done = working(`Removing ${item.name}…`);
  try {
    await api("DELETE", seg`/station/remove/${item.name}`);
    toast(`Removed station ${item.name}.`);
  } catch (error) {
    toast(error.message, { kind: "error" });
  } finally {
    done();
  }
  stations.load().catch(() => {});
  runs.load().catch(() => {});
}

let lastPush = null; // { at, ms, result }, shown on Stations until closed

async function pushDialog() {
  await Promise.all([stations.load(), projects.ensure(), runs.load()].map((p) => p.catch(() => {})));
  const online = (stations.data || []).filter((item) => item.status === "online").map((item) => item.name);
  const offline = (stations.data || []).filter((item) => item.status !== "online").map((item) => item.name);
  const now = (runs.data?.runs || []).filter((run) => run.status === "running" && online.includes(run.station));
  const count = (projects.data || []).length;
  const ok = await confirmDialog({
    title: "Push projects to stations?",
    body: [
      h("p", null, `For each online station, Plumber compares each of the ${plural(count, "registered project")} and variants with the station's copy, `
        + "and sends each one that differs or is missing. Every variant carries its vault files, credentials included. Sending a project stops its running runs on that station."),
      now.length ? h("p", { class: "warn-text" }, `Running on online stations now, stopped if their project is sent: ${runningList(now)}.`)
        : h("p", { class: "muted" }, "Nothing is running on online stations."),
      offline.length ? h("p", { class: "muted" }, `Skipped because offline: ${offline.join(", ")}.`) : null,
    ],
    confirmLabel: "Push",
    danger: now.length > 0,
  });
  if (!ok) return;
  const done = working("Pushing projects: each online station compares every project…");
  const started = Date.now();
  try {
    const result = await api("PUT", "/station/update");
    lastPush = { at: new Date(), ms: Date.now() - started, result };
    const sent = result.flatMap((entry) => entry.projects || []).filter((item) => item.sent).length;
    toast(`Push done: ${plural(sent, "project")} sent.`, { action: { label: "Show result", onClick: () => { location.hash = routeHash("stations", "", {}); } } });
  } catch (error) {
    toast(error.message, { kind: "error" });
  } finally {
    done();
  }
  runs.load().catch(() => {});
  if (parseRoute(location.hash).tab === "stations") render();
}

// Projects ---------------------------------------------------------------------

function renderProjects(params, ctx) {
  let scrolled = false; // To the highlighted project (?project=), once: later reloads leave the scroll alone
  const pending = new Map(); // Pull, Upload, Edit and Remove under way, see waitButton()
  const content = h("div", { class: "page-body" }, loading("Loading projects…"));
  const node = h("section", { class: "page" }, [
    pageHead("Projects", subTabs("projects", "", [["", "Projects"], ["vault", "Vault"]]), [
      button("Refresh", () => load(), "quiet"),
      button("Register project…", () => registerDialog(), "primary"),
    ]),
    content,
  ]);
  ctx.scope.cleanup(projects.listen(draw));
  load();
  return node;

  async function load() {
    await projects.load().catch(() => {});
  }

  function draw() {
    if (projects.error && !projects.data) {
      content.replaceChildren(errorBox(projects.error, load));
      return;
    }
    const list = projects.data || [];
    if (!list.length) {
      content.replaceChildren(emptyState("No projects yet", "Register a Canonada project from a git repository or a zip file.",
        button("Register project…", () => registerDialog(), "primary")));
      return;
    }
    const rows = [];
    for (const { base, variants } of projectTree(list)) {
      rows.push({
        key: base.name,
        class: base.name === params.project ? "base highlight" : "base",
        cells: [
          h("strong", null, base.name),
          base.repository ? [chip("git"), " ", h("span", { class: "mono" }, maskUrl(base.repository)), h("span", { class: "muted" }, ` @ ${base.branch}`)] : [chip("zip"), " uploaded"],
          h("span", { class: "muted" }, "Its own config"),
          h("div", { class: "row-actions" }, [
            base.repository ? waitButton(pending, `pull:${base.name}`, "Pull…", () => updateDialog(base, "pull"), "quiet small") : null,
            waitButton(pending, `zip:${base.name}`, "Upload zip…", () => updateDialog(base, "zip"), "quiet small"),
            button("New variant…", () => variantDialog({ base: base.name }), "quiet small"),
            h("a", { class: "btn quiet small", href: routeHash("pipelines", "", { project: base.name }) }, "Pipelines"),
            waitButton(pending, `remove:${base.name}`, "Remove…", () => removeProjectDialog(base), "danger quiet small"),
          ]),
        ],
      });
      for (const variant of variants) {
        const files = CATEGORIES.filter((category) => variant[category]);
        rows.push({
          key: variant.name,
          class: variant.name === params.project ? "variant highlight" : "variant",
          cells: [
            h("span", { class: "variant-name" }, [h("span", { class: "muted", "aria-hidden": "true" }, "↳ "), variant.name]),
            h("span", { class: "muted" }, `Variant of ${base.name}`),
            files.length
              ? h("span", { class: "chips" }, files.map((category) => h("a", { class: "chip link", href: routeHash("projects", "vault", { category, file: variant[category] }) }, `${category}: ${variant[category]}`)))
              : h("span", { class: "muted" }, `${base.name}'s config`),
            h("div", { class: "row-actions" }, [
              button("Duplicate…", () => variantDialog({ base: base.name, from: variant }), "quiet small"),
              waitButton(pending, `edit:${variant.name}`, "Edit…", () => editVariantDialog(variant), "quiet small"),
              h("a", { class: "btn quiet small", href: routeHash("pipelines", "", { project: variant.name }) }, "Pipelines"),
              waitButton(pending, `remove:${variant.name}`, "Remove…", () => removeProjectDialog(variant), "danger quiet small"),
            ]),
          ],
        });
      }
    }
    content.replaceChildren(table(["Project", "Source", "Vault files", ""], rows, { className: "projects" }));
    const highlighted = content.querySelector("tr.highlight");
    if (highlighted && !scrolled) {
      highlighted.scrollIntoView({ block: "center" });
      scrolled = true;
    }
  }
}

// Vault ------------------------------------------------------------------------

async function vaultEditor({ category, name = "", text = "", names = [], usedBy = [] }) {
  const editing = Boolean(name);
  const nameInput = textInput("name", { value: name, readonly: editing, required: true });
  const area = h("textarea", { name: "text", class: "code", rows: 18, spellcheck: "false", autocomplete: "off", wrap: "off", value: text });
  const fileInput = h("input", { type: "file", accept: ".toml,text/plain" });
  fileInput.addEventListener("change", async () => {
    const chosen = fileInput.files[0];
    if (!chosen) return;
    area.value = await chosen.text();
    if (!nameInput.value) nameInput.value = chosen.name.replace(/\.toml$/i, "");
  });
  const result = await formDialog({
    title: editing ? `Edit ${category} / ${name}` : `New ${category} file`,
    wide: true,
    body: [
      field("Name", nameInput, `Stored in Plumber as vault/${category}/<name>.toml.`),
      field("Load from a file", fileInput, "Optional: fills the text below."),
      field("Contents (TOML)", area),
      usedBy.length ? h("p", { class: "warn-text" }, `Used by ${usedBy.join(", ")}. They keep their current copy until their base project is updated or they are edited.`) : null,
    ],
    submitLabel: "Save",
    onSubmit: async () => {
      const finalName = nameInput.value.trim();
      if (!finalName) throw new Error("Name the file.");
      const problem = screenName(finalName);
      if (problem) throw new Error(problem);
      if (!editing && names.includes(finalName)) {
        const replace = await confirmDialog({ title: `Replace ${category} file ${finalName}?`, body: h("p", null, "Its current contents are lost; Plumber keeps no copy."), confirmLabel: "Replace", danger: true });
        if (!replace) throw new Error(`Not saved: ${finalName} already exists.`);
      }
      const data = new FormData();
      data.append("file", new Blob([area.value], { type: "application/toml" }), `${finalName}.toml`);
      await api("PUT", seg`/vault/${category}/${finalName}`, { body: data });
      return { name: finalName };
    },
  });
  area.value = "";
  return result;
}

function renderVault(params, ctx) {
  let category = CATEGORIES.includes(params.category) ? params.category : "catalog";
  let selected = params.file || "";
  let lists = null;
  let revealed = false;
  let fileText = null;
  let fileDraws = 0; // Counts drawFile() calls: only the latest one's read may set fileText
  const categoryBar = h("div", { class: "toolbar" });
  const listPane = h("div", { class: "pane vault-list" }, loading("Loading the vault…"));
  const filePane = h("div", { class: "pane vault-file" });
  const node = h("section", { class: "page" }, [
    pageHead("Projects", subTabs("projects", "vault", [["", "Projects"], ["vault", "Vault"]]), [
      button("New file…", () => edit(""), "primary"),
    ]),
    categoryBar,
    h("div", { class: "split vault" }, [listPane, filePane]),
  ]);
  load();
  return node;

  function save() {
    ctx.setParams({ category, file: selected });
  }

  async function load() {
    try {
      [lists] = await Promise.all([vaultLists(), projects.load()]);
    } catch (error) {
      listPane.replaceChildren(errorBox(error, load));
      return;
    }
    draw();
  }

  function usedBy(cat, name) {
    return (projects.data || []).filter((project) => project.base && project[cat] === name).map((project) => project.name);
  }

  function draw() {
    categoryBar.replaceChildren(segmented(CATEGORIES.map((value) => ({ value, label: `${value[0].toUpperCase()}${value.slice(1)} ${lists[value].length}` })), category, (value) => {
      category = value;
      selected = "";
      save();
      draw();
    }, "Category"));
    const names = lists[category];
    if (!names.length) {
      listPane.replaceChildren(emptyState(`No ${category} files yet`, "Vault files are what variants use instead of their base project's config files.", button("New file…", () => edit(""), "primary")));
    } else {
      listPane.replaceChildren(table(["File", "Used by"], names.map((name) => ({
        key: name,
        class: name === selected ? "selected clickable" : "clickable",
        onclick: () => { selected = name; revealed = false; save(); draw(); },
        cells: [h("a", { href: routeHash("projects", "vault", { category, file: name }), onclick: (event) => event.preventDefault() }, name),
          usedBy(category, name).join(", ") || h("span", { class: "muted" }, "Not used")],
      }))));
    }
    drawFile();
  }

  async function drawFile() {
    const ticket = ++fileDraws;
    fileText = null;
    if (!selected || !lists[category].includes(selected)) {
      filePane.replaceChildren(emptyState("Select a file", category === "credentials" ? "Credentials stay hidden until you ask to see them." : null));
      return;
    }
    const users = usedBy(category, selected);
    const deleteButton = h("button", {
      type: "button", class: "btn danger quiet", disabled: users.length > 0,
      title: users.length ? `Used by ${users.join(", ")}; Plumber refuses to delete it.` : null,
      onclick: () => remove(selected),
    }, "Delete…");
    const name = selected; // The file this pane shows: after a save or delete, selected changes a moment before the pane
    const download = button("Download", () => busy(download, async () => {
      try {
        // A hidden credentials file, or one still loading, is read for the download only
        saveText(fileText ?? await api("GET", seg`/vault/${category}/${name}`), `${name}.toml`);
      } catch (error) {
        toast(error.message, { kind: "error" });
      }
    }), "quiet");
    const head = h("div", { class: "viewer-head" }, [
      h("div", { class: "viewer-title" }, [h("span", { class: "muted" }, `${category} / `), h("strong", null, selected)]),
      h("div", { class: "viewer-actions" }, [button("Edit…", () => edit(selected), "quiet"), download, deleteButton]),
    ]);
    const usage = h("p", { class: "muted" }, users.length ? `Used by ${users.join(", ")}. Each keeps its own copy until its base project is updated or it is edited.` : "No variant uses it.");
    if (category === "credentials" && !revealed) {
      filePane.replaceChildren(head, usage, h("div", { class: "empty" }, [
        h("p", null, "Contents hidden. Plumber returns credentials as plain text, and anyone who can see this screen can read them."),
        button("Show contents", () => { revealed = true; drawFile(); }),
      ]));
      return;
    }
    const pre = h("pre", { class: "code" }, loading("Loading…"));
    filePane.replaceChildren(head, usage, pre);
    try {
      const text = await api("GET", seg`/vault/${category}/${selected}`, { signal: ctx.scope.signal });
      if (ticket !== fileDraws) return; // Another file (or category) is shown by now
      fileText = text;
      pre.replaceChildren(text || h("span", { class: "muted" }, "(empty)"));
    } catch (error) {
      if (error.name !== "AbortError") pre.replaceChildren(errorBox(error));
    }
  }

  async function edit(name) {
    let text = "";
    if (name) {
      try {
        text = await api("GET", seg`/vault/${category}/${name}`);
      } catch (error) {
        toast(error.message, { kind: "error" });
        return;
      }
    }
    const users = name ? usedBy(category, name) : [];
    const result = await vaultEditor({ category, name, text, names: lists ? lists[category] : [], usedBy: users });
    text = "";
    if (!result) return;
    const affected = usedBy(category, result.name);
    const bases = [...new Set(affected.map((variant) => baseOf(variant, projects.data)))];
    toast(affected.length
      ? `Saved ${category} / ${result.name}. ${affected.join(", ")} keep their copy until ${bases.join(", ")} is updated or they are edited.`
      : `Saved ${category} / ${result.name}.`,
    bases.length === 1 ? { action: { label: `Update ${bases[0]}…`, onClick: () => updateBase(bases[0]) }, sticky: true } : {});
    selected = result.name;
    save();
    await load();
  }

  async function remove(name) {
    const ok = await confirmDialog({
      title: `Delete ${category} file ${name}?`,
      body: h("p", null, `No variant uses it. Plumber deletes vault/${category}/${name}.toml; this can't be undone.`),
      confirmLabel: "Delete", danger: true,
    });
    if (!ok) return;
    try {
      await api("DELETE", seg`/vault/${category}/${name}`);
      toast(`Deleted ${category} / ${name}.`);
      selected = "";
      save();
    } catch (error) {
      toast(error.message, { kind: "error" });
    }
    await load();
  }
}

// Stations ---------------------------------------------------------------------

function renderStations(params, ctx) {
  const checked = h("span", { class: "updated muted" });
  const content = h("div", { class: "page-body" }, loading("Checking stations (up to 3 s)…"));
  const pushPanel = h("div");
  const pending = new Map(); // Edits and removals under way, see waitButton()
  // Push reads the run list first too (up to 30 s with a slow station); its button is drawn once, so busy() covers it
  const node = h("section", { class: "page" }, [
    pageHead("Stations", null, [checked, button("Push projects…", (event) => busy(event.currentTarget, pushDialog)), button("Add station…", addStationDialog, "primary")]),
    pushPanel,
    content,
    h("p", { class: "muted small" }, "Offline means no answer from the station's /health with its token within 3 s: it is unreachable, or the token is wrong. "
      + "To fix an offline station's URL or token, edit Plumber's config.toml and restart Plumber."),
    deployedPanel(),
  ]);
  ctx.scope.cleanup(stations.listen(draw));
  ctx.scope.cleanup(runs.listen(draw)); // The counts change right after a start or stop, not at the next poll
  ctx.scope.every(() => runs.load(), () => 15000);
  if (stations.data) draw();
  drawPush();
  return node;

  function draw() {
    if (stations.error && !stations.data) {
      redraw(content, "error:" + stations.error.message, () => errorBox(stations.error, () => stations.load().catch(() => {})));
      return;
    }
    if (!stations.data) return;
    checked.textContent = stations.at ? `Checked ${fmtClock(new Date(stations.at))}` : "";
    if (!stations.data.length) {
      redraw(content, "empty", () => emptyState("No stations yet", "Add a ValveStation: its URL and the token from its config.toml.",
        focusKey(button("Add station…", addStationDialog, "primary"), "add")));
      return;
    }
    const all = runs.data?.runs || [];
    const failed = new Set((runs.data?.errors || []).map((item) => item.station));
    // What each row shows, so polls that bring nothing new leave the table, and the focus in it, alone.
    // The counts are unknown (null) without a run list, or when the station failed to list its runs.
    const rows = stations.data.map((item) => {
      const here = all.filter((run) => run.station === item.name);
      return {
        item,
        counts: runs.data && !failed.has(item.name) ? {
          running: here.filter((run) => run.status === "running").length,
          errored: groupRuns(here).filter((group) => group.state === "errored").length,
        } : null,
      };
    });
    redraw(content, JSON.stringify(rows), () => table(["Status", "Station", "Connection", "Running", "Latest errored", ""], rows.map(({ item, counts }) => {
      const count = (status) => (!counts ? h("span", { class: "muted" }, "–")
        : counts[status] ? h("a", { href: routeHash("runs", "", { station: item.name, status }), "data-focus": `${status}:${item.name}` }, String(counts[status]))
          : h("span", { class: "muted" }, "0"));
      return {
        key: item.name,
        cells: [badge(item.status), h("strong", null, item.name), h("span", { class: "mono" }, item.connection), count("running"), count("errored"),
          h("div", { class: "row-actions" }, [
            focusKey(waitButton(pending, `edit:${item.name}`, "Edit…", () => editStationDialog(item), "quiet small"), `edit:${item.name}`),
            focusKey(waitButton(pending, `remove:${item.name}`, "Remove…", () => removeStationDialog(item), "danger quiet small"), `remove:${item.name}`),
          ])],
      };
    }), { className: "stations" }));
  }

  function drawPush() {
    if (!lastPush) {
      pushPanel.replaceChildren();
      return;
    }
    const { result, at, ms } = lastPush;
    const projectNames = [...new Set(result.flatMap((entry) => (entry.projects || []).map((item) => item.project)))];
    let sent = 0;
    let current = 0;
    let errors = 0;
    const rows = result.map((entry) => {
      if (entry.status !== "online") return [h("strong", null, entry.station), ...projectNames.map(() => h("span", { class: "muted" }, "offline, skipped"))];
      const byName = new Map((entry.projects || []).map((item) => [item.project, item]));
      return [h("strong", null, entry.station), ...projectNames.map((name) => {
        const item = byName.get(name);
        if (!item) return h("span", { class: "muted" }, "–");
        if (item.error) {
          errors += 1;
          return /did not respond/.test(item.error) ? badge("maybe", "maybe sent") : badge("error", "error");
        }
        if (item.sent) {
          sent += 1;
          return badge("sent", "sent");
        }
        current += 1;
        return badge("current", "current");
      })];
    });
    const errorLines = result.flatMap((entry) => (entry.projects || []).filter((item) => item.error).map((item) => `${entry.station} / ${item.project}: ${item.error}`));
    pushPanel.replaceChildren(h("section", { class: "panel" }, [
      h("div", { class: "panel-head" }, [
        h("h2", null, `Last push, ${fmtClock(at)}, ${Math.round(ms / 1000)} s`),
        h("span", { class: "muted" }, `${sent} sent, ${current} already current, ${plural(errors, "error")}`),
        h("a", { class: "btn quiet small", href: routeHash("runs", "", { status: "errored" }) }, "Runs that ended"),
        button("Close", () => { lastPush = null; drawPush(); }, "quiet small"),
      ]),
      table(["Station", ...projectNames], rows, { className: "matrix" }),
      errorLines.length ? h("ul", { class: "error-list" }, errorLines.map((line) => h("li", null, line))) : null,
    ]));
  }
}

function deployedPanel() {
  let kind = "catalog";
  const box = h("div", { class: "panel-body" }, h("p", { class: "muted" }, "Asks every station to load each of its projects with Canonada, so it takes a while."));
  const loadButton = button("Load from stations", () => busy(loadButton, async () => {
    const asked = kind; // The toggle stays usable: a reply for the view it no longer shows is dropped
    box.replaceChildren(loading("Asking every station to load each of its projects with Canonada…"));
    try {
      const [result] = await Promise.all([api("GET", `/catalog/view/${asked}`), projects.ensure().catch(() => [])]);
      if (asked === kind) box.replaceChildren(deployedMatrix(result, asked));
    } catch (error) {
      if (asked === kind) box.replaceChildren(errorBox(error));
    }
  }));
  const toggle = segmented([{ value: "catalog", label: "Datasets" }, { value: "parameters", label: "Parameters" }], kind, (value) => {
    kind = value;
    box.replaceChildren(h("p", { class: "muted" }, "Load again to see this view."));
  }, "Show");
  return h("section", { class: "panel" }, [h("div", { class: "panel-head" }, [h("h2", null, "What each station has"), toggle, loadButton]), box]);
}

function deployedMatrix(result, kind) {
  if (!result.length) return h("p", { class: "muted" }, "No stations.");
  const registered = new Set((projects.data || []).map((project) => project.name));
  const names = [...new Set(result.flatMap((entry) => (entry.projects || []).map((item) => item.project)))].sort();
  let unregistered = false;
  const rows = names.map((name) => {
    const known = registered.has(name);
    if (!known) unregistered = true;
    return [known ? name : [name, h("span", { class: "muted", title: "On a station, not registered in Plumber" }, " *")], ...result.map((entry) => {
      if (entry.error) return h("span", { class: "error-text" }, entry.error);
      const item = (entry.projects || []).find((candidate) => candidate.project === name);
      if (!item) return h("span", { class: "muted" }, "–");
      if (item.error) return h("span", { class: "error-text" }, item.error);
      const value = item[kind];
      if (value == null) return h("span", { class: "muted" }, "none");
      if (kind === "catalog") {
        return h("details", null, [h("summary", null, plural(value.length, "dataset")), h("ul", { class: "plain" }, value.map((dataset) => h("li", { class: "mono" }, dataset)))]);
      }
      const entries = Object.entries(value);
      return h("details", null, [h("summary", null, plural(entries.length, "parameter")),
        h("ul", { class: "plain" }, entries.map(([key, val]) => h("li", { class: "mono" }, `${key} = ${typeof val === "string" ? val : JSON.stringify(val)}`)))]);
    })];
  });
  // A station that failed lists no projects, so its error gets a line of its own too
  const failures = result.filter((entry) => entry.error);
  return h("div", null, [
    table(["Project", ...result.map((entry) => entry.station)], rows, {
      className: "matrix",
      empty: failures.length === result.length ? "No station answered." : "No station that answered has any project yet.",
    }),
    failures.map((entry) => h("p", { class: "station-error" }, [badge("error", entry.station), ` ${entry.error}. Its projects are not shown.`])),
    unregistered ? h("p", { class: "muted small" }, "* On a station but not registered in Plumber. Removing or editing that station deletes these too.") : null,
  ]);
}

// Pipelines: Browse ------------------------------------------------------------

function renderBrowse(params, ctx) {
  let selected = params.project || "";
  let filter = "";
  let waiting = null; // The registry's loading line, made once per load so redraws keep it and its count of seconds
  const open = new Set(); // Expanded rows, "pipeline:name"
  // Inputs and outputs, "kind:project:name" -> { pending: its loading line } while asked, then { result } or { error }
  const views = new Map();
  const left = h("div", { class: "pane project-pick" });
  const right = h("div", { class: "pane project-detail" });
  const note = h("span", { class: "updated muted" });
  const reload = button("Reload", () => { registry.forget(); loadRegistry(); }, "quiet");
  const node = h("section", { class: "page" }, [
    pageHead("Pipelines", subTabs("pipelines", "", [["", "Browse"], ["schedules", "Schedules"]]), [note, reload]),
    h("div", { class: "split browse" }, [left, right]),
  ]);
  ctx.scope.cleanup(projects.listen(() => { drawLeft(); drawRight(); }));
  ctx.scope.cleanup(runs.listen(drawRight)); // The run chips change right after a start or stop, not at the next poll
  drawLeft();
  ctx.scope.every(() => runs.load(), () => ((runs.data?.runs || []).some((run) => run.status === "running") ? 10000 : 20000));
  projects.load().catch(() => {});
  loadRegistry();
  schedules.load().catch(() => {});
  return node;

  async function loadRegistry() {
    const started = Date.now();
    note.textContent = "";
    waiting = loading("Plumber is loading each base project with Canonada, one after another (up to 60 s each)…");
    if (!registry.data) drawRight();
    try {
      await busy(reload, () => registry.ensure());
      note.textContent = registry.at >= started ? `Read with Canonada at ${fmtClock(new Date(registry.at))} in ${Math.round((Date.now() - started) / 1000)} s` : `Read at ${fmtClock(new Date(registry.at))}`;
    } catch (error) {
      note.textContent = "";
    }
    drawRight();
  }

  function drawLeft() {
    if (!projects.data) {
      left.replaceChildren(projects.error ? errorBox(projects.error, () => projects.load().catch(() => {})) : loading("Loading projects…"));
      return;
    }
    if (!projects.data.length) {
      left.replaceChildren(emptyState("No projects", "Register one on the Projects tab.", h("a", { class: "btn", href: routeHash("projects", "", {}) }, "Open Projects")));
      return;
    }
    if (!selected || !projects.data.some((project) => project.name === selected)) selected = projects.data.find((project) => !project.base)?.name || "";
    const search = h("input", { type: "search", placeholder: "Filter projects", value: filter, "aria-label": "Filter projects" });
    search.addEventListener("input", () => { filter = search.value; drawTree(tree); });
    const tree = h("ul", { class: "project-tree" });
    left.replaceChildren(search, tree);
    drawTree(tree);
  }

  function drawTree(tree) {
    const text = filter.trim().toLowerCase();
    const item = (project, isVariant) => h("li", { class: project.name === selected ? "selected" : null }, h("a", {
      href: routeHash("pipelines", "", { project: project.name }),
      onclick: (event) => {
        event.preventDefault();
        selected = project.name;
        ctx.setParams({ project: selected });
        drawTree(tree);
        drawRight();
      },
    }, isVariant ? [h("span", { class: "muted", "aria-hidden": "true" }, "↳ "), project.name] : h("strong", null, project.name)));
    const items = [];
    for (const { base, variants } of projectTree(projects.data)) {
      const shownVariants = variants.filter((variant) => !text || variant.name.toLowerCase().includes(text));
      if (text && !base.name.toLowerCase().includes(text) && !shownVariants.length) continue;
      items.push(item(base, false), ...shownVariants.map((variant) => item(variant, true)));
    }
    tree.replaceChildren(...(items.length ? items : [h("li", { class: "muted" }, "No project matches.")]));
  }

  function drawRight() {
    const record = (projects.data || []).find((project) => project.name === selected);
    const base = record ? record.base || record.name : "";
    // Everything the pane shows, so a poll that brings nothing new leaves it, and the focus in it, alone
    const signature = JSON.stringify([
      Boolean(projects.data), record,
      registry.data ? [registry.data.pipelines[base], registry.data.systems[base]] : registry.error?.message || null,
      (runs.data?.runs || []).filter((run) => run.project === selected),
      [...open],
      [...views].map(([key, value]) => [key, value.pending ? "pending" : value.error ? value.error.message : value.result]),
    ]);
    redraw(right, signature, () => buildRight(record, base));
  }

  function buildRight(record, base) {
    if (!record) return projects.data ? emptyState("Select a project") : loading("Loading projects…");
    const files = CATEGORIES.filter((category) => record[category]);
    const head = h("div", { class: "detail-head" }, [
      h("h2", null, record.name),
      record.base
        ? h("p", { class: "muted" }, `Variant of ${record.base}; its pipelines and systems are ${record.base}'s.`)
        : h("p", { class: "muted" }, record.repository ? [maskUrl(record.repository), ` @ ${record.branch}`] : "Uploaded as a zip"),
      files.length ? h("p", { class: "chips" }, files.map((category) => h("a", {
        class: "chip link", href: routeHash("projects", "vault", { category, file: record[category] }), "data-focus": `vault:${category}`,
      }, `${category}: ${record[category]}`))) : null,
    ]);
    if (!registry.data) {
      return [head, registry.error ? errorBox(registry.error, () => { registry.forget(); loadRegistry(); }) : waiting];
    }
    const pipelines = registry.data.pipelines[base];
    const systems = registry.data.systems[base];
    const failure = [pipelines, systems].find((entry) => entry && !Array.isArray(entry) && entry.error);
    if (failure || !pipelines || !systems) {
      return [head, h("div", { class: "warning-card" }, [
        h("p", null, failure ? `Plumber's registry can't load ${base}: ${failure.error}` : `Plumber's registry doesn't list ${base} yet; reload it.`),
        h("p", { class: "muted" }, "The registry loads projects in Plumber's own Python environment. Stations check the name themselves when a run starts, so you can still start or schedule by name."),
        h("div", { class: "row-actions" }, [
          focusKey(button("Start by name…", () => startDialog({ project: record.name, nameEditable: true }), "primary"), "start-by-name"),
          focusKey(button("Schedule by name…", () => scheduleDialog({ prefill: { project: record.name } })), "schedule-by-name"),
        ]),
      ])];
    }
    return [head,
      h("h3", null, "Pipelines"), targetTable("pipeline", pipelines, record.name),
      h("h3", null, "Systems"), targetTable("system", systems, record.name)];
  }

  function targetTable(kind, entries, project) {
    if (!entries.length) return h("p", { class: "muted" }, `No ${kind}s.`);
    const all = runs.data?.runs || [];
    const rows = [];
    for (const entry of entries) {
      const key = `${kind}:${entry.name}`;
      const isOpen = open.has(key);
      const firstLine = (entry.description || "").split("\n")[0];
      rows.push({
        key,
        class: isOpen ? "open" : null,
        cells: [
          h("button", {
            type: "button", class: "btn icon quiet", "aria-expanded": String(isOpen), "aria-label": isOpen ? "Hide details" : "Show details", "data-focus": `toggle:${key}`,
            onclick: () => { if (open.has(key)) open.delete(key); else open.add(key); drawRight(); },
          }, isOpen ? "▾" : "▸"),
          [h("strong", null, entry.name), firstLine ? h("div", { class: "muted small" }, firstLine) : null],
          kind === "pipeline" ? plural((entry.nodes || []).length, "node") : (entry.pipelines || []).join(" → "),
          runChips(all, kind, project, entry.name),
          h("div", { class: "row-actions" }, [
            focusKey(button("Start…", () => startDialog({ kind, project, name: entry.name }), "primary small"), `start:${key}`),
            focusKey(button("Schedule…", () => scheduleDialog({ prefill: { project, [kind]: entry.name } }), "quiet small"), `schedule:${key}`),
            h("a", { class: "btn quiet small", href: routeHash("runs", "", { filter: `${project} / ${entry.name}` }), "data-focus": `logs:${key}` }, "Logs"),
          ]),
        ],
      });
      if (isOpen) rows.push({ key: key + ":detail", class: "detail", cells: [details(kind, entry, project)] });
    }
    const built = table(["", kind === "pipeline" ? "Pipeline" : "System", kind === "pipeline" ? "Nodes" : "Pipelines, in order", "Latest run per station", ""], rows, { className: "targets" });
    for (const cell of built.querySelectorAll("tr.detail > td")) cell.setAttribute("colspan", "5");
    return built;
  }

  function details(kind, entry, project) {
    const key = `${kind}:${project}:${entry.name}`;
    const facts = kind === "pipeline"
      ? [`Nodes: ${(entry.nodes || []).join(" → ") || "none"}`, `max_workers ${entry.max_workers ?? "all cores"}`, `multiprocessing ${entry.multiprocessing ? "yes" : "no"}`, `error tolerant ${entry.error_tolerant ? "yes" : "no"}`]
      : [`Runs ${(entry.pipelines || []).join(", then ")}`];
    const box = h("div", { class: "target-detail" }, [
      entry.description ? h("p", { class: "description" }, entry.description) : null,
      h("p", { class: "muted small" }, facts.join(" · ")),
    ]);
    const loaded = views.get(key);
    if (!loaded) {
      box.append(focusKey(button("Load inputs and outputs from stations", async () => {
        // Pending in views, so a redraw while stations load the project shows this line, not the button again
        views.set(key, { pending: loading(`Asking every station to load ${project} with Canonada…`) });
        drawRight();
        try {
          views.set(key, { result: await api("GET", seg`/view/${kind}/${project}/${entry.name}`) });
        } catch (error) {
          views.set(key, { error });
        }
        drawRight();
      }, "quiet small"), `view:${key}`));
    } else if (loaded.pending) {
      box.append(loaded.pending);
    } else if (loaded.error) {
      box.append(errorBox(loaded.error));
    } else {
      box.append(makeup(kind, loaded.result, project, entry.name));
    }
    return box;
  }
}

/** Inputs and outputs per station; identical answers are shown once. */
function makeup(kind, result, project, name) {
  const groups = new Map();
  const problems = [];
  for (const entry of result) {
    if (entry.error) {
      const notSent = entry.error === `Project '${project}' not found`;
      problems.push(h("li", null, notSent ? `${entry.station}: doesn't have ${project} yet; it is sent the first time it starts there or at the next push.`
        : /not found/.test(entry.error) ? `${entry.station}: its copy has no ${kind} ${name}; it is older than Plumber's.` : `${entry.station}: ${entry.error}`));
      continue;
    }
    const signature = JSON.stringify(entry.view);
    if (!groups.has(signature)) groups.set(signature, { view: entry.view, stations: [] });
    groups.get(signature).stations.push(entry.station);
  }
  const nodeTable = (nodes) => table(["Node", "Inputs", "Outputs", "Description"], (nodes || []).map((item) => [
    h("strong", null, item.name), h("span", { class: "mono" }, (item.input || []).join(", ")), h("span", { class: "mono" }, (item.output || []).join(", ")), item.description || "",
  ]), { className: "nodes" });
  const blocks = [...groups.values()].map(({ view, stations: names }) => h("div", { class: "makeup" }, [
    h("p", { class: "muted small" }, `${groups.size > 1 ? "On" : "Same on"} ${names.join(", ")}:`),
    kind === "pipeline" ? nodeTable(view.nodes) : (view.pipelines || []).map((pipe) => [h("h4", null, pipe.name), nodeTable(pipe.nodes)]),
  ]));
  return h("div", null, [...blocks, problems.length ? h("ul", { class: "plain muted small" }, problems) : null]);
}

// Pipelines: Schedules ---------------------------------------------------------

const PRESETS = [
  ["*/5 * * * *", "every 5 min"],
  ["0 * * * *", "hourly"],
  ["0 2 * * *", "daily 02:00"],
  ["0 6 * * 1-5", "weekdays 06:00"],
  ["0 3 * * 0", "Sundays 03:00"],
];

async function scheduleDialog({ existing, prefill = {} }) {
  await Promise.all([projects.ensure(), stations.ensure()].map((p) => p.catch(() => {})));
  const record = existing || prefill;
  let kind = record.system !== undefined ? "system" : "pipeline";
  const projectNames = (projects.data || []).map((project) => project.name);
  if (record.project && !projectNames.includes(record.project)) projectNames.push(record.project);
  const stationNames = (stations.data || []).map((item) => item.name);
  if (record.station && !stationNames.includes(record.station)) stationNames.push(record.station);

  const name = textInput("name", { value: existing ? existing.name : "", readonly: Boolean(existing), required: true, placeholder: "nightly-lab" });
  const projectSelect = select("project", projectNames, record.project || projectNames[0]);
  const target = textInput("target", { value: record[kind] || "", required: true, list: "schedule-targets" });
  const targets = h("datalist", { id: "schedule-targets" });
  const stationSelect = select("station", stationNames, record.station || stationNames[0]);
  const cron = textInput("cron", { value: record.cron || "0 2 * * *", required: true });
  const preview = h("p", { class: "muted small", "aria-live": "polite" });
  const enabled = h("input", { type: "checkbox", checked: existing ? existing.enabled : true });
  const consequence = h("p", { class: "muted" });

  const fillTargets = () => {
    const base = baseOf(projectSelect.value, projects.data);
    const listed = registry.data?.[kind + "s"]?.[base];
    const names = new Set(Array.isArray(listed) ? listed.map((item) => item.name) : []);
    for (const run of runs.data?.runs || []) if (run.kind === kind && run.project === projectSelect.value) names.add(run.name);
    targets.replaceChildren(...[...names].sort().map((value) => h("option", { value })));
    consequence.textContent = `Each fire is skipped while ${target.value || "it"} is running on ${stationSelect.value}. Otherwise plumber-gui asks Plumber to start it, `
      + `and Plumber sends ${projectSelect.value} first if ${stationSelect.value}'s copy differs (for example after an update), which stops every running run of ${projectSelect.value} there.`;
  };
  let previewTimer = null;
  const updatePreview = () => {
    clearTimeout(previewTimer);
    if (!cron.value.trim()) {
      preview.classList.remove("error-text");
      preview.textContent = "Enter the five fields: minute hour day-of-month month day-of-week.";
      return;
    }
    previewTimer = setTimeout(async () => {
      const asked = cron.value;
      try {
        const result = await gui("GET", "/schedule/preview?cron=" + encodeURIComponent(asked));
        if (asked !== cron.value) return; // Edited meanwhile: the edit brought its own preview
        preview.classList.remove("error-text");
        preview.textContent = `Next: ${result.next.map(fmtServerTime).join(", ")} (plumber-gui's local time).`;
      } catch (error) {
        if (asked !== cron.value) return;
        preview.classList.add("error-text");
        preview.textContent = error.message;
      }
    }, 300);
  };
  cron.addEventListener("input", updatePreview);
  for (const control of [projectSelect, stationSelect]) control.addEventListener("change", fillTargets);
  target.addEventListener("input", fillTargets);
  fillTargets();
  updatePreview();
  if (!registry.data) registry.ensure().then(fillTargets).catch(() => {});

  const presets = h("div", { class: "presets" }, PRESETS.map(([value, label]) => button(label, () => { cron.value = value; updatePreview(); }, "quiet small")));
  const result = await formDialog({
    title: existing ? `Edit schedule ${existing.name}` : "New schedule",
    body: [
      field("Name", name, existing ? "Renaming isn't supported; delete it and create another." : "Letters, digits, dot, dash and underscore."),
      field("Runs", h("div", { class: "row" }, [
        segmented([{ value: "pipeline", label: "Pipeline" }, { value: "system", label: "System" }], kind, (value) => { kind = value; fillTargets(); }, "Kind"),
        target, targets,
      ])),
      field("Project", projectSelect),
      field("Station", stationSelect),
      field("Cron", cron, "minute hour day-of-month month day-of-week, in plumber-gui's local time. If both day fields are set, either one matching is enough."),
      presets,
      preview,
      h("label", { class: "check" }, [enabled, "Enabled"]),
      consequence,
    ],
    submitLabel: existing ? "Save" : "Create",
    onSubmit: async () => {
      const body = { name: name.value.trim(), project: projectSelect.value, [kind]: target.value.trim(), station: stationSelect.value, cron: cron.value.trim(), enabled: enabled.checked };
      if (existing) return gui("PUT", seg`/schedule/update/${existing.name}`, { json: body });
      return gui("POST", "/schedule/add", { json: body });
    },
  });
  clearTimeout(previewTimer);
  if (!result) return null;
  toast(existing ? `Saved schedule ${result.name}.` : `Created schedule ${result.name}.`,
    existing ? {} : { action: { label: "Show schedules", onClick: () => { location.hash = routeHash("pipelines", "schedules", { schedule: result.name }); } } });
  schedules.load().catch(() => {});
  return result;
}

function scheduleRecord(item) {
  const record = { name: item.name, project: item.project, station: item.station, cron: item.cron, enabled: item.enabled };
  if (item.pipeline !== undefined) record.pipeline = item.pipeline;
  else record.system = item.system;
  return record;
}

function renderSchedules(params, ctx) {
  let scrolled = false; // To the highlighted schedule (?schedule=), once: later polls leave the scroll alone
  const intro = h("p", { class: "muted" });
  const content = h("div", { class: "page-body" }, loading("Loading schedules…"));
  const node = h("section", { class: "page" }, [
    pageHead("Pipelines", subTabs("pipelines", "schedules", [["", "Browse"], ["schedules", "Schedules"]]), [
      button("New schedule…", () => scheduleDialog({}), "primary"),
    ]),
    intro,
    content,
  ]);
  ctx.scope.cleanup(schedules.listen(draw));
  ctx.scope.every(() => schedules.load(), () => 15000);
  Promise.all([projects.ensure(), stations.ensure()].map((p) => p.catch(() => {}))).then(draw);
  return node;

  function draw() {
    if (schedules.error && !schedules.data) {
      redraw(content, "error:" + schedules.error.message, () => errorBox(schedules.error, () => schedules.load().catch(() => {})));
      return;
    }
    const data = schedules.data;
    if (!data) return;
    intro.textContent = `Schedules fire from this plumber-gui while it runs, in its machine's local time: ${data.timezone} (UTC${data.utc_offset}), now ${fmtServerTime(data.now)}. `
      + `Fires missed while it was stopped are not made up. Last outcomes are kept since ${fmtServerTime(data.started)}.`;
    if (!data.schedules.length) {
      redraw(content, "empty", () => emptyState("No schedules yet", "A schedule starts one pipeline or system on one station at the times its cron expression gives, while plumber-gui runs.",
        focusKey(button("New schedule…", () => scheduleDialog({}), "primary"), "new")));
      return;
    }
    const registered = projects.data ? new Set(projects.data.map((project) => project.name)) : null;
    const configured = stations.data ? new Set(stations.data.map((item) => item.name)) : null;
    // What each row shows, "in 5 min" included, so polls that bring nothing new leave the table, and the focus in it, alone
    const rows = data.schedules.map((item) => {
      const until = item.enabled && item.next ? untilServerTime(item.next) : null;
      return {
        item,
        until: until !== null ? relTime(until) : null,
        unregistered: Boolean(registered && !registered.has(item.project)),
        unconfigured: Boolean(configured && !configured.has(item.station)),
      };
    });
    redraw(content, JSON.stringify(rows), () => table(["On", "Schedule", "Runs", "Station", "Cron", "Next", "Last", ""], rows.map(({ item, until, unregistered, unconfigured }) => {
      const kind = item.pipeline !== undefined ? "pipeline" : "system";
      const toggle = h("input", { type: "checkbox", checked: item.enabled, "aria-label": `${item.enabled ? "Disable" : "Enable"} ${item.name}`, "data-focus": `toggle:${item.name}` });
      toggle.addEventListener("change", async () => {
        toggle.disabled = true;
        try {
          await gui("PUT", seg`/schedule/update/${item.name}`, { json: { ...scheduleRecord(item), enabled: toggle.checked } });
        } catch (error) {
          toast(error.message, { kind: "error" });
          toggle.checked = item.enabled; // Nothing changed, so no redraw comes to put it back
        }
        toggle.disabled = false;
        schedules.load().catch(() => {});
      });
      const last = item.last;
      return {
        key: item.name,
        class: item.name === params.schedule ? "highlight" : null,
        cells: [
          toggle,
          h("strong", null, item.name),
          [`${kind} `, h("strong", null, item[kind]), h("span", { class: "muted" }, ` · ${item.project}`),
            unregistered ? h("span", { class: "tag warn" }, "project not registered") : null],
          [item.station, unconfigured ? h("span", { class: "tag warn" }, "station not configured") : null],
          h("code", null, item.cron),
          item.enabled && item.next ? [fmtServerTime(item.next), until !== null ? h("div", { class: "muted small" }, `in ${until}`) : null] : h("span", { class: "muted" }, "disabled"),
          item.firing ? badge("running", "firing…") : last ? [
            badge(last.outcome, last.outcome === "started" ? `started #${last.run}` : last.outcome),
            h("div", { class: "muted small" }, [fmtServerTime(last.at), last.detail ? ` · ${last.detail}` : "", last.sent ? " · project sent first" : ""]),
          ] : h("span", { class: "muted" }, "–"),
          h("div", { class: "row-actions" }, [
            focusKey(button("Run now…", () => startDialog({ kind, project: item.project, name: item[kind], station: item.station }), "quiet small"), `run:${item.name}`),
            focusKey(button("Edit…", () => scheduleDialog({ existing: scheduleRecord(item) }), "quiet small"), `edit:${item.name}`),
            focusKey(button("Delete…", () => removeSchedule(item), "danger quiet small"), `delete:${item.name}`),
          ]),
        ],
      };
    }), { className: "schedules" }));
    const highlighted = content.querySelector("tr.highlight");
    if (highlighted && !scrolled) {
      highlighted.scrollIntoView({ block: "center" });
      scrolled = true;
    }
  }

  async function removeSchedule(item) {
    const ok = await confirmDialog({
      title: `Delete schedule ${item.name}?`,
      body: h("p", null, "It stops firing now; runs it already started keep going."),
      confirmLabel: "Delete", danger: true,
    });
    if (!ok) return;
    try {
      await gui("DELETE", seg`/schedule/remove/${item.name}`);
      toast(`Deleted schedule ${item.name}.`);
    } catch (error) {
      toast(error.message, { kind: "error" });
    }
    schedules.load().catch(() => {});
  }
}

// Start ------------------------------------------------------------------------

window.addEventListener("hashchange", render);
loadVersion();
render();

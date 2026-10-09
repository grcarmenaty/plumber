// Shared helpers for plumber-gui: DOM building, Plumber API calls, dialogs, toasts, polling,
// the shared data stores, and formatting. No framework and nothing to build.
//
// Rule for every module: the page is built from DOM nodes and text nodes only. innerHTML and
// friends are never used (the server's Content-Security-Policy enforces Trusted Types), and data
// from Plumber is never used as a class name or a URL.

// DOM --------------------------------------------------------------------------

/**
 * Build an element. props: "class", on<event> listeners, boolean attributes (true sets,
 * false/null leaves out), "value" (set as a property after the children, so it works for
 * selects) and any other attribute. kids: nodes, strings, or nested arrays of them.
 */
export function h(tag, props, kids) {
  const node = document.createElement(tag);
  let value;
  for (const [key, val] of Object.entries(props || {})) {
    if (key === "style" || key === "innerHTML") throw new Error(`h(): "${key}" is not allowed`);
    if (val == null || val === false) continue;
    if (key.startsWith("on") && typeof val === "function") node.addEventListener(key.slice(2), val);
    else if (key === "class") node.className = val;
    else if (key === "value") value = val;
    else if (key === "checked" || key === "selected") node[key] = true;
    else node.setAttribute(key, val === true ? "" : String(val));
  }
  append(node, kids);
  if (value !== undefined) node.value = value;
  return node;
}

export function append(node, kids) {
  for (const kid of [kids].flat(Infinity)) {
    if (kid == null || kid === false || kid === true) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

const drawn = new WeakMap();

/**
 * Replace node's children with build()'s, unless signature (a string of everything they show) is
 * the one node was last drawn with. A poll that brings nothing new then leaves the view alone, so
 * focus, a text selection and a click in progress survive. On a real redraw, the focused element's
 * replacement (the one with the same data-focus value) gets the focus back. Returns whether it drew.
 */
export function redraw(node, signature, build) {
  const kids = node.childNodes;
  const last = drawn.get(node);
  if (last && last.signature === signature && last.first === kids[0] && last.end === kids[kids.length - 1]) return false;
  const active = document.activeElement;
  const focusKey = active && active !== node && node.contains(active) ? active.getAttribute("data-focus") : null;
  node.replaceChildren();
  append(node, build());
  const now = node.childNodes;
  drawn.set(node, { signature, first: now[0], end: now[now.length - 1] });
  if (focusKey !== null) {
    // Without scrolling: the user may have scrolled away from it, e.g. to the log below the list
    [...node.querySelectorAll("[data-focus]")].find((el) => el.getAttribute("data-focus") === focusKey)?.focus({ preventScroll: true });
  }
  return true;
}

/**
 * A data table. A row is an array of cells, or { cells, class, key, onclick }.
 */
export function table(headers, rows, { empty, className } = {}) {
  const body = h("tbody", null, rows.map((row) => {
    const spec = Array.isArray(row) ? { cells: row } : row;
    return h("tr", { class: spec.class, "data-key": spec.key, onclick: spec.onclick }, spec.cells.map((cell) => h("td", null, cell)));
  }));
  if (!rows.length && empty) body.append(h("tr", null, h("td", { colspan: headers.length, class: "empty-row" }, empty)));
  return h("table", { class: className ? "data " + className : "data" }, [
    h("thead", null, h("tr", null, headers.map((header) => h("th", { scope: "col" }, header)))),
    body,
  ]);
}

let fieldIds = 0;

/**
 * A captioned form control. A group of controls (checkboxes, a segmented bar, a row) is a role=group
 * named by its caption: a <label> around it would pass every click on the caption or on blank space
 * to the group's first control.
 */
export function field(label, control, hint) {
  const kids = [null, control, hint ? h("small", { class: "hint" }, hint) : null];
  if (["INPUT", "SELECT", "TEXTAREA"].includes(control.tagName)) {
    kids[0] = h("span", { class: "field-label" }, label);
    return h("label", { class: "field" }, kids);
  }
  const id = `field-${++fieldIds}`;
  kids[0] = h("span", { class: "field-label", id }, label);
  return h("div", { class: "field", role: "group", "aria-labelledby": id }, kids);
}

export function textInput(name, options) {
  const opts = typeof options === "string" ? { type: options } : options || {};
  return h("input", {
    name,
    type: opts.type || "text",
    value: opts.value,
    placeholder: opts.placeholder,
    required: opts.required,
    readonly: opts.readonly,
    autocomplete: opts.autocomplete || "off",
    spellcheck: "false",
    list: opts.list,
  });
}

/**
 * A select. options: strings, or { value, label, disabled }.
 */
export function select(name, options, value, props) {
  return h("select", { name, value, ...props }, options.map((option) => {
    const opt = typeof option === "string" ? { value: option, label: option } : option;
    return h("option", { value: opt.value, disabled: opt.disabled }, opt.label ?? opt.value);
  }));
}

/**
 * A row of toggle buttons where exactly one is pressed. options: strings, or { value, label }.
 */
export function segmented(options, value, onChange, label) {
  const group = h("div", { class: "segmented", role: "group", "aria-label": label });
  for (const option of options) {
    const opt = typeof option === "string" ? { value: option, label: option } : option;
    const button = h("button", { type: "button", "aria-pressed": String(opt.value === value), "data-value": opt.value }, opt.label);
    button.addEventListener("click", () => {
      for (const other of group.children) other.setAttribute("aria-pressed", String(other === button));
      onChange(opt.value);
    });
    group.append(button);
  }
  return group;
}

const BADGE_TONES = {
  running: "run", finished: "ok", errored: "err", online: "ok", offline: "muted",
  sent: "run", current: "ok", started: "ok", skipped: "warn", failed: "err", unknown: "warn",
  disabled: "muted", error: "err", maybe: "warn",
};

/**
 * A status badge: a drawn mark plus a word, so colour is never the only signal. The state picks one
 * of a fixed set of classes; anything unknown is muted.
 */
export function badge(state, label) {
  return h("span", { class: "badge " + (BADGE_TONES[state] || "muted") }, label ?? state);
}

export function chip(text, props) {
  return h("span", { class: "chip", ...props }, text);
}

const waits = new Set(); // { counter: WeakRef to a loading() line's seconds, started }
let ticker = null;

/**
 * "Loading" text with the seconds waited so far, for calls that run Canonada on Plumber or stations.
 * A view may take the line off the page and put it back while the call goes on, so one shared ticker
 * keeps every line counting until nothing holds it any more.
 */
export function loading(text) {
  const seconds = h("span", { class: "elapsed" });
  waits.add({ counter: new WeakRef(seconds), started: Date.now() });
  ticker ??= setInterval(tickWaits, 1000);
  return h("p", { class: "loading", role: "status" }, [h("span", { class: "spinner", "aria-hidden": "true" }), text, " ", seconds]);
}

function tickWaits() {
  for (const wait of waits) {
    const seconds = wait.counter.deref();
    if (!seconds) {
      waits.delete(wait);
      continue;
    }
    const waited = Math.round((Date.now() - wait.started) / 1000);
    seconds.textContent = waited >= 2 ? `(${waited} s)` : "";
  }
  if (!waits.size) {
    clearInterval(ticker);
    ticker = null;
  }
}

export function emptyState(title, text, action) {
  return h("div", { class: "empty" }, [h("h3", null, title), text ? h("p", null, text) : null, action || null]);
}

export function errorBox(error, retry) {
  return h("div", { class: "error-box", role: "alert" }, [
    h("p", null, error.message || String(error)),
    retry ? h("button", { type: "button", class: "btn", onclick: retry }, "Retry") : null,
  ]);
}

export function button(label, onclick, kind) {
  return h("button", { type: "button", class: kind ? "btn " + kind : "btn", onclick }, label);
}

// API --------------------------------------------------------------------------

export class ApiError extends Error {
  constructor(status, detail, source) {
    super(detail);
    this.status = status;
    this.detail = detail;
    this.source = source; // "plumber-gui", "plumber", "network" or "size"
  }
}

const reach = { plumber: true, gui: true, since: null };
const reachListeners = new Set();

/**
 * Hear when Plumber or plumber-gui stops or starts answering. fn gets { plumber, gui, since }.
 */
export function onReachability(fn) {
  reachListeners.add(fn);
  return () => reachListeners.delete(fn);
}

function setReach(plumber, gui) {
  if (reach.plumber === plumber && reach.gui === gui) return;
  reach.plumber = plumber;
  reach.gui = gui;
  reach.since = plumber && gui ? null : reach.since || new Date();
  for (const fn of reachListeners) fn({ ...reach });
}

function formatDetail(payload, status) {
  const detail = payload && typeof payload === "object" ? payload.detail : null;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    // FastAPI's validation errors
    return detail.map((item) => (item.loc || []).filter((part) => part !== "body").join(".") + ": " + item.msg).join("; ");
  }
  if (typeof payload === "string" && payload.trim()) return payload.trim().slice(0, 300);
  return `Request failed (${status})`;
}

async function request(base, method, path, { json, body, headers, signal, maxBytes } = {}) {
  const sent = { "X-Plumber-GUI": "1", ...headers };
  if (json !== undefined) {
    body = JSON.stringify(json);
    sent["Content-Type"] = "application/json";
  }
  // The caller's signal (a page's scope) outlives many requests, so its listener goes when each one ends
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", onAbort);
  try {
    let response;
    try {
      response = await fetch(base + path, { method, body, headers: sent, signal: controller.signal, cache: "no-store" });
    } catch (error) {
      if (controller.signal.aborted) throw error;
      setReach(reach.plumber, false);
      throw new ApiError(0, "plumber-gui is not responding: it stopped, or the SSH tunnel closed.", "network");
    }
    const length = Number(response.headers.get("content-length"));
    if (maxBytes && response.ok && length > maxBytes) {
      controller.abort();
      const error = new ApiError(response.status, `The reply is ${fmtBytes(length)}.`, "size");
      error.size = length;
      throw error;
    }
    const type = response.headers.get("content-type") || "";
    const payload = type.includes("json") ? await response.json().catch(() => null) : await response.text();
    const source = payload && typeof payload === "object" && payload.source === "plumber-gui" ? "plumber-gui" : "plumber";
    if (!response.ok) {
      // Only a proxied call tells whether Plumber answers; plumber-gui's own endpoints never reach it
      const plumberDown = source === "plumber-gui" && (response.status === 502 || response.status === 504);
      setReach(base === "api" ? !plumberDown : reach.plumber, true);
      throw new ApiError(response.status, formatDetail(payload, response.status), source);
    }
    setReach(base === "api" ? true : reach.plumber, true);
    return payload;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/** A call to Plumber through plumber-gui. path starts with "/". */
export function api(method, path, options) {
  return request("api", method, path, options);
}

/** A call to plumber-gui's own endpoints (the schedules). */
export function gui(method, path, options) {
  return request("gui", method, path, options);
}

/** Encode each path segment: seg`/run/pipeline/${project}/${name}`. */
export function seg(strings, ...values) {
  return strings.reduce((out, part, i) => out + part + (i < values.length ? encodeURIComponent(String(values[i])) : ""), "");
}

// Stores -----------------------------------------------------------------------

/**
 * Data shared by several views: { data, at, error, load(), listen(fn) }. Callers share a load
 * that is already under way. listen(fn) is called after every load, failed ones included.
 */
export function store(loader) {
  let pending = null;
  const listeners = new Set();
  const s = {
    data: undefined,
    at: 0,
    error: null,
    load() {
      if (pending) return pending;
      pending = (async () => {
        try {
          s.data = await loader();
          s.at = Date.now();
          s.error = null;
          return s.data;
        } catch (error) {
          s.error = error;
          throw error;
        } finally {
          pending = null;
          for (const fn of listeners) fn(s);
        }
      })();
      return pending;
    },
    /** Load only when nothing was loaded yet. */
    ensure() {
      return s.data !== undefined ? Promise.resolve(s.data) : s.load();
    },
    forget() {
      s.data = undefined;
      s.at = 0;
    },
    listen(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  return s;
}

export const stations = store(() => api("GET", "/station/list"));
export const projects = store(() => api("GET", "/project/list"));
export const registry = store(async () => {
  const [pipelines, systems] = await Promise.all([api("GET", "/registry/pipelines"), api("GET", "/registry/systems")]);
  return { pipelines, systems };
});
export const schedules = store(() => gui("GET", "/schedule/list"));

/** The base project of a project or variant, from the project list. */
export function baseOf(name, list) {
  const record = (list || []).find((project) => project.name === name);
  return record && record.base ? record.base : name;
}

/** Base projects with their variants, in list order: [{ base, variants: [...] }]. */
export function projectTree(list) {
  const bases = (list || []).filter((project) => !project.base);
  return bases.map((base) => ({ base, variants: list.filter((project) => project.base === base.name) }));
}

// Dialogs and toasts -----------------------------------------------------------

function openDialog(className, form, onCancel) {
  const dialog = h("dialog", { class: className }, form);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    onCancel();
  });
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

/**
 * Ask before an action. Resolves true when confirmed. typeToConfirm: the text the user must type.
 */
export function confirmDialog({ title, body, confirmLabel = "Confirm", danger = false, typeToConfirm }) {
  return new Promise((resolve) => {
    const confirm = h("button", { type: "submit", class: danger ? "btn danger" : "btn primary" }, confirmLabel);
    const cancel = h("button", { type: "button", class: "btn", onclick: () => finish(false) }, "Cancel");
    let typed = null;
    if (typeToConfirm) {
      typed = textInput("confirm", { placeholder: typeToConfirm });
      typed.addEventListener("input", () => {
        confirm.disabled = typed.value !== typeToConfirm;
      });
      confirm.disabled = true;
    }
    const form = h("form", { class: "dialog-form" }, [
      h("h2", { class: "dialog-title" }, title),
      h("div", { class: "dialog-body" }, body),
      typed ? field(["Type ", h("code", null, typeToConfirm), " to confirm"], typed) : null,
      h("div", { class: "dialog-actions" }, [cancel, confirm]),
    ]);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!confirm.disabled) finish(true);
    });
    const dialog = openDialog(danger ? "dialog danger" : "dialog", form, () => finish(false));
    (typed || (danger ? cancel : confirm)).focus();

    function finish(result) {
      dialog.close();
      dialog.remove();
      resolve(result);
    }
  });
}

/**
 * A dialog with a form. onSubmit(form) runs while the buttons are disabled; its result resolves the
 * promise, and an error it throws is shown in the dialog. Cancel resolves null.
 */
export function formDialog({ title, body, submitLabel = "Save", danger = false, wide = false, onSubmit }) {
  return new Promise((resolve) => {
    const error = h("p", { class: "note error", role: "alert", hidden: true });
    const submit = h("button", { type: "submit", class: danger ? "btn danger" : "btn primary" }, submitLabel);
    const cancel = h("button", { type: "button", class: "btn", onclick: () => !busyNow && finish(null) }, "Cancel");
    let busyNow = false;
    let finished = false;
    const form = h("form", { class: "dialog-form" }, [
      h("h2", { class: "dialog-title" }, title),
      h("div", { class: "dialog-body" }, typeof body === "function" ? body() : body),
      error,
      h("div", { class: "dialog-actions" }, [cancel, submit]),
    ]);
    // While onSubmit runs the dialog must stay open, so its result or error has somewhere to go and
    // the caller's cleanup (clearing a token or a key) runs. Cancelling the cancel event only holds
    // off the first Escape (the browser's close-watcher rules), so the key itself is stopped.
    const holdEscape = (event) => {
      if (event.key === "Escape") event.preventDefault();
    };
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (busyNow) return;
      busyNow = true;
      submit.disabled = cancel.disabled = true;
      submit.setAttribute("aria-busy", "true");
      error.hidden = true;
      document.addEventListener("keydown", holdEscape, true);
      try {
        const result = await onSubmit(form);
        finish(result === undefined ? true : result);
      } catch (failure) {
        error.textContent = failure.message || String(failure);
        error.hidden = false;
      } finally {
        busyNow = false;
        document.removeEventListener("keydown", holdEscape, true);
        submit.disabled = cancel.disabled = false;
        submit.removeAttribute("aria-busy");
      }
    });
    const dialog = openDialog(wide ? "dialog wide" : "dialog", form, () => !busyNow && finish(null));
    dialog.addEventListener("close", () => {
      if (busyNow && !finished) dialog.showModal(); // Closed by the browser anyway
    });
    form.querySelector("input:not([type=hidden]):not([readonly]), select, textarea")?.focus();

    function finish(result) {
      finished = true;
      dialog.close();
      dialog.remove();
      resolve(result);
    }
  });
}

/**
 * A short message in the corner. Errors stay until closed; other kinds go after 6 s unless sticky.
 * message: text or nodes. action: { label, onClick }.
 */
export function toast(message, { kind = "ok", action, sticky = false } = {}) {
  const region = document.querySelector("#toasts");
  const stays = sticky || kind === "error";
  const item = h("div", { class: "toast " + kind, role: kind === "error" ? "alert" : "status", "data-stays": stays });
  const close = h("button", { type: "button", class: "toast-close", "aria-label": "Dismiss", onclick: () => item.remove() }, "×");
  append(item, [
    h("div", { class: "toast-body" }, message),
    action ? h("button", { type: "button", class: "btn quiet", onclick: () => { item.remove(); action.onClick(); } }, action.label) : null,
    close,
  ]);
  region.append(item);
  // At most 4 on screen: the oldest that would go by itself makes room; ones that stay are never dropped
  const passing = [...region.children].filter((node) => !node.hasAttribute("data-stays"));
  while (region.children.length > 4 && passing.length) passing.shift().remove();
  if (!stays) setTimeout(() => item.remove(), 6000);
  return item;
}

/** Run fn with the button disabled, so a double click sends one request. */
export async function busy(buttonNode, fn) {
  if (buttonNode.disabled) return undefined;
  buttonNode.disabled = true;
  buttonNode.setAttribute("aria-busy", "true");
  try {
    return await fn();
  } finally {
    buttonNode.disabled = false;
    buttonNode.removeAttribute("aria-busy");
  }
}

// Polling ----------------------------------------------------------------------

/**
 * Everything a page starts that must stop when you leave it: { signal, every, cleanup, dispose }.
 * every(task, delay) runs task now and then again delay() ms after each run ends (never two at
 * once). It waits while the browser tab is hidden, and backs off x2 per failure up to 60 s.
 * It returns { now() } to refresh at once.
 */
export function scope() {
  const controller = new AbortController();
  const cleanups = [];
  let disposed = false;
  return {
    signal: controller.signal,
    every(task, delay) {
      let timer = null;
      let running = false;
      let again = false;
      let failures = 0;
      let waiting = false;
      const run = async () => {
        timer = null;
        if (disposed) return;
        if (document.hidden) {
          waiting = true;
          return;
        }
        running = true;
        try {
          await task();
          failures = 0;
        } catch (error) {
          if (error.name !== "AbortError") failures += 1;
          if (error.name !== "AbortError" && !(error instanceof ApiError)) console.error(error); // A bug, not a failed request
        }
        running = false;
        if (disposed) return;
        const base = again ? 0 : delay();
        again = false;
        timer = setTimeout(run, failures ? Math.min(Math.max(base, 1000) * 2 ** failures, 60000) : base);
      };
      const onVisible = () => {
        if (!document.hidden && waiting && !running && !disposed) {
          waiting = false;
          run();
        }
      };
      document.addEventListener("visibilitychange", onVisible);
      cleanups.push(() => {
        document.removeEventListener("visibilitychange", onVisible);
        clearTimeout(timer);
      });
      run();
      return {
        now() {
          if (running) {
            again = true;
          } else if (!disposed) {
            clearTimeout(timer);
            run();
          }
        },
      };
    },
    cleanup(fn) {
      cleanups.push(fn);
    },
    dispose() {
      disposed = true;
      controller.abort();
      for (const fn of cleanups) fn();
    },
  };
}

// Routes -----------------------------------------------------------------------
//
// "#/<tab>[/<view>]?<query>". The path only names the tab and its view; every name goes in the
// query, so a project called "vault" can't be mistaken for a view.

export function parseRoute(hash) {
  const raw = String(hash || "").replace(/^#\/?/, "");
  const mark = raw.indexOf("?");
  const path = mark < 0 ? raw : raw.slice(0, mark);
  const params = Object.fromEntries(new URLSearchParams(mark < 0 ? "" : raw.slice(mark + 1)));
  const [tab = "", view = ""] = path.split("/");
  return { tab, view, params };
}

export function routeHash(tab, view, params) {
  const query = new URLSearchParams(Object.entries(params || {}).filter(([, value]) => value !== "" && value != null)).toString();
  return "#/" + tab + (view ? "/" + view : "") + (query ? "?" + query : "");
}

/** The Runs & logs link that selects one run (and filters the list to its station). */
export function runHref({ station, kind, project, name, run }) {
  return routeHash("runs", "", { station, kind, project, name, run, on: station });
}

// Formatting -------------------------------------------------------------------

export function fmtBytes(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function fmtClock(date) {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function relTime(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} h` + (minutes % 60 ? ` ${minutes % 60} min` : "");
  return `${Math.floor(minutes / 1440)} d`;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A plumber-gui time ("2026-10-10T02:00+02:00") as that machine's wall clock, e.g. "Sat 10 Oct 02:00".
 * The browser's own time zone is never applied.
 */
export function fmtServerTime(iso) {
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)/.exec(iso || "");
  if (!match) return iso || "";
  const [, year, month, day, hour, minute] = match;
  const weekday = DAYS[new Date(Date.UTC(+year, +month - 1, +day)).getUTCDay()];
  return `${weekday} ${+day} ${MONTHS[+month - 1]} ${hour}:${minute}`;
}

/** Milliseconds from now until a plumber-gui time, using the offset it carries. */
export function untilServerTime(iso) {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : at - Date.now();
}

/** A repository URL with any user:password hidden. */
export function maskUrl(url) {
  return String(url || "").replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1•••@");
}

/**
 * Why a name the GUI is about to create would break Plumber, or "" when it is fine: Plumber writes
 * names into TOML with json.dumps, whose escapes for control characters and characters outside the
 * BMP (such as emoji) it can't read back after a restart.
 */
export function screenName(name) {
  for (const char of String(name)) {
    const code = char.codePointAt(0);
    if (code < 32 || code === 127) return "Names can't contain control characters.";
    if (code > 0xffff) return "Names can't contain emoji or other characters outside the Basic Multilingual Plane: Plumber could not read its files back after a restart.";
  }
  return "";
}

/** Offer text as a file download. */
export function saveText(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const anchor = h("a", { href: url, download: filename });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A filename made of safe characters. */
export function safeFilename(...parts) {
  return parts.join("_").replace(/[^A-Za-z0-9._-]+/g, "_");
}

export function plural(count, word, many) {
  return `${count} ${count === 1 ? word : many || word + "s"}`;
}

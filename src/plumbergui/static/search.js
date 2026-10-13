// Search logs: find text in many runs' logs at once. Plumber sends one run's log per request, so
// the panel downloads the logs of the runs the list shows, a few at a time, searches each one the
// way the log viewer does, and keeps only the rows of the records that match, never whole logs.

import { api, append, button, emptyState, field, h, plural, seg, segmented, select, textInput } from "./ui.js";
import { cleanText, filterRecords, matchRanges, parseLog, tailStart } from "./logparse.js";

const MiB = 1024 * 1024;
const KEEP = 4 * MiB; // Characters of a log that are parsed, as in the viewer
const MAX_BYTES = 64 * MiB; // Larger logs are skipped: the viewer asks before reading one
const SHOWN = 5; // Matching records shown per run; the rest are only counted
const PARALLEL = 3; // Logs downloaded at a time
const WARN_ABOVE = 50; // Logs to search above which the panel says what that costs

export const LEVELS = [ // The lowest level searched here, and shown in the log viewer (runs.js)
  { value: "", label: "All", rank: 0 },
  { value: "info", label: "Info+", rank: 20 },
  { value: "warning", label: "Warning+", rank: 30 },
  { value: "error", label: "Error+", rank: 40 },
];
const PER_TARGET = [ // Runs searched of each pipeline and system in the list
  { value: "1", label: "Last run of each" }, { value: "3", label: "Last 3 of each" },
  { value: "10", label: "Last 10 of each" }, { value: "all", label: "All runs" },
];

// Searching --------------------------------------------------------------------

/** The runs to search: the newest perTarget (a count or Infinity) of each group, in list order */
export function searchTargets(groups, perTarget) {
  return groups.flatMap((group) => [...group.runs].sort((a, b) => b.run - a.run).slice(0, perTarget));
}

/**
 * One log searched as the viewer searches it: the records at minRank or above that contain query,
 * ignoring case, in its last KEEP characters. { matches: the first SHOWN, count: all, cut: it was cut }
 */
export function searchLog(text, { query, minRank = 0 }) {
  const cut = tailStart(text, KEEP);
  const found = filterRecords(parseLog(cut ? text.slice(cut) : text).records, { minRank, search: query });
  return { matches: found.slice(0, SHOWN), count: found.length, cut: cut > 0 };
}

/** { text } of one run's log, or { error }: a log over MAX_BYTES is not downloaded (source "size") */
function fetchLog(run, signal) {
  return api("GET", seg`/logs/${run.kind}/${run.station}/${run.project}/${run.name}/${run.run}`, { maxBytes: MAX_BYTES, signal })
    .then((text) => ({ text: typeof text === "string" ? text : "" }), (error) => ({ error }));
}

// Rows, drawn as the viewer draws them -----------------------------------------

/** A record's row class; the log viewer's rows use it too */
export function rankClass(record) {
  if (record.kind === "notice" || record.kind === "output" || record.kind === "progress") return record.kind;
  if (record.rank >= 50) return "critical";
  if (record.rank >= 40) return "error";
  if (record.rank >= 30) return "warning";
  if (record.rank >= 20) return "info";
  return "debug";
}

/** Text with the matches wrapped in <mark>, built from text nodes only; the log viewer's too */
export function highlight(text, query) {
  const clean = cleanText(text);
  if (!query) return [clean];
  const parts = [];
  let at = 0;
  for (const [start, end] of matchRanges(clean, query)) {
    if (start > at) parts.push(clean.slice(at, start));
    parts.push(h("mark", null, clean.slice(start, end)));
    at = end;
  }
  if (at < clean.length) parts.push(clean.slice(at));
  return parts;
}

function recordRow(record, query) {
  if (record.kind === "notice") return h("div", { class: "rec notice" }, h("span", { class: "msg" }, highlight(record.message, query)));
  // A match in a traceback or continuation lines shows those lines, so each row shows why it matched
  const needle = query.toLowerCase();
  const lines = record.extra.filter((line) => line.toLowerCase().includes(needle)).slice(0, SHOWN);
  return h("div", { class: "rec " + rankClass(record) }, [
    h("span", { class: "t", title: record.ts }, record.ts ? record.ts.slice(11) : ""),
    h("span", { class: "lv" }, record.kind === "log" || record.kind === "traceback" ? record.level : ""),
    h("span", { class: "lg" }, cleanText(record.logger || "")),
    h("span", { class: "msg" }, highlight(record.message, query)),
    lines.length ? h("pre", { class: "extra" }, highlight(lines.join("\n"), query)) : null,
  ]);
}

/** One run's matches under a heading, with the button that opens its log in the viewer */
function resultSection(run, found, { query, level }, open) {
  const rows = [];
  let lastDate = null;
  for (const record of found.matches) {
    const date = record.ts ? record.ts.slice(0, 10) : null;
    if (date && date !== lastDate) {
      rows.push(h("div", { class: "log-date" }, date));
      lastDate = date;
    }
    rows.push(recordRow(record, query));
  }
  const more = found.count - found.matches.length;
  return h("section", { class: "search-result" }, [
    h("div", { class: "search-result-head" }, [
      h("h4", null, `${run.station} · ${run.project} / ${run.name} · ${run.kind} · run #${run.run}`),
      found.cut ? h("span", { class: "tag", title: `Only the last ${KEEP / MiB} MiB of this log was searched` }, `last ${KEEP / MiB} MiB`) : null,
      h("span", { class: "muted" }, plural(found.count, "match", "matches")),
      button("Open log", () => open(run, { search: query, level }), "quiet small"),
    ]),
    h("div", { class: "search-hits" }, rows),
    more > 0 ? h("p", { class: "search-more muted" }, `and ${more} more`) : null,
  ]);
}

// Panel ------------------------------------------------------------------------

/**
 * groups: the run list's groups as it shows them, after its filters (groupRuns() output, in list order).
 * open(run, { search, level }): show that run's log in the viewer with this search filled in.
 * signal: aborts everything when the page is left.
 * Returns the panel's root element.
 */
export function logSearch({ groups, open, signal }) {
  if (!groups.length) return h("div", { class: "log-search" }, emptyState("No runs in the list to search", "Change the list's filters."));
  let level = "";
  let current = null; // The running search's AbortController
  const input = textInput("query", { type: "search", placeholder: "Text to find" });
  const levels = segmented(LEVELS, level, (value) => { level = value; }, "Lowest level searched");
  const perTarget = select("runs", PER_TARGET, "1");
  const count = h("p");
  const start = button("Search", search, "primary");
  const cancel = button("Cancel", () => current?.abort(), "quiet small");
  const status = h("span");
  const progress = h("p", { class: "search-progress", hidden: true }, [h("span", { class: "spinner", "aria-hidden": "true" }), status, cancel]);
  const summary = h("div", { class: "search-summary", role: "status" });
  const results = h("div", { class: "search-results" });
  input.addEventListener("input", drawControls);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) search();
  });
  perTarget.addEventListener("change", drawCount);
  drawCount();
  drawControls();
  return h("div", { class: "log-search" }, [
    h("div", { class: "search-form" }, [field("Find", input), field("Level", levels), field("Runs to search", perTarget), start]),
    count, progress, summary, results,
  ]);

  function targets() {
    return searchTargets(groups, perTarget.value === "all" ? Infinity : Number(perTarget.value));
  }

  function drawCount() {
    const total = targets().length;
    count.className = total > WARN_ABOVE ? "search-count warn-text" : "search-count muted";
    count.textContent = `Searches ${plural(total, "log")}` + (total > WARN_ABOVE ? "; each one is downloaded in full" : "");
  }

  function drawControls() {
    for (const control of [input, perTarget, ...levels.children]) control.disabled = Boolean(current);
    start.disabled = Boolean(current) || !input.value.trim();
  }

  async function search() {
    const query = input.value.trim();
    if (current || !query || signal?.aborted) return;
    const runs = targets();
    const job = { query, level, minRank: LEVELS.find((item) => item.value === level).rank }; // As started
    const tally = { done: 0, total: runs.length, searched: 0, matched: 0, matches: 0, skipped: 0, cut: 0, failed: [] };
    const placed = []; // The search order of the sections shown, so each new one goes in its place
    const stop = new AbortController();
    const leave = () => stop.abort();
    signal?.addEventListener("abort", leave);
    current = stop;
    results.replaceChildren();
    summary.replaceChildren();
    progress.hidden = false;
    drawControls();
    drawProgress();
    cancel.focus();

    let next = 0;
    const worker = async () => {
      while (next < runs.length && !stop.signal.aborted) {
        const index = next++;
        const run = runs[index];
        const { text, error } = await fetchLog(run, stop.signal);
        if (stop.signal.aborted) return; // Cancelled, or the page was left: not counted
        tally.done++;
        if (!error) show(run, index, searchLog(text, job));
        else if (error.source === "size") tally.skipped++;
        else tally.failed.push(`${run.station} · ${run.project} / ${run.name} #${run.run}: ${error.message}`);
        drawProgress();
      }
    };
    try {
      await Promise.all(Array.from({ length: PARALLEL }, worker));
    } finally {
      signal?.removeEventListener("abort", leave);
      const refocus = document.activeElement === cancel;
      current = null;
      progress.hidden = true;
      drawControls();
      if (refocus) input.focus();
    }
    if (!signal?.aborted) drawSummary(stop.signal.aborted);

    function show(run, index, found) {
      tally.searched++;
      tally.matches += found.count;
      if (found.cut) tally.cut++;
      if (!found.count) return;
      tally.matched++;
      let at = placed.findIndex((other) => other > index);
      if (at < 0) at = placed.length;
      results.insertBefore(resultSection(run, found, job, open), results.children[at] || null);
      placed.splice(at, 0, index);
    }

    function drawProgress() {
      status.textContent = `Searched ${tally.done} of ${plural(tally.total, "log")} · ${plural(tally.matches, "match", "matches")}`;
    }

    function drawSummary(cancelled) {
      const parts = [];
      if (cancelled) parts.push(`Cancelled after ${tally.done} of ${plural(tally.total, "log")}`);
      if (tally.matched) parts.push(`${plural(tally.matches, "match", "matches")} in ${plural(tally.matched, "log")}`);
      if (tally.searched > tally.matched) parts.push(`No matches in ${tally.searched - tally.matched} of ${plural(tally.searched, "log")}`);
      if (tally.skipped) parts.push(`${plural(tally.skipped, "log")} ${tally.skipped === 1 ? "was" : "were"} over ${MAX_BYTES / MiB} MiB and skipped`);
      if (tally.cut) parts.push(`Only the last ${KEEP / MiB} MiB of ${plural(tally.cut, "log")} was searched`);
      if (tally.failed.length) parts.push(`${plural(tally.failed.length, "log")} could not be read`);
      append(summary, [
        parts.length ? h("p", null, parts.join(". ") + (tally.failed.length ? ":" : ".")) : null,
        tally.failed.length ? h("ul", { class: "error-list" }, tally.failed.map((line) => h("li", null, line))) : null,
      ]);
    }
  }
}

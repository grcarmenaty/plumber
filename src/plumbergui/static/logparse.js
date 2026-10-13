// Log parsing for the plumber-gui log viewer. A run's log is the raw file a ValveStation wrote,
// with the run's stdout and stderr merged: Canonada log lines, project prints, Python tracebacks,
// Canonada's progress bar (it redraws with "\r" and ends its line only when it finishes), and the
// notice ValveStation appends when it stops a run. parseLog turns that text into records the
// viewer can filter, search and colour.
//
// A pure module: no DOM, no imports, and nothing runs at import time, so the browser and node's
// test runner load the same file.

export const RANKS = { DEBUG: 10, INFO: 20, WARNING: 30, WARN: 30, ERROR: 40, CRITICAL: 50, FATAL: 50 };

// Patterns ---------------------------------------------------------------------

const ESCAPES = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g; // ANSI CSI and OSC sequences
const NOTICE = /ValveStation (stopped this run(?: because the project was (?:updated|removed))?|restarted while this run was still going)$/;
// Canonada's "%(asctime)s - %(name)s: [%(levelname)s]: ". The logger name is capped at 200
// characters, so a long line full of timestamps can't make the search quadratic.
const HEADER = /(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d,\d{3}) - (\S.{0,199}?): \[([A-Z]+|Level \d+)\]: ?/;
const TRACEBACK = "Traceback (most recent call last):";
const GROUP = /^\s*\+ Exception Group Traceback \(most recent call last\):$/;
const CHAIN = new Set([
  "During handling of the above exception, another exception occurred:",
  "The above exception was the direct cause of the following exception:",
]);
const MARGIN = /^ +\| ?(.*)$/; // A line inside an exception group, behind its "|" margin
const SEPARATOR = /^\s+\+-/; // "+---- n ----" before each sub-exception of a group, and its end
// "KeyError: 'sensor_42'", "KeyboardInterrupt", or "run.<locals>.SensorError: x" for a local class
const EXCEPTION = /^[A-Za-z_][\w.<>]*(?::|$)/;
// "Pipeline stream: |░░░█████░░░…| ": Canonada draws 30 of "█░", or of "#-" where stdout can't
// encode those. The run is capped so a long one can't overflow the regexp's backtracking stack.
const PROGRESS = /^.+?: \|[█░#\-]{5,500}\| /;
const PY_WARNING = /^\S.*:\d+: [A-Za-z_]*Warning: /;
const UNSAFE = /[\x00-\x08\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g; // Controls but \t and \n, DEL, bidi controls
const END_REASONS = {
  "ValveStation stopped this run": "stopped",
  "ValveStation stopped this run because the project was updated": "stopped: project replaced",
  "ValveStation stopped this run because the project was removed": "stopped: project removed",
  "ValveStation restarted while this run was still going": "station restarted during this run",
};

// Helpers ----------------------------------------------------------------------

/** The rank of a level as written: RANKS, N for "Level N", and INFO's 20 for any other name */
function rankOf(level) {
  return level.startsWith("Level ") ? Number(level.slice(6)) : (RANKS[level] ?? 20);
}

/** The last "\r" segment of a line that is not blank, or "" when all of them are */
function lastSegment(line) {
  for (let end = line.length; end > 0; ) {
    const start = line.lastIndexOf("\r", end - 1) + 1;
    const segment = line.slice(start, end);
    if (segment.trim()) return segment;
    end = start - 1;
  }
  return "";
}

// Parsing ----------------------------------------------------------------------

/**
 * Parse one run's log into { records, progress, counts: { warning, error }, endReason }.
 *
 * progress is the progress bar still being redrawn on the unfinished last line, or null.
 * endReason comes from the last ValveStation notice, or is null when there is none.
 */
export function parseLog(text) {
  const records = [];
  const lines = text.split("\n");
  let open = null; // The log or traceback record that blank and indented lines continue
  let mode = 0; // Traceback mode of the open record: 0 none, 1 traceback, 2 exception group
  let expect = false; // In a group: the next line shaped like an exception line is one, not a note
  let progress = null;

  // A new record closes the open one; a log or traceback record becomes the open one itself
  function add(kind, line, level, rank, message, ts = null, logger = null) {
    const record = { kind, line, ts, logger, level, rank, message, extra: [], summary: null, text: "" };
    records.push(record);
    open = kind === "log" || kind === "traceback" ? record : null;
    mode = 0;
  }

  // One physical line, or the part of it before a notice. live: it is the unfinished last line.
  function read(line, number, live) {
    const header = HEADER.exec(line);
    if (header) {
      // Text before a header is usually the progress bar, which never ends its line
      const before = lastSegment(line.slice(0, header.index));
      if (PROGRESS.test(before)) {
        if (live) progress = before;
      } else if (before) {
        add("output", number, "OUTPUT", 20, before);
      }
      const [match, ts, logger, level] = header;
      add("log", number, level, rankOf(level), line.slice(header.index + match.length), ts, logger);
      return;
    }

    const group = GROUP.test(line);
    if (line === TRACEBACK || group) {
      // A warning or error logged with exc_info owns the traceback printed after it, and a
      // traceback record the next one of its chain. A Python warnings line has no header and never
      // a traceback, so a crash printed right after it is an error of its own.
      if (open && open.rank >= 30 && (open.ts !== null || open.kind === "traceback")) open.extra.push(line);
      else add("traceback", number, "ERROR", 40, line.trim());
      mode = group ? 2 : 1;
      expect = true;
      return;
    }

    const blank = !line.trim();
    const indented = line[0] === " " || line[0] === "\t";
    if (open && CHAIN.has(line) && (mode || open.summary !== null)) {
      open.extra.push(line); // Another exception of the chain follows, in this same record
      mode = 1;
      return;
    }
    if (mode === 1) {
      if (!blank && !indented) {
        open.summary = line; // The exception line ends the traceback; the record stays open for chains
        mode = 0;
      }
      open.extra.push(blank ? "" : line);
      return;
    }
    if (mode === 2) {
      // Every line of an exception group is indented: separators between its sub-exceptions, and
      // their tracebacks and exception lines behind a "|" margin. An exception line is the first
      // line shaped like one after the group's start, a separator or a chain marker (past any
      // frames); the lines after it are its notes or the rest of its message.
      if (blank || indented) {
        const inner = MARGIN.exec(line);
        if (SEPARATOR.test(line) || (inner && CHAIN.has(inner[1]))) {
          expect = true;
        } else if (expect && inner && EXCEPTION.test(inner[1])) {
          open.summary = inner[1];
          expect = false;
        }
        open.extra.push(blank ? "" : line);
        return;
      }
      open = null; // The group is over and this line is something else
      mode = 0;
    }
    if (open && (blank || indented)) {
      open.extra.push(blank ? "" : line);
      return;
    }

    const segment = lastSegment(line);
    if (PROGRESS.test(segment)) {
      if (live) progress = segment;
      else add("progress", number, "PROGRESS", 20, segment);
    } else if (PY_WARNING.test(segment)) {
      add("log", number, "WARNING", 30, segment, null, "py.warnings");
    } else if (segment) {
      add("output", number, "OUTPUT", 20, segment);
    }
  }

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (line.includes("\x1b")) line = line.replace(ESCAPES, "");
    if (line.endsWith("\r")) line = line.slice(0, -1);
    const live = i === lines.length - 1; // The text after the last "\n" is still being written
    const notice = line.includes("ValveStation ") ? NOTICE.exec(line) : null;
    if (!notice) {
      read(line, i + 1, live);
      continue;
    }
    const before = line.slice(0, notice.index);
    if (before.trim()) read(before, i + 1, live); // Usually the progress bar the run was stopped in
    add("notice", i + 1, "NOTICE", 100, notice[0]);
  }

  const counts = { warning: 0, error: 0 };
  let endReason = null;
  for (const record of records) {
    const { extra } = record;
    while (extra.length && !extra[extra.length - 1]) extra.pop();
    const head = record.logger ? `${record.logger} ${record.message}` : record.message;
    record.text = `${head}\n${extra.join("\n")}`.toLowerCase();
    if (record.rank >= 30 && record.rank < 40) counts.warning++;
    else if (record.rank >= 40 && record.rank < 100) counts.error++;
    if (record.kind === "notice") endReason = END_REASONS[record.message];
  }
  return { records, progress, counts, endReason };
}

// Viewing ----------------------------------------------------------------------

/**
 * The records at minRank or above (notices always pass) whose search text contains search,
 * ignoring case. Always a new array.
 */
export function filterRecords(records, { minRank = 0, search = "" } = {}) {
  const needle = search.toLowerCase();
  return records.filter((record) => (record.kind === "notice" || record.rank >= minRank) && (!needle || record.text.includes(needle)));
}

/** [start, end) pairs where query occurs in text, ignoring case, in order and not overlapping */
export function matchRanges(text, query, max = 100) {
  const ranges = [];
  if (!query) return ranges;
  const pattern = new RegExp(query.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"), "gi");
  while (ranges.length < max) {
    const match = pattern.exec(text);
    if (!match) break;
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

/**
 * text with control characters (except \t and \n), DEL and the bidi controls written as
 * <U+XXXX>, so they can't hide or reorder text on screen
 */
export function cleanText(text) {
  return text.replace(UNSAFE, (char) => `<U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}>`);
}

/**
 * Where to cut text so at most maxChars remain: 0 when it all fits, else just after the first
 * line break in the tail. A tail whose only line break is the text's last character is one long
 * line (a progress bar that ran for hours), so it is cut mid-line instead of to nothing.
 */
export function tailStart(text, maxChars) {
  if (text.length <= maxChars) return 0;
  const from = text.length - maxChars;
  const newline = text.indexOf("\n", from);
  return newline === -1 || newline === text.length - 1 ? from : newline + 1;
}

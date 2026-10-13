// Tests for src/plumbergui/static/logparse.js, the log viewer's parser. Run from the repository root:
//   node --test tests/plumbergui/logparse.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

import { RANKS, cleanText, filterRecords, matchRanges, parseLog, tailStart } from "../../src/plumbergui/static/logparse.js";

// Fixtures ---------------------------------------------------------------------
// Built the way Canonada and ValveStation write them: logging.basicConfig's format, tracebacks
// from exc_info, and the progress bar's "\r" + spaces + "\r" + text redraws, which never end a line.

const CORE_FRAME = [
  '  File "/venv/lib/python3.13/site-packages/canonada/pipeline/_core.py", line 364, in _run_pass',
  "    output_data = node.func(*node_inputs)",
];

/** "2026-10-09 16:53:45,793" plus ms milliseconds */
function stamp(ms) {
  return new Date(Date.UTC(2026, 9, 9, 16, 53, 45, 793) + ms).toISOString().slice(0, 23).replace("T", " ").replace(".", ",");
}

/** What Canonada's progress bar shows after `items` items of a stream of unknown length */
function barText(prefix, items) {
  const at = Math.floor((Math.sin(items / 30) / 2 + 0.5) * 26);
  const bar = "░".repeat(at) + "█".repeat(5) + "░".repeat(25 - at);
  const timing = items ? `${(items / 10).toFixed(1)}s | 9.98 items/s | 0.1s/item` : "0ms | N/A | N/A";
  return `${prefix} |${bar}| Items: ${items} | Elapsed: ${timing}`;
}

/** A progress bar's redraws: each blanks the previous text with spaces between two "\r" */
function progressBar(prefix) {
  let previous = 0;
  return (items) => {
    const output = barText(prefix, items);
    const redraw = `\r${" ".repeat(previous)}\r${output}`;
    previous = output.length;
    return redraw;
  };
}

/** The never-ending stream pipeline after `items` items, waiting for the next with its bar drawn */
function streamLog(items) {
  const redraw = progressBar("Pipeline stream:");
  const lines = [
    `${stamp(0)} - canonada: [WARNING]: Output named '_' is never used nor saved.`,
    `${stamp(0)} - canonada: [INFO]: Running pipeline: stream`,
  ];
  for (let item = 0; item < items; item++) {
    const start = redraw(item) + stamp(100 * (item + 1));
    if (item % 20 === 19) {
      lines.push(
        `${start} - canonada: [ERROR]: Error in pipeline stream with key ${item}: sensor glitch at item ${item}`,
        "Traceback (most recent call last):",
        ...CORE_FRAME,
        '  File "/station/projects/demo/pipelines/stream.py", line 11, in tick',
        '    raise ValueError(f"sensor glitch at item {value}")',
        `ValueError: sensor glitch at item ${item}`,
        "",
      );
    } else if (item % 7 === 6) {
      lines.push(`${start} - canonada.demo: [WARNING]: item ${item}: reading drifting`);
    } else {
      lines.push(`${start} - canonada.demo: [INFO]: item ${item}: ok`);
    }
  }
  return lines.join("\n") + "\n" + redraw(items);
}

const CHATTY = [
  "2026-10-09 16:53:39,028 - canonada: [WARNING]: Output named '_' is never used nor saved.",
  "2026-10-09 16:53:39,028 - canonada: [INFO]: Running pipeline: chatty",
  ...[1, 2, 3, 4, 5].map((i) => `2026-10-09 16:53:39,029 - canonada.demo: [INFO]: chatty line ${i} of 5`),
  "2026-10-09 16:53:39,029 - canonada.demo: [WARNING]: chatty: disk usage at 91%",
  "2026-10-09 16:53:39,029 - canonada.demo: [ERROR]: chatty: lookup failed, carrying on",
  "Traceback (most recent call last):",
  '  File "/station/projects/demo/pipelines/chatty.py", line 13, in chat',
  '    {}["sensor_42"]',
  "    ~~^^^^^^^^^^^^^",
  "KeyError: 'sensor_42'",
  "chatty: plain print output",
  "2026-10-09 16:53:39,029 - canonada: [INFO]: Pipeline chatty finished",
  "",
].join("\n");

const BOOM = [
  "2026-10-09 16:53:39,081 - canonada: [WARNING]: Output named '_' is never used nor saved.",
  "2026-10-09 16:53:39,081 - canonada: [INFO]: Running pipeline: boom",
  "2026-10-09 16:53:39,081 - canonada.demo: [INFO]: boom: about to fail",
  "2026-10-09 16:53:39,091 - canonada: [ERROR]: Error in pipeline boom with key (None,): boom: this pipeline always fails",
  "Traceback (most recent call last):",
  ...CORE_FRAME,
  '  File "/station/projects/demo/pipelines/boom.py", line 10, in explode',
  '    raise RuntimeError("boom: this pipeline always fails")',
  "RuntimeError: boom: this pipeline always fails",
  "",
  "2026-10-09 16:53:39,091 - canonada: [ERROR]: boom: this pipeline always fails",
  "",
].join("\n");

// Python 3.13's rendering of an ExceptionGroup with two sub-exceptions, one with its own traceback
const GROUP_LINES = [
  "  + Exception Group Traceback (most recent call last):",
  '  |   File "/station/projects/demo/pipelines/sensors.py", line 23, in read_all',
  "  |     raise_group()",
  "  |     ~~~~~~~~~~~^^",
  '  |   File "/station/projects/demo/pipelines/sensors.py", line 19, in raise_group',
  '  |     raise ExceptionGroup("2 sensors failed", errors)',
  "  | ExceptionGroup: 2 sensors failed (2 sub-exceptions)",
  "  +-+---------------- 1 ----------------",
  "    | Traceback (most recent call last):",
  '    |   File "/station/projects/demo/pipelines/sensors.py", line 11, in bad',
  '    |     raise ValueError("bad reading")',
  "    | ValueError: bad reading",
  "    +---------------- 2 ----------------",
  "    | TypeError: wrong type",
  "    +------------------------------------",
];

// Python 3.13's rendering of a group with a note of its own (add_note), and a nested group whose
// last sub-exception has one
const NOTED_GROUP = [
  "  + Exception Group Traceback (most recent call last):",
  '  |   File "/station/projects/demo/pipelines/sensors.py", line 42, in read_all',
  "  |     raise group",
  "  | ExceptionGroup: 2 sensors failed (2 sub-exceptions)",
  "  | Batch: 7",
  "  +-+---------------- 1 ----------------",
  "    | ValueError: bad reading",
  "    +---------------- 2 ----------------",
  "    | ExceptionGroup: retries failed (2 sub-exceptions)",
  "    +-+---------------- 1 ----------------",
  "      | TimeoutError: sensor_3",
  "      +---------------- 2 ----------------",
  "      | KeyError: 'sensor_9'",
  "      | note: retry",
  "      +------------------------------------",
];

/**
 * Python 3.13's rendering of ExceptionGroup("checks failed", errors), given the lines of each
 * sub-exception it shows; of more than 15 it shows 15 and counts the rest
 */
function groupOf(subs, total = subs.length) {
  const lines = [
    "  + Exception Group Traceback (most recent call last):",
    '  |   File "/station/projects/demo/pipelines/sensors.py", line 30, in check',
    '  |     raise ExceptionGroup("checks failed", errors)',
    `  | ExceptionGroup: checks failed (${total} sub-exception${total === 1 ? "" : "s"})`,
  ];
  subs.forEach((sub, i) => {
    lines.push(i ? `    +---------------- ${i + 1} ----------------` : "  +-+---------------- 1 ----------------");
    lines.push(...sub.map((line) => `    | ${line}`));
  });
  if (total > subs.length) lines.push("    +---------------- ... ----------------", `    | and ${total - subs.length} more exceptions`);
  return [...lines, "    +------------------------------------"];
}

/** kind, level, logger and message of each record, for compact comparisons */
function brief(records) {
  return records.map((record) => [record.kind, record.level, record.logger, record.message]);
}

/** One log line in Canonada's format */
function logLine(level, message, logger = "canonada.demo", ms = 100) {
  return `${stamp(ms)} - ${logger}: [${level}]: ${message}`;
}

// The three demo pipelines ------------------------------------------------------

test("chatty: a finished run with a traceback logged with its error, and a print line", () => {
  const { records, progress, counts, endReason } = parseLog(CHATTY);
  assert.deepEqual(brief(records), [
    ["log", "WARNING", "canonada", "Output named '_' is never used nor saved."],
    ["log", "INFO", "canonada", "Running pipeline: chatty"],
    ...[1, 2, 3, 4, 5].map((i) => ["log", "INFO", "canonada.demo", `chatty line ${i} of 5`]),
    ["log", "WARNING", "canonada.demo", "chatty: disk usage at 91%"],
    ["log", "ERROR", "canonada.demo", "chatty: lookup failed, carrying on"],
    ["output", "OUTPUT", null, "chatty: plain print output"],
    ["log", "INFO", "canonada", "Pipeline chatty finished"],
  ]);
  const traceback = [
    "Traceback (most recent call last):",
    '  File "/station/projects/demo/pipelines/chatty.py", line 13, in chat',
    '    {}["sensor_42"]',
    "    ~~^^^^^^^^^^^^^",
    "KeyError: 'sensor_42'",
  ];
  assert.deepEqual(records[8], {
    kind: "log",
    line: 9,
    ts: "2026-10-09 16:53:39,029",
    logger: "canonada.demo",
    level: "ERROR",
    rank: 40,
    message: "chatty: lookup failed, carrying on",
    extra: traceback,
    summary: "KeyError: 'sensor_42'",
    text: ["canonada.demo chatty: lookup failed, carrying on", ...traceback].join("\n").toLowerCase(),
  });
  assert.deepEqual(records[9], {
    kind: "output",
    line: 15,
    ts: null,
    logger: null,
    level: "OUTPUT",
    rank: 20,
    message: "chatty: plain print output",
    extra: [],
    summary: null,
    text: "chatty: plain print output\n",
  });
  assert.deepEqual(records.map((record) => record.rank), [30, 20, 20, 20, 20, 20, 20, 30, 40, 20, 20]);
  assert.equal(records[10].line, 16);
  assert.deepEqual(counts, { warning: 2, error: 1 });
  assert.equal(progress, null);
  assert.equal(endReason, null);
});

test("boom: Canonada's error with its traceback, then the CLI's final error line", () => {
  const { records, progress, counts, endReason } = parseLog(BOOM);
  assert.deepEqual(brief(records), [
    ["log", "WARNING", "canonada", "Output named '_' is never used nor saved."],
    ["log", "INFO", "canonada", "Running pipeline: boom"],
    ["log", "INFO", "canonada.demo", "boom: about to fail"],
    ["log", "ERROR", "canonada", "Error in pipeline boom with key (None,): boom: this pipeline always fails"],
    ["log", "ERROR", "canonada", "boom: this pipeline always fails"],
  ]);
  const failed = records[3];
  assert.equal(failed.line, 4);
  assert.equal(failed.ts, "2026-10-09 16:53:39,091");
  assert.equal(failed.summary, "RuntimeError: boom: this pipeline always fails");
  assert.equal(failed.extra.length, 6, "the blank line after the exception line is trimmed");
  assert.equal(failed.extra.at(-1), "RuntimeError: boom: this pipeline always fails");
  assert.equal(records[4].line, 12);
  assert.equal(records[4].summary, null);
  assert.deepEqual(counts, { warning: 1, error: 2 });
  assert.equal(progress, null);
  assert.equal(endReason, null);
});

test("stream: headers after progress text, a traceback mid-stream, and the bar left drawn", () => {
  const { records, progress, counts, endReason } = parseLog(streamLog(34));
  assert.equal(records.length, 2 + 34, "progress text before a header makes no record");
  assert.ok(records.every((record) => record.kind === "log"));
  assert.deepEqual(records[2], {
    kind: "log",
    line: 3,
    ts: "2026-10-09 16:53:45,893",
    logger: "canonada.demo",
    level: "INFO",
    rank: 20,
    message: "item 0: ok",
    extra: [],
    summary: null,
    text: "canonada.demo item 0: ok\n",
  });
  const glitch = records.find((record) => record.level === "ERROR");
  assert.equal(glitch.line, 22);
  assert.equal(glitch.logger, "canonada");
  assert.equal(glitch.ts, "2026-10-09 16:53:47,793");
  assert.equal(glitch.message, "Error in pipeline stream with key 19: sensor glitch at item 19");
  assert.deepEqual(glitch.extra, [
    "Traceback (most recent call last):",
    ...CORE_FRAME,
    '  File "/station/projects/demo/pipelines/stream.py", line 11, in tick',
    '    raise ValueError(f"sensor glitch at item {value}")',
    "ValueError: sensor glitch at item 19",
  ]);
  assert.equal(glitch.summary, "ValueError: sensor glitch at item 19");
  const after = records[records.indexOf(glitch) + 1];
  assert.deepEqual([after.line, after.level, after.message], [30, "WARNING", "item 20: reading drifting"]);
  assert.deepEqual(counts, { warning: 5, error: 1 }, "one WARNING from Canonada and items 6, 13, 20 and 27");
  assert.equal(progress, `Pipeline stream: |${"░".repeat(24)}█████░| Items: 34 | Elapsed: 3.4s | 9.98 items/s | 0.1s/item`);
  assert.equal(endReason, null);
});

// Progress, headers and notices --------------------------------------------------

test("a header in the middle of a line, after progress text or a print without a newline", () => {
  const first = `\r\r${barText("Pipeline stream:", 0)}${logLine("INFO", "item 0: ok")}\n`;
  let parsed = parseLog(first);
  assert.deepEqual(brief(parsed.records), [["log", "INFO", "canonada.demo", "item 0: ok"]]);
  assert.equal(parsed.progress, null, "a progress bar on a finished line is not live");

  const live = `\r${" ".repeat(85)}\r${barText("Pipeline stream:", 5)}${logLine("INFO", "item 5: ok")}`;
  parsed = parseLog(first + live);
  assert.deepEqual(parsed.records.map((record) => [record.line, record.message]), [[1, "item 0: ok"], [2, "item 5: ok"]]);
  assert.equal(parsed.progress, barText("Pipeline stream:", 5), "on the unfinished last line it is the live progress");

  parsed = parseLog(`half a print${logLine("WARNING", "next")}\n`);
  assert.deepEqual(brief(parsed.records), [
    ["output", "OUTPUT", null, "half a print"],
    ["log", "WARNING", "canonada.demo", "next"],
  ]);
  assert.deepEqual(parsed.records.map((record) => record.line), [1, 1]);
});

test("a header with no space after its level, and the first of two headers on one line", () => {
  const tight = parseLog(`${stamp(0)} - canonada.demo: [INFO]:no space\n`);
  assert.deepEqual(brief(tight.records), [["log", "INFO", "canonada.demo", "no space"]]);

  const relayed = logLine("ERROR", "sensor_9 offline", "station");
  const twice = parseLog(`${logLine("INFO", "relayed: ")}${relayed}\n`);
  assert.deepEqual(brief(twice.records), [["log", "INFO", "canonada.demo", `relayed: ${relayed}`]]);
  assert.deepEqual(twice.counts, { warning: 0, error: 0 });
});

test("a finished progress bar is a progress record; other redrawn lines keep their last text", () => {
  const prefix = "Pipeline batch:";
  const text = [
    `\r\r${prefix} |░░░░░░░░░░░░░░░░░░░░| 0.0% | 0/2 | Elapsed: 0ms | Remaining: Unknown`
      + `\r${" ".repeat(80)}\r${prefix} |██████████░░░░░░░░░░| 50.0% | 1/2 | Elapsed: 0.1s | Remaining: 0.1s`
      + `\r${" ".repeat(80)}\r${prefix} |████████████████████| 100.0% | 2/2 | Elapsed: 0.2s | Remaining: 0ms`,
    logLine("INFO", "Pipeline batch finished", "canonada"),
    "downloading 10%\rdownloading 100%\r   ",
    "",
  ].join("\n");
  const { records, progress } = parseLog(text);
  assert.deepEqual(brief(records), [
    ["progress", "PROGRESS", null, `${prefix} |████████████████████| 100.0% | 2/2 | Elapsed: 0.2s | Remaining: 0ms`],
    ["log", "INFO", "canonada", "Pipeline batch finished"],
    ["output", "OUTPUT", null, "downloading 100%"],
  ]);
  assert.equal(records[0].rank, 20);
  assert.equal(progress, null);
});

test("the ASCII bar Canonada draws where stdout can't encode █░ is progress too, but not a shorter bar", () => {
  const prefix = "Pipeline batch:";
  const done = `${prefix} |${"#".repeat(30)}| 100.0% | 2/2 | Elapsed: 0.2s | Remaining: 0ms`;
  const live = `Pipeline stream: |${"-".repeat(14)}#####${"-".repeat(11)}| Items: 3 | Elapsed: 0.3s | 9.98 items/s | 0.1s/item`;
  const text = [
    `\r\r${prefix} |${"-".repeat(30)}| 0.0% | 0/2 | Elapsed: 0ms | Remaining: Unknown\r${" ".repeat(80)}\r${done}`,
    "sensor_3: |####| 4 readings",
    `\r\r${live}`,
  ].join("\n");
  const { records, progress } = parseLog(text);
  assert.deepEqual(brief(records), [
    ["progress", "PROGRESS", null, done],
    ["output", "OUTPUT", null, "sensor_3: |####| 4 readings"],
  ]);
  assert.equal(progress, live);
});

test("a long run of bar characters is plain text, not a regexp stack overflow", () => {
  // An unbounded run overflowed V8's regexp backtracking stack past about 5.6 million characters
  for (const char of ["-", "█"]) {
    const line = `Pipeline stream: |${char.repeat(1 << 23)}`;
    const { records, progress } = parseLog(`${line}\n${logLine("INFO", "next")}\n${line}`);
    assert.deepEqual(records.map((record) => [record.kind, record.line]), [["output", 1], ["log", 2], ["output", 3]]);
    assert.equal(progress, null);
  }
});

test("ValveStation's notices, glued to the progress bar, and the end reason of each", () => {
  const reasons = [
    ["ValveStation stopped this run", "stopped"],
    ["ValveStation stopped this run because the project was updated", "stopped: project replaced"],
    ["ValveStation stopped this run because the project was removed", "stopped: project removed"],
    ["ValveStation restarted while this run was still going", "station restarted during this run"],
  ];
  for (const [notice, reason] of reasons) {
    const { records, progress, counts, endReason } = parseLog(`${streamLog(3)}${notice}\n`);
    assert.deepEqual(brief(records.slice(-2)), [
      ["progress", "PROGRESS", null, barText("Pipeline stream:", 3)],
      ["notice", "NOTICE", null, notice],
    ]);
    assert.deepEqual(records.slice(-2).map((record) => [record.line, record.rank, record.ts]), [[6, 20, null], [6, 100, null]]);
    assert.equal(endReason, reason);
    assert.equal(progress, null);
    assert.deepEqual(counts, { warning: 1, error: 0 }, "notices are not counted");
  }

  const twice = parseLog("ValveStation restarted while this run was still going\nValveStation stopped this run\n");
  assert.equal(twice.endReason, "stopped", "the last notice decides");

  const quoted = parseLog(`${logLine("INFO", "ValveStation stopped this run, retrying")}\n`);
  assert.equal(quoted.endReason, null, "a notice has to end its line");
  assert.equal(quoted.records.length, 1);

  const closing = parseLog(`${logLine("ERROR", "failed")}\nValveStation stopped this run\n  indented after the notice\n`);
  assert.deepEqual(brief(closing.records), [
    ["log", "ERROR", "canonada.demo", "failed"],
    ["notice", "NOTICE", null, "ValveStation stopped this run"],
    ["output", "OUTPUT", null, "  indented after the notice"],
  ]);
});

// Line cleanup -------------------------------------------------------------------

test("CRLF line endings, ANSI colours and OSC sequences are stripped", () => {
  const crlf = parseLog(CHATTY.replaceAll("\n", "\r\n"));
  const lf = parseLog(CHATTY);
  assert.deepEqual(crlf, lf);

  const coloured = [
    `\x1b[32m${logLine("INFO", "\x1b[1mgreen\x1b[0m")}\x1b[0m`,
    "\x1b[31mplain red\x1b[0m",
    "\x1b]8;;https://example.com\x07link\x1b]8;;\x07 text",
    "\x1b]0;window title\x1b\\after the title\r",
    `\x1b[33m${logLine("WARNING", "careful")}\x1b[0m\r`,
    "",
  ].join("\n");
  const { records, counts } = parseLog(coloured);
  assert.deepEqual(brief(records), [
    ["log", "INFO", "canonada.demo", "green"],
    ["output", "OUTPUT", null, "plain red"],
    ["output", "OUTPUT", null, "link text"],
    ["output", "OUTPUT", null, "after the title"],
    ["log", "WARNING", "canonada.demo", "careful"],
  ]);
  assert.deepEqual(counts, { warning: 1, error: 0 });
});

// Tracebacks ---------------------------------------------------------------------

test("a traceback after INFO lines is an error record of its own", () => {
  const text = [
    logLine("INFO", "starting"),
    logLine("INFO", "reading"),
    "Traceback (most recent call last):",
    '  File "/station/projects/demo/pipelines/read.py", line 4, in <module>',
    "    main()",
    "KeyboardInterrupt",
    "",
  ].join("\n");
  const { records, counts } = parseLog(text);
  assert.equal(records.length, 3);
  assert.deepEqual(records[1].extra, [], "an INFO record does not take the traceback");
  assert.deepEqual(records[2], {
    kind: "traceback",
    line: 3,
    ts: null,
    logger: null,
    level: "ERROR",
    rank: 40,
    message: "Traceback (most recent call last):",
    extra: ['  File "/station/projects/demo/pipelines/read.py", line 4, in <module>', "    main()", "KeyboardInterrupt"],
    summary: "KeyboardInterrupt",
    text: 'traceback (most recent call last):\n  file "/station/projects/demo/pipelines/read.py", line 4, in <module>\n    main()\nkeyboardinterrupt',
  });
  assert.deepEqual(counts, { warning: 0, error: 1 });

  // A blank line, such as a print landing inside the traceback, is not its exception line
  const gap = parseLog(["Traceback (most recent call last):", "", ...records[2].extra, ""].join("\n"));
  assert.deepEqual(gap.records.map((record) => [record.kind, record.summary]), [["traceback", "KeyboardInterrupt"]]);
  assert.deepEqual(gap.records[0].extra, ["", ...records[2].extra]);
});

test("a traceback logged at WARNING belongs to that record, which stays a warning", () => {
  const traceback = [
    "Traceback (most recent call last):",
    '  File "/station/projects/demo/pipelines/read.py", line 8, in fetch',
    "    return client.get(sensor)",
    "TimeoutError: timed out",
  ];
  const text = [logLine("WARNING", "sensor_3 unreachable, retrying"), ...traceback, logLine("INFO", "sensor_3 read on retry"), ""].join("\n");
  const { records, counts } = parseLog(text);
  assert.deepEqual(brief(records), [
    ["log", "WARNING", "canonada.demo", "sensor_3 unreachable, retrying"],
    ["log", "INFO", "canonada.demo", "sensor_3 read on retry"],
  ]);
  assert.deepEqual(records[0].extra, traceback);
  assert.equal(records[0].summary, "TimeoutError: timed out");
  assert.equal(records[0].rank, 30);
  assert.deepEqual(counts, { warning: 1, error: 0 });
});

test("a crash printed after a Python warnings line is an error record of its own", () => {
  const text = [
    "/station/projects/demo/pipelines/a.py:12: FutureWarning: observed=False is deprecated",
    "  df.groupby('a')",
    "Traceback (most recent call last):",
    '  File "/station/projects/demo/pipelines/a.py", line 13, in run',
    "    time.sleep(1)",
    "KeyboardInterrupt",
    "",
  ].join("\n");
  const { records, counts } = parseLog(text);
  assert.deepEqual(records.map((record) => [record.kind, record.logger, record.level, record.rank, record.line, record.summary]), [
    ["log", "py.warnings", "WARNING", 30, 1, null],
    ["traceback", null, "ERROR", 40, 3, "KeyboardInterrupt"],
  ]);
  assert.deepEqual(records[0].extra, ["  df.groupby('a')"]);
  assert.deepEqual(counts, { warning: 1, error: 1 });
  assert.deepEqual(filterRecords(records, { minRank: 40 }), [records[1]]);
});

test("chained exceptions: the summary is the last exception line", () => {
  const chain = [
    "Traceback (most recent call last):",
    '  File "/station/projects/demo/pipelines/chain.py", line 5, in run',
    '    {}["sensor_42"]',
    "    ~~^^^^^^^^^^^^^",
    "KeyError: 'sensor_42'",
    "",
    "During handling of the above exception, another exception occurred:",
    "",
    "Traceback (most recent call last):",
    '  File "/station/projects/demo/pipelines/chain.py", line 7, in run',
    '    int("x")',
    "ValueError: invalid literal for int() with base 10: 'x'",
    "",
    "The above exception was the direct cause of the following exception:",
    "",
    "Traceback (most recent call last):",
    '  File "/station/projects/demo/pipelines/chain.py", line 9, in run',
    '    raise RuntimeError("sensor 42 unreadable") from e',
    "RuntimeError: sensor 42 unreadable",
  ];
  const logged = parseLog([logLine("ERROR", "lookup chain failed"), ...chain, logLine("INFO", "next"), ""].join("\n"));
  assert.deepEqual(brief(logged.records), [
    ["log", "ERROR", "canonada.demo", "lookup chain failed"],
    ["log", "INFO", "canonada.demo", "next"],
  ]);
  assert.deepEqual(logged.records[0].extra, chain);
  assert.equal(logged.records[0].summary, "RuntimeError: sensor 42 unreadable");

  const printed = parseLog([logLine("INFO", "starting"), ...chain, "after the crash", ""].join("\n"));
  assert.deepEqual(brief(printed.records), [
    ["log", "INFO", "canonada.demo", "starting"],
    ["traceback", "ERROR", null, "Traceback (most recent call last):"],
    ["output", "OUTPUT", null, "after the crash"],
  ]);
  assert.deepEqual(printed.records[1].extra, chain.slice(1));
  assert.equal(printed.records[1].summary, "RuntimeError: sensor 42 unreadable");
  assert.deepEqual(printed.counts, { warning: 0, error: 1 });

  // A chain marker only continues a record that has a traceback
  const marker = "During handling of the above exception, another exception occurred:";
  const plain = parseLog([logLine("ERROR", "lookup failed"), marker, ""].join("\n"));
  assert.deepEqual(brief(plain.records), [
    ["log", "ERROR", "canonada.demo", "lookup failed"],
    ["output", "OUTPUT", null, marker],
  ]);
});

test("an exception group: the summary is its last exception line, and the group ends at the next line", () => {
  const logged = parseLog([logLine("ERROR", "group failed"), ...GROUP_LINES, "after the group", ""].join("\n"));
  assert.deepEqual(brief(logged.records), [
    ["log", "ERROR", "canonada.demo", "group failed"],
    ["output", "OUTPUT", null, "after the group"],
  ]);
  assert.deepEqual(logged.records[0].extra, GROUP_LINES);
  assert.equal(logged.records[0].summary, "TypeError: wrong type");

  const wrapped = [
    "",
    "The above exception was the direct cause of the following exception:",
    "",
    "Traceback (most recent call last):",
    '  File "/station/projects/demo/pipelines/sensors.py", line 32, in run',
    '    raise RuntimeError("wrapped group") from e',
    "RuntimeError: wrapped group",
  ];
  const chained = parseLog([logLine("ERROR", "wrapped"), ...GROUP_LINES, ...wrapped, logLine("INFO", "next"), ""].join("\n"));
  assert.equal(chained.records.length, 2);
  assert.deepEqual(chained.records[0].extra, [...GROUP_LINES, ...wrapped]);
  assert.equal(chained.records[0].summary, "RuntimeError: wrapped group");

  const uncaught = parseLog([logLine("INFO", "starting"), ...GROUP_LINES].join("\n"));
  assert.deepEqual(brief(uncaught.records), [
    ["log", "INFO", "canonada.demo", "starting"],
    ["traceback", "ERROR", null, "+ Exception Group Traceback (most recent call last):"],
  ]);
  assert.deepEqual(uncaught.records[1].extra, GROUP_LINES.slice(1));
  assert.equal(uncaught.records[1].summary, "TypeError: wrong type");
  assert.deepEqual(uncaught.counts, { warning: 0, error: 1 });
});

test("an exception group: notes and message lines after an exception line are not its summary", () => {
  /** The summary of a group logged with an error, checking the whole group went to that record */
  function summaryOf(lines) {
    const { records } = parseLog([logLine("ERROR", "checks failed"), ...lines, logLine("INFO", "next"), ""].join("\n"));
    assert.deepEqual(records.map((record) => record.level), ["ERROR", "INFO"]);
    assert.deepEqual(records[0].extra, lines);
    return records[0].summary;
  }
  assert.equal(summaryOf(groupOf([["ValueError: bad reading", "Hint: check the sensor id"]])), "ValueError: bad reading", "a note");
  assert.equal(summaryOf(groupOf([["ValueError: first line", "Second: line"]])), "ValueError: first line", "a message's next line");
  assert.equal(summaryOf(groupOf([["TypeError: wrong type", "more"]])), "TypeError: wrong type", "a next line like a bare name");
  assert.equal(
    summaryOf(groupOf([["ValueError: a", "A: note"], ["TypeError: b", "B: note one", "  indented: note", "C: note"]])),
    "TypeError: b",
    "an indented note is not a frame",
  );
  assert.equal(
    summaryOf(groupOf([["sensors.check.<locals>.SensorError: sensor_9 offline", "Retry: 3 of 3"]])),
    "sensors.check.<locals>.SensorError: sensor_9 offline",
    "an exception class defined in a function",
  );
  const chained = ["KeyError: 'sensor_9'", "", "During handling of the above exception, another exception occurred:", "", "ValueError: no reading"];
  assert.equal(summaryOf(groupOf([chained])), "ValueError: no reading", "a chained exception without a traceback");
  const wide = Array.from({ length: 15 }, (_, i) => [`ValueError: sensor_${i}`]);
  assert.equal(summaryOf(groupOf(wide, 20)), "ValueError: sensor_14", "the count of sub-exceptions Python does not show");
  assert.equal(summaryOf(NOTED_GROUP), "KeyError: 'sensor_9'", "the group's own note, and a nested group's");

  // A group cut short after its own exception line, the run killed while Python printed it
  const cut = parseLog([logLine("ERROR", "checks failed"), ...groupOf([["ValueError: v"]]).slice(0, 4)].join("\n"));
  assert.equal(cut.records[0].summary, "ExceptionGroup: checks failed (1 sub-exception)");
});

// Continuation -------------------------------------------------------------------

test("blank and indented lines continue the open record; trailing blank lines are trimmed", () => {
  const text = [logLine("INFO", "table follows"), "  col a | col b", "", "\t1 | 2", "   ", "", logLine("INFO", "next"), "", ""].join("\n");
  const { records } = parseLog(text);
  assert.deepEqual(brief(records), [
    ["log", "INFO", "canonada.demo", "table follows"],
    ["log", "INFO", "canonada.demo", "next"],
  ]);
  assert.deepEqual(records[0].extra, ["  col a | col b", "", "\t1 | 2"]);
  assert.equal(records[0].summary, null);
  assert.equal(records[0].text, "canonada.demo table follows\n  col a | col b\n\n\t1 | 2");
  assert.deepEqual(records[1].extra, []);
  assert.equal(records[1].line, 7);
});

test("an output line closes the open record, and takes no continuation itself", () => {
  const text = [logLine("ERROR", "failed"), "  detail", "plain print", "  indented print", "", "another print", ""].join("\n");
  const { records } = parseLog(text);
  assert.deepEqual(brief(records), [
    ["log", "ERROR", "canonada.demo", "failed"],
    ["output", "OUTPUT", null, "plain print"],
    ["output", "OUTPUT", null, "  indented print"],
    ["output", "OUTPUT", null, "another print"],
  ]);
  assert.deepEqual(records[0].extra, ["  detail"]);
  assert.deepEqual(records.map((record) => record.line), [1, 3, 4, 6]);
});

// Levels -------------------------------------------------------------------------

test("a Python warnings line is a WARNING record from py.warnings, with its source line", () => {
  const text = [
    "/venv/lib/python3.13/site-packages/canonada/catalog/_core.py:36: DeprecationWarning: old api",
    '  warnings.warn("old api", DeprecationWarning)',
    "/station/projects/demo/pipelines/stream.py:12: UserWarning: careful",
    "",
  ].join("\n");
  const { records, counts } = parseLog(text);
  assert.deepEqual(records.map((record) => [record.kind, record.logger, record.level, record.rank, record.ts, record.line]), [
    ["log", "py.warnings", "WARNING", 30, null, 1],
    ["log", "py.warnings", "WARNING", 30, null, 3],
  ]);
  assert.equal(records[0].message, "/venv/lib/python3.13/site-packages/canonada/catalog/_core.py:36: DeprecationWarning: old api");
  assert.deepEqual(records[0].extra, ['  warnings.warn("old api", DeprecationWarning)']);
  assert.deepEqual(counts, { warning: 2, error: 0 });

  const indented = "  /station/projects/demo/pipelines/stream.py:12: UserWarning: careful";
  assert.deepEqual(brief(parseLog(`${indented}\n`).records), [["output", "OUTPUT", null, indented]], "a warnings line starts its line");
});

test("custom levels: Level N ranks N, unknown names rank as INFO", () => {
  assert.deepEqual(RANKS, { DEBUG: 10, INFO: 20, WARNING: 30, WARN: 30, ERROR: 40, CRITICAL: 50, FATAL: 50 });
  const levels = ["Level 5", "NOTICE", "DEBUG", "WARN", "Level 45", "CRITICAL", "FATAL", "Level 75"];
  const { records, counts } = parseLog(levels.map((level) => logLine(level, `at ${level}`, "x")).join("\n"));
  assert.deepEqual(records.map((record) => [record.level, record.rank, record.message]), [
    ["Level 5", 5, "at Level 5"],
    ["NOTICE", 20, "at NOTICE"],
    ["DEBUG", 10, "at DEBUG"],
    ["WARN", 30, "at WARN"],
    ["Level 45", 45, "at Level 45"],
    ["CRITICAL", 50, "at CRITICAL"],
    ["FATAL", 50, "at FATAL"],
    ["Level 75", 75, "at Level 75"],
  ]);
  assert.deepEqual(counts, { warning: 1, error: 4 }, "every rank from 40 up to a notice's 100 is an error");
});

// Edges --------------------------------------------------------------------------

test("an empty log has no records", () => {
  const empty = { records: [], progress: null, counts: { warning: 0, error: 0 }, endReason: null };
  assert.deepEqual(parseLog(""), empty);
  assert.deepEqual(parseLog("\n\n"), empty);
});

test("a last line without a newline is still a record", () => {
  const { records, progress } = parseLog(`${logLine("INFO", "a")}\n${logLine("WARNING", "still writing")}`);
  assert.deepEqual(brief(records), [
    ["log", "INFO", "canonada.demo", "a"],
    ["log", "WARNING", "canonada.demo", "still writing"],
  ]);
  assert.equal(records[1].line, 2);
  assert.equal(progress, null);
  assert.deepEqual(brief(parseLog("partial print").records), [["output", "OUTPUT", null, "partial print"]]);
});

// Filtering and display ------------------------------------------------------------

test("filterRecords: minimum rank, search, and notices past the level filter", () => {
  const text = [
    logLine("DEBUG", "probe sensor_7"),
    logLine("INFO", "reading SENSOR_42"),
    logLine("WARNING", "drifting"),
    logLine("ERROR", "lookup failed", "canonada"),
    "Traceback (most recent call last):",
    '  File "/station/projects/demo/pipelines/chatty.py", line 13, in chat',
    "KeyError: 'sensor_42'",
    "plain print",
    "ValveStation stopped this run",
    "",
  ].join("\n");
  const { records } = parseLog(text);
  const messages = (list) => list.map((record) => record.message);

  const all = filterRecords(records);
  assert.deepEqual(all, records);
  assert.notEqual(all, records, "a new array");
  assert.deepEqual(messages(filterRecords(records, { minRank: 30 })), ["drifting", "lookup failed", "ValveStation stopped this run"]);
  assert.deepEqual(messages(filterRecords(records, { minRank: 1000 })), ["ValveStation stopped this run"]);
  assert.deepEqual(messages(filterRecords(records, { search: "Sensor_42" })), ["reading SENSOR_42", "lookup failed"], "message or traceback, any case");
  assert.deepEqual(messages(filterRecords(records, { search: "canonada.demo", minRank: 20 })), ["reading SENSOR_42", "drifting"], "the logger is searched");
  assert.deepEqual(messages(filterRecords(records, { minRank: 30, search: "sensor" })), ["lookup failed"], "a notice still has to match the search");
  assert.deepEqual(messages(filterRecords(records, { search: "stopped" })), ["ValveStation stopped this run"]);
});

test("matchRanges: case-insensitive, in order, not overlapping, capped", () => {
  assert.deepEqual(matchRanges("Error error ERROR", "error"), [[0, 5], [6, 11], [12, 17]]);
  assert.deepEqual(matchRanges("aaaa", "aa"), [[0, 2], [2, 4]]);
  assert.deepEqual(matchRanges("aaaaa", "A", 3), [[0, 1], [1, 2], [2, 3]]);
  assert.equal(matchRanges("a".repeat(150), "a").length, 100);
  assert.deepEqual(matchRanges("anything", ""), []);
  assert.deepEqual(matchRanges("nothing here", "sensor"), []);
  assert.deepEqual(matchRanges("a.b (x) [y]", "."), [[1, 2]], "regex characters are literal");
  assert.deepEqual(matchRanges("cost $5 (est.)", "(EST.)"), [[8, 14]]);
});

test("cleanText: control and bidi characters become <U+XXXX>; tabs and newlines stay", () => {
  assert.equal(cleanText("a\x00b\x07c\x1b[31md\x7fe"), "a<U+0000>b<U+0007>c<U+001B>[31md<U+007F>e");
  assert.equal(cleanText("a\rb\x08c\x1f"), "a<U+000D>b<U+0008>c<U+001F>");
  assert.equal(cleanText("\x0b\x0c"), "<U+000B><U+000C>", "vertical tab and form feed");
  assert.equal(cleanText("evil\u202Etxt.exe \u202A\u202C\u2066x\u2067\u2068\u2069"), "evil<U+202E>txt.exe <U+202A><U+202C><U+2066>x<U+2067><U+2068><U+2069>");
  assert.equal(cleanText("col\tcol"), "col\tcol");
  assert.equal(cleanText("line 1\nline 2"), "line 1\nline 2");
  assert.equal(cleanText("|░░█████| é 日本 ✓"), "|░░█████| é 日本 ✓");
  assert.equal(cleanText(""), "");
});

test("tailStart: whole text, cut after a newline, or mid-line when the tail has none", () => {
  assert.equal(tailStart("short", 10), 0);
  assert.equal(tailStart("exact", 5), 0);
  const text = "aaaa\nbbbb\ncccc\n";
  assert.equal(tailStart(text, 7), 10);
  assert.equal(text.slice(tailStart(text, 7)), "cccc\n");
  assert.equal(tailStart(text, 6), 10, "a newline right at the cut");
  assert.equal(tailStart("aaaa\nbbbbbbbb", 5), 8, "no newline in the tail");
  const oneLine = "\r ".repeat(50) + "ValveStation stopped this run\n";
  assert.equal(tailStart(oneLine, 40), oneLine.length - 40, "a tail whose only newline is the last character");
});

// Performance --------------------------------------------------------------------

test("performance: 200,000 lines of mixed records parse in under a second", (t) => {
  // 100 different 10-line blocks, repeated: building the text line by line would leave enough
  // garbage behind that V8's first full GC, landing inside the timed parse, would be measured too
  const redraw = `\r${" ".repeat(90)}\r${barText("Pipeline stream:", 7)}`;
  const blocks = [];
  for (let i = 0; i < 100; i++) {
    blocks.push(
      `${redraw}${logLine("INFO", `item ${i}: ok`, "canonada.demo", i)}`,
      logLine("DEBUG", `detail ${i}`, "canonada.demo", i),
      logLine("WARNING", `item ${i}: reading drifting`, "canonada.demo", i),
      logLine("ERROR", `Error in pipeline stream with key ${i}: sensor glitch`, "canonada", i),
      "Traceback (most recent call last):",
      ...CORE_FRAME,
      `ValueError: sensor glitch at item ${i}`,
      `plain print ${i}`,
      "",
    );
  }
  const text = `${blocks.join("\n")}\n`.repeat(200);
  assert.equal(text.split("\n").length - 1, 200000);
  const started = performance.now();
  const { records, counts } = parseLog(text);
  const elapsed = performance.now() - started;
  t.diagnostic(`parsed ${text.length} characters in ${Math.round(elapsed)} ms`);
  assert.equal(records.length, 100000);
  assert.deepEqual(counts, { warning: 20000, error: 20000 });
  assert.ok(elapsed < 1000, `parsing took ${Math.round(elapsed)} ms`);
});

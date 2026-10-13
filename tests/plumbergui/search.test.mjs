// Tests for the pure parts of src/plumbergui/static/search.js, the Search logs panel. Run from the
// repository root:
//   node --test tests/plumbergui/search.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

import { searchLog, searchTargets } from "../../src/plumbergui/static/search.js";

const KEEP = 4 * 1024 * 1024;

function group(station, kind, name, numbers) {
  const runs = numbers.map((run) => ({ station, kind, project: "demo", name, run, status: "finished" }));
  return { key: JSON.stringify([station, kind, "demo", name]), station, kind, project: "demo", name, runs };
}

function line(level, logger, message, second = 39) {
  return `2026-10-09 16:53:${second},028 - ${logger}: [${level}]: ${message}`;
}

const LOG = [
  line("INFO", "canonada", "Running pipeline: chatty"),
  line("WARNING", "canonada.demo", "chatty: disk usage at 91%"),
  line("ERROR", "canonada.demo", "chatty: lookup failed, carrying on"),
  "Traceback (most recent call last):",
  '  File "/x/pipelines/chatty.py", line 13, in chat',
  '    {}["sensor_42"]',
  "KeyError: 'sensor_42'",
  "chatty: plain print output",
  "ValveStation stopped this run",
  "",
].join("\n");

test("targets follow the list's order of groups, newest run first, up to perTarget each", () => {
  const groups = [group("lab", "pipeline", "stream", [5, 4, 3, 2, 1]), group("bench", "system", "nightly", [2, 7]), group("lab", "pipeline", "chatty", [1])];
  const pick = (perTarget) => searchTargets(groups, perTarget).map((run) => `${run.name}#${run.run}`);
  assert.deepEqual(pick(1), ["stream#5", "nightly#7", "chatty#1"]);
  assert.deepEqual(pick(3), ["stream#5", "stream#4", "stream#3", "nightly#7", "nightly#2", "chatty#1"]);
  assert.deepEqual(pick(Infinity), ["stream#5", "stream#4", "stream#3", "stream#2", "stream#1", "nightly#7", "nightly#2", "chatty#1"]);
  assert.equal(searchTargets(groups, 1)[1], groups[1].runs[1]); // The list's own run objects, for open()
  assert.deepEqual(groups[1].runs.map((run) => run.run), [2, 7]); // and the list is left as it was
  assert.deepEqual(searchTargets([], 3), []);
});

test("a log is searched as the viewer searches it: any case, inside tracebacks, from a level up", () => {
  const all = searchLog(LOG, { query: "CHATTY", minRank: 0 });
  assert.equal(all.count, 4);
  assert.deepEqual(all.matches.map((record) => record.level), ["INFO", "WARNING", "ERROR", "OUTPUT"]);
  assert.equal(all.cut, false);
  assert.equal(searchLog(LOG, { query: "chatty", minRank: 30 }).count, 2);
  const traced = searchLog(LOG, { query: "sensor_42", minRank: 40 });
  assert.deepEqual(traced.matches.map((record) => record.message), ["chatty: lookup failed, carrying on"]);
  // ValveStation's notices pass any level, but must contain the text too
  assert.deepEqual(searchLog(LOG, { query: "stopped this", minRank: 40 }).matches.map((record) => record.kind), ["notice"]);
  assert.equal(searchLog(LOG, { query: "not in there", minRank: 0 }).count, 0);
  assert.deepEqual(searchLog("", { query: "x", minRank: 0 }), { matches: [], count: 0, cut: false });
});

test("only the first five matches are kept, and every match is counted", () => {
  const log = Array.from({ length: 12 }, (_, i) => line("INFO", "canonada.demo", `item ${i}: sensor ok`, 10 + i)).join("\n") + "\n";
  const found = searchLog(log, { query: "sensor", minRank: 0 });
  assert.equal(found.count, 12);
  assert.deepEqual(found.matches.map((record) => record.message), [0, 1, 2, 3, 4].map((i) => `item ${i}: sensor ok`));
});

test("only the last 4 MiB of a long log is searched, and the result says so", () => {
  const filler = ("x".repeat(9999) + "\n").repeat(Math.ceil(KEEP / 10000));
  const log = line("ERROR", "canonada", "early needle") + "\n" + filler + line("ERROR", "canonada", "late needle") + "\n";
  const found = searchLog(log, { query: "needle", minRank: 0 });
  assert.equal(found.cut, true);
  assert.deepEqual(found.matches.map((record) => record.message), ["late needle"]);
  assert.equal(searchLog("y".repeat(KEEP), { query: "y", minRank: 0 }).cut, false); // Exactly 4 MiB is whole
});

// Tests of the browser modules' pure parts (routes, names, formatting, run grouping) and of the
// front-end rules every module must follow. Run with:
//   node --test tests/plumbergui/ui.test.mjs

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

import {
  baseOf, fmtBytes, fmtServerTime, maskUrl, parseRoute, projectTree, routeHash, runHref, safeFilename, screenName, seg,
} from "../../src/plumbergui/static/ui.js";
import { groupRuns, normalizeRuns, runningOn } from "../../src/plumbergui/static/runs.js";

const STATIC = new URL("../../src/plumbergui/static/", import.meta.url);

test("routes round-trip names that look like paths or need encoding", () => {
  const params = { project: "vault", name: "a b/c&d%e", station: "plänt" };
  const hash = routeHash("pipelines", "schedules", params);
  assert.equal(hash.startsWith("#/pipelines/schedules?"), true);
  assert.deepEqual(parseRoute(hash), { tab: "pipelines", view: "schedules", params });
});

test("empty parameters are left out and an empty hash parses", () => {
  assert.equal(routeHash("runs", "", { station: "", status: null, filter: undefined }), "#/runs");
  assert.deepEqual(parseRoute(""), { tab: "", view: "", params: {} });
  assert.deepEqual(parseRoute("#/"), { tab: "", view: "", params: {} });
  assert.deepEqual(parseRoute("#/projects"), { tab: "projects", view: "", params: {} });
});

test("a run link selects the run and filters the list to its station", () => {
  const route = parseRoute(runHref({ station: "lab", kind: "pipeline", project: "demo", name: "chatty", run: 7 }));
  assert.deepEqual(route, { tab: "runs", view: "", params: { station: "lab", kind: "pipeline", project: "demo", name: "chatty", run: "7", on: "lab" } });
});

test("seg encodes every interpolated path segment", () => {
  assert.equal(seg`/run/pipeline/${"lab/x"}/${"a b"}/${7}`, "/run/pipeline/lab%2Fx/a%20b/7");
  assert.equal(seg`/vault/${"credentials"}/${"..%2f"}`, "/vault/credentials/..%252f");
});

test("repository credentials are masked", () => {
  assert.equal(maskUrl("https://user:token@git.example.com/g/p.git"), "https://•••@git.example.com/g/p.git");
  assert.equal(maskUrl("git@git.example.com:g/p.git"), "git@git.example.com:g/p.git");
  assert.equal(maskUrl("https://git.example.com/g/p.git"), "https://git.example.com/g/p.git");
});

test("names Plumber can't read back are refused", () => {
  assert.equal(screenName("plant-3"), "");
  assert.equal(screenName("plänt Ω"), "");
  assert.match(screenName("bad\u0001name"), /control/);
  assert.match(screenName("del\u007f"), /control/);
  assert.match(screenName("rocket🚀"), /emoji/);
});

test("server times keep the server's wall clock", () => {
  assert.equal(fmtServerTime("2026-10-10T02:00+02:00"), "Sat 10 Oct 02:00");
  assert.equal(fmtServerTime("2028-02-29T23:59+01:00"), "Tue 29 Feb 23:59");
  assert.equal(fmtServerTime("not a time"), "not a time");
});

test("formatting helpers", () => {
  assert.equal(fmtBytes(512), "512 B");
  assert.equal(fmtBytes(2.1 * 1024 * 1024), "2.1 MB");
  assert.equal(fmtBytes(70 * 1024 * 1024), "70 MB");
  assert.equal(safeFilename("lab", "demo", "pipeline-chatty", "run7"), "lab_demo_pipeline-chatty_run7");
  assert.equal(safeFilename("a b", "c/d"), "a_b_c_d");
});

test("projects and their variants", () => {
  const list = [{ name: "demo" }, { name: "demo-fast", base: "demo", catalog: "fast" }, { name: "pump" }, { name: "demo-lab", base: "demo" }];
  assert.deepEqual(projectTree(list).map((node) => [node.base.name, node.variants.map((v) => v.name)]), [["demo", ["demo-fast", "demo-lab"]], ["pump", []]]);
  assert.equal(baseOf("demo-fast", list), "demo");
  assert.equal(baseOf("demo", list), "demo");
  assert.equal(baseOf("unknown", list), "unknown");
});

const PIPELINES = [
  { station: "lab", runs: [
    { project: "demo", pipeline: "chatty", run: 1, status: "finished" },
    { project: "demo", pipeline: "chatty", run: 2, status: "errored" },
    { project: "demo", pipeline: "stream", run: 1, status: "running" },
    { project: "demo", pipeline: "stream", run: 2, status: "running" },
  ] },
  { station: "plant", error: "Station 'plant' did not respond" },
  { station: "bench", runs: [{ project: "__proto__", pipeline: "constructor", run: 1, status: "finished" }] },
];
const SYSTEMS = [
  { station: "lab", runs: [{ project: "demo", system: "nightly", run: 3, status: "finished" }] },
  { station: "plant", error: "Station 'plant' did not respond" },
  { station: "bench", runs: [] },
];

test("run lists are merged, and a failing station is listed once", () => {
  const { runs, errors } = normalizeRuns(PIPELINES, SYSTEMS);
  assert.equal(runs.length, 6);
  assert.deepEqual(runs.find((run) => run.kind === "system"), { station: "lab", kind: "system", project: "demo", name: "nightly", run: 3, status: "finished" });
  assert.deepEqual(errors, [{ station: "plant", error: "Station 'plant' did not respond" }]);
  assert.deepEqual(normalizeRuns(null, undefined), { runs: [], errors: [] });
});

test("runs are grouped per station and target, running first", () => {
  const groups = groupRuns(normalizeRuns(PIPELINES, SYSTEMS).runs);
  assert.deepEqual(groups.map((group) => [group.state, group.station, group.name]), [
    ["running", "lab", "stream"],
    ["errored", "lab", "chatty"],
    ["finished", "bench", "constructor"],
    ["finished", "lab", "nightly"],
  ]);
  const stream = groups[0];
  assert.deepEqual(stream.runs.map((run) => run.run), [2, 1]);
  assert.equal(stream.latest.run, 2);
  assert.equal(stream.running.length, 2);
  const chatty = groups[1];
  assert.equal(chatty.latest.run, 2);
});

test("running runs of a project on a station", () => {
  const { runs } = normalizeRuns(PIPELINES, SYSTEMS);
  assert.deepEqual(runningOn(runs, "lab", "demo").map((run) => run.run), [1, 2]);
  assert.deepEqual(runningOn(runs, "bench", "demo"), []);
});

test("front-end rules: no HTML sinks, no inline styles, no inline scripts", () => {
  const files = readdirSync(STATIC).filter((name) => name.endsWith(".js") || name.endsWith(".html"));
  assert.ok(files.includes("app.js") && files.includes("index.html"));
  for (const name of files) {
    const text = readFileSync(new URL(name, STATIC), "utf8").replace(/\/\/.*$/gm, "");
    for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", ".style.", "setAttribute(\"style\"", "style="]) {
      if (name === "ui.js" && sink === "innerHTML") continue; // h() refuses the prop by name
      assert.equal(text.includes(sink), false, `${name} uses ${sink}`);
    }
    if (name.endsWith(".html")) {
      assert.equal(/<script(?![^>]*\bsrc=)/i.test(text), false, `${name} has an inline script`);
      assert.equal(/<style/i.test(text), false, `${name} has an inline style`);
      assert.equal(/\son[a-z]+=/i.test(text), false, `${name} has an inline handler`);
    }
  }
});

test("every static file is served by main.py's FILES map", () => {
  const main = readFileSync(new URL("../main.py", STATIC), "utf8");
  for (const name of readdirSync(STATIC)) {
    assert.ok(main.includes(`"/${name}": ("${name}"`), `${name} is missing from FILES`);
  }
});

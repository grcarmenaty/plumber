// Tests of the pipeline graphs' model and layout (graph.js). Run with:
//   node --test tests/plumbergui/graph.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

import { graphModel, layout, placeRow, routePath, spreadLabels } from "../../src/plumbergui/static/graph.js";

// The pipeline of Canonada's simple example
const SIGNALS = [
  { name: "create_offsets", description: "Adds parametrized offset to the signals", input: ["raw_signals", "params:section_1.offset"], output: ["offset_signals"] },
  { name: "save_offsets", description: "", input: ["offset_signals"], output: ["offset_signals_catalog"] },
  { name: "get_signal_max", description: "", input: ["offset_signals"], output: ["max_values"] },
  { name: "calculate_mean", description: "", input: ["offset_signals"], output: ["mean_values"] },
  { name: "list_stats", description: "", input: ["offset_signals", "max_values", "mean_values"], output: ["stats"] },
];

function laidOut(nodes, size = () => ({ width: 120, height: 40 })) {
  const { items, edges } = graphModel(nodes);
  const ids = items.map((item) => item.id);
  return { items, edges, placed: layout(ids, new Map(ids.map((id) => [id, size(id)])), edges) };
}

test("the model: sources, sinks, and data between nodes on the edges, as Canonada draws them", () => {
  const { items, edges } = graphModel(SIGNALS);
  assert.deepEqual(items.filter((item) => item.kind !== "node"), [
    { id: "d0", kind: "source", name: "raw_signals" },
    { id: "d1", kind: "sink", name: "offset_signals_catalog" },
    { id: "d2", kind: "sink", name: "stats" },
  ]);
  assert.deepEqual(edges, [
    { from: "d0", to: "n0", labels: ["raw_signals"] },
    { from: "n0", to: "n1", labels: ["offset_signals"] },
    { from: "n0", to: "n2", labels: ["offset_signals"] },
    { from: "n0", to: "n3", labels: ["offset_signals"] },
    { from: "n0", to: "n4", labels: ["offset_signals"] },
    { from: "n1", to: "d1", labels: [] },
    { from: "n2", to: "n4", labels: ["max_values"] },
    { from: "n3", to: "n4", labels: ["mean_values"] },
    { from: "n4", to: "d2", labels: [] },
  ]);
});

test("the model: params stay in the box, two data between the same nodes share an edge, one source per name", () => {
  const { items, edges } = graphModel([
    { name: "a", input: ["params:x", "raw"], output: ["p", "q"] },
    { name: "b", input: ["p", "q", "raw"], output: [] },
  ]);
  assert.deepEqual(items.filter((item) => item.kind === "source").map((item) => item.name), ["raw"]);
  assert.deepEqual(edges, [
    { from: "d0", to: "n0", labels: ["raw"] },
    { from: "n0", to: "n1", labels: ["p", "q"] },
    { from: "d0", to: "n1", labels: ["raw"] },
  ]);
  // A node that only reads params and writes data nobody reads, like the devstack demo's
  const alone = graphModel([{ name: "chat", input: ["params:chatty.lines"], output: ["_"] }]);
  assert.deepEqual(alone.edges, [{ from: "n0", to: "d0", labels: [] }]);
  assert.equal(alone.items[1].kind, "sink");
});

test("the layout: one rank per step down, sources just above what they feed, no overlaps, edges from bottom to top", () => {
  const { edges, placed } = laidOut(SIGNALS);
  const y = (id) => placed.boxes.get(id).y;
  assert.ok(y("d0") < y("n0") && y("n0") < y("n1"));
  assert.equal(y("n1"), y("n2"));
  assert.equal(y("n2"), y("n3"));
  assert.ok(y("n3") < y("n4") && y("n4") < y("d2"));
  assert.equal(y("d1"), y("n4")); // save_offsets' sink sits next to list_stats
  const rows = new Map();
  for (const [id, box] of placed.boxes) rows.set(box.y, [...(rows.get(box.y) || []), { id, ...box }]);
  for (const row of rows.values()) {
    row.sort((a, b) => a.x - b.x);
    for (let i = 1; i < row.length; i++) assert.ok(row[i].x >= row[i - 1].x + row[i - 1].width, `${row[i - 1].id} and ${row[i].id} overlap`);
  }
  for (const box of placed.boxes.values()) {
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= placed.width && box.y + box.height <= placed.height);
  }
  placed.routes.forEach((points, e) => {
    const from = placed.boxes.get(edges[e].from);
    const to = placed.boxes.get(edges[e].to);
    assert.equal(points[0].y, from.y + from.height);
    assert.equal(points.at(-1).y, to.y);
  });
  // create_offsets -> list_stats skips a rank: it runs straight down past that rank's boxes
  const long = placed.routes[edges.findIndex((edge) => edge.from === "n0" && edge.to === "n4")];
  assert.equal(long.length, 4);
  assert.equal(long[1].x, long[2].x);
  assert.equal(long[1].y, y("n1"));
});

test("the layout: the order within ranks takes crossings out", () => {
  // a feeds the second node and b the first: drawn in that order the two edges would cross
  const nodes = [
    { name: "a", input: [], output: ["for_d"] },
    { name: "b", input: [], output: ["for_c"] },
    { name: "c", input: ["for_c"], output: [] },
    { name: "d", input: ["for_d"], output: [] },
  ];
  const { placed } = laidOut(nodes);
  const x = (id) => placed.boxes.get(id).x;
  assert.equal(Math.sign(x("n0") - x("n1")), Math.sign(x("n3") - x("n2")));
});

test("the layout: a cycle still ends, and a node is centred over what it feeds", () => {
  const cycle = laidOut([{ name: "a", input: ["y"], output: ["x"] }, { name: "b", input: ["x"], output: ["y"] }]);
  assert.equal(cycle.placed.boxes.size, 2);
  const { placed } = laidOut([
    { name: "top", input: [], output: ["v"] },
    { name: "left", input: ["v"], output: [] },
    { name: "right", input: ["v"], output: [] },
  ]);
  const centre = (id) => placed.boxes.get(id).x + placed.boxes.get(id).width / 2;
  assert.ok(Math.abs(centre("n0") - (centre("n1") + centre("n2")) / 2) < 1);
});

test("routePath bends vertically through each point", () => {
  assert.equal(routePath([{ x: 10, y: 0 }, { x: 30, y: 40 }]), "M10,0 C10,20 30,20 30,40");
  assert.equal(routePath([{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 5, y: 30 }]), "M0,0 C0,5 0,5 0,10 C0,20 5,20 5,30");
});

test("placeRow keeps the gaps and stays as close as it can to where each box wants to be", () => {
  assert.deepEqual(placeRow([100, 100], [0, 300]), [0, 300]); // Already apart
  assert.deepEqual(placeRow([100, 100, 100], [50, 50, 50]), [-78, 50, 178]); // All want the middle: spread around it
  assert.deepEqual(placeRow([40], [7]), [7]);
  assert.deepEqual(placeRow([], []), []);
});

test("spreadLabels moves a label off the ones placed before it, and leaves lone ones alone", () => {
  const spots = spreadLabels([
    { x: 100, y: 50, width: 80, height: 14 },
    null,
    { x: 130, y: 50, width: 80, height: 14 },
    { x: 400, y: 50, width: 80, height: 14 },
  ]);
  assert.deepEqual(spots[0], { x: 100, y: 50, width: 80, height: 14 });
  assert.equal(spots[1], null);
  assert.equal(spots[2].y, 66); // One step down
  assert.deepEqual(spots[3], { x: 400, y: 50, width: 80, height: 14 });
});

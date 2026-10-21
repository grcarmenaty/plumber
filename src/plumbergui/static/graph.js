// Pipeline graphs, drawn the way Canonada's view draws them, from the nodes' inputs and outputs alone: a node is
// a box with its name, description, inputs and outputs; data no node of the pipeline produces is a source (an
// orange ellipse), data no node uses is a sink (a green ellipse), and data passed from node to node labels the
// edge. A small layered layout runs top to bottom. Boxes are HTML in SVG foreignObjects and edges SVG paths:
// positions are SVG attributes, as the page allows no inline styles.

import { h } from "./ui.js";

const SVG = "http://www.w3.org/2000/svg";
const GAP = 28; // Pixels between neighbours in a rank
const RANK_GAP = 64; // Pixels between ranks, room for an edge label
const MARGIN = 12;
const SWEEPS = 12; // Ordering passes that reduce crossings

/**
 * The graph of a pipeline's nodes ({ name, description, input, output }): { items, edges }. An item is
 * { id, kind: "node", node } or { id, kind: "source" | "sink", name }; an edge is { from, to, labels }, one per
 * pair, with the names of the data it carries (none from a node to its sink, as Canonada draws it).
 */
export function graphModel(nodes) {
  const items = nodes.map((node, i) => ({ id: `n${i}`, kind: "node", node }));
  const producers = new Map();
  nodes.forEach((node, i) => {
    for (const output of node.output || []) producers.set(output, [...(producers.get(output) || []), i]);
  });
  const datasets = new Map();
  const dataset = (kind, name) => {
    const key = kind + ":" + name;
    if (!datasets.has(key)) {
      const item = { id: `d${datasets.size}`, kind, name };
      datasets.set(key, item);
      items.push(item);
    }
    return datasets.get(key).id;
  };
  const edges = [];
  const pairs = new Map();
  const edge = (from, to, label) => {
    const key = from + ">" + to;
    if (!pairs.has(key)) {
      const added = { from, to, labels: [] };
      pairs.set(key, added);
      edges.push(added);
    }
    const labels = pairs.get(key).labels;
    if (label !== null && !labels.includes(label)) labels.push(label);
  };
  nodes.forEach((node, i) => {
    for (const input of node.input || []) {
      if (input.startsWith("params:")) continue; // Shown in the box, as Canonada does
      if (!(producers.get(input) || []).some((j) => j !== i)) edge(dataset("source", input), `n${i}`, input);
    }
    for (const output of node.output || []) {
      const users = nodes.map((_, j) => j).filter((j) => j !== i && (nodes[j].input || []).includes(output));
      for (const j of users) edge(`n${i}`, `n${j}`, output);
      if (!users.length) edge(`n${i}`, dataset("sink", output), null);
    }
  });
  return { items, edges };
}

/**
 * Lay out a graph top to bottom. sizes: Map id -> { width, height }; edges: [{ from, to }]. Returns
 * { width, height, boxes: Map id -> { x, y, width, height }, routes: [[{ x, y }, …] per edge] }, each route
 * from the bottom of its edge's start to the top of its end, straight down through each rank it crosses.
 */
export function layout(ids, sizes, edges) {
  // Ranks: the longest path from a start, then starts pulled down next to what they feed
  const next = new Map(ids.map((id) => [id, []]));
  const prev = new Map(ids.map((id) => [id, []]));
  for (const { from, to } of edges) {
    next.get(from).push(to);
    prev.get(to).push(from);
  }
  const rank = new Map();
  const waiting = new Map(ids.map((id) => [id, prev.get(id).length]));
  const ready = ids.filter((id) => !waiting.get(id));
  for (let i = 0; i < ready.length; i++) {
    const id = ready[i];
    rank.set(id, Math.max(0, ...prev.get(id).map((p) => rank.get(p) + 1)));
    for (const n of next.get(id)) {
      waiting.set(n, waiting.get(n) - 1);
      if (!waiting.get(n)) ready.push(n);
    }
  }
  for (const id of ids) if (!rank.has(id)) rank.set(id, Math.max(0, ...[...rank.values()].map((r) => r + 1))); // A cycle: below the rest
  for (const id of ids) {
    if (!prev.get(id).length && next.get(id).length) rank.set(id, Math.max(rank.get(id), Math.min(...next.get(id).map((n) => rank.get(n))) - 1));
  }
  const used = [...new Set(rank.values())].sort((a, b) => a - b); // Without the ranks pulling down emptied
  for (const id of ids) rank.set(id, used.indexOf(rank.get(id)));

  // Long edges go through a point in each rank they cross, so the ordering keeps them clear of boxes
  const ranks = [];
  const place = (id, r) => {
    while (ranks.length <= r) ranks.push([]);
    ranks[r].push(id);
  };
  for (const id of ids) place(id, rank.get(id));
  const chains = edges.map(({ from, to }, e) => {
    const chain = [from];
    for (let r = rank.get(from) + 1; r < rank.get(to); r++) {
      const point = `e${e}:${r}`;
      rank.set(point, r);
      place(point, r);
      chain.push(point);
    }
    chain.push(to);
    return chain;
  });
  const up = new Map();
  const down = new Map();
  for (const chain of chains) {
    for (let i = 1; i < chain.length; i++) {
      down.set(chain[i - 1], [...(down.get(chain[i - 1]) || []), chain[i]]);
      up.set(chain[i], [...(up.get(chain[i]) || []), chain[i - 1]]);
    }
  }

  // Order within ranks: barycentres, sweeping down and up, keeping the order with the fewest crossings
  const index = () => new Map(ranks.flatMap((row) => row.map((id, i) => [id, i])));
  const crossings = () => {
    const at = index();
    let count = 0;
    for (let r = 0; r + 1 < ranks.length; r++) {
      const links = ranks[r].flatMap((id) => (down.get(id) || []).map((n) => [at.get(id), at.get(n)]));
      for (let a = 0; a < links.length; a++) {
        for (let b = a + 1; b < links.length; b++) {
          if ((links[a][0] - links[b][0]) * (links[a][1] - links[b][1]) < 0) count++;
        }
      }
    }
    return count;
  };
  let best = ranks.map((row) => [...row]);
  let fewest = crossings();
  for (let sweep = 0; sweep < SWEEPS && fewest > 0; sweep++) {
    const downward = sweep % 2 === 0;
    const order = downward ? ranks.map((_, r) => r).slice(1) : ranks.map((_, r) => r).reverse().slice(1);
    for (const r of order) {
      const at = index();
      const links = downward ? up : down;
      const centre = (id, i) => {
        const near = links.get(id) || [];
        return near.length ? near.reduce((sum, n) => sum + at.get(n), 0) / near.length : i;
      };
      ranks[r] = ranks[r].map((id, i) => [id, centre(id, i), i]).sort((a, b) => a[1] - b[1] || a[2] - b[2]).map(([id]) => id);
    }
    const count = crossings();
    if (count < fewest) {
      fewest = count;
      best = ranks.map((row) => [...row]);
    }
  }
  ranks.splice(0, ranks.length, ...best);

  // x: each box centred under or over its neighbours as far as the gaps allow, a few passes each way
  const size = (id) => sizes.get(id) || { width: 0, height: 0 };
  const x = new Map();
  for (const row of ranks) {
    let left = 0;
    for (const id of row) {
      x.set(id, left + size(id).width / 2);
      left += size(id).width + GAP;
    }
  }
  // Downward passes centre boxes under what feeds them, upward ones over what they feed; the last goes down
  for (let pass = 0; pass < 7; pass++) {
    const downward = pass % 2 === 0;
    const order = downward ? ranks.map((_, r) => r) : ranks.map((_, r) => r).reverse();
    for (const r of order) {
      const row = ranks[r];
      const links = downward ? up : down;
      const wanted = row.map((id) => {
        const near = links.get(id) || [];
        return near.length ? near.reduce((sum, n) => sum + x.get(n), 0) / near.length : x.get(id);
      });
      placeRow(row.map((id) => size(id).width), wanted).forEach((centre, i) => x.set(row[i], centre));
    }
  }
  const lefts = [...x].map(([id, centre]) => centre - size(id).width / 2);
  const offset = MARGIN - Math.min(0, ...lefts);

  // y: ranks one under the other, each box centred in its rank's height
  const tops = [];
  let top = MARGIN;
  for (const row of ranks) {
    const tallest = Math.max(0, ...row.map((id) => size(id).height));
    tops.push({ top, tallest });
    top += tallest + RANK_GAP;
  }
  const boxes = new Map();
  for (const id of ids) {
    const { width, height } = size(id);
    const { top: rowTop, tallest } = tops[rank.get(id)];
    boxes.set(id, { x: x.get(id) + offset - width / 2, y: rowTop + (tallest - height) / 2, width, height });
  }
  // A long edge runs straight down past the boxes of each rank it crosses, and bends only between ranks
  const routes = chains.map((chain) => chain.flatMap((id, i) => {
    const centre = x.get(id) + offset;
    if (i === 0) return [{ x: centre, y: boxes.get(id).y + boxes.get(id).height }];
    if (i === chain.length - 1) return [{ x: centre, y: boxes.get(id).y }];
    const { top: rowTop, tallest } = tops[rank.get(id)];
    return [{ x: centre, y: rowTop }, { x: centre, y: rowTop + tallest }];
  }));
  // Edges count too: a long one may bend round the outside of a rank's boxes
  const right = Math.max(0, ...[...boxes.values()].map((box) => box.x + box.width), ...routes.flat().map((point) => point.x));
  return { width: Math.ceil(right + MARGIN), height: Math.ceil(top - RANK_GAP + MARGIN), boxes, routes };
}

/**
 * Centres for a row of boxes (widths, left to right) as close as they can be to the wanted ones, in the least
 * squares sense, with GAP between neighbours. With c the room the boxes before each one need, centre = y + c,
 * and the gaps hold when y never decreases: pool adjacent violators finds that y.
 */
export function placeRow(widths, wanted) {
  const room = [0];
  for (let i = 1; i < widths.length; i++) room.push(room[i - 1] + (widths[i - 1] + widths[i]) / 2 + GAP);
  const blocks = []; // { sum, count }: runs of boxes that share one y
  wanted.forEach((want, i) => {
    blocks.push({ sum: want - room[i], count: 1 });
    while (blocks.length > 1 && blocks.at(-2).sum / blocks.at(-2).count > blocks.at(-1).sum / blocks.at(-1).count) {
      const last = blocks.pop();
      blocks.at(-1).sum += last.sum;
      blocks.at(-1).count += last.count;
    }
  });
  const centres = [];
  for (const { sum, count } of blocks) for (let k = 0; k < count; k++) centres.push(sum / count + room[centres.length]);
  return centres;
}

/**
 * Labels ({ x, y, width, height }, x and y their centres, or null) moved up or down, in steps of their height,
 * until none covers another: the edges leaving one box start close together. Earlier labels keep their place.
 */
export function spreadLabels(labels) {
  const placed = [];
  const clear = (box) => !placed.some((other) => Math.abs(other.x - box.x) * 2 < other.width + box.width
    && Math.abs(other.y - box.y) * 2 < other.height + box.height);
  return labels.map((label) => {
    if (!label) return null;
    const step = label.height + 2;
    const spot = [0, 1, -1, 2, -2, 3, -3].map((k) => ({ ...label, y: label.y + k * step })).find(clear) || label;
    placed.push(spot);
    return spot;
  });
}

/** An SVG path through points, vertical at each of them, so long edges bend smoothly */
export function routePath(points) {
  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dy = (b.y - a.y) / 2;
    d += ` C${a.x},${a.y + dy} ${b.x},${b.y - dy} ${b.x},${b.y}`;
  }
  return d;
}

function svg(tag, attrs, kids) {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, String(value));
  for (const kid of kids || []) node.append(kid);
  return node;
}

function itemBox(item) {
  if (item.kind !== "node") return h("div", { class: `graph-data ${item.kind}` }, item.name);
  const { node } = item;
  const list = (title, names) => h("div", { class: "graph-io-list" }, [h("strong", null, title), ...(names || []).map((name) => h("div", null, name))]);
  return h("div", { class: "graph-node" }, [
    h("strong", { class: "graph-node-name" }, node.name),
    node.description ? h("em", { class: "graph-node-description" }, node.description) : null,
    h("div", { class: "graph-io" }, [list("Inputs", node.input), list("Outputs", node.output)]),
  ]);
}

let graphs = 0; // Each graph's arrowhead marker gets its own id

/**
 * A pipeline's graph, for its nodes ({ name, description, input, output }). It is laid out once it is on screen
 * with a size, since that needs its boxes measured: at once when shown, or when a hidden one is shown.
 */
export function pipelineGraph(nodes, name) {
  const { items, edges } = graphModel(nodes);
  const holder = h("div", { class: "graph", role: "img", "aria-label": `Graph of ${name}: ${nodes.length} nodes. The table view lists them as text.` });
  if (!items.length) {
    holder.append(h("p", { class: "muted small" }, "No nodes."));
    return holder;
  }
  const boxes = new Map(items.map((item) => [item.id, itemBox(item)]));
  const labels = edges.map((edge) => (edge.labels.length ? h("div", { class: "graph-label" }, edge.labels.map((label) => h("div", null, label))) : null));
  const measure = h("div", { class: "graph-measure", "aria-hidden": "true" }, [...boxes.values(), ...labels.filter(Boolean)]);
  holder.append(measure);
  let drawn = false;

  const draw = () => {
    if (drawn || !holder.isConnected || !holder.offsetWidth) return;
    drawn = true;
    const sizeOf = (el) => ({ width: Math.ceil(el.offsetWidth) + 1, height: Math.ceil(el.offsetHeight) + 1 });
    const sizes = new Map([...boxes].map(([id, el]) => [id, sizeOf(el)]));
    const labelSizes = labels.map((el) => (el ? sizeOf(el) : null));
    const placed = layout(items.map((item) => item.id), sizes, edges);
    const marker = `graph-arrow-${++graphs}`;
    const picture = svg("svg", { class: "graph-svg", width: placed.width, height: placed.height, viewBox: `0 0 ${placed.width} ${placed.height}` }, [
      svg("defs", null, [svg("marker", { id: marker, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 8, markerHeight: 8, orient: "auto-start-reverse" }, [
        svg("path", { class: "graph-arrow", d: "M0,0 L10,5 L0,10 z" }),
      ])]),
      ...placed.routes.map((points) => svg("path", { class: "graph-edge", d: routePath(points), "marker-end": `url(#${marker})` })),
    ]);
    for (const [id, el] of boxes) {
      const box = placed.boxes.get(id);
      picture.append(svg("foreignObject", { x: box.x, y: box.y, width: box.width, height: box.height }, [el]));
    }
    // Each on the middle of its edge's first stretch, where the curve is halfway between the two ends
    const spots = spreadLabels(placed.routes.map((points, e) => labelSizes[e] && {
      x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2, ...labelSizes[e],
    }));
    spots.forEach((spot, e) => {
      if (spot) picture.append(svg("foreignObject", { x: spot.x - spot.width / 2, y: spot.y - spot.height / 2, width: spot.width, height: spot.height }, [labels[e]]));
    });
    measure.remove();
    holder.append(picture);
  };

  // Laid out when it gets a size: shown now, or later when a hidden one is shown
  if (typeof ResizeObserver === "function") {
    const watch = new ResizeObserver(() => {
      draw();
      if (drawn) watch.disconnect();
    });
    watch.observe(holder);
  } else {
    requestAnimationFrame(draw);
  }
  return holder;
}

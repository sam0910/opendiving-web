// Turns a depth grid into what the seascape sample draws: a coloured terrain mesh,
// contour lines and their labels, distance and depth axes, and the site pin, as plain
// arrays a WebGL view can upload and label anchors it can project.
//
// Scene space: x points east, y up (the water surface is y = 0) and z **south**, which
// keeps the frame right-handed with north at -z. The wider side of the tile is 10 units
// across, and depth is drawn exaggerated so a shallow slope over kilometres still reads.

import {
  METRES_PER_DEG_LAT,
  METRES_PER_DEG_LON,
  type SeascapeGrid,
} from "@/lib/seascape-grid";

export const SCENE_SPAN = 10;

// Shallow water is teal and the deepest cell of the tile navy; land and cells with no
// reading are sand.
export const SHALLOW_COLOR = "#2DD4BF";
export const DEEP_COLOR = "#1E3A8A";
export const LAND_COLOR = "#C2A878";

// Land rises at most as high as the tile's water is deep: enough for an island's real
// shape (Munseom's 73 m over 83 m of water) now that land heights are measured, not so
// much that a mountain behind the coast towers over the seabed the view is about.
const LAND_CAP = 1;

// The exaggeration aims for this depth-to-width ratio, within these bounds.
const TARGET_RELIEF = 0.35;
const MIN_EXAGGERATION = 1;
const MAX_EXAGGERATION = 8;

// How far a contour floats above its own depth, so it is not lost inside the surface,
// and its label a little higher still.
const CONTOUR_LIFT_METERS = 0.15;
const CONTOUR_LABEL_LIFT_METERS = 0.25;

// Where along a contour its label may sit, as shares of the line's length. The view
// picks whichever is nearest the camera, so the label stays on the side facing you.
const LABEL_SPOTS = [0.1, 0.3, 0.5, 0.7, 0.9];
// A contour shorter than this, in scene units, is a small ring and goes unlabelled.
const MIN_LABELLED_LENGTH = 0.8;

// Axis chrome, in scene units: tick length, and how far out tick labels and titles sit.
const TICK_LENGTH = 0.2;
const TICK_LABEL_OFFSET = 0.5;
const TITLE_OFFSET = 1.1;

export interface SceneBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

export type Point3 = [number, number, number];

/**
 * Text pinned to the scene. A label with several anchors is drawn at whichever one is
 * nearest the camera. `kind` ranks labels when they collide on screen: titles first,
 * then axis ticks, then major and minor contours.
 */
export interface SceneLabel {
  text: string;
  kind: "title" | "tick" | "major" | "minor";
  anchors: Point3[];
}

export interface SeascapeScene {
  /** xyz per grid node. */
  positions: Float32Array;
  /** rgb (0-1, sRGB) per grid node. */
  colors: Float32Array;
  /** Two triangles per grid cell. */
  indices: Uint32Array;
  /** Contour segments, two xyz points each. */
  minorContours: Float32Array;
  majorContours: Float32Array;
  /** The three axes, and their ticks, as segments. */
  axisLines: Float32Array;
  axisTicks: Float32Array;
  labels: SceneLabel[];
  bounds: SceneBounds;
  /** Deepest wet cell, in metres (at least 1). */
  maxDepth: number;
  exaggeration: number;
  contourStep: number;
  hasLand: boolean;
  /** Where the site is; `seabedY` is null when the pin is on land or off the data. */
  pin: { x: number; z: number; seabedY: number | null };
}

/** The smallest of 1, 2 or 5 × 10ⁿ that is at least `value`. */
export function niceStep(value: number): number {
  if (!(value > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const fraction = value / magnitude;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return nice * magnitude;
}

/** How much to stretch depth: enough to read, never flatter than life or wilder than 8×. */
export function verticalExaggeration(
  maxDepth: number,
  narrowSpanMeters: number,
): number {
  const relief = Math.max(maxDepth, 1) / Math.max(narrowSpanMeters, 1);
  return Math.min(
    MAX_EXAGGERATION,
    Math.max(MIN_EXAGGERATION, TARGET_RELIEF / relief),
  );
}

/** The height a raw depth is drawn at, before scaling: empty is the waterline, land is capped. */
export function surfaceDepth(depth: number | null, maxDepth: number): number {
  return depth === null ? 0 : Math.max(depth, -LAND_CAP * maxDepth);
}

/** Depth at a point by bilinear interpolation, or null off the grid or next to an empty cell. */
export function depthAt(
  grid: SeascapeGrid,
  lat: number,
  lon: number,
): number | null {
  const rowF = (lat - grid.originLat) / grid.cellLat;
  const colF = (lon - grid.originLon) / grid.cellLon;
  if (rowF < 0 || colF < 0 || rowF > grid.rows - 1 || colF > grid.cols - 1)
    return null;
  const r0 = Math.floor(rowF);
  const c0 = Math.floor(colF);
  const r1 = Math.min(r0 + 1, grid.rows - 1);
  const c1 = Math.min(c0 + 1, grid.cols - 1);
  const corners = [
    grid.depths[r0 * grid.cols + c0],
    grid.depths[r0 * grid.cols + c1],
    grid.depths[r1 * grid.cols + c0],
    grid.depths[r1 * grid.cols + c1],
  ];
  if (corners.some((depth) => depth === null)) return null;
  const [sw, se, nw, ne] = corners as number[];
  const fr = rowF - r0;
  const fc = colF - c0;
  return (sw * (1 - fc) + se * fc) * (1 - fr) + (nw * (1 - fc) + ne * fc) * fr;
}

function hexToRgb(hex: string): [number, number, number] {
  const value = parseInt(hex.slice(1), 16);
  return [
    ((value >> 16) & 255) / 255,
    ((value >> 8) & 255) / 255,
    (value & 255) / 255,
  ];
}

const SHALLOW = hexToRgb(SHALLOW_COLOR);
const DEEP = hexToRgb(DEEP_COLOR);
const LAND = hexToRgb(LAND_COLOR);

// Marching squares: for each of the 16 ways a cell's corners can sit above or below a
// level (bit 1 south-west, 2 south-east, 4 north-east, 8 north-west, set when the
// corner is at least that deep), the pairs of edges the contour crosses. Edges are
// 0 south, 1 east, 2 north, 3 west. Cases 5 and 10 are saddles, settled separately.
const SEGMENTS: Record<number, [number, number][]> = {
  1: [[3, 0]],
  2: [[0, 1]],
  3: [[3, 1]],
  4: [[1, 2]],
  6: [[0, 2]],
  7: [[3, 2]],
  8: [[2, 3]],
  9: [[0, 2]],
  11: [[1, 2]],
  12: [[1, 3]],
  13: [[0, 1]],
  14: [[3, 0]],
};

export function buildSeascapeScene(grid: SeascapeGrid): SeascapeScene {
  const { rows, cols, depths } = grid;
  const cosLat = Math.cos((grid.centerLat * Math.PI) / 180);
  const metresPerDegLon = METRES_PER_DEG_LON * cosLat;

  const eastSpan = (cols - 1) * grid.cellLon * metresPerDegLon;
  const northSpan = (rows - 1) * grid.cellLat * METRES_PER_DEG_LAT;
  const scale = SCENE_SPAN / Math.max(eastSpan, northSpan, 1);

  let maxDepth = 1;
  let hasLand = false;
  for (const depth of depths) {
    if (depth !== null && depth > maxDepth) maxDepth = depth;
    if (depth === null || depth <= 0) hasLand = true;
  }
  const exaggeration = verticalExaggeration(
    maxDepth,
    Math.min(eastSpan, northSpan),
  );
  const depthScale = scale * exaggeration;

  // Grid coordinates (fractional row and column) to scene x and z.
  const xAt = (col: number) =>
    (grid.originLon + col * grid.cellLon - grid.centerLon) *
    metresPerDegLon *
    scale;
  const zAt = (row: number) =>
    -(grid.originLat + row * grid.cellLat - grid.centerLat) *
    METRES_PER_DEG_LAT *
    scale;

  const positions = new Float32Array(rows * cols * 3);
  const colors = new Float32Array(rows * cols * 3);
  const bounds: SceneBounds = {
    minX: Infinity,
    maxX: -Infinity,
    minY: 0,
    maxY: 0,
    minZ: Infinity,
    maxZ: -Infinity,
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const depth = depths[i];
      const x = xAt(c);
      const y = -surfaceDepth(depth, maxDepth) * depthScale;
      const z = zAt(r);
      positions.set([x, y, z], i * 3);

      let rgb = LAND;
      if (depth !== null && depth > 0) {
        const t = Math.min(depth / maxDepth, 1);
        rgb = [0, 1, 2].map((k) => SHALLOW[k] + (DEEP[k] - SHALLOW[k]) * t) as [
          number,
          number,
          number,
        ];
      }
      colors.set(rgb, i * 3);

      bounds.minX = Math.min(bounds.minX, x);
      bounds.maxX = Math.max(bounds.maxX, x);
      bounds.minY = Math.min(bounds.minY, y);
      bounds.maxY = Math.max(bounds.maxY, y);
      bounds.minZ = Math.min(bounds.minZ, z);
      bounds.maxZ = Math.max(bounds.maxZ, z);
    }
  }

  const indices = new Uint32Array((rows - 1) * (cols - 1) * 6);
  let k = 0;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const d = a + cols;
      const e = d + 1;
      indices.set([a, b, d, b, e, d], k);
      k += 6;
    }
  }

  const contourStep = Math.max(niceStep(maxDepth / 15), 1);
  const levelCount = Math.floor(maxDepth / contourStep);
  const minor: number[] = [];
  const major: number[] = [];
  const labels: SceneLabel[] = [];
  if (levelCount >= 2) {
    for (let level = 1; level <= levelCount; level++) {
      const depth = level * contourStep;
      const isMajor = level % 5 === 0;
      const y =
        -(depth - Math.min(CONTOUR_LIFT_METERS, depth / 2)) * depthScale;
      const segments: Segment[] = [];
      traceLevel(grid, depth, (r1, c1, r2, c2) => {
        segments.push([r1, c1, r2, c2]);
        (isMajor ? major : minor).push(
          xAt(c1),
          y,
          zAt(r1),
          xAt(c2),
          y,
          zAt(r2),
        );
      });

      // The label goes on the level's longest line, at its spot nearest the viewer.
      const labelY =
        -(depth - Math.min(CONTOUR_LABEL_LIFT_METERS, depth / 2)) * depthScale;
      const longest = longestLine(
        chainSegments(segments).map((line) =>
          line.map(([r, c]): Point3 => [xAt(c), labelY, zAt(r)]),
        ),
      );
      if (longest && longest.length >= MIN_LABELLED_LENGTH) {
        labels.push({
          text: `${Math.round(depth)} m`,
          kind: isMajor ? "major" : "minor",
          anchors: LABEL_SPOTS.map((share) =>
            pointAlong(longest.points, longest.length * share),
          ),
        });
      }
    }
  }

  // The depth gauge stands on the tile's deepest corner, from the seabed there up to
  // the surface, clear of the view's middle. A tile whose corners are all land keeps it
  // at the south-west corner, down to the tile's deepest point.
  const gauge = deepestCorner(grid) ?? {
    row: 0,
    col: 0,
    depth: maxDepth,
    outX: -Math.SQRT1_2,
    outZ: Math.SQRT1_2,
  };
  const axes = buildAxes(
    bounds,
    eastSpan,
    northSpan,
    { ...gauge, x: xAt(gauge.col), z: zAt(gauge.row) },
    depthScale,
  );
  labels.unshift(...axes.labels);

  const pinDepth = depthAt(grid, grid.centerLat, grid.centerLon);
  return {
    positions,
    colors,
    indices,
    minorContours: new Float32Array(minor),
    majorContours: new Float32Array(major),
    axisLines: new Float32Array(axes.lines),
    axisTicks: new Float32Array(axes.ticks),
    labels,
    bounds,
    maxDepth,
    exaggeration,
    contourStep,
    hasLand,
    // The tile is centred on the site, so the pin sits at the scene's origin.
    pin: {
      x: 0,
      z: 0,
      seabedY:
        pinDepth !== null && pinDepth > 0 ? -pinDepth * depthScale : null,
    },
  };
}

/** A corner of the tile, its depth, and which way is out of the tile there. */
export interface EdgePoint {
  row: number;
  col: number;
  depth: number;
  /** Unit vector, in scene x and z, pointing away from the tile. */
  outX: number;
  outZ: number;
}

/**
 * The deepest of the tile's four corners that is under water, or null when all four
 * are land or empty. Ties keep the first, in the order south-west, south-east,
 * north-west, north-east.
 */
export function deepestCorner(grid: SeascapeGrid): EdgePoint | null {
  const { rows, cols, depths } = grid;
  let best: EdgePoint | null = null;
  for (const [row, col] of [
    [0, 0],
    [0, cols - 1],
    [rows - 1, 0],
    [rows - 1, cols - 1],
  ]) {
    const depth = depths[row * cols + col];
    if (depth === null || depth <= 0 || (best && depth <= best.depth)) continue;
    // Out of the tile, diagonally: south is +z, north -z, west -x, east +x.
    best = {
      row,
      col,
      depth,
      outX: (col === 0 ? -1 : 1) * Math.SQRT1_2,
      outZ: (row === 0 ? 1 : -1) * Math.SQRT1_2,
    };
  }
  return best;
}

/**
 * Distance axes along the south and west edges, at the waterline, and a depth gauge
 * standing on one of the tile's corners from the seabed up to the surface, with ticks
 * at round numbers.
 */
function buildAxes(
  bounds: SceneBounds,
  eastSpan: number,
  northSpan: number,
  gauge: EdgePoint & { x: number; z: number },
  depthScale: number,
): { lines: number[]; ticks: number[]; labels: SceneLabel[] } {
  const { minX, maxX, minZ, maxZ } = bounds;
  const metresPerUnit = eastSpan / (maxX - minX || 1);
  const bottom = -gauge.depth * depthScale;
  const lines = [
    ...[minX, 0, maxZ, maxX, 0, maxZ],
    ...[minX, 0, maxZ, minX, 0, minZ],
    ...[gauge.x, 0, gauge.z, gauge.x, bottom, gauge.z],
  ];
  const ticks: number[] = [];
  const labels: SceneLabel[] = [];
  const tick = (from: Point3, to: Point3, label: Point3, text: string) => {
    ticks.push(...from, ...to);
    labels.push({ text, kind: "tick", anchors: [label] });
  };

  // East, along the south edge, ticks pointing south.
  const eastStep = niceStep(eastSpan / 5);
  for (let m = eastStep; m <= eastSpan; m += eastStep) {
    const x = minX + m / metresPerUnit;
    tick(
      [x, 0, maxZ],
      [x, 0, maxZ + TICK_LENGTH],
      [x, 0, maxZ + TICK_LABEL_OFFSET],
      String(m),
    );
  }
  // North, along the west edge, ticks pointing west.
  const northStep = niceStep(northSpan / 5);
  for (let m = northStep; m <= northSpan; m += northStep) {
    const z = maxZ - m / metresPerUnit;
    tick(
      [minX, 0, z],
      [minX - TICK_LENGTH, 0, z],
      [minX - TICK_LABEL_OFFSET, 0, z],
      String(m),
    );
  }
  // Down the gauge, ticks pointing out of the tile: the surface's 0, round depths,
  // and the seabed's own depth at the foot when it is not one of them.
  const gaugeTick = (depth: number, text: string) => {
    const y = -depth * depthScale;
    tick(
      [gauge.x, y, gauge.z],
      [
        gauge.x + gauge.outX * TICK_LENGTH,
        y,
        gauge.z + gauge.outZ * TICK_LENGTH,
      ],
      [
        gauge.x + gauge.outX * TICK_LABEL_OFFSET,
        y,
        gauge.z + gauge.outZ * TICK_LABEL_OFFSET,
      ],
      text,
    );
  };
  const foot = Math.round(gauge.depth);
  const depthStep = niceStep(gauge.depth / 4);
  gaugeTick(0, "0");
  for (let m = depthStep; m <= gauge.depth; m += depthStep) {
    gaugeTick(m, String(m));
  }
  if (foot % depthStep !== 0) gaugeTick(gauge.depth, String(foot));

  // A title sits midway between the two ticks nearest the axis's middle, so it never
  // lands on a tick label and hides it.
  const titleAt = (span: number, step: number) =>
    (Math.floor(span / 2 / step) + 0.5) * step;
  labels.unshift(
    {
      text: "Distance (m)",
      kind: "title",
      anchors: [
        [
          minX + titleAt(eastSpan, eastStep) / metresPerUnit,
          0,
          maxZ + TITLE_OFFSET,
        ],
      ],
    },
    {
      text: "Distance (m)",
      kind: "title",
      anchors: [
        [
          minX - TITLE_OFFSET,
          0,
          maxZ - titleAt(northSpan, northStep) / metresPerUnit,
        ],
      ],
    },
    {
      text: "Depth (m)",
      kind: "title",
      anchors: [
        [
          gauge.x + gauge.outX * TICK_LABEL_OFFSET,
          bottom - 0.35,
          gauge.z + gauge.outZ * TICK_LABEL_OFFSET,
        ],
      ],
    },
  );
  return { lines, ticks, labels };
}

/** A contour piece in grid space: row and column of each end. */
type Segment = [number, number, number, number];

/** Joins segments that share an end into polylines, each a list of (row, col) points. */
export function chainSegments(segments: Segment[]): [number, number][][] {
  // Neighbouring cells compute a shared crossing separately, so ends are matched to
  // six decimals of a cell rather than exactly.
  const key = (r: number, c: number) => `${r.toFixed(6)},${c.toFixed(6)}`;
  const byEnd = new Map<string, number[]>();
  segments.forEach(([r1, c1, r2, c2], i) => {
    for (const end of [key(r1, c1), key(r2, c2)]) {
      byEnd.set(end, [...(byEnd.get(end) ?? []), i]);
    }
  });

  const used = new Uint8Array(segments.length);
  // The far end of the unused segment touching `point`, marking it used.
  const next = (point: [number, number]): [number, number] | null => {
    for (const i of byEnd.get(key(...point)) ?? []) {
      if (used[i]) continue;
      used[i] = 1;
      const [r1, c1, r2, c2] = segments[i];
      return key(r1, c1) === key(...point) ? [r2, c2] : [r1, c1];
    }
    return null;
  };

  const lines: [number, number][][] = [];
  for (let i = 0; i < segments.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const [r1, c1, r2, c2] = segments[i];
    const line: [number, number][] = [
      [r1, c1],
      [r2, c2],
    ];
    for (let p = next(line[line.length - 1]); p; p = next(p)) line.push(p);
    for (let p = next(line[0]); p; p = next(p)) line.unshift(p);
    lines.push(line);
  }
  return lines;
}

function distance(a: Point3, b: Point3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function longestLine(
  lines: Point3[][],
): { points: Point3[]; length: number } | null {
  let best: { points: Point3[]; length: number } | null = null;
  for (const points of lines) {
    let length = 0;
    for (let i = 1; i < points.length; i++) {
      length += distance(points[i - 1], points[i]);
    }
    if (!best || length > best.length) best = { points, length };
  }
  return best;
}

/** The point `target` units along a polyline. */
function pointAlong(points: Point3[], target: number): Point3 {
  let travelled = 0;
  for (let i = 1; i < points.length; i++) {
    const step = distance(points[i - 1], points[i]);
    if (travelled + step >= target && step > 0) {
      const t = (target - travelled) / step;
      return [0, 1, 2].map(
        (k) => points[i - 1][k] + (points[i][k] - points[i - 1][k]) * t,
      ) as Point3;
    }
    travelled += step;
  }
  return points[points.length - 1];
}

/** Calls `segment` with the grid-space ends of every piece of the contour at `level`. */
function traceLevel(
  grid: SeascapeGrid,
  level: number,
  segment: (r1: number, c1: number, r2: number, c2: number) => void,
): void {
  const { rows, cols, depths } = grid;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const sw = depths[r * cols + c];
      const se = depths[r * cols + c + 1];
      const ne = depths[(r + 1) * cols + c + 1];
      const nw = depths[(r + 1) * cols + c];
      // Only wet cells carry contours: a line along a coast would trace the land cap.
      if (sw === null || se === null || ne === null || nw === null) continue;
      if (sw <= 0 || se <= 0 || ne <= 0 || nw <= 0) continue;

      const index =
        (sw >= level ? 1 : 0) |
        (se >= level ? 2 : 0) |
        (ne >= level ? 4 : 0) |
        (nw >= level ? 8 : 0);
      if (index === 0 || index === 15) continue;

      const along = (a: number, b: number) =>
        a === b ? 0.5 : (level - a) / (b - a);
      // Where the level crosses each edge, as (row, col).
      const edge = (e: number): [number, number] => {
        switch (e) {
          case 0:
            return [r, c + along(sw, se)];
          case 1:
            return [r + along(se, ne), c + 1];
          case 2:
            return [r + 1, c + 1 - along(ne, nw)];
          default:
            return [r + 1 - along(nw, sw), c];
        }
      };

      let pairs = SEGMENTS[index];
      if (index === 5 || index === 10) {
        // A saddle: the cell's average says whether the deep corners join through the middle.
        const centreDeep = (sw + se + ne + nw) / 4 >= level;
        const aroundSwNe: [number, number][] = [
          [3, 0],
          [1, 2],
        ];
        const aroundSeNw: [number, number][] = [
          [0, 1],
          [2, 3],
        ];
        pairs = (index === 5) === centreDeep ? aroundSeNw : aroundSwNe;
      }
      for (const [from, to] of pairs) {
        const [r1, c1] = edge(from);
        const [r2, c2] = edge(to);
        segment(r1, c1, r2, c2);
      }
    }
  }
}

/**
 * Mesh unfolding: grows spanning trees over the face-adjacency graph, flattening
 * each face into the root face's plane by rotating about shared (hinge) edges.
 * Faces whose flattened placement would overlap the net are split off into new
 * islands. Produces fold segments (mountain/valley), cut segments with matched
 * pair numbers, and glue tabs.
 */

import type { CutSeg, FoldSeg, Island, Mesh, NetFace, NetResult, Vec2 } from "./types";
import { buildTopology, faceArea, faceNormal } from "./mesh";

export const MAX_UNFOLD_FACES = 2000;

/**
 * Islands stop growing past this many faces. Smaller pieces print larger
 * (a sprawling island caps the page scale) and are far saner to glue.
 */
const MAX_ISLAND_FACES = 90;

export class UnfoldError extends Error {}

// ---------------------------------------------------------------------------
// Small affine-transform helpers. Row-major 3x4: [r00 r01 r02 tx, r10.., r20..].
// ---------------------------------------------------------------------------

type Affine = Float64Array;

function identity(): Affine {
  return new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
}

/** out = a ∘ b (apply b first, then a). */
function compose(a: Affine, b: Affine, out: Affine): void {
  for (let r = 0; r < 3; r++) {
    const r0 = a[r * 4], r1 = a[r * 4 + 1], r2 = a[r * 4 + 2];
    out[r * 4] = r0 * b[0] + r1 * b[4] + r2 * b[8];
    out[r * 4 + 1] = r0 * b[1] + r1 * b[5] + r2 * b[9];
    out[r * 4 + 2] = r0 * b[2] + r1 * b[6] + r2 * b[10];
    out[r * 4 + 3] = r0 * b[3] + r1 * b[7] + r2 * b[11] + a[r * 4 + 3];
  }
}

/** Rotation by angle about the line through point p with unit direction d. */
function rotationAboutLine(
  px: number, py: number, pz: number,
  dx: number, dy: number, dz: number,
  angle: number
): Affine {
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  const r00 = t * dx * dx + c, r01 = t * dx * dy - s * dz, r02 = t * dx * dz + s * dy;
  const r10 = t * dx * dy + s * dz, r11 = t * dy * dy + c, r12 = t * dy * dz - s * dx;
  const r20 = t * dx * dz - s * dy, r21 = t * dy * dz + s * dx, r22 = t * dz * dz + c;
  const tx = px - (r00 * px + r01 * py + r02 * pz);
  const ty = py - (r10 * px + r11 * py + r12 * pz);
  const tz = pz - (r20 * px + r21 * py + r22 * pz);
  return new Float64Array([r00, r01, r02, tx, r10, r11, r12, ty, r20, r21, r22, tz]);
}

function apply(m: Affine, x: number, y: number, z: number, out: number[]): void {
  out[0] = m[0] * x + m[1] * y + m[2] * z + m[3];
  out[1] = m[4] * x + m[5] * y + m[6] * z + m[7];
  out[2] = m[8] * x + m[9] * y + m[10] * z + m[11];
}

// ---------------------------------------------------------------------------
// 2D overlap testing with a uniform grid.
// ---------------------------------------------------------------------------

type Tri2 = [number, number, number, number, number, number];

class TriGrid {
  cell: number;
  tris: Tri2[] = [];
  cells = new Map<string, number[]>();
  constructor(cell: number) {
    this.cell = cell;
  }
  private key(cx: number, cy: number) {
    return cx + "," + cy;
  }
  private forCells(t: Tri2, fn: (key: string) => void) {
    const minX = Math.min(t[0], t[2], t[4]), maxX = Math.max(t[0], t[2], t[4]);
    const minY = Math.min(t[1], t[3], t[5]), maxY = Math.max(t[1], t[3], t[5]);
    const c0 = Math.floor(minX / this.cell), c1 = Math.floor(maxX / this.cell);
    const r0 = Math.floor(minY / this.cell), r1 = Math.floor(maxY / this.cell);
    for (let cx = c0; cx <= c1; cx++) for (let cy = r0; cy <= r1; cy++) fn(this.key(cx, cy));
  }
  add(t: Tri2) {
    const id = this.tris.length;
    this.tris.push(t);
    this.forCells(t, (k) => {
      let arr = this.cells.get(k);
      if (!arr) this.cells.set(k, (arr = []));
      arr.push(id);
    });
  }
  /** True if t overlaps any stored triangle. */
  overlaps(t: Tri2): boolean {
    const seen = new Set<number>();
    let hit = false;
    this.forCells(t, (k) => {
      if (hit) return;
      const arr = this.cells.get(k);
      if (!arr) return;
      for (const id of arr) {
        if (seen.has(id)) continue;
        seen.add(id);
        if (trianglesOverlap(t, this.tris[id])) {
          hit = true;
          return;
        }
      }
    });
    return hit;
  }
}

function shrinkTri(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, f: number): Tri2 {
  const gx = (ax + bx + cx) / 3, gy = (ay + by + cy) / 3;
  return [
    ax + (gx - ax) * f, ay + (gy - ay) * f,
    bx + (gx - bx) * f, by + (gy - by) * f,
    cx + (gx - cx) * f, cy + (gy - cy) * f,
  ];
}

function orient(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
  return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
}

function segsCross(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number
): boolean {
  const d1 = orient(cx, cy, dx, dy, ax, ay);
  const d2 = orient(cx, cy, dx, dy, bx, by);
  const d3 = orient(ax, ay, bx, by, cx, cy);
  const d4 = orient(ax, ay, bx, by, dx, dy);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function pointInTri(px: number, py: number, t: Tri2): boolean {
  const d1 = orient(t[0], t[1], t[2], t[3], px, py);
  const d2 = orient(t[2], t[3], t[4], t[5], px, py);
  const d3 = orient(t[4], t[5], t[0], t[1], px, py);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

export function trianglesOverlap(t1: Tri2, t2: Tri2): boolean {
  // Quick bbox reject.
  if (
    Math.max(t1[0], t1[2], t1[4]) < Math.min(t2[0], t2[2], t2[4]) ||
    Math.max(t2[0], t2[2], t2[4]) < Math.min(t1[0], t1[2], t1[4]) ||
    Math.max(t1[1], t1[3], t1[5]) < Math.min(t2[1], t2[3], t2[5]) ||
    Math.max(t2[1], t2[3], t2[5]) < Math.min(t1[1], t1[3], t1[5])
  ) {
    return false;
  }
  for (let i = 0; i < 3; i++) {
    const a = [t1[i * 2], t1[i * 2 + 1]];
    const b = [t1[((i + 1) % 3) * 2], t1[((i + 1) % 3) * 2 + 1]];
    for (let j = 0; j < 3; j++) {
      const c = [t2[j * 2], t2[j * 2 + 1]];
      const d = [t2[((j + 1) % 3) * 2], t2[((j + 1) % 3) * 2 + 1]];
      if (segsCross(a[0], a[1], b[0], b[1], c[0], c[1], d[0], d[1])) return true;
    }
  }
  if (pointInTri(t1[0], t1[1], t2)) return true;
  if (pointInTri(t2[0], t2[1], t1)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Candidate priority queue (prefer flattest hinges → compact strips).
// ---------------------------------------------------------------------------

interface Candidate {
  parentFace: number;
  childFace: number;
  edgeId: number;
  priority: number;
}

class CandHeap {
  items: Candidate[] = [];
  push(it: Candidate) {
    const a = this.items;
    a.push(it);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].priority <= a[i].priority) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): Candidate | undefined {
    const a = this.items;
    if (!a.length) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l].priority < a[m].priority) m = l;
        if (r < a.length && a[r].priority < a[m].priority) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
  get size() {
    return this.items.length;
  }
}

// ---------------------------------------------------------------------------
// Main unfold.
// ---------------------------------------------------------------------------

export function unfoldMesh(mesh: Mesh): NetResult {
  const nf = mesh.faces.length / 3;
  if (nf === 0) throw new UnfoldError("The mesh has no faces.");
  if (nf > MAX_UNFOLD_FACES) {
    throw new UnfoldError(
      `This mesh has ${nf.toLocaleString()} faces — too many to unfold into a usable papercraft net. ` +
        `Simplify it to ${MAX_UNFOLD_FACES.toLocaleString()} faces or fewer first.`
    );
  }

  const topo = buildTopology(mesh);
  const pos = mesh.positions;

  // Precompute normals, areas, centroids, average edge length.
  const normals = new Float64Array(nf * 3);
  const areas = new Float64Array(nf);
  const centroids = new Float64Array(nf * 3);
  const tmpN = [0, 0, 0];
  for (let f = 0; f < nf; f++) {
    faceNormal(mesh, f, tmpN);
    normals[f * 3] = tmpN[0]; normals[f * 3 + 1] = tmpN[1]; normals[f * 3 + 2] = tmpN[2];
    areas[f] = faceArea(mesh, f);
    for (let k = 0; k < 3; k++) {
      const v = mesh.faces[f * 3 + k];
      centroids[f * 3] += pos[v * 3] / 3;
      centroids[f * 3 + 1] += pos[v * 3 + 1] / 3;
      centroids[f * 3 + 2] += pos[v * 3 + 2] / 3;
    }
  }
  let avgEdge = 0;
  for (const e of topo.edges) {
    avgEdge += Math.hypot(
      pos[e.v1 * 3] - pos[e.v0 * 3],
      pos[e.v1 * 3 + 1] - pos[e.v0 * 3 + 1],
      pos[e.v1 * 3 + 2] - pos[e.v0 * 3 + 2]
    );
  }
  avgEdge /= topo.edges.length || 1;
  const tabDepth = Math.min(0.1, Math.max(0.03, avgEdge * 0.35));

  const netFaces: NetFace[] = new Array(nf);
  const placed = new Uint8Array(nf);
  const flatten: Affine[] = new Array(nf); // per-face full flatten transform
  const islands: Island[] = [];
  const islandGrids: TriGrid[] = [];

  // Directed edge lookup within a face: returns corner index whose edge (k, k+1) is (a,b).
  const directedEdgeCorner = (f: number, a: number, b: number): number => {
    for (let k = 0; k < 3; k++) {
      if (mesh.faces[f * 3 + k] === a && mesh.faces[f * 3 + ((k + 1) % 3)] === b) return k;
    }
    return -1;
  };

  const flattenAngleFor = (parent: number, child: number, va: number, vb: number): number => {
    // Axis direction along parent's directed edge va -> vb.
    let ex = pos[vb * 3] - pos[va * 3];
    let ey = pos[vb * 3 + 1] - pos[va * 3 + 1];
    let ez = pos[vb * 3 + 2] - pos[va * 3 + 2];
    const len = Math.hypot(ex, ey, ez) || 1;
    ex /= len; ey /= len; ez /= len;
    const npx = normals[parent * 3], npy = normals[parent * 3 + 1], npz = normals[parent * 3 + 2];
    const ncx = normals[child * 3], ncy = normals[child * 3 + 1], ncz = normals[child * 3 + 2];
    // cross(nc, np)
    const cx = ncy * npz - ncz * npy;
    const cy = ncz * npx - ncx * npz;
    const cz = ncx * npy - ncy * npx;
    const sinA = ex * cx + ey * cy + ez * cz;
    const cosA = ncx * npx + ncy * npy + ncz * npz;
    return Math.atan2(sinA, cosA);
  };

  const p3 = [0, 0, 0];
  const uvOf = (island: Island, m: Affine, v: number): Vec2 => {
    apply(m, pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2], p3);
    const dx = p3[0] - island.origin3[0];
    const dy = p3[1] - island.origin3[1];
    const dz = p3[2] - island.origin3[2];
    return {
      x: dx * island.u3[0] + dy * island.u3[1] + dz * island.u3[2],
      y: dx * island.v3[0] + dy * island.v3[1] + dz * island.v3[2],
    };
  };

  // Barely shrink triangles before overlap testing: enough to let faces that
  // share an edge or vertex coexist, strict enough to reject real slivers.
  const SHRINK = 0.002;

  // Grow islands until every face is placed.
  const order = Array.from({ length: nf }, (_, i) => i).sort((a, b) => areas[b] - areas[a]);
  for (const seed of order) {
    if (placed[seed]) continue;

    const islandIndex = islands.length;
    const v0 = mesh.faces[seed * 3];
    const v1 = mesh.faces[seed * 3 + 1];
    let ux = pos[v1 * 3] - pos[v0 * 3];
    let uy = pos[v1 * 3 + 1] - pos[v0 * 3 + 1];
    let uz = pos[v1 * 3 + 2] - pos[v0 * 3 + 2];
    const ulen = Math.hypot(ux, uy, uz) || 1;
    ux /= ulen; uy /= ulen; uz /= ulen;
    const nx = normals[seed * 3], ny = normals[seed * 3 + 1], nz = normals[seed * 3 + 2];
    // v = n × u  (so that u × v = n and the projected winding stays CCW)
    const vx = ny * uz - nz * uy;
    const vy = nz * ux - nx * uz;
    const vz = nx * uy - ny * ux;

    const island: Island = {
      index: islandIndex,
      rootFace: seed,
      faceCount: 0,
      faceOrder: [],
      origin3: [pos[v0 * 3], pos[v0 * 3 + 1], pos[v0 * 3 + 2]],
      u3: [ux, uy, uz],
      v3: [vx, vy, vz],
      n3: [nx, ny, nz],
      rotation: 0,
      bboxMin: { x: 0, y: 0 },
      bboxMax: { x: 0, y: 0 },
    };
    islands.push(island);
    const grid = new TriGrid(Math.max(avgEdge * 2, 1e-4));
    islandGrids.push(grid);

    const heap = new CandHeap();

    const placeFace = (f: number, parent: number, edgeId: number, m: Affine, uv: [Vec2, Vec2, Vec2], depth: number) => {
      placed[f] = 1;
      flatten[f] = m;
      island.faceCount++;
      island.faceOrder.push(f);
      let hingeA = -1, hingeB = -1, angle = 0;
      if (parent >= 0) {
        const rec = topo.edges[edgeId];
        // Hinge oriented as the parent's directed edge.
        const k = directedEdgeCorner(parent, rec.v0, rec.v1);
        if (k >= 0) {
          hingeA = rec.v0; hingeB = rec.v1;
        } else {
          hingeA = rec.v1; hingeB = rec.v0;
        }
        angle = flattenAngleFor(parent, f, hingeA, hingeB);
      }
      netFaces[f] = {
        faceIndex: f,
        islandIndex,
        parent,
        depth,
        hingeA,
        hingeB,
        flattenAngle: angle,
        uv,
      };
      grid.add(shrinkTri(uv[0].x, uv[0].y, uv[1].x, uv[1].y, uv[2].x, uv[2].y, SHRINK));
      // Offer unplaced neighbors.
      for (let e = 0; e < 3; e++) {
        const eid = topo.faceEdges[f * 3 + e];
        const rec = topo.edges[eid];
        if (rec.faces.length !== 2) continue;
        const g = rec.faces[0] === f ? rec.faces[1] : rec.faces[0];
        if (placed[g]) continue;
        const ang = Math.abs(flattenAngleFor(f, g, rec.v0, rec.v1));
        heap.push({ parentFace: f, childFace: g, edgeId: eid, priority: ang - areas[g] * 0.001 });
      }
    };

    // Root face.
    {
      const m = identity();
      const uv: [Vec2, Vec2, Vec2] = [
        uvOf(island, m, mesh.faces[seed * 3]),
        uvOf(island, m, mesh.faces[seed * 3 + 1]),
        uvOf(island, m, mesh.faces[seed * 3 + 2]),
      ];
      placeFace(seed, -1, -1, m, uv, 0);
    }

    while (heap.size > 0) {
      if (island.faceCount >= MAX_ISLAND_FACES) break;
      const cand = heap.pop()!;
      const f = cand.childFace;
      if (placed[f]) continue;
      const parent = cand.parentFace;
      const rec = topo.edges[cand.edgeId];
      const k = directedEdgeCorner(parent, rec.v0, rec.v1);
      const hingeA = k >= 0 ? rec.v0 : rec.v1;
      const hingeB = k >= 0 ? rec.v1 : rec.v0;
      const angle = flattenAngleFor(parent, f, hingeA, hingeB);
      let ex = pos[hingeB * 3] - pos[hingeA * 3];
      let ey = pos[hingeB * 3 + 1] - pos[hingeA * 3 + 1];
      let ez = pos[hingeB * 3 + 2] - pos[hingeA * 3 + 2];
      const elen = Math.hypot(ex, ey, ez) || 1;
      const rot = rotationAboutLine(
        pos[hingeA * 3], pos[hingeA * 3 + 1], pos[hingeA * 3 + 2],
        ex / elen, ey / elen, ez / elen,
        angle
      );
      const m = identity();
      compose(flatten[parent], rot, m);
      const uv: [Vec2, Vec2, Vec2] = [
        uvOf(island, m, mesh.faces[f * 3]),
        uvOf(island, m, mesh.faces[f * 3 + 1]),
        uvOf(island, m, mesh.faces[f * 3 + 2]),
      ];
      const tri = shrinkTri(uv[0].x, uv[0].y, uv[1].x, uv[1].y, uv[2].x, uv[2].y, SHRINK);
      if (grid.overlaps(tri)) continue; // face may still arrive via another edge, or seed a new island
      placeFace(f, parent, cand.edgeId, m, uv, netFaces[parent].depth + 1);
    }
  }

  // ------------------------------------------------------------------
  // Classify edges: folds (tree edges) vs cuts (everything else).
  // ------------------------------------------------------------------
  const folds: FoldSeg[] = [];
  const cuts: CutSeg[] = [];
  let pairCount = 0;
  let tabCount = 0;

  const edgeUV = (f: number, va: number, vb: number): [Vec2, Vec2] | null => {
    const nfc = netFaces[f];
    for (let k = 0; k < 3; k++) {
      const a = mesh.faces[f * 3 + k], b = mesh.faces[f * 3 + ((k + 1) % 3)];
      if ((a === va && b === vb) || (a === vb && b === va)) {
        return a === va ? [nfc.uv[k], nfc.uv[(k + 1) % 3]] : [nfc.uv[(k + 1) % 3], nfc.uv[k]];
      }
    }
    return null;
  };

  /** Directed edge of face f in its own winding, as uv points. */
  const directedEdgeUV = (f: number, edgeV0: number, edgeV1: number): [Vec2, Vec2] => {
    const k = directedEdgeCorner(f, edgeV0, edgeV1);
    const nfc = netFaces[f];
    if (k >= 0) return [nfc.uv[k], nfc.uv[(k + 1) % 3]];
    const k2 = directedEdgeCorner(f, edgeV1, edgeV0);
    return [nfc.uv[k2], nfc.uv[(k2 + 1) % 3]];
  };

  const buildTab = (f: number, a: Vec2, b: Vec2, depth: number): Vec2[] | null => {
    // Face interior is left of a->b (CCW winding); tab goes right (outward).
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return null;
    const ux = dx / len, uy = dy / len;
    const ox = uy, oy = -ux; // right normal
    const d = Math.min(depth, len * 0.45);
    const bev = Math.min(d * 0.9, len * 0.3);
    return [
      { x: a.x, y: a.y },
      { x: a.x + ox * d + ux * bev, y: a.y + oy * d + uy * bev },
      { x: b.x + ox * d - ux * bev, y: b.y + oy * d - uy * bev },
      { x: b.x, y: b.y },
    ];
  };

  const tabFits = (islandIdx: number, poly: Vec2[]): boolean => {
    const grid = islandGrids[islandIdx];
    const t1 = shrinkTri(poly[0].x, poly[0].y, poly[1].x, poly[1].y, poly[2].x, poly[2].y, 0.03);
    const t2 = shrinkTri(poly[0].x, poly[0].y, poly[2].x, poly[2].y, poly[3].x, poly[3].y, 0.03);
    return !grid.overlaps(t1) && !grid.overlaps(t2);
  };

  for (let ei = 0; ei < topo.edges.length; ei++) {
    const rec = topo.edges[ei];
    if (rec.faces.length === 2) {
      const [f, g] = rec.faces;
      const child =
        netFaces[g].parent === f && sameEdge(netFaces[g], rec.v0, rec.v1) ? g :
        netFaces[f].parent === g && sameEdge(netFaces[f], rec.v0, rec.v1) ? f : -1;
      if (child >= 0) {
        // Fold edge inside an island.
        const parent = child === g ? f : g;
        const nfc = netFaces[child];
        if (Math.abs(nfc.flattenAngle) > 0.008) {
          const seg = edgeUV(parent, rec.v0, rec.v1)!;
          // Convexity from original geometry: neighbor centroid below parent plane → mountain.
          const npx = normals[parent * 3], npy = normals[parent * 3 + 1], npz = normals[parent * 3 + 2];
          const wx = centroids[child * 3] - pos[rec.v0 * 3];
          const wy = centroids[child * 3 + 1] - pos[rec.v0 * 3 + 1];
          const wz = centroids[child * 3 + 2] - pos[rec.v0 * 3 + 2];
          const convex = npx * wx + npy * wy + npz * wz < 0;
          folds.push({
            islandIndex: nfc.islandIndex,
            a: seg[0],
            b: seg[1],
            type: convex ? "mountain" : "valley",
            angleDeg: Math.abs(nfc.flattenAngle) * (180 / Math.PI),
          });
        }
        continue;
      }
      // Cut pair: matched numbers, tab on one side.
      pairCount++;
      const id = pairCount;
      const [a1, b1] = directedEdgeUV(f, rec.v0, rec.v1);
      const [a2, b2] = directedEdgeUV(g, rec.v0, rec.v1);
      const tryTab = (face: number, a: Vec2, b: Vec2): Vec2[] | null => {
        for (const k of [1, 0.6, 0.35]) {
          const poly = buildTab(face, a, b, tabDepth * k);
          if (poly && tabFits(netFaces[face].islandIndex, poly)) return poly;
        }
        return null;
      };
      let tabF: Vec2[] | null = tryTab(f, a1, b1);
      let tabG: Vec2[] | null = tabF ? null : tryTab(g, a2, b2);
      if (tabF || tabG) tabCount++;
      cuts.push({ islandIndex: netFaces[f].islandIndex, faceIndex: f, a: a1, b: b1, pairId: id, tab: tabF });
      cuts.push({ islandIndex: netFaces[g].islandIndex, faceIndex: g, a: a2, b: b2, pairId: id, tab: tabG });
      if (tabF) markTab(islandGrids[netFaces[f].islandIndex], tabF);
      if (tabG) markTab(islandGrids[netFaces[g].islandIndex], tabG);
    } else {
      // Boundary or non-manifold: plain cut on every adjacent face.
      for (const f of rec.faces) {
        const [a, b] = directedEdgeUV(f, rec.v0, rec.v1);
        cuts.push({ islandIndex: netFaces[f].islandIndex, faceIndex: f, a, b, pairId: null, tab: null });
      }
    }
  }

  // ------------------------------------------------------------------
  // Per-island best rotation + bbox (tabs included via padding at layout).
  // ------------------------------------------------------------------
  for (const island of islands) {
    const pts: Vec2[] = [];
    for (const f of island.faceOrder) for (const p of netFaces[f].uv) pts.push(p);
    for (const c of cuts) {
      if (c.islandIndex === island.index && c.tab) for (const p of c.tab) pts.push(p);
    }
    let best = Infinity;
    let bestRot = 0;
    for (let deg = 0; deg < 180; deg += 5) {
      const th = (deg * Math.PI) / 180;
      const c = Math.cos(th), s = Math.sin(th);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of pts) {
        const x = p.x * c - p.y * s;
        const y = p.x * s + p.y * c;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
      const area = (maxX - minX) * (maxY - minY);
      if (area < best) {
        best = area;
        bestRot = th;
        island.bboxMin = { x: minX, y: minY };
        island.bboxMax = { x: maxX, y: maxY };
      }
    }
    island.rotation = bestRot;
  }

  let maxDepth = 0;
  for (const nfc of netFaces) if (nfc.depth > maxDepth) maxDepth = nfc.depth;

  return { mesh, faces: netFaces, islands, folds, cuts, maxDepth, tabCount, pairCount, tabDepth };
}

function sameEdge(nfc: NetFace, v0: number, v1: number): boolean {
  return (
    (nfc.hingeA === v0 && nfc.hingeB === v1) || (nfc.hingeA === v1 && nfc.hingeB === v0)
  );
}

function markTab(grid: TriGrid, poly: Vec2[]): void {
  grid.add(shrinkTri(poly[0].x, poly[0].y, poly[1].x, poly[1].y, poly[2].x, poly[2].y, 0.05));
  grid.add(shrinkTri(poly[0].x, poly[0].y, poly[2].x, poly[2].y, poly[3].x, poly[3].y, 0.05));
}

/** Rotate a raw island-space point into layout space (rotation only, no offset). */
export function rotatePoint(p: Vec2, rotation: number): Vec2 {
  const c = Math.cos(rotation), s = Math.sin(rotation);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}

/**
 * Mesh decimation via quadric error metrics (Garland–Heckbert).
 * Real edge-collapse simplification with link-condition and normal-flip guards.
 */

import type { Mesh } from "./types";
import { normalizeInPlace } from "./mesh";

interface HeapItem {
  cost: number;
  v1: number;
  v2: number;
  ver1: number;
  ver2: number;
  px: number;
  py: number;
  pz: number;
  attempts: number;
}

class MinHeap {
  items: HeapItem[] = [];
  push(it: HeapItem) {
    const a = this.items;
    a.push(it);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].cost <= a[i].cost) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): HeapItem | undefined {
    const a = this.items;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l].cost < a[m].cost) m = l;
        if (r < a.length && a[r].cost < a[m].cost) m = r;
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

/** Simplify mesh to approximately targetFaces triangles. */
export async function simplifyMesh(
  mesh: Mesh,
  targetFaces: number,
  onProgress?: (fraction: number) => void
): Promise<Mesh> {
  const nv = mesh.positions.length / 3;
  const nf0 = mesh.faces.length / 3;
  if (nf0 <= targetFaces) return mesh;

  const pos = new Float64Array(mesh.positions);
  const faces = new Int32Array(mesh.faces);
  const faceAlive = new Uint8Array(nf0).fill(1);
  const vertAlive = new Uint8Array(nv).fill(1);
  const version = new Int32Array(nv);
  const quad = new Float64Array(nv * 10); // q00 q01 q02 q03 q11 q12 q13 q22 q23 q33
  const vertFaces: number[][] = Array.from({ length: nv }, () => []);

  const n = [0, 0, 0];
  const faceNormalOf = (f: number, out: number[], override?: { v: number; x: number; y: number; z: number }): number => {
    let a = faces[f * 3], b = faces[f * 3 + 1], c = faces[f * 3 + 2];
    const gx = (v: number, k: number) =>
      override && v === override.v ? (k === 0 ? override.x : k === 1 ? override.y : override.z) : pos[v * 3 + k];
    const ax = gx(a, 0), ay = gx(a, 1), az = gx(a, 2);
    const ux = gx(b, 0) - ax, uy = gx(b, 1) - ay, uz = gx(b, 2) - az;
    const vx = gx(c, 0) - ax, vy = gx(c, 1) - ay, vz = gx(c, 2) - az;
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const len = Math.hypot(cx, cy, cz);
    if (len < 1e-30) {
      out[0] = out[1] = out[2] = 0;
      return 0;
    }
    out[0] = cx / len; out[1] = cy / len; out[2] = cz / len;
    return len / 2; // area
  };

  const addPlaneQuadric = (v: number, a: number, b: number, c: number, d: number, w: number) => {
    const q = quad, o = v * 10;
    q[o] += w * a * a; q[o + 1] += w * a * b; q[o + 2] += w * a * c; q[o + 3] += w * a * d;
    q[o + 4] += w * b * b; q[o + 5] += w * b * c; q[o + 6] += w * b * d;
    q[o + 7] += w * c * c; q[o + 8] += w * c * d;
    q[o + 9] += w * d * d;
  };

  // Face quadrics.
  for (let f = 0; f < nf0; f++) {
    const area = faceNormalOf(f, n);
    const a = faces[f * 3], b = faces[f * 3 + 1], c = faces[f * 3 + 2];
    vertFaces[a].push(f); vertFaces[b].push(f); vertFaces[c].push(f);
    if (area === 0) continue;
    const d = -(n[0] * pos[a * 3] + n[1] * pos[a * 3 + 1] + n[2] * pos[a * 3 + 2]);
    addPlaneQuadric(a, n[0], n[1], n[2], d, area);
    addPlaneQuadric(b, n[0], n[1], n[2], d, area);
    addPlaneQuadric(c, n[0], n[1], n[2], d, area);
  }

  // Boundary constraint quadrics: keep open edges pinned.
  {
    const edgeCount = new Map<number, { a: number; b: number; f: number; count: number }>();
    for (let f = 0; f < nf0; f++) {
      for (let e = 0; e < 3; e++) {
        const a = faces[f * 3 + e], b = faces[f * 3 + ((e + 1) % 3)];
        const key = Math.min(a, b) * nv + Math.max(a, b);
        const rec = edgeCount.get(key);
        if (rec) rec.count++;
        else edgeCount.set(key, { a, b, f, count: 1 });
      }
    }
    for (const rec of edgeCount.values()) {
      if (rec.count !== 1) continue;
      // Plane through the edge, perpendicular to the face.
      faceNormalOf(rec.f, n);
      const ax = pos[rec.a * 3], ay = pos[rec.a * 3 + 1], az = pos[rec.a * 3 + 2];
      const ex = pos[rec.b * 3] - ax, ey = pos[rec.b * 3 + 1] - ay, ez = pos[rec.b * 3 + 2] - az;
      let px = ey * n[2] - ez * n[1], py = ez * n[0] - ex * n[2], pz = ex * n[1] - ey * n[0];
      const len = Math.hypot(px, py, pz);
      if (len < 1e-30) continue;
      px /= len; py /= len; pz /= len;
      const d = -(px * ax + py * ay + pz * az);
      const w = (ex * ex + ey * ey + ez * ez) * 100;
      addPlaneQuadric(rec.a, px, py, pz, d, w);
      addPlaneQuadric(rec.b, px, py, pz, d, w);
    }
  }

  const quadCost = (o1: number, o2: number, x: number, y: number, z: number): number => {
    const q = quad;
    const s = (i: number) => q[o1 + i] + q[o2 + i];
    return (
      s(0) * x * x + 2 * s(1) * x * y + 2 * s(2) * x * z + 2 * s(3) * x +
      s(4) * y * y + 2 * s(5) * y * z + 2 * s(6) * y +
      s(7) * z * z + 2 * s(8) * z +
      s(9)
    );
  };

  const target = { x: 0, y: 0, z: 0 };
  const computeTarget = (v1: number, v2: number): number => {
    const o1 = v1 * 10, o2 = v2 * 10;
    const q = quad;
    const a00 = q[o1] + q[o2], a01 = q[o1 + 1] + q[o2 + 1], a02 = q[o1 + 2] + q[o2 + 2];
    const a11 = q[o1 + 4] + q[o2 + 4], a12 = q[o1 + 5] + q[o2 + 5], a22 = q[o1 + 7] + q[o2 + 7];
    const b0 = -(q[o1 + 3] + q[o2 + 3]), b1 = -(q[o1 + 6] + q[o2 + 6]), b2 = -(q[o1 + 8] + q[o2 + 8]);
    const det =
      a00 * (a11 * a22 - a12 * a12) - a01 * (a01 * a22 - a12 * a02) + a02 * (a01 * a12 - a11 * a02);
    if (Math.abs(det) > 1e-12) {
      const inv = 1 / det;
      const detY =
        a00 * (b1 * a22 - a12 * b2) - a01 * (b0 * a22 - a02 * b2) + a02 * (b0 * a12 - a02 * b1);
      const detZ =
        a00 * (a11 * b2 - b1 * a12) - a01 * (a01 * b2 - b0 * a12) + a02 * (a01 * b1 - b0 * a11);
      const detX =
        b0 * (a11 * a22 - a12 * a12) - a01 * (b1 * a22 - b2 * a12) + a02 * (b1 * a12 - b2 * a11);
      target.x = detX * inv;
      target.y = detY * inv;
      target.z = detZ * inv;
      const sane =
        Number.isFinite(target.x) && Number.isFinite(target.y) && Number.isFinite(target.z) &&
        Math.abs(target.x) < 1e4 && Math.abs(target.y) < 1e4 && Math.abs(target.z) < 1e4;
      if (sane) return quadCost(o1, o2, target.x, target.y, target.z);
    }
    // Fallback: best of v1, v2, midpoint.
    let best = Infinity;
    const cand = [
      [pos[v1 * 3], pos[v1 * 3 + 1], pos[v1 * 3 + 2]],
      [pos[v2 * 3], pos[v2 * 3 + 1], pos[v2 * 3 + 2]],
      [
        (pos[v1 * 3] + pos[v2 * 3]) / 2,
        (pos[v1 * 3 + 1] + pos[v2 * 3 + 1]) / 2,
        (pos[v1 * 3 + 2] + pos[v2 * 3 + 2]) / 2,
      ],
    ];
    for (const [x, y, z] of cand) {
      const cst = quadCost(o1, o2, x, y, z);
      if (cst < best) {
        best = cst;
        target.x = x; target.y = y; target.z = z;
      }
    }
    return best;
  };

  const heap = new MinHeap();
  const pushEdge = (v1: number, v2: number, attempts = 0) => {
    if (v1 === v2 || !vertAlive[v1] || !vertAlive[v2]) return;
    const cost = computeTarget(v1, v2);
    heap.push({
      cost: cost * (1 + attempts * 0.5),
      v1, v2,
      ver1: version[v1], ver2: version[v2],
      px: target.x, py: target.y, pz: target.z,
      attempts,
    });
  };

  // Seed all edges.
  {
    const seen = new Set<number>();
    for (let f = 0; f < nf0; f++) {
      for (let e = 0; e < 3; e++) {
        const a = faces[f * 3 + e], b = faces[f * 3 + ((e + 1) % 3)];
        const key = Math.min(a, b) * nv + Math.max(a, b);
        if (seen.has(key)) continue;
        seen.add(key);
        pushEdge(Math.min(a, b), Math.max(a, b));
      }
    }
  }

  const neighborsOf = (v: number): Set<number> => {
    const out = new Set<number>();
    for (const f of vertFaces[v]) {
      if (!faceAlive[f]) continue;
      for (let k = 0; k < 3; k++) {
        const u = faces[f * 3 + k];
        if (u !== v) out.add(u);
      }
    }
    return out;
  };

  let faceCount = nf0;
  const nBefore = [0, 0, 0];
  const nAfter = [0, 0, 0];
  let iter = 0;
  const startExcess = nf0 - targetFaces;

  while (faceCount > targetFaces && heap.size > 0) {
    if (++iter % 4096 === 0) {
      onProgress?.(Math.min(0.99, (nf0 - faceCount) / startExcess));
      await new Promise((r) => setTimeout(r, 0));
    }
    const it = heap.pop()!;
    const { v1, v2 } = it;
    if (!vertAlive[v1] || !vertAlive[v2]) continue;
    if (version[v1] !== it.ver1 || version[v2] !== it.ver2) continue;

    // Faces on the collapsing edge.
    const dying: number[] = [];
    for (const f of vertFaces[v1]) {
      if (!faceAlive[f]) continue;
      const a = faces[f * 3], b = faces[f * 3 + 1], c = faces[f * 3 + 2];
      if (a === v2 || b === v2 || c === v2) dying.push(f);
    }
    if (dying.length === 0) continue; // not an edge anymore

    // Link condition: shared neighbors must be exactly the opposite vertices of dying faces.
    const opposite = new Set<number>();
    for (const f of dying) {
      for (let k = 0; k < 3; k++) {
        const u = faces[f * 3 + k];
        if (u !== v1 && u !== v2) opposite.add(u);
      }
    }
    const n1 = neighborsOf(v1);
    const n2 = neighborsOf(v2);
    let linkOK = true;
    for (const u of n1) {
      if (u !== v2 && n2.has(u) && !opposite.has(u)) {
        linkOK = false;
        break;
      }
    }
    if (!linkOK) {
      if (it.attempts < 4) pushEdge(v1, v2, it.attempts + 1);
      continue;
    }

    // Normal-flip / degeneracy guard on surviving faces around both vertices.
    let flip = false;
    const checkFaces = (v: number, other: number) => {
      for (const f of vertFaces[v]) {
        if (flip || !faceAlive[f]) continue;
        const a = faces[f * 3], b = faces[f * 3 + 1], c = faces[f * 3 + 2];
        if (a === other || b === other || c === other) continue; // dying
        const areaB = faceNormalOf(f, nBefore);
        const areaA = faceNormalOf(f, nAfter, { v, x: it.px, y: it.py, z: it.pz });
        if (areaB === 0) continue;
        if (areaA < areaB * 1e-6) {
          flip = true;
          continue;
        }
        const dot = nBefore[0] * nAfter[0] + nBefore[1] * nAfter[1] + nBefore[2] * nAfter[2];
        if (dot < 0.15) flip = true;
      }
    };
    checkFaces(v1, v2);
    checkFaces(v2, v1);
    if (flip) {
      if (it.attempts < 4) pushEdge(v1, v2, it.attempts + 1);
      continue;
    }

    // Perform collapse: v2 -> v1, v1 moves to target.
    pos[v1 * 3] = it.px; pos[v1 * 3 + 1] = it.py; pos[v1 * 3 + 2] = it.pz;
    for (let k = 0; k < 10; k++) quad[v1 * 10 + k] += quad[v2 * 10 + k];
    for (const f of dying) {
      faceAlive[f] = 0;
      faceCount--;
    }
    for (const f of vertFaces[v2]) {
      if (!faceAlive[f]) continue;
      for (let k = 0; k < 3; k++) if (faces[f * 3 + k] === v2) faces[f * 3 + k] = v1;
      vertFaces[v1].push(f);
    }
    vertAlive[v2] = 0;
    vertFaces[v2] = [];
    version[v1]++;
    version[v2]++;
    // Occasionally prune dead faces from the incidence list to stay fast.
    if (vertFaces[v1].length > 32) {
      vertFaces[v1] = vertFaces[v1].filter((f) => faceAlive[f]);
    }
    // Re-queue edges around the surviving vertex.
    for (const u of neighborsOf(v1)) {
      version[u]++;
      pushEdge(Math.min(v1, u), Math.max(v1, u));
    }
  }

  onProgress?.(1);

  // Compact.
  const remap = new Int32Array(nv).fill(-1);
  const outPos: number[] = [];
  const outFaces: number[] = [];
  for (let f = 0; f < nf0; f++) {
    if (!faceAlive[f]) continue;
    const tri: number[] = [];
    for (let k = 0; k < 3; k++) {
      const v = faces[f * 3 + k];
      if (remap[v] === -1) {
        remap[v] = outPos.length / 3;
        outPos.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
      }
      tri.push(remap[v]);
    }
    if (tri[0] !== tri[1] && tri[1] !== tri[2] && tri[0] !== tri[2]) outFaces.push(...tri);
  }
  const positions = new Float64Array(outPos);
  normalizeInPlace(positions);
  return {
    positions,
    faces: new Uint32Array(outFaces),
    name: mesh.name,
    source: mesh.source,
  };
}

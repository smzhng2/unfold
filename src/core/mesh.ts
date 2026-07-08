/** Mesh construction: welding, normalization, topology analysis. */

import type { Mesh, MeshSource, MeshStats } from "./types";
import type { TriangleSoup } from "./stl";

/** Weld a triangle soup into an indexed mesh, drop degenerate faces, normalize scale. */
export function buildMesh(soup: TriangleSoup, name: string, source: MeshSource): Mesh {
  const { positions: raw, triangleCount } = soup;
  if (triangleCount === 0) throw new Error("No triangles found in file.");

  // Bounding box for weld tolerance + normalization.
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < triangleCount * 9; i += 3) {
    const x = raw[i], y = raw[i + 1], z = raw[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;
  const tol = diag * 1e-6;

  const map = new Map<string, number>();
  const verts: number[] = [];
  const faces: number[] = [];
  const idx = new Int32Array(3);

  for (let t = 0; t < triangleCount; t++) {
    for (let c = 0; c < 3; c++) {
      const o = t * 9 + c * 3;
      const x = raw[o], y = raw[o + 1], z = raw[o + 2];
      const key = `${Math.round(x / tol)}_${Math.round(y / tol)}_${Math.round(z / tol)}`;
      let vi = map.get(key);
      if (vi === undefined) {
        vi = verts.length / 3;
        map.set(key, vi);
        verts.push(x, y, z);
      }
      idx[c] = vi;
    }
    if (idx[0] === idx[1] || idx[1] === idx[2] || idx[0] === idx[2]) continue;
    // Drop near-zero-area slivers (they poison unfolding).
    const area = triAreaFromVerts(verts, idx[0], idx[1], idx[2]);
    if (area < (diag * 1e-7) ** 2) continue;
    faces.push(idx[0], idx[1], idx[2]);
  }
  if (faces.length === 0) throw new Error("All triangles were degenerate.");

  const positions = new Float64Array(verts);
  const faceArr = new Uint32Array(faces);
  fixWinding(positions, faceArr);
  normalizeInPlace(positions);
  return { positions, faces: faceArr, name, source };
}

/**
 * Make triangle winding consistent per connected component (BFS across manifold
 * edges), then orient closed components outward via signed volume. STL files are
 * usually fine, but this makes mountain/valley classification robust.
 */
export function fixWinding(positions: Float64Array, faces: Uint32Array): void {
  const nf = faces.length / 3;
  const nv = positions.length / 3;
  // Undirected edge -> faces.
  const edgeFaces = new Map<number, number[]>();
  for (let f = 0; f < nf; f++) {
    for (let e = 0; e < 3; e++) {
      const a = faces[f * 3 + e], b = faces[f * 3 + ((e + 1) % 3)];
      const key = Math.min(a, b) * nv + Math.max(a, b);
      let arr = edgeFaces.get(key);
      if (!arr) edgeFaces.set(key, (arr = []));
      arr.push(f);
    }
  }
  const hasDirectedEdge = (f: number, a: number, b: number): boolean => {
    for (let e = 0; e < 3; e++) {
      if (faces[f * 3 + e] === a && faces[f * 3 + ((e + 1) % 3)] === b) return true;
    }
    return false;
  };
  const flipFace = (f: number) => {
    const tmp = faces[f * 3 + 1];
    faces[f * 3 + 1] = faces[f * 3 + 2];
    faces[f * 3 + 2] = tmp;
  };
  const visited = new Uint8Array(nf);
  const queue: number[] = [];
  for (let seed = 0; seed < nf; seed++) {
    if (visited[seed]) continue;
    const component: number[] = [];
    visited[seed] = 1;
    queue.length = 0;
    queue.push(seed);
    while (queue.length) {
      const f = queue.pop()!;
      component.push(f);
      for (let e = 0; e < 3; e++) {
        const a = faces[f * 3 + e], b = faces[f * 3 + ((e + 1) % 3)];
        const key = Math.min(a, b) * nv + Math.max(a, b);
        const adj = edgeFaces.get(key)!;
        if (adj.length !== 2) continue; // only propagate across manifold edges
        const g = adj[0] === f ? adj[1] : adj[0];
        if (visited[g]) continue;
        visited[g] = 1;
        // Consistent winding means g holds the reversed directed edge (b -> a).
        if (hasDirectedEdge(g, a, b)) flipFace(g);
        queue.push(g);
      }
    }
    // Orient outward: positive signed volume (only meaningful when mostly closed).
    let vol = 0;
    for (const f of component) {
      const a = faces[f * 3], b = faces[f * 3 + 1], c = faces[f * 3 + 2];
      const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
      const bx = positions[b * 3], by = positions[b * 3 + 1], bz = positions[b * 3 + 2];
      const cx = positions[c * 3], cy = positions[c * 3 + 1], cz = positions[c * 3 + 2];
      vol += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
    }
    if (vol < 0) for (const f of component) flipFace(f);
  }
}

/** Center at bbox center, scale so the longest axis spans 2 units. */
export function normalizeInPlace(positions: Float64Array): void {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
  const maxDim = Math.max(maxX - minX, maxY - minY, maxZ - minZ) || 1;
  const s = 2 / maxDim;
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = (positions[i] - cx) * s;
    positions[i + 1] = (positions[i + 1] - cy) * s;
    positions[i + 2] = (positions[i + 2] - cz) * s;
  }
}

function triAreaFromVerts(verts: number[], a: number, b: number, c: number): number {
  const ax = verts[a * 3], ay = verts[a * 3 + 1], az = verts[a * 3 + 2];
  const ux = verts[b * 3] - ax, uy = verts[b * 3 + 1] - ay, uz = verts[b * 3 + 2] - az;
  const vx = verts[c * 3] - ax, vy = verts[c * 3 + 1] - ay, vz = verts[c * 3 + 2] - az;
  const cx = uy * vz - uz * vy, cy2 = uz * vx - ux * vz, cz = ux * vy - uy * vx;
  return 0.5 * Math.hypot(cx, cy2, cz);
}

export function faceArea(mesh: Mesh, f: number): number {
  const [a, b, c] = [mesh.faces[f * 3], mesh.faces[f * 3 + 1], mesh.faces[f * 3 + 2]];
  const p = mesh.positions;
  const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
  const ux = p[b * 3] - ax, uy = p[b * 3 + 1] - ay, uz = p[b * 3 + 2] - az;
  const vx = p[c * 3] - ax, vy = p[c * 3 + 1] - ay, vz = p[c * 3 + 2] - az;
  const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
  return 0.5 * Math.hypot(cx, cy, cz);
}

export function faceNormal(mesh: Mesh, f: number, out: number[]): void {
  const [a, b, c] = [mesh.faces[f * 3], mesh.faces[f * 3 + 1], mesh.faces[f * 3 + 2]];
  const p = mesh.positions;
  const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
  const ux = p[b * 3] - ax, uy = p[b * 3 + 1] - ay, uz = p[b * 3 + 2] - az;
  const vx = p[c * 3] - ax, vy = p[c * 3 + 1] - ay, vz = p[c * 3 + 2] - az;
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  out[0] = nx / len; out[1] = ny / len; out[2] = nz / len;
}

export interface EdgeRecord {
  v0: number; // min vertex id
  v1: number; // max vertex id
  faces: number[]; // adjacent face indices
}

export interface Topology {
  /** All unique edges. */
  edges: EdgeRecord[];
  /** edgeKey (v0*V+v1 with v0<v1) -> index into edges. */
  edgeIndex: Map<number, number>;
  /** Per face: 3 edge ids for edges (0-1, 1-2, 2-0). */
  faceEdges: Int32Array;
}

export function buildTopology(mesh: Mesh): Topology {
  const nf = mesh.faces.length / 3;
  const nv = mesh.positions.length / 3;
  const edgeIndex = new Map<number, number>();
  const edges: EdgeRecord[] = [];
  const faceEdges = new Int32Array(nf * 3);
  for (let f = 0; f < nf; f++) {
    for (let e = 0; e < 3; e++) {
      const a = mesh.faces[f * 3 + e];
      const b = mesh.faces[f * 3 + ((e + 1) % 3)];
      const v0 = Math.min(a, b), v1 = Math.max(a, b);
      const key = v0 * nv + v1;
      let ei = edgeIndex.get(key);
      if (ei === undefined) {
        ei = edges.length;
        edgeIndex.set(key, ei);
        edges.push({ v0, v1, faces: [] });
      }
      edges[ei].faces.push(f);
      faceEdges[f * 3 + e] = ei;
    }
  }
  return { edges, edgeIndex, faceEdges };
}

export function computeStats(mesh: Mesh, topo?: Topology): MeshStats {
  const t = topo ?? buildTopology(mesh);
  let boundary = 0, nonManifold = 0;
  for (const e of t.edges) {
    if (e.faces.length === 1) boundary++;
    else if (e.faces.length > 2) nonManifold++;
  }
  // Connected components over face adjacency.
  const nf = mesh.faces.length / 3;
  const seen = new Uint8Array(nf);
  let components = 0;
  const stack: number[] = [];
  for (let f = 0; f < nf; f++) {
    if (seen[f]) continue;
    components++;
    stack.push(f);
    seen[f] = 1;
    while (stack.length) {
      const cur = stack.pop()!;
      for (let e = 0; e < 3; e++) {
        const rec = t.edges[t.faceEdges[cur * 3 + e]];
        if (rec.faces.length === 2) {
          const other = rec.faces[0] === cur ? rec.faces[1] : rec.faces[0];
          if (!seen[other]) {
            seen[other] = 1;
            stack.push(other);
          }
        }
      }
    }
  }
  return {
    vertices: mesh.positions.length / 3,
    faces: nf,
    boundaryEdges: boundary,
    nonManifoldEdges: nonManifold,
    components,
    watertight: boundary === 0 && nonManifold === 0,
  };
}

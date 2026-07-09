/** Wavefront OBJ parsing into a raw triangle soup (geometry only; materials/UVs ignored). */

import type { TriangleSoup } from "./stl";

export function parseOBJ(text: string): TriangleSoup {
  const verts: number[] = [];
  const tris: number[] = [];

  const resolve = (idx: number): number => {
    // OBJ indices are 1-based; negative indices count back from the end.
    const vi = idx > 0 ? idx - 1 : verts.length / 3 + idx;
    return vi;
  };

  const pushCorner = (vi: number) => {
    tris.push(verts[vi * 3], verts[vi * 3 + 1], verts[vi * 3 + 2]);
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line[0] === "#") continue;

    if (line.startsWith("v ")) {
      const parts = line.slice(2).trim().split(/\s+/);
      verts.push(parseFloat(parts[0]), parseFloat(parts[1]), parseFloat(parts[2]));
    } else if (line.startsWith("f ")) {
      const parts = line.slice(2).trim().split(/\s+/);
      // Each corner is v, v/vt, v//vn, or v/vt/vn — we only need the vertex index.
      const corners: number[] = [];
      for (const p of parts) {
        const idx = parseInt(p, 10); // parseInt stops at the first "/"
        if (!Number.isFinite(idx)) continue;
        const vi = resolve(idx);
        if (vi >= 0 && vi * 3 + 2 < verts.length) corners.push(vi);
      }
      // Fan-triangulate quads and n-gons.
      for (let i = 1; i + 1 < corners.length; i++) {
        pushCorner(corners[0]);
        pushCorner(corners[i]);
        pushCorner(corners[i + 1]);
      }
    }
    // vt, vn, o, g, s, usemtl, mtllib: ignored — Unfold only needs geometry.
  }

  const triangleCount = Math.floor(tris.length / 9);
  if (triangleCount === 0) {
    throw new Error("No faces found — is this a valid OBJ file with 'f' lines?");
  }
  return { positions: new Float64Array(tris.slice(0, triangleCount * 9)), triangleCount };
}

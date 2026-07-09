/**
 * Headless pipeline verification: builds sample meshes plus a synthetic STL,
 * unfolds them, checks geometric invariants, and renders real PDFs to disk.
 * Run: npx tsx scripts/verify.ts
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { SAMPLES } from "../src/core/samples";
import { parseSTL } from "../src/core/stl";
import { parseOBJ } from "../src/core/obj";
import { buildMesh, computeStats, buildTopology } from "../src/core/mesh";
import { simplifyMesh } from "../src/core/simplify";
import { unfoldMesh, trianglesOverlap } from "../src/core/unfold";
import { renderPDF, maxSizeCm } from "../src/core/pdf";
import { animationLayout } from "../src/core/layout";
import type { Mesh, NetResult } from "../src/core/types";

const OUT = process.argv[2] ?? "verify-out";
mkdirSync(OUT, { recursive: true });

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) {
    failures++;
    console.error(`  ✗ ${msg}`);
  }
};

function verifyNet(mesh: Mesh, net: NetResult, label: string) {
  const nf = mesh.faces.length / 3;
  check(net.faces.length === nf && net.faces.every(Boolean), `${label}: every face placed`);

  // Edge accounting: tree edges (folds incl. flat ones) + cut pairs + boundary sides = all edges.
  const topo = buildTopology(mesh);
  let manifold = 0, boundaryish = 0;
  for (const e of topo.edges) {
    if (e.faces.length === 2) manifold++;
    else boundaryish += e.faces.length;
  }
  const treeEdges = net.faces.filter((f) => f.parent >= 0).length;
  check(
    treeEdges + net.pairCount === manifold,
    `${label}: tree(${treeEdges}) + pairs(${net.pairCount}) = manifold(${manifold})`
  );
  const boundaryCuts = net.cuts.filter((c) => c.pairId === null).length;
  check(boundaryCuts === boundaryish, `${label}: boundary cuts ${boundaryCuts} = ${boundaryish}`);

  // Rigidity: every flattened face keeps its 3D edge lengths.
  let worst = 0;
  for (let f = 0; f < nf; f++) {
    const uv = net.faces[f].uv;
    for (let k = 0; k < 3; k++) {
      const a = mesh.faces[f * 3 + k], b = mesh.faces[f * 3 + ((k + 1) % 3)];
      const len3 = Math.hypot(
        mesh.positions[b * 3] - mesh.positions[a * 3],
        mesh.positions[b * 3 + 1] - mesh.positions[a * 3 + 1],
        mesh.positions[b * 3 + 2] - mesh.positions[a * 3 + 2]
      );
      const p = uv[k], q = uv[(k + 1) % 3];
      const len2 = Math.hypot(q.x - p.x, q.y - p.y);
      worst = Math.max(worst, Math.abs(len3 - len2));
    }
  }
  check(worst < 1e-9, `${label}: flattening is isometric (worst edge error ${worst.toExponential(2)})`);

  // No two faces of the same island overlap (the guarantee that makes nets printable).
  let overlaps = 0;
  for (const island of net.islands) {
    const tris = island.faceOrder.map((f) => {
      const uv = net.faces[f].uv;
      const gx = (uv[0].x + uv[1].x + uv[2].x) / 3;
      const gy = (uv[0].y + uv[1].y + uv[2].y) / 3;
      const s = 0.99; // more lenient than the unfolder's own test, so any hit is a real defect
      return [
        gx + (uv[0].x - gx) * s, gy + (uv[0].y - gy) * s,
        gx + (uv[1].x - gx) * s, gy + (uv[1].y - gy) * s,
        gx + (uv[2].x - gx) * s, gy + (uv[2].y - gy) * s,
      ] as [number, number, number, number, number, number];
    });
    for (let i = 0; i < tris.length; i++) {
      for (let j = i + 1; j < tris.length; j++) {
        if (trianglesOverlap(tris[i], tris[j])) overlaps++;
      }
    }
  }
  check(overlaps === 0, `${label}: no overlapping faces in any island (${overlaps} found)`);

  // NaN sweep.
  let nan = false;
  for (const f of net.faces) for (const p of f.uv) if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) nan = true;
  check(!nan, `${label}: no NaN coordinates`);

  // Animation layout works.
  const layout = animationLayout(net);
  check(layout.placements.length === net.islands.length, `${label}: animation layout places every island`);
}

async function main() {
  // 1) Samples.
  for (const s of SAMPLES) {
    const mesh = s.build();
    const stats = computeStats(mesh);
    console.log(`\n■ ${s.name}: ${stats.faces} faces, watertight=${stats.watertight}`);
    const net = unfoldMesh(mesh);
    console.log(
      `  islands=${net.islands.length} folds=${net.folds.length} pairs=${net.pairCount} tabs=${net.tabCount} maxDepth=${net.maxDepth}`
    );
    verifyNet(mesh, net, s.name);
    const doc = renderPDF(net, { format: "a4", targetSizeCm: Math.min(12, maxSizeCm(net, "a4")) });
    const file = join(OUT, `${s.id}.pdf`);
    writeFileSync(file, Buffer.from(doc.output("arraybuffer")));
    console.log(`  ✓ PDF written: ${file}`);
  }

  // 2) Synthetic binary STL round-trip (tetrahedron).
  {
    const verts = [
      [1, 1, 1], [-1, -1, 1], [-1, 1, -1], [1, -1, -1],
    ];
    const faces = [
      [0, 1, 2], [0, 3, 1], [0, 2, 3], [1, 3, 2],
    ];
    const buf = new ArrayBuffer(84 + 50 * faces.length);
    const view = new DataView(buf);
    view.setUint32(80, faces.length, true);
    let o = 84;
    for (const f of faces) {
      o += 12;
      for (const vi of f) {
        view.setFloat32(o, verts[vi][0], true);
        view.setFloat32(o + 4, verts[vi][1], true);
        view.setFloat32(o + 8, verts[vi][2], true);
        o += 12;
      }
      o += 2;
    }
    const soup = parseSTL(buf);
    check(soup.triangleCount === 4, "STL: parsed 4 triangles");
    const mesh = buildMesh(soup, "tetra", "stl");
    const stats = computeStats(mesh);
    console.log(`\n■ STL tetrahedron: ${stats.faces} faces, watertight=${stats.watertight}`);
    check(stats.watertight, "STL: tetra watertight after weld");
    const net = unfoldMesh(mesh);
    verifyNet(mesh, net, "tetra");
    console.log(`  islands=${net.islands.length} folds=${net.folds.length}`);
  }

  // 3) Synthetic OBJ round-trip (quad cube — exercises fan triangulation,
  //    v/vt/vn corner syntax, and negative indices).
  {
    const objText = [
      "# unit cube, quad faces",
      "v -1 -1 -1", "v 1 -1 -1", "v 1 1 -1", "v -1 1 -1",
      "v -1 -1 1", "v 1 -1 1", "v 1 1 1", "v -1 1 1",
      "vt 0 0", "vn 0 0 1",
      "f 1/1/1 2/1/1 3/1/1 4/1/1",
      "f 5//1 8//1 7//1 6//1",
      "f 1/1 5/1 6/1 2/1",
      "f 2 6 7 3",
      "f 3 7 8 4",
      "f -8 -4 -1 -5", // negative indices: 1 5 8 4
    ].join("\n");
    const soup = parseOBJ(objText);
    check(soup.triangleCount === 12, `OBJ: 6 quads -> 12 triangles (got ${soup.triangleCount})`);
    const mesh = buildMesh(soup, "obj cube", "stl");
    const stats = computeStats(mesh);
    console.log(`\n■ OBJ quad cube: ${stats.faces} faces, watertight=${stats.watertight}`);
    check(stats.watertight, "OBJ: cube watertight after weld");
    const net = unfoldMesh(mesh);
    verifyNet(mesh, net, "obj cube");
  }

  // 4) Simplification: dense sphere -> 200 faces -> unfold.
  {
    const THREE = await import("three");
    const geo = new THREE.SphereGeometry(1, 48, 32).toNonIndexed();
    const arr = geo.getAttribute("position").array as Float32Array;
    const mesh = buildMesh(
      { positions: Float64Array.from(arr), triangleCount: arr.length / 9 },
      "dense sphere",
      "sample"
    );
    const before = mesh.faces.length / 3;
    const simp = await simplifyMesh(mesh, 200);
    const after = simp.faces.length / 3;
    const stats = computeStats(simp);
    console.log(`\n■ QEM simplify: ${before} -> ${after} faces, watertight=${stats.watertight}`);
    check(after <= 220, `simplify reached target (${after})`);
    check(stats.watertight, "simplified sphere still watertight");
    const net = unfoldMesh(simp);
    verifyNet(simp, net, "simplified sphere");
    console.log(`  islands=${net.islands.length} folds=${net.folds.length} tabs=${net.tabCount}`);
    const doc = renderPDF(net, { format: "a4", targetSizeCm: Math.min(10, maxSizeCm(net, "a4")) });
    const file = join(OUT, "simplified-sphere.pdf");
    writeFileSync(file, Buffer.from(doc.output("arraybuffer")));
    console.log(`  ✓ PDF written: ${file}`);
  }

  console.log(failures === 0 ? "\nAll checks passed ✓" : `\n${failures} CHECK(S) FAILED ✗`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

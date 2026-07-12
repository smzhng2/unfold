# Unfold

Turns a 3D model into printable papercraft: cut lines, mountain/valley fold
lines, and numbered glue tabs on a PDF, plus a 3D viewer that animates the
real unfolding (every face rotates about its true hinge edge) and then flies
the flattened pieces onto virtual paper sheets. Runs entirely client-side —
no backend, nothing uploaded.

Tagline shown in the UI: **Print. Fold. Glue.**

## Stack

React 18 + TypeScript + Vite. three.js for the 3D viewer, jsPDF for vector
export, `@huggingface/transformers` (transformers.js) for in-browser depth
estimation. No backend, no database, no auth.

```
npm run dev      # vite dev server, http://localhost:5173
npm run build    # tsc -b && vite build
npx tsx scripts/verify.ts [outDir]   # headless pipeline check, see below
```

## Entry flow

`src/App.tsx` switches between three views: `Landing` → `Workspace` (once a
mesh is loaded) or `PhotoFlow` (photo → mesh, then also lands in
`Workspace`). Meshes come from three sources: an uploaded model file
(`.stl` or `.obj`), a procedural sample (`src/core/samples.ts`), or a
photo-derived relief (`src/core/depth.ts`). All three converge on the same `Mesh` type and the
same `Workspace` component.

## Core geometry pipeline (`src/core/`)

Everything here is pure, framework-free TypeScript operating on a shared
`Mesh` = `{ positions: Float64Array, faces: Uint32Array }` (see `types.ts`
for the full type map — `Mesh`, `NetFace`, `Island`, `NetResult`,
`LayoutResult`, etc.).

1. **`stl.ts`** — parses binary and ASCII STL into a raw triangle soup.
   **`obj.ts`** — parses Wavefront OBJ into the same soup (fan-triangulates
   quads/n-gons, handles `v/vt/vn` corner syntax and negative indices;
   materials and UVs are currently ignored — geometry only).
2. **`mesh.ts`** — welds the soup into an indexed mesh, drops degenerate
   triangles, normalizes scale (longest bbox axis = 2 units), repairs
   triangle winding per connected component (BFS across manifold edges +
   signed-volume orientation), and builds edge/topology tables
   (`buildTopology`, `computeStats` for watertight/boundary/non-manifold
   reporting).
3. **`simplify.ts`** — real quadric-error-metric (QEM) edge-collapse
   decimation (Garland–Heckbert), with a min-heap of candidate edges, a link
   condition check, and a normal-flip guard, plus boundary-preserving plane
   quadrics so open meshes don't shrink at their edges. Async with a
   progress callback; yields to the event loop periodically so the UI stays
   responsive on large meshes.
4. **`unfold.ts`** — the heart of the app. Grows a spanning tree over the
   face-adjacency graph starting from a seed face, flattening each new face
   into the root's plane by rotating rigidly about the shared hinge edge
   (exact affine transforms, not approximations — see the verification
   invariant below). A candidate priority queue prefers flat hinges first
   (compact strips). Each candidate placement is tested for 2D overlap
   against everything already placed in that island via a uniform spatial
   grid (`TriGrid` + real triangle-triangle intersection, `trianglesOverlap`,
   which is also exported for use in tests). If placing a face would
   overlap, it's *not* forced into a new island immediately — the outer loop
   just starts a fresh island from the next unplaced seed face, so islands
   emerge organically. Two caps exist: `MAX_UNFOLD_FACES` (2000 — mesh-level,
   throws `UnfoldError` above this) and `MAX_ISLAND_FACES` (90 — a single
   island stops growing past this so pieces stay printable-size and
   glueable; remaining faces spill into new islands). After placement, edges
   are classified as **fold** (tree edges, tagged mountain/valley by comparing
   the neighbor's centroid against the parent's normal) or **cut** (all
   non-tree manifold edges, which get a matched pair number and a glue tab
   on whichever side has room, tried at decreasing tab depth) or **boundary**
   (non-manifold/open edges — plain cut, no tab, no pair). Finally each
   island is rotated to its minimum-bounding-box orientation for packing.
5. **`layout.ts`** — shelf-packs islands onto pages. `packIslands` is the
   general packer (used by both the PDF export and, at scale 1, by the 3D
   animation's virtual paper sheets via `animationLayout`).
   `maxScaleFor` finds the largest print scale where every island still
   fits one page.
6. **`pdf.ts`** — vector PDF export via jsPDF. Draws tab fills, solid cut
   lines, dashed valley / dash-dot mountain fold lines, and matching edge
   numbers, paginated per `layout.ts`. `renderPDF` builds the `jsPDF` object
   without saving it (used by the headless verify script); `exportPDF` wraps
   it and triggers a download.
7. **`depth.ts`** — photo mode. Loads Depth Anything V2
   (`onnx-community/depth-anything-v2-small`) via transformers.js, WebGPU
   with WASM fallback. `sampleGrid` downsamples the depth map to a grid,
   applies a cutoff, and keeps only the largest connected component (so
   background specks don't survive). `meshFromDepth` extrudes the surviving
   cells into a watertight relief mesh (front face at estimated depth, flat
   back face, walls closing every open edge) — explicitly *not* a full
   360° reconstruction; the UI is upfront about this being a relief, like a
   chocolate mold.

## 3D viewer (`src/three/viewer.ts`)

`UnfoldViewer` is a plain class (not a React component) that owns the
three.js scene, camera, and render loop; `Workspace.tsx` mounts it into a
ref'd div. Two display modes:

- `setMesh(mesh)` — shows the solid model, auto-rotating.
- `setNet(net, layout)` — shows the animated unfold. The animation parameter
  `t` runs 0→2: **0→1** is the true per-face hinge rotation (staggered by
  tree depth so children start folding after their parents, easing per
  face), **1→2** is a rigid per-island transform from the flattened pose to
  its position on a virtual paper sheet (computed by fitting a rotation
  from three reference points on the root face), with the camera blending
  to a top-down view over the same range. `seek(t)` scrubs directly;
  `play()`/`playBack()`/`pause()` animate `t` over time.

Geometry is written into `DynamicDrawUsage` buffer attributes every frame
(`applyT`) — there's no per-face mesh objects, just one flat/interleaved
buffer recomputed from each face's current matrix, plus separate line
segment buffers for cut/mountain/valley overlays.

## UI (`src/ui/`)

- `Landing.tsx` — drop zone for STL/OBJ, photo-mode entry, sample picker,
  Community link in the topbar.
- `Community.tsx` — "Community creations" gallery. Sharing is NOT live:
  the accounts/creations are placeholders defined in
  `src/core/community.ts` (fictional authors, procedurally built models —
  including two gallery-only meshes, a star prism and a hexagonal
  crystal). Every card opens as a real mesh in `Workspace`. Thumbnails are
  rendered at mount via a shared offscreen WebGL renderer
  (`renderThumbnail`), one frame per model, cached per session. The UI
  banner explicitly says sharing/uploads are coming — keep that honesty
  if you touch this.
- `Workspace.tsx` — the main app: viewer + right-hand panel with model
  stats, simplify slider, unfold button, fold-animation transport, and PDF
  export controls (paper size, finished-size slider clamped to
  `maxSizeCm`).
- `PhotoFlow.tsx` — photo upload → depth estimation (with progress) → mask
  cutoff/relief-depth/detail tuning with a live canvas preview → build mesh
  → hands off to `Workspace`.

Design language: paper-white studio aesthetic (see `styles.css` — CSS
custom properties for the palette, `Instrument Serif` for display type,
`Inter` for UI text, `JetBrains Mono` for numbers).

## Verification

`scripts/verify.ts` is a headless (non-browser) script that builds every
sample plus a synthetic STL, unfolds them, and asserts hard invariants:
every face gets placed, edge accounting is exact (tree edges + pairs =
manifold edges, boundary cuts = boundary/non-manifold edge count),
flattening is isometric (3D edge lengths match 2D edge lengths to <1e-9),
and no two faces within an island overlap (checked independently of the
unfolder's own overlap test, with a looser shrink tolerance, so it doesn't
just re-confirm the same code path). It also renders real PDFs to disk for
manual inspection. Run it after touching anything in `src/core/unfold.ts`,
`simplify.ts`, or `mesh.ts` — this is the fastest way to catch a regression
without opening a browser.

For UI/animation changes, there's no automated test — use the `run` /
preview tooling to actually load a sample, unfold it, scrub the animation
timeline, and download a PDF.

## Known constraints worth knowing before changing things

- `MAX_UNFOLD_FACES = 2000` and `MAX_ISLAND_FACES = 90` in `unfold.ts` are
  load-bearing product decisions (foldability and printable piece size),
  not arbitrary perf limits — don't raise them without also reconsidering
  print/build UX.
- The flattening math in `unfold.ts` must stay exactly isometric (rigid
  rotation about the hinge, nothing approximate) — that's what
  `scripts/verify.ts` checks and what makes the printed net actually
  buildable.
- `UnfoldViewer.applyT` rebuilds a *fresh* `THREE.Matrix4` per island per
  frame in the phase-2 loop — there was a real bug earlier from reusing one
  matrix instance across islands (aliasing crumpled multi-piece landings).
  Be careful with matrix/vector reuse in that hot path.
- This machine's `node_modules` is an NTFS junction to a `D:` drive (see
  the project memory) because `C:` was nearly full — don't be surprised
  it's not a normal folder, and don't `rm -rf` it carelessly.

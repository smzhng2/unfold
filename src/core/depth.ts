/**
 * Photo mode: monocular depth estimation (Depth Anything V2, running fully
 * in-browser via transformers.js) turned into a watertight relief mesh.
 *
 * Honest scope: one photo gives one viewpoint — the result is a "relief"
 * (like a chocolate mold), not a true all-around 3D model.
 */

import { pipeline, env } from "@huggingface/transformers";
import type { Mesh } from "./types";
import { buildMesh } from "./mesh";

export interface DepthMap {
  width: number;
  height: number;
  /** Normalized 0..1, higher = closer to camera. */
  data: Float32Array;
}

export type DepthProgress = (info: { label: string; fraction: number }) => void;

let depthPipe: unknown = null;
let loadPromise: Promise<void> | null = null;
export let depthBackend: "webgpu" | "wasm" | null = null;

export function loadDepthModel(onProgress?: DepthProgress): Promise<void> {
  if (depthPipe) return Promise.resolve();
  if (loadPromise) return loadPromise;

  env.allowLocalModels = false;

  const progressCb = (p: { status?: string; progress?: number; file?: string }) => {
    if (p.status === "progress" && typeof p.progress === "number") {
      onProgress?.({
        label: `Downloading depth model${p.file ? ` (${p.file.split("/").pop()})` : ""}`,
        fraction: Math.min(0.999, p.progress / 100),
      });
    }
  };

  loadPromise = (async () => {
    const model = "onnx-community/depth-anything-v2-small";
    try {
      depthPipe = await pipeline("depth-estimation", model, {
        device: "webgpu",
        progress_callback: progressCb,
      });
      depthBackend = "webgpu";
    } catch {
      depthPipe = await pipeline("depth-estimation", model, {
        device: "wasm",
        progress_callback: progressCb,
      });
      depthBackend = "wasm";
    }
    onProgress?.({ label: "Depth model ready", fraction: 1 });
  })();
  loadPromise.catch(() => {
    loadPromise = null;
  });
  return loadPromise;
}

export async function estimateDepth(imageUrl: string, onProgress?: DepthProgress): Promise<DepthMap> {
  await loadDepthModel(onProgress);
  onProgress?.({ label: "Estimating depth", fraction: 0.999 });
  const pipe = depthPipe as (url: string) => Promise<{ depth: { data: Uint8Array | Uint8ClampedArray; width: number; height: number } }>;
  const out = await pipe(imageUrl);
  const { data, width, height } = out.depth;
  const f = new Float32Array(width * height);
  let min = 255, max = 0;
  for (let i = 0; i < f.length; i++) {
    const v = data[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = Math.max(1, max - min);
  for (let i = 0; i < f.length; i++) f[i] = (data[i] - min) / range;
  return { width, height, data: f };
}

// ---------------------------------------------------------------------------
// Depth map -> relief mesh
// ---------------------------------------------------------------------------

export interface ReliefOptions {
  /** Cells along the longest image axis. */
  gridSize: number;
  /** Depth cutoff 0..1 — cells closer than this survive. */
  cutoff: number;
  /** Relief height as a fraction of the subject width. */
  reliefDepth: number;
  /** Flat base thickness as a fraction of subject width. */
  baseThickness: number;
}

export const DEFAULT_RELIEF: ReliefOptions = {
  gridSize: 40,
  cutoff: 0.45,
  reliefDepth: 0.35,
  baseThickness: 0.12,
};

interface GridSample {
  gw: number;
  gh: number;
  depth: Float32Array; // per-cell average depth
  mask: Uint8Array; // per-cell subject mask (largest connected component)
}

export function sampleGrid(map: DepthMap, gridSize: number, cutoff: number): GridSample {
  const aspect = map.width / map.height;
  const gw = aspect >= 1 ? gridSize : Math.max(4, Math.round(gridSize * aspect));
  const gh = aspect >= 1 ? Math.max(4, Math.round(gridSize / aspect)) : gridSize;
  const depth = new Float32Array(gw * gh);
  const mask = new Uint8Array(gw * gh);

  for (let gy = 0; gy < gh; gy++) {
    const y0 = Math.floor((gy / gh) * map.height);
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) / gh) * map.height));
    for (let gx = 0; gx < gw; gx++) {
      const x0 = Math.floor((gx / gw) * map.width);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) / gw) * map.width));
      let sum = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          sum += map.data[y * map.width + x];
          n++;
        }
      }
      const d = sum / n;
      depth[gy * gw + gx] = d;
      mask[gy * gw + gx] = d >= cutoff ? 1 : 0;
    }
  }

  keepLargestComponent(mask, gw, gh);
  return { gw, gh, depth, mask };
}

function keepLargestComponent(mask: Uint8Array, gw: number, gh: number): void {
  const label = new Int32Array(gw * gh).fill(-1);
  let bestLabel = -1, bestSize = 0, next = 0;
  const stack: number[] = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || label[i] >= 0) continue;
    const id = next++;
    let size = 0;
    stack.push(i);
    label[i] = id;
    while (stack.length) {
      const cur = stack.pop()!;
      size++;
      const cx = cur % gw, cy = (cur / gw) | 0;
      const neighbors = [
        cx > 0 ? cur - 1 : -1,
        cx < gw - 1 ? cur + 1 : -1,
        cy > 0 ? cur - gw : -1,
        cy < gh - 1 ? cur + gw : -1,
      ];
      for (const nb of neighbors) {
        if (nb >= 0 && mask[nb] && label[nb] < 0) {
          label[nb] = id;
          stack.push(nb);
        }
      }
    }
    if (size > bestSize) {
      bestSize = size;
      bestLabel = id;
    }
  }
  for (let i = 0; i < mask.length; i++) mask[i] = label[i] === bestLabel ? 1 : 0;
}

/** Number of surviving subject cells for the current settings (for UI feedback). */
export function maskCellCount(map: DepthMap, opts: ReliefOptions): number {
  const g = sampleGrid(map, opts.gridSize, opts.cutoff);
  let n = 0;
  for (let i = 0; i < g.mask.length; i++) n += g.mask[i];
  return n;
}

export function meshFromDepth(map: DepthMap, opts: ReliefOptions, name: string): Mesh {
  const { gw, gh, depth, mask } = sampleGrid(map, opts.gridSize, opts.cutoff);

  let active = 0;
  for (let i = 0; i < mask.length; i++) active += mask[i];
  if (active < 6) {
    throw new Error(
      "Almost nothing survives the background cutoff. Lower the cutoff so more of the subject is kept."
    );
  }

  // Depth range within the subject for relief scaling.
  let dMin = Infinity, dMax = -Infinity;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    if (depth[i] < dMin) dMin = depth[i];
    if (depth[i] > dMax) dMax = depth[i];
  }
  const dRange = Math.max(1e-6, dMax - dMin);

  const cell = 1; // arbitrary units; buildMesh normalizes
  const W = gw * cell;
  const reliefScale = opts.reliefDepth * W;
  const base = opts.baseThickness * W;

  // Corner height = average of adjacent active cells' depths.
  const cornerH = new Float32Array((gw + 1) * (gh + 1));
  const cornerActive = new Uint8Array((gw + 1) * (gh + 1));
  for (let cy = 0; cy <= gh; cy++) {
    for (let cx = 0; cx <= gw; cx++) {
      let sum = 0, n = 0;
      for (let dy = -1; dy <= 0; dy++) {
        for (let dx = -1; dx <= 0; dx++) {
          const gx = cx + dx, gy = cy + dy;
          if (gx < 0 || gy < 0 || gx >= gw || gy >= gh) continue;
          const i = gy * gw + gx;
          if (!mask[i]) continue;
          sum += (depth[i] - dMin) / dRange;
          n++;
        }
      }
      if (n > 0) {
        cornerH[cy * (gw + 1) + cx] = base + (sum / n) * reliefScale;
        cornerActive[cy * (gw + 1) + cx] = 1;
      }
    }
  }

  // Emit triangle soup; buildMesh welds + fixes winding.
  const tris: number[] = [];
  const X = (cx: number) => (cx - gw / 2) * cell;
  const Y = (cy: number) => (gh / 2 - cy) * cell; // image y-down -> world y-up
  const zF = (cx: number, cy: number) => cornerH[cy * (gw + 1) + cx];

  const pushTri = (
    x1: number, y1: number, z1: number,
    x2: number, y2: number, z2: number,
    x3: number, y3: number, z3: number
  ) => {
    tris.push(x1, y1, z1, x2, y2, z2, x3, y3, z3);
  };

  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      if (!mask[gy * gw + gx]) continue;
      const c00: [number, number] = [gx, gy];
      const c10: [number, number] = [gx + 1, gy];
      const c01: [number, number] = [gx, gy + 1];
      const c11: [number, number] = [gx + 1, gy + 1];
      // Front (toward +z / viewer).
      pushTri(
        X(c00[0]), Y(c00[1]), zF(c00[0], c00[1]),
        X(c01[0]), Y(c01[1]), zF(c01[0], c01[1]),
        X(c11[0]), Y(c11[1]), zF(c11[0], c11[1])
      );
      pushTri(
        X(c00[0]), Y(c00[1]), zF(c00[0], c00[1]),
        X(c11[0]), Y(c11[1]), zF(c11[0], c11[1]),
        X(c10[0]), Y(c10[1]), zF(c10[0], c10[1])
      );
      // Back (flat, z = 0).
      pushTri(X(c00[0]), Y(c00[1]), 0, X(c11[0]), Y(c11[1]), 0, X(c01[0]), Y(c01[1]), 0);
      pushTri(X(c00[0]), Y(c00[1]), 0, X(c10[0]), Y(c10[1]), 0, X(c11[0]), Y(c11[1]), 0);
      // Walls where the neighbor is empty or out of bounds.
      const sides: Array<{ n: [number, number]; a: [number, number]; b: [number, number] }> = [
        { n: [gx, gy - 1], a: c00, b: c10 }, // top
        { n: [gx + 1, gy], a: c10, b: c11 }, // right
        { n: [gx, gy + 1], a: c11, b: c01 }, // bottom
        { n: [gx - 1, gy], a: c01, b: c00 }, // left
      ];
      for (const s of sides) {
        const [nx, ny] = s.n;
        const open = nx < 0 || ny < 0 || nx >= gw || ny >= gh || !mask[ny * gw + nx];
        if (!open) continue;
        const [ax, ay] = s.a, [bx, by] = s.b;
        pushTri(X(ax), Y(ay), zF(ax, ay), X(bx), Y(by), zF(bx, by), X(bx), Y(by), 0);
        pushTri(X(ax), Y(ay), zF(ax, ay), X(bx), Y(by), 0, X(ax), Y(ay), 0);
      }
    }
  }

  return buildMesh(
    { positions: new Float64Array(tris), triangleCount: tris.length / 9 },
    name,
    "photo-single"
  );
}

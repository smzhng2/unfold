/** Shared geometry types for the Unfold pipeline. */

export type MeshSource = "stl" | "photo-single" | "sample";

/** Welded, indexed triangle mesh. Positions normalized: centered, maxDim = 2. */
export interface Mesh {
  positions: Float64Array; // 3 * vertexCount
  faces: Uint32Array; // 3 * faceCount (vertex indices, CCW as given)
  name: string;
  source: MeshSource;
}

export interface MeshStats {
  vertices: number;
  faces: number;
  boundaryEdges: number;
  nonManifoldEdges: number;
  components: number;
  watertight: boolean;
}

export interface Vec2 {
  x: number;
  y: number;
}

/** One face placed in the net. */
export interface NetFace {
  faceIndex: number;
  islandIndex: number;
  parent: number; // faceIndex of parent in unfold tree, -1 for island root
  depth: number; // tree depth within island
  /** Hinge with parent: rotation axis through vertex hingeA toward hingeB (mesh vertex ids). */
  hingeA: number;
  hingeB: number;
  /** Signed radians to rotate this subtree about the hinge to flatten onto parent. */
  flattenAngle: number;
  /** Flattened 2D coords in island-raw space, same order as the mesh face's 3 vertices. */
  uv: [Vec2, Vec2, Vec2];
}

export type FoldType = "mountain" | "valley";

export interface FoldSeg {
  islandIndex: number;
  a: Vec2;
  b: Vec2;
  type: FoldType;
  /** Fold deviation from flat, degrees (how far you fold). */
  angleDeg: number;
}

export interface CutSeg {
  islandIndex: number;
  faceIndex: number;
  a: Vec2;
  b: Vec2;
  /** Matching-edge number shared with the partner edge; null for boundary/non-manifold edges. */
  pairId: number | null;
  /** Glue tab polygon (island-raw space) if the tab sits on this side. */
  tab: Vec2[] | null;
}

export interface Island {
  index: number;
  rootFace: number;
  faceCount: number;
  /** Face indices in placement (BFS) order — parents always precede children. */
  faceOrder: number[];
  /** Basis mapping island-raw 2D -> 3D root plane (model space): p3 = origin + u*x + v*y. */
  origin3: [number, number, number];
  u3: [number, number, number];
  v3: [number, number, number];
  n3: [number, number, number];
  /** Rotation (radians) applied to raw uv that minimizes the bounding box. */
  rotation: number;
  /** Bbox of rotated island (model units), including tabs. */
  bboxMin: Vec2;
  bboxMax: Vec2;
}

export interface NetResult {
  mesh: Mesh;
  /** Indexed by faceIndex; every mesh face gets placed. */
  faces: NetFace[];
  islands: Island[];
  folds: FoldSeg[];
  cuts: CutSeg[];
  maxDepth: number;
  tabCount: number;
  pairCount: number;
  /** Tab depth used, in model units. */
  tabDepth: number;
}

/** Placement of one island onto a page, in page units (mm for PDF, model units for animation). */
export interface Placement {
  islandIndex: number;
  page: number;
  /** Offset such that pagePoint = rot(uv, island.rotation) - bboxMin, scaled, + (x, y). */
  x: number;
  y: number;
}

export interface LayoutResult {
  pageW: number;
  pageH: number;
  margin: number;
  pageCount: number;
  scale: number; // page units per model unit
  placements: Placement[];
}

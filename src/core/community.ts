/**
 * Community gallery data. Sharing isn't live yet — these are placeholder
 * creations (fictional accounts, procedurally built models) so the gallery
 * UI exists ahead of a real backend. Every creation opens as a real mesh.
 */

import * as THREE from "three";
import type { Mesh } from "./types";
import { buildMesh } from "./mesh";
import { SAMPLES } from "./samples";

export interface CommunityCreation {
  id: string;
  title: string;
  author: string;
  handle: string;
  likes: number;
  builds: number;
  blurb: string;
  build: () => Mesh;
}

/** Extruded five-point star (prism): front + back star faces, walls all around. */
function starMesh(): Mesh {
  const outer = 1.0;
  const inner = 0.42;
  const half = 0.32;
  const ring: [number, number][] = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    ring.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  const tris: number[] = [];
  const push = (p: number[], q: number[], r: number[]) => tris.push(...p, ...q, ...r);
  // Front/back fans from center (a star polygon is star-shaped about its center).
  for (let i = 0; i < 10; i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[(i + 1) % 10];
    push([0, 0, half], [ax, ay, half], [bx, by, half]);
    push([0, 0, -half], [bx, by, -half], [ax, ay, -half]);
  }
  // Walls.
  for (let i = 0; i < 10; i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[(i + 1) % 10];
    push([ax, ay, half], [ax, ay, -half], [bx, by, -half]);
    push([ax, ay, half], [bx, by, -half], [bx, by, half]);
  }
  return buildMesh(
    { positions: new Float64Array(tris), triangleCount: tris.length / 9 },
    "Lucky star",
    "sample"
  );
}

/** Elongated hexagonal crystal: prism band with pyramid caps. */
function crystalMesh(): Mesh {
  const r = 0.52;
  const band = 0.42;
  const apex = 1.35;
  const ring: [number, number][] = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    ring.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  const tris: number[] = [];
  const push = (p: number[], q: number[], s: number[]) => tris.push(...p, ...q, ...s);
  for (let i = 0; i < 6; i++) {
    const [ax, az] = ring[i];
    const [bx, bz] = ring[(i + 1) % 6];
    // caps
    push([0, apex, 0], [ax, band, az], [bx, band, bz]);
    push([0, -apex, 0], [bx, -band, bz], [ax, -band, az]);
    // band
    push([ax, band, az], [ax, -band, az], [bx, -band, bz]);
    push([ax, band, az], [bx, -band, bz], [bx, band, bz]);
  }
  return buildMesh(
    { positions: new Float64Array(tris), triangleCount: tris.length / 9 },
    "Amethyst shard",
    "sample"
  );
}

function fromSample(id: string, rename: string): () => Mesh {
  return () => {
    const sample = SAMPLES.find((s) => s.id === id);
    if (!sample) throw new Error(`missing sample ${id}`);
    const mesh = sample.build();
    return { ...mesh, name: rename };
  };
}

export const COMMUNITY_CREATIONS: CommunityCreation[] = [
  {
    id: "lucky-star",
    title: "Lucky star",
    author: "June Ateliers",
    handle: "juneatelier",
    likes: 214,
    builds: 58,
    blurb: "Hangs off my desk lamp now. Fold the points sharp before gluing the back face.",
    build: starMesh,
  },
  {
    id: "amethyst-shard",
    title: "Amethyst shard",
    author: "Milo P.",
    handle: "paperfoldmilo",
    likes: 178,
    builds: 41,
    blurb: "Printed on lilac card stock — looks great in a cluster of three sizes.",
    build: crystalMesh,
  },
  {
    id: "tiny-cottage",
    title: "Tiny cottage",
    author: "Hana Orikata",
    handle: "hana_folds",
    likes: 342,
    builds: 127,
    blurb: "My first build! The roof ridge folds are very forgiving for beginners.",
    build: fromSample("house", "Tiny cottage"),
  },
  {
    id: "game-night-d20",
    title: "Game night d20",
    author: "Theo R.",
    handle: "critfold",
    likes: 156,
    builds: 73,
    blurb: "Made one per player. A dab of glue on the last tab and it holds its shape.",
    build: fromSample("icosahedron", "Game night d20"),
  },
  {
    id: "disco-ball",
    title: "Disco ball",
    author: "Sasha K.",
    handle: "sashamakes",
    likes: 267,
    builds: 39,
    blurb: "80 faces of patience, worth every crease. Foil paper if you have it!",
    build: fromSample("sphere", "Disco ball"),
  },
  {
    id: "strawberry-donut",
    title: "Strawberry donut",
    author: "June Ateliers",
    handle: "juneatelier",
    likes: 198,
    builds: 52,
    blurb: "The strip pieces curl naturally as you glue — trust the numbers.",
    build: fromSample("torus", "Strawberry donut"),
  },
];

// ---------------------------------------------------------------------------
// Thumbnail rendering: one shared offscreen renderer, one frame per mesh.
// ---------------------------------------------------------------------------

const thumbCache = new Map<string, string>();
let thumbRenderer: THREE.WebGLRenderer | null = null;

export function renderThumbnail(id: string, mesh: Mesh, size = 320): string {
  const cached = thumbCache.get(id);
  if (cached) return cached;

  if (!thumbRenderer) {
    thumbRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    thumbRenderer.setPixelRatio(1);
  }
  const renderer = thumbRenderer;
  renderer.setSize(size, size, false);
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0xcfc8ba, 1.2));
  const key = new THREE.DirectionalLight(0xffffff, 1.3);
  key.position.set(2.5, 4, 2);
  scene.add(key);

  const nf = mesh.faces.length / 3;
  const pos = new Float32Array(nf * 9);
  for (let f = 0; f < nf; f++) {
    for (let k = 0; k < 3; k++) {
      const v = mesh.faces[f * 3 + k];
      pos[f * 9 + k * 3] = mesh.positions[v * 3];
      pos[f * 9 + k * 3 + 1] = mesh.positions[v * 3 + 1];
      pos[f * 9 + k * 3 + 2] = mesh.positions[v * 3 + 2];
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  const group = new THREE.Group();
  group.add(
    new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.82, side: THREE.FrontSide })),
    new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xe7dfce, roughness: 0.95, side: THREE.BackSide }))
  );
  const edges = new THREE.EdgesGeometry(geo, 8);
  group.add(new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0xb3ab99 })));
  group.rotation.y = 0.6;
  group.rotation.x = 0.12;
  scene.add(group);

  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 20);
  camera.position.set(0.9, 0.75, 3.4);
  camera.lookAt(0, 0, 0);

  renderer.render(scene, camera);
  const url = renderer.domElement.toDataURL("image/png");

  geo.dispose();
  edges.dispose();
  group.children.forEach((c) => {
    const mat = (c as THREE.Mesh).material as THREE.Material | THREE.Material[];
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat.dispose();
  });

  thumbCache.set(id, url);
  return url;
}

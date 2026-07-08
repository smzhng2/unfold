/** Procedural sample models so the app works with zero assets. */

import * as THREE from "three";
import type { Mesh } from "./types";
import { buildMesh } from "./mesh";

export interface Sample {
  id: string;
  name: string;
  hint: string;
  build: () => Mesh;
}

function fromGeometry(geo: THREE.BufferGeometry, name: string): Mesh {
  const non = geo.index ? geo.toNonIndexed() : geo;
  const arr = non.getAttribute("position").array as Float32Array;
  non.dispose();
  if (non !== geo) geo.dispose();
  return buildMesh(
    { positions: Float64Array.from(arr), triangleCount: arr.length / 9 },
    name,
    "sample"
  );
}

function houseMesh(): Mesh {
  // Closed 5-gon prism: a little house with a gabled roof.
  const w = 0.75, wallH = 0.55, apexH = 1.05, d = 0.6;
  const profile = [
    [-w, 0], [w, 0], [w, wallH], [0, apexH], [-w, wallH],
  ];
  const front = profile.map(([x, y]) => [x, y, d]);
  const back = profile.map(([x, y]) => [x, y, -d]);
  const tris: number[][] = [];
  // front fan (CCW toward +z) and back fan
  for (let i = 1; i < 4; i++) {
    tris.push(front[0], front[i], front[i + 1]);
    tris.push(back[0], back[i + 1], back[i]);
  }
  // sides
  for (let i = 0; i < 5; i++) {
    const j = (i + 1) % 5;
    tris.push(front[i], back[i], back[j]);
    tris.push(front[i], back[j], front[j]);
  }
  const positions = new Float64Array(tris.length * 3);
  tris.forEach((p, i) => {
    positions[i * 3] = p[0];
    positions[i * 3 + 1] = p[1];
    positions[i * 3 + 2] = p[2];
  });
  return buildMesh({ positions, triangleCount: tris.length / 3 }, "Little house", "sample");
}

export const SAMPLES: Sample[] = [
  {
    id: "cube",
    name: "Cube",
    hint: "12 faces · the classic first fold",
    build: () => fromGeometry(new THREE.BoxGeometry(1, 1, 1), "Cube"),
  },
  {
    id: "house",
    name: "Little house",
    hint: "16 faces · gabled roof",
    build: houseMesh,
  },
  {
    id: "gem",
    name: "Gem",
    hint: "8 faces · octahedron",
    build: () => fromGeometry(new THREE.OctahedronGeometry(1), "Gem"),
  },
  {
    id: "icosahedron",
    name: "Icosahedron",
    hint: "20 faces · the d20",
    build: () => fromGeometry(new THREE.IcosahedronGeometry(1, 0), "Icosahedron"),
  },
  {
    id: "sphere",
    name: "Low-poly sphere",
    hint: "80 faces · splits into pieces",
    build: () => fromGeometry(new THREE.IcosahedronGeometry(1, 1), "Low-poly sphere"),
  },
  {
    id: "torus",
    name: "Donut",
    hint: "120 faces · unrolls into strips",
    build: () => fromGeometry(new THREE.TorusGeometry(0.72, 0.34, 6, 10), "Donut"),
  },
];

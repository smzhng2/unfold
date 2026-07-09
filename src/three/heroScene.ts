/**
 * Landing-page background: a handful of small sample models drift slowly and
 * fold open into their flat nets and back, on a loop — a live preview of what
 * the app does. Same hinge math as UnfoldViewer, minus controls/sheets/camera
 * choreography, so it stays cheap enough to run behind the hero text.
 */

import * as THREE from "three";
import type { Mesh, NetResult } from "../core/types";
import { unfoldMesh } from "../core/unfold";
import { SAMPLES } from "../core/samples";

const PAPER_FRONT = 0xffffff;
const PAPER_BACK = 0xe7dfce;
const COL_MOUNTAIN = 0xc2410c;
const COL_VALLEY = 0x2563eb;
const COL_CUT = 0x9a9284;

interface FaceAnim {
  faceIndex: number;
  parent: number;
  depth: number;
  hx: number; hy: number; hz: number;
  dx: number; dy: number; dz: number;
  angle: number;
}

interface Floater {
  group: THREE.Group;
  faceAnims: FaceAnim[];
  faceMatrix: THREE.Matrix4[];
  mesh: Mesh;
  maxDepth: number;
  posAttr: THREE.BufferAttribute;
  normAttr: THREE.BufferAttribute;
  lines: { attr: THREE.BufferAttribute; refs: { face: number; va: number; vb: number }[] }[];
  basePos: THREE.Vector3;
  /** seconds for one full fold-unfold cycle */
  period: number;
  phase: number;
  spin: number;
  bob: number;
  lastT: number;
}

export class HeroScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private floaters: Floater[] = [];
  private raf = 0;
  private clock = new THREE.Clock();
  private elapsed = 0;
  private resizeObs: ResizeObserver;
  private container: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = "block";

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 50);
    this.camera.position.set(0, 0, 9);

    const hemi = new THREE.HemisphereLight(0xffffff, 0xcfc8ba, 1.15);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 1.3);
    key.position.set(2.5, 4, 3);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xfff2e0, 0.4);
    fill.position.set(-3, 1, 2);
    this.scene.add(fill);

    // Small samples only — each unfolds in well under a millisecond.
    const picks: Array<{ id: string; pos: [number, number, number]; scale: number; period: number; phase: number }> = [
      { id: "cube", pos: [-5.3, 2.0, -1], scale: 0.6, period: 14, phase: 0 },
      { id: "gem", pos: [5.2, 1.9, -1.5], scale: 0.7, period: 17, phase: 0.45 },
      { id: "icosahedron", pos: [-5.1, -2.2, -2], scale: 0.7, period: 19, phase: 0.7 },
      { id: "house", pos: [5.1, -2.1, -1], scale: 0.62, period: 15, phase: 0.25 },
    ];
    for (const pick of picks) {
      const sample = SAMPLES.find((s) => s.id === pick.id);
      if (!sample) continue;
      try {
        const mesh = sample.build();
        const net = unfoldMesh(mesh);
        this.addFloater(mesh, net, pick);
      } catch {
        // decorative only — skip a model rather than break the landing page
      }
    }

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);
    this.resize();
    this.loop();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.resizeObs.disconnect();
    for (const f of this.floaters) {
      f.group.traverse((obj) => {
        const m = obj as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      });
    }
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private addFloater(
    mesh: Mesh,
    net: NetResult,
    opts: { pos: [number, number, number]; scale: number; period: number; phase: number }
  ) {
    const nf = mesh.faces.length / 3;
    const faceAnims: FaceAnim[] = [];
    const faceMatrix: THREE.Matrix4[] = new Array(nf);
    let maxDepth = 1;
    for (const island of net.islands) {
      for (const f of island.faceOrder) {
        const nfc = net.faces[f];
        maxDepth = Math.max(maxDepth, nfc.depth);
        if (nfc.parent >= 0) {
          const ax = mesh.positions[nfc.hingeA * 3];
          const ay = mesh.positions[nfc.hingeA * 3 + 1];
          const az = mesh.positions[nfc.hingeA * 3 + 2];
          let dx = mesh.positions[nfc.hingeB * 3] - ax;
          let dy = mesh.positions[nfc.hingeB * 3 + 1] - ay;
          let dz = mesh.positions[nfc.hingeB * 3 + 2] - az;
          const len = Math.hypot(dx, dy, dz) || 1;
          faceAnims.push({
            faceIndex: f, parent: nfc.parent, depth: nfc.depth,
            hx: ax, hy: ay, hz: az, dx: dx / len, dy: dy / len, dz: dz / len,
            angle: nfc.flattenAngle,
          });
        } else {
          faceAnims.push({ faceIndex: f, parent: -1, depth: 0, hx: 0, hy: 0, hz: 0, dx: 1, dy: 0, dz: 0, angle: 0 });
        }
        faceMatrix[f] = new THREE.Matrix4();
      }
    }

    const geo = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(new Float32Array(nf * 9), 3);
    const normAttr = new THREE.BufferAttribute(new Float32Array(nf * 9), 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    normAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("position", posAttr);
    geo.setAttribute("normal", normAttr);

    const group = new THREE.Group();
    group.add(
      new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: PAPER_FRONT, roughness: 0.82, side: THREE.FrontSide })),
      new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: PAPER_BACK, roughness: 0.95, side: THREE.BackSide }))
    );

    // Fold-line overlays (the app's visual signature).
    const mountain: { face: number; va: number; vb: number }[] = [];
    const valley: { face: number; va: number; vb: number }[] = [];
    for (const nfc of net.faces) {
      if (nfc.parent >= 0 && Math.abs(nfc.flattenAngle) > 0.008) {
        (nfc.flattenAngle < 0 ? mountain : valley).push({ face: nfc.faceIndex, va: nfc.hingeA, vb: nfc.hingeB });
      }
    }
    const lines: Floater["lines"] = [];
    for (const [refs, color, opacity] of [
      [mountain, COL_MOUNTAIN, 0.55],
      [valley, COL_VALLEY, 0.55],
      [[], COL_CUT, 0],
    ] as const) {
      if (refs.length === 0) continue;
      const lattr = new THREE.BufferAttribute(new Float32Array(refs.length * 6), 3);
      lattr.setUsage(THREE.DynamicDrawUsage);
      const lgeo = new THREE.BufferGeometry();
      lgeo.setAttribute("position", lattr);
      group.add(new THREE.LineSegments(lgeo, new THREE.LineBasicMaterial({ color, transparent: true, opacity })));
      lines.push({ attr: lattr, refs: [...refs] });
    }

    group.scale.setScalar(opts.scale);
    group.position.set(...opts.pos);
    this.scene.add(group);

    this.floaters.push({
      group, faceAnims, faceMatrix, mesh, maxDepth,
      posAttr, normAttr, lines,
      basePos: new THREE.Vector3(...opts.pos),
      period: opts.period,
      phase: opts.phase,
      spin: 0.1 + Math.random() * 0.08,
      bob: 0.55 + Math.random() * 0.5,
      lastT: -1,
    });
  }

  /** Fold cycle: dwell solid → unfold → dwell flat → refold, eased. */
  private cycleT(time: number, f: Floater): number {
    const p = ((time / f.period + f.phase) % 1 + 1) % 1;
    if (p < 0.14) return 0; // solid
    if (p < 0.45) return easeInOut((p - 0.14) / 0.31); // unfolding
    if (p < 0.59) return 1; // flat
    if (p < 0.9) return 1 - easeInOut((p - 0.59) / 0.31); // refolding
    return 0;
  }

  private applyFold(f: Floater, t: number) {
    if (Math.abs(t - f.lastT) < 1e-4) return; // dwell — skip buffer rewrites
    f.lastT = t;
    const mesh = f.mesh;
    const w = 0.55;
    const delay = (1 - w) / f.maxDepth;
    const rot = new THREE.Matrix4();
    const tmp = new THREE.Matrix4();
    for (const anim of f.faceAnims) {
      const M = f.faceMatrix[anim.faceIndex];
      if (anim.parent < 0) {
        M.identity();
        continue;
      }
      const local = THREE.MathUtils.clamp((t - (anim.depth - 1) * delay) / w, 0, 1);
      makeRotationAboutLine(rot, anim, anim.angle * easeInOut(local));
      tmp.multiplyMatrices(f.faceMatrix[anim.parent], rot);
      M.copy(tmp);
    }

    const posArr = f.posAttr.array as Float32Array;
    const normArr = f.normAttr.array as Float32Array;
    const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    const e1 = new THREE.Vector3();
    const e2 = new THREE.Vector3();
    const n = new THREE.Vector3();
    const nf = mesh.faces.length / 3;
    for (let face = 0; face < nf; face++) {
      const M = f.faceMatrix[face];
      for (let k = 0; k < 3; k++) {
        const vi = mesh.faces[face * 3 + k];
        v[k].set(mesh.positions[vi * 3], mesh.positions[vi * 3 + 1], mesh.positions[vi * 3 + 2]).applyMatrix4(M);
        posArr[face * 9 + k * 3] = v[k].x;
        posArr[face * 9 + k * 3 + 1] = v[k].y;
        posArr[face * 9 + k * 3 + 2] = v[k].z;
      }
      n.copy(e1.copy(v[1]).sub(v[0]).cross(e2.copy(v[2]).sub(v[0]))).normalize();
      for (let k = 0; k < 3; k++) {
        normArr[face * 9 + k * 3] = n.x;
        normArr[face * 9 + k * 3 + 1] = n.y;
        normArr[face * 9 + k * 3 + 2] = n.z;
      }
    }
    f.posAttr.needsUpdate = true;
    f.normAttr.needsUpdate = true;

    const p = new THREE.Vector3();
    for (const lg of f.lines) {
      const arr = lg.attr.array as Float32Array;
      for (let i = 0; i < lg.refs.length; i++) {
        const ref = lg.refs[i];
        const M = f.faceMatrix[ref.face];
        p.set(mesh.positions[ref.va * 3], mesh.positions[ref.va * 3 + 1], mesh.positions[ref.va * 3 + 2]).applyMatrix4(M);
        arr[i * 6] = p.x; arr[i * 6 + 1] = p.y; arr[i * 6 + 2] = p.z;
        p.set(mesh.positions[ref.vb * 3], mesh.positions[ref.vb * 3 + 1], mesh.positions[ref.vb * 3 + 2]).applyMatrix4(M);
        arr[i * 6 + 3] = p.x; arr[i * 6 + 4] = p.y; arr[i * 6 + 5] = p.z;
      }
      lg.attr.needsUpdate = true;
    }
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    this.elapsed += dt;
    const time = this.elapsed;
    for (const f of this.floaters) {
      this.applyFold(f, this.cycleT(time, f));
      f.group.rotation.y += dt * f.spin;
      f.group.rotation.x = Math.sin(time * 0.11 + f.phase * 7) * 0.14;
      f.group.position.y = f.basePos.y + Math.sin(time * 0.4 + f.phase * 9) * 0.12 * f.bob;
    }
    this.renderer.render(this.scene, this.camera);
  };
}

function easeInOut(x: number): number {
  return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
}

function makeRotationAboutLine(out: THREE.Matrix4, a: FaceAnim, angle: number) {
  out.makeRotationAxis(_axis.set(a.dx, a.dy, a.dz), angle);
  const e = out.elements;
  e[12] = a.hx - (e[0] * a.hx + e[4] * a.hy + e[8] * a.hz);
  e[13] = a.hy - (e[1] * a.hx + e[5] * a.hy + e[9] * a.hz);
  e[14] = a.hz - (e[2] * a.hx + e[6] * a.hy + e[10] * a.hz);
}

const _axis = new THREE.Vector3();

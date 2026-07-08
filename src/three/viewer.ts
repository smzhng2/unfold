/**
 * The Unfold viewer: renders the mesh, then animates the true unfolding —
 * every face rotates about its actual hinge edge by its actual flatten angle,
 * staggered by spanning-tree depth; flattened islands then glide onto virtual
 * paper sheets matching the print layout.
 */

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { LayoutResult, Mesh, NetResult } from "../core/types";

const PAPER_FRONT = 0xffffff;
const PAPER_BACK = 0xe7dfce;
const BG = 0xf6f4ef;
const FLOOR_Y = -1.45;

const COL_CUT = 0x8a8375;
const COL_MOUNTAIN = 0xc2410c;
const COL_VALLEY = 0x2563eb;

interface FaceAnim {
  faceIndex: number;
  parent: number; // faceIndex or -1
  islandIndex: number;
  depth: number;
  // hinge in original model space
  hx: number; hy: number; hz: number; // point
  dx: number; dy: number; dz: number; // unit direction
  angle: number;
}

interface IslandAnim {
  quat: THREE.Quaternion; // flattened -> sheet rotation
  c0: THREE.Vector3; // centroid flattened
  c1: THREE.Vector3; // centroid on sheet
  order: number; // stagger order for phase 2
}

type LineRef = { face: number; va: number; vb: number };

export class UnfoldViewer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private root = new THREE.Group();
  private sheetGroup = new THREE.Group();
  private raf = 0;
  private clock = new THREE.Clock();
  private resizeObs: ResizeObserver;
  private container: HTMLElement;

  private mesh: Mesh | null = null;
  private net: NetResult | null = null;

  // net-mode buffers
  private posAttr: THREE.BufferAttribute | null = null;
  private normAttr: THREE.BufferAttribute | null = null;
  private faceAnims: FaceAnim[] = []; // in placement order (parents first)
  private faceMatrix: THREE.Matrix4[] = [];
  private islandAnims: IslandAnim[] = [];
  private lineGroups: { attr: THREE.BufferAttribute; refs: LineRef[] }[] = [];
  private netGroup: THREE.Group | null = null;
  private meshGroup: THREE.Group | null = null;
  private maxDepth = 1;

  // animation state
  private t = 0;
  private playTarget: number | null = null;
  private autoSpin = true;
  private camBlend = { active: false, from: new THREE.Vector3(), fromTarget: new THREE.Vector3() };
  private topPos = new THREE.Vector3();
  private topTarget = new THREE.Vector3();

  onTick: ((t: number) => void) | null = null;
  onPlayStateChange: ((playing: boolean) => void) | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(BG);
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = "block";

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
    this.camera.position.set(2.6, 1.7, 3.2);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 0.6;
    this.controls.maxDistance = 30;
    this.controls.addEventListener("start", () => {
      this.autoSpin = false;
    });

    const hemi = new THREE.HemisphereLight(0xffffff, 0xcfc8ba, 1.15);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(2.5, 4, 2);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xfff2e0, 0.45);
    fill.position.set(-3, 1.5, -2);
    this.scene.add(fill);

    this.scene.add(this.root);
    this.scene.add(this.sheetGroup);

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);
    this.resize();
    this.loop();
    (window as unknown as { __unfoldViewer: UnfoldViewer }).__unfoldViewer = this;
  }

  private resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.resizeObs.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ------------------------------------------------------------------
  // Mesh (pre-unfold) display
  // ------------------------------------------------------------------

  setMesh(mesh: Mesh) {
    this.mesh = mesh;
    this.net = null;
    this.t = 0;
    this.playTarget = null;
    this.clearGroups();
    this.autoSpin = true;

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
    group.add(new THREE.Mesh(geo, frontMaterial()));
    group.add(new THREE.Mesh(geo, backMaterial()));
    const edges = new THREE.EdgesGeometry(geo, 8);
    group.add(
      new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0xb3ab99, transparent: true, opacity: 0.85 }))
    );
    this.meshGroup = group;
    this.root.add(group);
    this.frameSubject(1.6);
  }

  // ------------------------------------------------------------------
  // Net (unfold animation) setup
  // ------------------------------------------------------------------

  setNet(net: NetResult, layout: LayoutResult) {
    this.net = net;
    this.mesh = net.mesh;
    this.t = 0;
    this.playTarget = null;
    this.autoSpin = false;
    this.clearGroups();
    this.maxDepth = Math.max(net.maxDepth, 1);

    const mesh = net.mesh;
    const nf = mesh.faces.length / 3;

    // Placement order across all islands (parents before children).
    this.faceAnims = [];
    this.faceMatrix = new Array(nf);
    for (const island of net.islands) {
      for (const f of island.faceOrder) {
        const nfc = net.faces[f];
        let anim: FaceAnim;
        if (nfc.parent >= 0) {
          const ax = mesh.positions[nfc.hingeA * 3];
          const ay = mesh.positions[nfc.hingeA * 3 + 1];
          const az = mesh.positions[nfc.hingeA * 3 + 2];
          let dx = mesh.positions[nfc.hingeB * 3] - ax;
          let dy = mesh.positions[nfc.hingeB * 3 + 1] - ay;
          let dz = mesh.positions[nfc.hingeB * 3 + 2] - az;
          const len = Math.hypot(dx, dy, dz) || 1;
          anim = {
            faceIndex: f, parent: nfc.parent, islandIndex: nfc.islandIndex, depth: nfc.depth,
            hx: ax, hy: ay, hz: az, dx: dx / len, dy: dy / len, dz: dz / len, angle: nfc.flattenAngle,
          };
        } else {
          anim = {
            faceIndex: f, parent: -1, islandIndex: nfc.islandIndex, depth: 0,
            hx: 0, hy: 0, hz: 0, dx: 1, dy: 0, dz: 0, angle: 0,
          };
        }
        this.faceAnims.push(anim);
        this.faceMatrix[f] = new THREE.Matrix4();
      }
    }

    // Phase-2 island rigid transforms (flattened pose -> sheet pose).
    this.buildIslandTransforms(net, layout);
    this.buildSheets(net, layout);

    // Geometry buffers.
    const pos = new Float32Array(nf * 9);
    const norm = new Float32Array(nf * 9);
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(pos, 3);
    this.normAttr = new THREE.BufferAttribute(norm, 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.normAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("position", this.posAttr);
    geo.setAttribute("normal", this.normAttr);

    const group = new THREE.Group();
    group.add(new THREE.Mesh(geo, frontMaterial()));
    group.add(new THREE.Mesh(geo, backMaterial()));

    // Fold/cut line overlays, endpoints recomputed per frame.
    const mountainRefs: LineRef[] = [];
    const valleyRefs: LineRef[] = [];
    const cutRefs: LineRef[] = [];
    for (const nfc of net.faces) {
      if (nfc.parent >= 0 && Math.abs(nfc.flattenAngle) > 0.008) {
        // classify like the PDF: convex edge = mountain
        const type = this.foldTypeOf(net, nfc.faceIndex);
        (type === "mountain" ? mountainRefs : valleyRefs).push({
          face: nfc.faceIndex,
          va: nfc.hingeA,
          vb: nfc.hingeB,
        });
      }
    }
    for (const cut of net.cuts) {
      // draw each cut side; find the vertex ids from uv is lossy — recover from faces
      const f = cut.faceIndex;
      const ids = [mesh.faces[f * 3], mesh.faces[f * 3 + 1], mesh.faces[f * 3 + 2]];
      // match by uv reference equality
      const nfc = net.faces[f];
      let va = -1, vb = -1;
      for (let k = 0; k < 3; k++) {
        if (nfc.uv[k] === cut.a) va = ids[k];
        if (nfc.uv[k] === cut.b) vb = ids[k];
      }
      if (va >= 0 && vb >= 0) cutRefs.push({ face: f, va, vb });
    }

    this.lineGroups = [];
    for (const [refs, color, opacity] of [
      [cutRefs, COL_CUT, 0.55],
      [mountainRefs, COL_MOUNTAIN, 0.9],
      [valleyRefs, COL_VALLEY, 0.9],
    ] as const) {
      const lpos = new Float32Array(refs.length * 6);
      const lattr = new THREE.BufferAttribute(lpos, 3);
      lattr.setUsage(THREE.DynamicDrawUsage);
      const lgeo = new THREE.BufferGeometry();
      lgeo.setAttribute("position", lattr);
      const lines = new THREE.LineSegments(
        lgeo,
        new THREE.LineBasicMaterial({ color, transparent: true, opacity })
      );
      group.add(lines);
      this.lineGroups.push({ attr: lattr, refs: [...refs] });
    }

    this.netGroup = group;
    this.root.add(group);
    this.applyT(0);
    // Frame generously: the flattened net spreads far wider than the solid.
    let maxDiag = 0;
    for (const island of net.islands) {
      const w = island.bboxMax.x - island.bboxMin.x;
      const h = island.bboxMax.y - island.bboxMin.y;
      maxDiag = Math.max(maxDiag, Math.hypot(w, h));
    }
    this.frameSubject(Math.max(1.7, maxDiag * 0.62));
  }

  private foldTypeOf(net: NetResult, child: number): "mountain" | "valley" {
    const mesh = net.mesh;
    const nfc = net.faces[child];
    const parent = nfc.parent;
    const n = new THREE.Vector3();
    const p = mesh.positions;
    const [a, b, c] = [mesh.faces[parent * 3], mesh.faces[parent * 3 + 1], mesh.faces[parent * 3 + 2]];
    const va = new THREE.Vector3(p[a * 3], p[a * 3 + 1], p[a * 3 + 2]);
    const vb = new THREE.Vector3(p[b * 3], p[b * 3 + 1], p[b * 3 + 2]);
    const vc = new THREE.Vector3(p[c * 3], p[c * 3 + 1], p[c * 3 + 2]);
    n.copy(vb).sub(va).cross(vc.clone().sub(va)).normalize();
    const cc = new THREE.Vector3();
    for (let k = 0; k < 3; k++) {
      const v = mesh.faces[child * 3 + k];
      cc.x += p[v * 3] / 3; cc.y += p[v * 3 + 1] / 3; cc.z += p[v * 3 + 2] / 3;
    }
    const w = cc.sub(new THREE.Vector3(p[nfc.hingeA * 3], p[nfc.hingeA * 3 + 1], p[nfc.hingeA * 3 + 2]));
    return n.dot(w) < 0 ? "mountain" : "valley";
  }

  private buildIslandTransforms(net: NetResult, layout: LayoutResult) {
    const pageW = layout.pageW;
    const pageH = layout.pageH;
    const gapX = pageW * 0.12;
    const nPages = layout.pageCount;
    const totalW = nPages * pageW + (nPages - 1) * gapX;

    const sheetOrigin = (page: number) => ({
      x: -totalW / 2 + page * (pageW + gapX),
      z: -pageH / 2,
    });

    this.islandAnims = [];
    const placementOf = new Map<number, { page: number; x: number; y: number }>();
    for (const pl of layout.placements) placementOf.set(pl.islandIndex, pl);

    for (const island of net.islands) {
      const pl = placementOf.get(island.index)!;
      const o = sheetOrigin(pl.page);
      const cos = Math.cos(island.rotation), sin = Math.sin(island.rotation);
      const sheetPoint = (x: number, y: number) => {
        const rx = x * cos - y * sin;
        const ry = x * sin + y * cos;
        const px = pl.x + (rx - island.bboxMin.x);
        const py = pl.y + (island.bboxMax.y - ry);
        return new THREE.Vector3(o.x + px, FLOOR_Y, o.z + py);
      };
      const flatPoint = (x: number, y: number) =>
        new THREE.Vector3(
          island.origin3[0] + island.u3[0] * x + island.v3[0] * y,
          island.origin3[1] + island.u3[1] * x + island.v3[1] * y,
          island.origin3[2] + island.u3[2] * x + island.v3[2] * y
        );

      // Rigid transform from three reference points.
      const rootUV = net.faces[island.rootFace].uv;
      const s0 = flatPoint(rootUV[0].x, rootUV[0].y);
      const s1 = flatPoint(rootUV[1].x, rootUV[1].y);
      const s2 = flatPoint(rootUV[2].x, rootUV[2].y);
      const d0 = sheetPoint(rootUV[0].x, rootUV[0].y);
      const d1 = sheetPoint(rootUV[1].x, rootUV[1].y);
      const d2 = sheetPoint(rootUV[2].x, rootUV[2].y);
      const frame = (p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3) => {
        const e1 = p1.clone().sub(p0).normalize();
        const e3 = e1.clone().cross(p2.clone().sub(p0)).normalize();
        const e2 = e3.clone().cross(e1);
        return new THREE.Matrix4().makeBasis(e1, e2, e3);
      };
      const Fs = frame(s0, s1, s2);
      const Fd = frame(d0, d1, d2);
      const R = Fd.clone().multiply(Fs.clone().transpose());
      const quat = new THREE.Quaternion().setFromRotationMatrix(R);

      // Centroids (of the island bbox center) for a clean straight path.
      const cx = (island.bboxMin.x + island.bboxMax.x) / 2;
      const cy = (island.bboxMin.y + island.bboxMax.y) / 2;
      // bbox center is in rotated space; take it back to raw island coords
      const rc = Math.cos(-island.rotation), rs = Math.sin(-island.rotation);
      const rawCx = cx * rc - cy * rs;
      const rawCy = cx * rs + cy * rc;
      const c0 = flatPoint(rawCx, rawCy);
      const c1 = sheetPoint(rawCx, rawCy);
      this.islandAnims.push({ quat, c0, c1, order: island.index });
    }
  }

  private buildSheets(net: NetResult, layout: LayoutResult) {
    this.sheetGroup.clear();
    const pageW = layout.pageW, pageH = layout.pageH;
    const gapX = pageW * 0.12;
    const nPages = layout.pageCount;
    const totalW = nPages * pageW + (nPages - 1) * gapX;
    for (let p = 0; p < nPages; p++) {
      const geo = new THREE.PlaneGeometry(pageW, pageH);
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0 });
      const sheet = new THREE.Mesh(geo, mat);
      sheet.rotation.x = -Math.PI / 2;
      sheet.position.set(-totalW / 2 + p * (pageW + gapX) + pageW / 2, FLOOR_Y - 0.006, 0);
      const border = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo),
        new THREE.LineBasicMaterial({ color: 0xd8d1c2, transparent: true, opacity: 0 })
      );
      border.rotation.x = -Math.PI / 2;
      border.position.copy(sheet.position);
      this.sheetGroup.add(sheet, border);
    }
  }

  // ------------------------------------------------------------------
  // Animation
  // ------------------------------------------------------------------

  /** t in [0, 2]: 0..1 unfold, 1..2 arrange onto sheets. */
  seek(t: number) {
    this.t = THREE.MathUtils.clamp(t, 0, 2);
    this.playTarget = null;
    this.onPlayStateChange?.(false);
    if (this.net) this.applyT(this.t);
    this.onTick?.(this.t);
  }

  play() {
    if (!this.net) return;
    if (this.t >= 1.999) this.t = 0;
    this.playTarget = 2;
    this.onPlayStateChange?.(true);
  }

  playBack() {
    if (!this.net) return;
    this.playTarget = 0;
    this.onPlayStateChange?.(true);
  }

  pause() {
    this.playTarget = null;
    this.onPlayStateChange?.(false);
  }

  get param() {
    return this.t;
  }

  private applyT(t: number) {
    const net = this.net!;
    const mesh = net.mesh;
    const u = THREE.MathUtils.clamp(t, 0, 1);
    const u2raw = THREE.MathUtils.clamp(t - 1, 0, 1);
    const u2 = easeInOut(u2raw);

    // Fold stagger: each fold occupies a window; deeper hinges start later.
    const w = 0.55;
    const delay = (1 - w) / this.maxDepth;

    const rot = new THREE.Matrix4();
    const tmp = new THREE.Matrix4();
    const axis = new THREE.Vector3();
    const point = new THREE.Vector3();

    for (const anim of this.faceAnims) {
      const M = this.faceMatrix[anim.faceIndex];
      if (anim.parent < 0) {
        M.identity();
      } else {
        const local = THREE.MathUtils.clamp((u - (anim.depth - 1) * delay) / w, 0, 1);
        const ang = anim.angle * easeInOut(local);
        axis.set(anim.dx, anim.dy, anim.dz);
        point.set(anim.hx, anim.hy, anim.hz);
        makeRotationAboutLine(rot, point, axis, ang);
        tmp.multiplyMatrices(this.faceMatrix[anim.parent], rot);
        M.copy(tmp);
      }
    }

    // Phase 2: rigid island motion onto sheets.
    if (u2 > 0) {
      const q = new THREE.Quaternion();
      const iq = new THREE.Quaternion();
      const one = new THREE.Vector3(1, 1, 1);
      const pre = new THREE.Matrix4();
      const nIslands = this.islandAnims.length;
      const perIslandM: THREE.Matrix4[] = new Array(nIslands);
      for (let i = 0; i < nIslands; i++) {
        const ia = this.islandAnims[i];
        // slight per-island stagger for a cascading landing
        const s = nIslands > 1 ? (i / (nIslands - 1)) * 0.18 : 0;
        const uu = THREE.MathUtils.clamp((u2 - s) / (1 - 0.18), 0, 1);
        iq.identity();
        q.copy(iq).slerp(ia.quat, uu);
        const c = ia.c0.clone().lerp(ia.c1, uu);
        // lift the path in an arc
        c.y += Math.sin(uu * Math.PI) * 0.35;
        // rotate about c0: M = T(c) R T(-c0)  (fresh matrix per island!)
        perIslandM[i] = new THREE.Matrix4()
          .compose(c, q, one)
          .multiply(pre.makeTranslation(-ia.c0.x, -ia.c0.y, -ia.c0.z));
      }
      for (const anim of this.faceAnims) {
        this.faceMatrix[anim.faceIndex].premultiply(perIslandM[anim.islandIndex]);
      }
    }

    // Write vertex positions + flat normals.
    const posArr = this.posAttr!.array as Float32Array;
    const normArr = this.normAttr!.array as Float32Array;
    const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    const e1 = new THREE.Vector3();
    const e2 = new THREE.Vector3();
    const n = new THREE.Vector3();
    const nf = mesh.faces.length / 3;
    for (let f = 0; f < nf; f++) {
      const M = this.faceMatrix[f];
      for (let k = 0; k < 3; k++) {
        const vi = mesh.faces[f * 3 + k];
        v[k].set(mesh.positions[vi * 3], mesh.positions[vi * 3 + 1], mesh.positions[vi * 3 + 2]).applyMatrix4(M);
        posArr[f * 9 + k * 3] = v[k].x;
        posArr[f * 9 + k * 3 + 1] = v[k].y;
        posArr[f * 9 + k * 3 + 2] = v[k].z;
      }
      n.copy(e1.copy(v[1]).sub(v[0]).cross(e2.copy(v[2]).sub(v[0]))).normalize();
      for (let k = 0; k < 3; k++) {
        normArr[f * 9 + k * 3] = n.x;
        normArr[f * 9 + k * 3 + 1] = n.y;
        normArr[f * 9 + k * 3 + 2] = n.z;
      }
    }
    this.posAttr!.needsUpdate = true;
    this.normAttr!.needsUpdate = true;
    this.netGroup?.children.forEach((c) => {
      const g = (c as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
      g?.computeBoundingSphere?.();
    });

    // Lines.
    const p = new THREE.Vector3();
    for (const lg of this.lineGroups) {
      const arr = lg.attr.array as Float32Array;
      for (let i = 0; i < lg.refs.length; i++) {
        const ref = lg.refs[i];
        const M = this.faceMatrix[ref.face];
        p.set(mesh.positions[ref.va * 3], mesh.positions[ref.va * 3 + 1], mesh.positions[ref.va * 3 + 2]).applyMatrix4(M);
        arr[i * 6] = p.x; arr[i * 6 + 1] = p.y; arr[i * 6 + 2] = p.z;
        p.set(mesh.positions[ref.vb * 3], mesh.positions[ref.vb * 3 + 1], mesh.positions[ref.vb * 3 + 2]).applyMatrix4(M);
        arr[i * 6 + 3] = p.x; arr[i * 6 + 4] = p.y; arr[i * 6 + 5] = p.z;
      }
      lg.attr.needsUpdate = true;
    }

    // Sheets fade in with phase 2.
    this.sheetGroup.children.forEach((c) => {
      const mat = (c as THREE.Mesh).material as THREE.Material & { opacity: number };
      mat.opacity = u2 * ((c as THREE.LineSegments).isLineSegments ? 0.9 : 0.94);
    });

    // Camera choreography for phase 2.
    this.updateCameraBlend(u2);
  }

  private updateCameraBlend(u2: number) {
    if (u2 > 0 && !this.camBlend.active) {
      this.camBlend.active = true;
      this.camBlend.from.copy(this.camera.position);
      this.camBlend.fromTarget.copy(this.controls.target);
      // Fit sheets from above.
      const box = new THREE.Box3().setFromObject(this.sheetGroup);
      const size = box.getSize(new THREE.Vector3());
      const fitH = Math.max(size.x / this.camera.aspect, size.z) * 1.25;
      const dist = fitH / 2 / Math.tan((this.camera.fov * Math.PI) / 360);
      this.topPos.set(0, FLOOR_Y + Math.max(dist, 1.5), 0.001);
      this.topTarget.set(0, FLOOR_Y, 0);
      this.controls.enabled = false;
    }
    if (this.camBlend.active) {
      const k = easeInOut(THREE.MathUtils.clamp(u2 * 1.15, 0, 1));
      this.camera.position.lerpVectors(this.camBlend.from, this.topPos, k);
      this.controls.target.lerpVectors(this.camBlend.fromTarget, this.topTarget, k);
      this.camera.lookAt(this.controls.target);
      if (u2 <= 0.0001) {
        this.camBlend.active = false;
        this.controls.enabled = true;
      }
    }
  }

  private frameSubject(radius: number) {
    const vFov = (this.camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    const fov = Math.min(vFov, hFov);
    const dist = (radius / Math.tan(fov / 2)) * 1.12;
    const dir = new THREE.Vector3(0.72, 0.45, 0.9).normalize();
    this.camera.position.copy(dir.multiplyScalar(Math.max(dist, 2.2)));
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  private clearGroups() {
    if (this.meshGroup) {
      this.root.remove(this.meshGroup);
      disposeGroup(this.meshGroup);
      this.meshGroup = null;
    }
    if (this.netGroup) {
      this.root.remove(this.netGroup);
      disposeGroup(this.netGroup);
      this.netGroup = null;
    }
    this.sheetGroup.clear();
    this.camBlend.active = false;
    this.controls.enabled = true;
    this.root.rotation.set(0, 0, 0);
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 0.05);

    if (this.playTarget !== null && this.net) {
      const nf = this.net.mesh.faces.length / 3;
      const durPhase1 = Math.min(6.5, 3.0 + nf * 0.0022);
      const durPhase2 = 1.9;
      const dur = this.t < 1 || (this.playTarget === 0 && this.t <= 1) ? durPhase1 : durPhase2;
      const dir = this.playTarget > this.t ? 1 : -1;
      this.t += (dir * dt) / dur;
      if ((dir > 0 && this.t >= this.playTarget) || (dir < 0 && this.t <= this.playTarget)) {
        this.t = this.playTarget;
        this.playTarget = null;
        this.onPlayStateChange?.(false);
      }
      this.applyT(this.t);
      this.onTick?.(this.t);
    }

    if (this.autoSpin && this.meshGroup && !this.net) {
      this.root.rotation.y += dt * 0.25;
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };
}

function easeInOut(x: number): number {
  return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
}

function makeRotationAboutLine(out: THREE.Matrix4, point: THREE.Vector3, axis: THREE.Vector3, angle: number) {
  out.makeRotationAxis(axis, angle);
  const e = out.elements;
  const px = point.x, py = point.y, pz = point.z;
  e[12] = px - (e[0] * px + e[4] * py + e[8] * pz);
  e[13] = py - (e[1] * px + e[5] * py + e[9] * pz);
  e[14] = pz - (e[2] * px + e[6] * py + e[10] * pz);
}

function frontMaterial() {
  return new THREE.MeshStandardMaterial({
    color: PAPER_FRONT,
    roughness: 0.82,
    metalness: 0,
    side: THREE.FrontSide,
  });
}

function backMaterial() {
  return new THREE.MeshStandardMaterial({
    color: PAPER_BACK,
    roughness: 0.95,
    metalness: 0,
    side: THREE.BackSide,
  });
}

function disposeGroup(g: THREE.Group) {
  g.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat?.dispose();
  });
}

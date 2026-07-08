/** Vector PDF export: cut lines, valley/mountain fold lines, numbered glue tabs. */

import { jsPDF } from "jspdf";
import type { NetResult, Vec2 } from "./types";
import { maxScaleFor, packIslands } from "./layout";

export type PaperFormat = "a4" | "letter";

export interface PdfOptions {
  format: PaperFormat;
  /** Finished model longest dimension, cm. */
  targetSizeCm: number;
}

export const PAGE_MM: Record<PaperFormat, { w: number; h: number }> = {
  a4: { w: 210, h: 297 },
  letter: { w: 215.9, h: 279.4 },
};

const MARGIN = 12;
const GAP = 5;

/** Largest printable model size (cm) for this net and paper format. */
export function maxSizeCm(net: NetResult, format: PaperFormat): number {
  const { w, h } = PAGE_MM[format];
  const s = maxScaleFor(net, w, h, MARGIN, GAP);
  // model longest dim = 2 units; scale is mm per unit.
  return Math.floor(((s * 2) / 10) * 10) / 10;
}

export function estimatePages(net: NetResult, opts: PdfOptions): number {
  const { w, h } = PAGE_MM[opts.format];
  const scale = Math.min((opts.targetSizeCm * 10) / 2, maxScaleFor(net, w, h, MARGIN, GAP));
  return packIslands(net, { pageW: w, pageH: h, margin: MARGIN, scale, gap: GAP }).pageCount;
}

export function exportPDF(net: NetResult, opts: PdfOptions): void {
  const doc = renderPDF(net, opts);
  const safeName = net.mesh.name.replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "") || "model";
  doc.save(`unfold-${safeName}.pdf`);
}

/** Build the PDF document (separated from save() so tests can inspect it). */
export function renderPDF(net: NetResult, opts: PdfOptions): jsPDF {
  const { w: pageW, h: pageH } = PAGE_MM[opts.format];
  const requested = (opts.targetSizeCm * 10) / 2;
  const scale = Math.min(requested, maxScaleFor(net, pageW, pageH, MARGIN, GAP));
  const layout = packIslands(net, { pageW, pageH, margin: MARGIN, scale, gap: GAP });

  const doc = new jsPDF({ unit: "mm", format: opts.format, orientation: "portrait" });

  // Per-island page transform. Print shows the OUTSIDE of the model, so we flip
  // y (island space is y-up, page is y-down) to view the net from the +normal side.
  const transforms = new Map<number, (p: Vec2) => Vec2>();
  for (const pl of layout.placements) {
    const island = net.islands[pl.islandIndex];
    const { rotation, bboxMin, bboxMax } = island;
    const c = Math.cos(rotation), s = Math.sin(rotation);
    const x0 = pl.x, y0 = pl.y, ymax = bboxMax.y;
    transforms.set(pl.islandIndex, (p: Vec2) => {
      const rx = p.x * c - p.y * s;
      const ry = p.x * s + p.y * c;
      return { x: x0 + (rx - bboxMin.x) * scale, y: y0 + (ymax - ry) * scale };
    });
  }
  const pageOf = new Map<number, number>();
  for (const pl of layout.placements) pageOf.set(pl.islandIndex, pl.page);

  const ink: [number, number, number] = [40, 38, 34];
  const soft: [number, number, number] = [120, 115, 106];
  const tabFill: [number, number, number] = [243, 240, 232];

  const numberSizePt = Math.min(9, Math.max(4.5, (net.tabDepth * scale * 0.55) / 0.3528));

  for (let page = 0; page < layout.pageCount; page++) {
    if (page > 0) doc.addPage(opts.format, "portrait");

    doc.setFont("helvetica", "normal");

    for (const pl of layout.placements) {
      if (pl.page !== page) continue;
      const islandIdx = pl.islandIndex;
      const T = transforms.get(islandIdx)!;

      // Glue tabs first (filled), their bases become fold lines.
      doc.setFillColor(...tabFill);
      doc.setDrawColor(...ink);
      doc.setLineWidth(0.3);
      doc.setLineDashPattern([], 0);
      for (const cut of net.cuts) {
        if (cut.islandIndex !== islandIdx || !cut.tab) continue;
        const pts = cut.tab.map(T);
        // Outer tab outline: solid cut line around the 3 outer segments + fill.
        const vectors: [number, number][] = [];
        for (let i = 1; i < pts.length; i++) vectors.push([pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y]);
        doc.lines(vectors, pts[0].x, pts[0].y, [1, 1], "F", true);
        for (let i = 0; i < 3; i++) doc.line(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
        // Tab base folds inward: dashed.
        doc.setLineDashPattern([1.6, 1.2], 0);
        doc.line(pts[0].x, pts[0].y, pts[3].x, pts[3].y);
        doc.setLineDashPattern([], 0);
      }

      // Cut edges without a tab: solid.
      doc.setLineWidth(0.35);
      doc.setDrawColor(...ink);
      for (const cut of net.cuts) {
        if (cut.islandIndex !== islandIdx || cut.tab) continue;
        const a = T(cut.a), b = T(cut.b);
        doc.line(a.x, a.y, b.x, b.y);
      }

      // Fold lines.
      doc.setLineWidth(0.22);
      doc.setDrawColor(...soft);
      for (const fold of net.folds) {
        if (fold.islandIndex !== islandIdx) continue;
        const a = T(fold.a), b = T(fold.b);
        if (fold.type === "valley") doc.setLineDashPattern([2.2, 1.5], 0);
        else doc.setLineDashPattern([3.2, 1.2, 0.6, 1.2], 0);
        doc.line(a.x, a.y, b.x, b.y);
      }
      doc.setLineDashPattern([], 0);

      // Edge-pair numbers.
      doc.setFontSize(numberSizePt);
      doc.setTextColor(...soft);
      for (const cut of net.cuts) {
        if (cut.islandIndex !== islandIdx || cut.pairId === null) continue;
        let px: number, py: number;
        if (cut.tab) {
          // Center of tab.
          px = (cut.tab[0].x + cut.tab[1].x + cut.tab[2].x + cut.tab[3].x) / 4;
          py = (cut.tab[0].y + cut.tab[1].y + cut.tab[2].y + cut.tab[3].y) / 4;
        } else {
          // Just inside the face (left of a->b in island space).
          const dx = cut.b.x - cut.a.x, dy = cut.b.y - cut.a.y;
          const len = Math.hypot(dx, dy) || 1;
          const off = Math.min(net.tabDepth * 0.5, len * 0.25);
          px = (cut.a.x + cut.b.x) / 2 - (dy / len) * off;
          py = (cut.a.y + cut.b.y) / 2 + (dx / len) * off;
        }
        const p = T({ x: px, y: py });
        doc.text(String(cut.pairId), p.x, p.y, { align: "center", baseline: "middle" });
      }

      // Piece label near the island's first face.
      if (net.islands.length > 1) {
        const root = net.faces[net.islands[islandIdx].rootFace];
        const cx = (root.uv[0].x + root.uv[1].x + root.uv[2].x) / 3;
        const cy = (root.uv[0].y + root.uv[1].y + root.uv[2].y) / 3;
        const p = T({ x: cx, y: cy });
        doc.setFontSize(Math.min(11, numberSizePt + 3));
        doc.setTextColor(190, 184, 172);
        doc.text(`P${islandIdx + 1}`, p.x, p.y, { align: "center", baseline: "middle" });
        doc.setTextColor(...soft);
      }
    }

    // Footer.
    doc.setFontSize(7.5);
    doc.setTextColor(150, 144, 134);
    const sizeNote = `finished size ~${((scale * 2) / 10).toFixed(1)} cm`;
    doc.text(
      `Unfold — ${net.mesh.name}  ·  ${sizeNote}  ·  solid = cut   dashed = valley fold   dash-dot = mountain fold   matching numbers glue together`,
      pageW / 2,
      pageH - 5.5,
      { align: "center" }
    );
    doc.text(`${page + 1} / ${layout.pageCount}`, pageW - MARGIN, pageH - 5.5, { align: "right" });
  }

  return doc;
}

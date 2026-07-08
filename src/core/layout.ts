/** Shelf-packing of net islands onto pages (PDF pages or virtual paper sheets). */

import type { LayoutResult, NetResult, Placement } from "./types";

export interface PackOptions {
  pageW: number;
  pageH: number;
  margin: number;
  /** Page units per model unit. */
  scale: number;
  /** Gap between islands, page units. */
  gap: number;
}

/** Largest scale at which every island fits within one page's printable area. */
export function maxScaleFor(net: NetResult, pageW: number, pageH: number, margin: number, gap: number): number {
  const printW = pageW - 2 * margin - 2 * gap;
  const printH = pageH - 2 * margin - 2 * gap;
  let s = Infinity;
  for (const island of net.islands) {
    const w = island.bboxMax.x - island.bboxMin.x;
    const h = island.bboxMax.y - island.bboxMin.y;
    if (w <= 0 || h <= 0) continue;
    s = Math.min(s, printW / w, printH / h);
  }
  return Number.isFinite(s) ? s : 1;
}

export function packIslands(net: NetResult, opts: PackOptions): LayoutResult {
  const { pageW, pageH, margin, scale, gap } = opts;
  const printW = pageW - 2 * margin;
  const printH = pageH - 2 * margin;

  const dims = new Map<number, { w: number; h: number }>();
  for (const island of net.islands) {
    dims.set(island.index, {
      w: (island.bboxMax.x - island.bboxMin.x) * scale,
      h: (island.bboxMax.y - island.bboxMin.y) * scale,
    });
  }

  const items = net.islands
    .map((island) => {
      const d = dims.get(island.index)!;
      return { index: island.index, w: d.w + gap, h: d.h + gap };
    })
    .sort((a, b) => b.h - a.h);

  const placements: Placement[] = [];
  let page = 0;
  let shelfY = 0;
  let shelfH = 0;
  let cursorX = 0;

  for (const it of items) {
    if (it.w > printW + 1e-9 || it.h > printH + 1e-9) {
      throw new Error("An island is larger than the printable page area at this scale.");
    }
    if (cursorX + it.w > printW + 1e-9) {
      // next shelf
      shelfY += shelfH;
      cursorX = 0;
      shelfH = 0;
    }
    if (shelfY + it.h > printH + 1e-9) {
      // next page
      page++;
      shelfY = 0;
      shelfH = 0;
      cursorX = 0;
    }
    placements.push({
      islandIndex: it.index,
      page,
      x: margin + cursorX + gap / 2,
      y: margin + shelfY + gap / 2,
    });
    cursorX += it.w;
    shelfH = Math.max(shelfH, it.h);
  }

  const pageCount = page + 1;
  centerPlacements(placements, dims, pageCount, margin, printW, printH);

  return { pageW, pageH, margin, pageCount, scale, placements };
}

/** Distribute each page's leftover space evenly on all sides instead of leaving it in one corner. */
function centerPlacements(
  placements: Placement[],
  dims: Map<number, { w: number; h: number }>,
  pageCount: number,
  margin: number,
  printW: number,
  printH: number
): void {
  for (let p = 0; p < pageCount; p++) {
    const onPage = placements.filter((pl) => pl.page === p);
    if (onPage.length === 0) continue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const pl of onPage) {
      const d = dims.get(pl.islandIndex)!;
      minX = Math.min(minX, pl.x);
      minY = Math.min(minY, pl.y);
      maxX = Math.max(maxX, pl.x + d.w);
      maxY = Math.max(maxY, pl.y + d.h);
    }
    const offsetX = margin + (printW - (maxX - minX)) / 2 - minX;
    const offsetY = margin + (printH - (maxY - minY)) / 2 - minY;
    for (const pl of onPage) {
      pl.x += offsetX;
      pl.y += offsetY;
    }
  }
}

/**
 * Layout used by the unfold animation: islands land on virtual A4-proportioned
 * sheets sized in model units, so the motion is perfectly rigid (scale 1).
 */
export function animationLayout(net: NetResult): LayoutResult {
  let maxW = 0, maxH = 0, totalArea = 0;
  for (const island of net.islands) {
    const w = island.bboxMax.x - island.bboxMin.x;
    const h = island.bboxMax.y - island.bboxMin.y;
    maxW = Math.max(maxW, w);
    maxH = Math.max(maxH, h);
    totalArea += w * h;
  }
  const aspect = Math.SQRT2; // A-series
  let sheetW = Math.max(maxW * 1.18, (maxH / aspect) * 1.18, Math.sqrt((totalArea * 1.7) / aspect));
  sheetW = Math.max(sheetW, 0.5);
  const margin = sheetW * 0.045;
  const gap = sheetW * 0.03;
  return packIslands(net, { pageW: sheetW, pageH: sheetW * aspect, margin, scale: 1, gap });
}

/** STL parsing (binary + ASCII) into a raw triangle soup. */

export interface TriangleSoup {
  /** 9 floats per triangle: v0 v1 v2. */
  positions: Float64Array;
  triangleCount: number;
}

export function parseSTL(buffer: ArrayBuffer): TriangleSoup {
  if (isBinarySTL(buffer)) return parseBinary(buffer);
  return parseASCII(new TextDecoder().decode(buffer));
}

function isBinarySTL(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 84) return false;
  const view = new DataView(buffer);
  const count = view.getUint32(80, true);
  const expected = 84 + count * 50;
  if (expected === buffer.byteLength) return true;
  // Some exporters pad the file; accept close matches.
  if (count > 0 && Math.abs(expected - buffer.byteLength) <= 512 && expected <= buffer.byteLength) return true;
  // If it doesn't start with "solid", it must be binary (possibly malformed count).
  const head = new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(6, buffer.byteLength)));
  return !/^solid/i.test(head.trim());
}

function parseBinary(buffer: ArrayBuffer): TriangleSoup {
  const view = new DataView(buffer);
  let count = view.getUint32(80, true);
  const maxCount = Math.floor((buffer.byteLength - 84) / 50);
  count = Math.min(count, maxCount);
  const positions = new Float64Array(count * 9);
  let o = 84;
  for (let i = 0; i < count; i++) {
    o += 12; // skip normal
    for (let k = 0; k < 9; k++) {
      positions[i * 9 + k] = view.getFloat32(o, true);
      o += 4;
    }
    o += 2; // attribute byte count
  }
  return { positions, triangleCount: count };
}

function parseASCII(text: string): TriangleSoup {
  const verts: number[] = [];
  const re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    verts.push(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
  }
  const triangleCount = Math.floor(verts.length / 9);
  return { positions: new Float64Array(verts.slice(0, triangleCount * 9)), triangleCount };
}

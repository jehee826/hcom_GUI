import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_DIR = resolve(ROOT_DIR, 'build');

interface RgbaCanvas {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

function createCanvas(width: number, height: number, r: number, g: number, b: number, a = 255): RgbaCanvas {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = a;
  }
  return { width, height, data };
}

function blendPixel(canvas: RgbaCanvas, x: number, y: number, r: number, g: number, b: number, alpha: number): void {
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height || alpha <= 0) return;
  const a = Math.min(1, alpha);
  const idx = (y * canvas.width + x) * 4;
  const dstA = canvas.data[idx + 3]! / 255;
  const outA = a + dstA * (1 - a);
  if (outA <= 0) return;
  canvas.data[idx] = Math.round((r * a + canvas.data[idx]! * dstA * (1 - a)) / outA);
  canvas.data[idx + 1] = Math.round((g * a + canvas.data[idx + 1]! * dstA * (1 - a)) / outA);
  canvas.data[idx + 2] = Math.round((b * a + canvas.data[idx + 2]! * dstA * (1 - a)) / outA);
  canvas.data[idx + 3] = Math.round(outA * 255);
}

function roundedRectSdf(px: number, py: number, x: number, y: number, w: number, h: number, radius: number): number {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const hx = w / 2 - radius;
  const hy = h / 2 - radius;
  const dx = Math.abs(px - cx) - hx;
  const dy = Math.abs(py - cy) - hy;
  const out = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  const inside = Math.min(Math.max(dx, dy), 0);
  return out + inside - radius;
}

function fillRoundedRect(
  canvas: RgbaCanvas,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  color: [number, number, number],
  opacity = 1,
): void {
  const x0 = Math.max(0, Math.floor(x - 2));
  const y0 = Math.max(0, Math.floor(y - 2));
  const x1 = Math.min(canvas.width - 1, Math.ceil(x + w + 2));
  const y1 = Math.min(canvas.height - 1, Math.ceil(y + h + 2));
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const dist = roundedRectSdf(px + 0.5, py + 0.5, x, y, w, h, radius);
      const cov = Math.max(0, Math.min(1, 0.5 - dist));
      if (cov > 0) blendPixel(canvas, px, py, color[0], color[1], color[2], cov * opacity);
    }
  }
}

function strokeRoundedRect(
  canvas: RgbaCanvas,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  thickness: number,
  color: [number, number, number],
  opacity = 1,
): void {
  const half = thickness / 2;
  const x0 = Math.max(0, Math.floor(x - thickness - 2));
  const y0 = Math.max(0, Math.floor(y - thickness - 2));
  const x1 = Math.min(canvas.width - 1, Math.ceil(x + w + thickness + 2));
  const y1 = Math.min(canvas.height - 1, Math.ceil(y + h + thickness + 2));
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const dist = Math.abs(roundedRectSdf(px + 0.5, py + 0.5, x, y, w, h, radius)) - half;
      const cov = Math.max(0, Math.min(1, 0.5 - dist));
      if (cov > 0) blendPixel(canvas, px, py, color[0], color[1], color[2], cov * opacity);
    }
  }
}

function fillCircle(
  canvas: RgbaCanvas,
  cx: number,
  cy: number,
  radius: number,
  color: [number, number, number],
  opacity = 1,
): void {
  const x0 = Math.max(0, Math.floor(cx - radius - 2));
  const y0 = Math.max(0, Math.floor(cy - radius - 2));
  const x1 = Math.min(canvas.width - 1, Math.ceil(cx + radius + 2));
  const y1 = Math.min(canvas.height - 1, Math.ceil(cy + radius + 2));
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const dist = Math.hypot(px + 0.5 - cx, py + 0.5 - cy) - radius;
      const cov = Math.max(0, Math.min(1, 0.5 - dist));
      if (cov > 0) blendPixel(canvas, px, py, color[0], color[1], color[2], cov * opacity);
    }
  }
}

function strokeSegment(
  canvas: RgbaCanvas,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  thickness: number,
  color: [number, number, number],
  opacity = 1,
): void {
  const half = thickness / 2;
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - half - 2));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by) - half - 2));
  const x1 = Math.min(canvas.width - 1, Math.ceil(Math.max(ax, bx) + half + 2));
  const y1 = Math.min(canvas.height - 1, Math.ceil(Math.max(ay, by) + half + 2));
  const vx = bx - ax;
  const vy = by - ay;
  const lenSq = vx * vx + vy * vy || 1;
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const wx = px + 0.5 - ax;
      const wy = py + 0.5 - ay;
      const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / lenSq));
      const dist = Math.hypot(wx - t * vx, wy - t * vy) - half;
      const cov = Math.max(0, Math.min(1, 0.5 - dist));
      if (cov > 0) blendPixel(canvas, px, py, color[0], color[1], color[2], cov * opacity);
    }
  }
}

function drawEmblem(canvas: RgbaCanvas, x: number, y: number, size: number, inverted = false): void {
  const bg: [number, number, number] = inverted ? [255, 255, 255] : [17, 17, 17];
  const fg: [number, number, number] = inverted ? [17, 17, 17] : [255, 255, 255];
  const rim: [number, number, number] = inverted ? [224, 224, 228] : [48, 48, 54];
  const radius = size * 0.24;

  fillRoundedRect(canvas, x, y, size, size, radius, bg, 1);
  strokeRoundedRect(canvas, x + size * 0.02, y + size * 0.02, size * 0.96, size * 0.96, radius * 0.94, Math.max(1, size * 0.02), rim, 0.9);

  const n1x = x + size * 0.34;
  const n1y = y + size * 0.36;
  const n2x = x + size * 0.66;
  const n2y = y + size * 0.36;
  const n3x = x + size * 0.50;
  const n3y = y + size * 0.66;
  const strokeW = Math.max(1.2, size * 0.068);
  const dotR = Math.max(1.5, size * 0.105);

  strokeSegment(canvas, n1x, n1y, n2x, n2y, strokeW, fg, 0.92);
  strokeSegment(canvas, n1x, n1y, n3x, n3y, strokeW, fg, 0.92);
  strokeSegment(canvas, n2x, n2y, n3x, n3y, strokeW, fg, 0.92);

  fillCircle(canvas, n1x, n1y, dotR, fg, 1);
  fillCircle(canvas, n2x, n2y, dotR, fg, 1);
  fillCircle(canvas, n3x, n3y, dotR, fg, 1);
}

function renderIconCanvas(size: number): RgbaCanvas {
  const canvas = createCanvas(size, size, 0, 0, 0, 0);
  const pad = Math.round(size * 0.06);
  drawEmblem(canvas, pad, pad, size - pad * 2, false);
  return canvas;
}

function renderHeaderBmp(): RgbaCanvas {
  // NSIS MUI2 헤더 규격: 150 x 57
  const width = 150;
  const height = 57;
  const canvas = createCanvas(width, height, 255, 255, 255, 255);

  // 상단 옅은 회색 도트 그리드 장식
  for (let gx = 10; gx < 96; gx += 12) {
    for (let gy = 10; gy < 48; gy += 12) {
      fillCircle(canvas, gx, gy, 1, [232, 232, 236], 1);
    }
  }

  // 우측 hcom_gui 엠블럼
  drawEmblem(canvas, 102, 10, 36, false);

  // 하단 1px 구분선
  for (let x = 0; x < width; x++) {
    blendPixel(canvas, x, height - 1, 230, 230, 234, 1);
  }
  return canvas;
}

function renderSidebarBmp(): RgbaCanvas {
  // NSIS MUI2 웰컴/완료 사이드바 규격: 164 x 314
  const width = 164;
  const height = 314;
  const canvas = createCanvas(width, height, 17, 17, 19, 255);

  // 미세한 모노크롬 그라데이션과 기하학 격자
  for (let y = 0; y < height; y++) {
    const shade = Math.round(15 + (y / height) * 10);
    for (let x = 0; x < width; x++) {
      blendPixel(canvas, x, y, shade, shade, shade + 2, 1);
    }
  }
  for (let x = 16; x < width - 10; x += 18) {
    for (let y = 16; y < height - 16; y += 18) {
      fillCircle(canvas, x, y, 0.9, [52, 52, 58], 0.7);
    }
  }

  // 상단 중앙 브랜드 카드 + 화이트 엠블럼
  fillRoundedRect(canvas, 24, 34, 114, 114, 24, [28, 28, 32], 1);
  strokeRoundedRect(canvas, 24, 34, 114, 114, 24, 1.2, [58, 58, 66], 1);
  drawEmblem(canvas, 45, 55, 72, true);

  // 하단 프로젝트별 격리 세션 시각화 카드 3개
  const cards = [
    { y: 176, active: true, w1: 68, w2: 44 },
    { y: 214, active: false, w1: 58, w2: 38 },
    { y: 252, active: false, w1: 64, w2: 30 },
  ];
  for (const item of cards) {
    fillRoundedRect(canvas, 20, item.y, 122, 28, 8, item.active ? [34, 34, 39] : [25, 25, 29], 1);
    strokeRoundedRect(canvas, 20, item.y, 122, 28, 8, 1, item.active ? [86, 86, 94] : [44, 44, 50], 1);
    fillCircle(canvas, 33, item.y + 14, 3.2, item.active ? [255, 255, 255] : [132, 132, 140], 1);
    fillRoundedRect(canvas, 44, item.y + 8, item.w1, 4.5, 2, item.active ? [242, 242, 245] : [128, 128, 136], 1);
    fillRoundedRect(canvas, 44, item.y + 16, item.w2, 3.5, 1.7, [86, 86, 94], 1);
  }

  // 우측 1px 화이트 패널 경계선
  for (let y = 0; y < height; y++) {
    blendPixel(canvas, width - 1, y, 230, 230, 234, 1);
  }
  return canvas;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, payload: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(payload.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, payload])), 0);
  return Buffer.concat([lenBuf, typeBuf, payload, crcBuf]);
}

function encodePng(canvas: RgbaCanvas): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(canvas.width, 0);
  ihdr.writeUInt32BE(canvas.height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = canvas.width * 4;
  const raw = Buffer.alloc((stride + 1) * canvas.height);
  for (let y = 0; y < canvas.height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter None
    Buffer.from(canvas.data.buffer, canvas.data.byteOffset + y * stride, stride).copy(raw, rowStart + 1);
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function encodeBmp24(canvas: RgbaCanvas): Buffer {
  const rowSize = Math.ceil((canvas.width * 3) / 4) * 4;
  const pixelBytes = rowSize * canvas.height;
  const fileSize = 54 + pixelBytes;
  const buf = Buffer.alloc(fileSize);

  // BITMAPFILEHEADER
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(54, 10);

  // BITMAPINFOHEADER
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(canvas.width, 18);
  buf.writeInt32LE(canvas.height, 22); // bottom-up
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(0, 30);
  buf.writeUInt32LE(pixelBytes, 34);
  buf.writeInt32LE(2835, 38);
  buf.writeInt32LE(2835, 42);

  for (let y = 0; y < canvas.height; y++) {
    const srcY = canvas.height - 1 - y;
    const dstRow = 54 + y * rowSize;
    for (let x = 0; x < canvas.width; x++) {
      const srcIdx = (srcY * canvas.width + x) * 4;
      const dstIdx = dstRow + x * 3;
      buf[dstIdx] = canvas.data[srcIdx + 2]!;
      buf[dstIdx + 1] = canvas.data[srcIdx + 1]!;
      buf[dstIdx + 2] = canvas.data[srcIdx]!;
    }
  }
  return buf;
}

function encodeIcoDib32(canvas: RgbaCanvas): Buffer {
  const xorBytes = canvas.width * canvas.height * 4;
  const maskRowBytes = Math.ceil(canvas.width / 32) * 4;
  const andBytes = maskRowBytes * canvas.height;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(canvas.width, 4);
  header.writeInt32LE(canvas.height * 2, 8); // XOR + AND mask height
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(xorBytes + andBytes, 20);

  const xor = Buffer.alloc(xorBytes);
  const andMask = Buffer.alloc(andBytes);
  for (let y = 0; y < canvas.height; y++) {
    const srcY = canvas.height - 1 - y;
    for (let x = 0; x < canvas.width; x++) {
      const srcIdx = (srcY * canvas.width + x) * 4;
      const dstIdx = (y * canvas.width + x) * 4;
      const a = canvas.data[srcIdx + 3]!;
      xor[dstIdx] = canvas.data[srcIdx + 2]!;
      xor[dstIdx + 1] = canvas.data[srcIdx + 1]!;
      xor[dstIdx + 2] = canvas.data[srcIdx]!;
      xor[dstIdx + 3] = a;
      if (a < 128) {
        const byteIdx = y * maskRowBytes + (x >> 3);
        andMask[byteIdx] = andMask[byteIdx]! | (0x80 >> (x & 7));
      }
    }
  }
  return Buffer.concat([header, xor, andMask]);
}

function encodeIco(sizes: number[]): Buffer {
  const frames = sizes.map(size => {
    const canvas = renderIconCanvas(size);
    const data = size >= 256 ? encodePng(canvas) : encodeIcoDib32(canvas);
    return { size, data };
  });

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);

  const entries: Buffer[] = [];
  let offset = 6 + frames.length * 16;
  for (const frame of frames) {
    const entry = Buffer.alloc(16);
    entry[0] = frame.size >= 256 ? 0 : frame.size;
    entry[1] = frame.size >= 256 ? 0 : frame.size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(frame.data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += frame.data.length;
  }

  return Buffer.concat([header, ...entries, ...frames.map(f => f.data)]);
}

export function generateBuildAssets(): void {
  mkdirSync(BUILD_DIR, { recursive: true });
  writeFileSync(resolve(BUILD_DIR, 'icon.png'), encodePng(renderIconCanvas(256)));
  writeFileSync(resolve(BUILD_DIR, 'icon.ico'), encodeIco([16, 24, 32, 48, 64, 128, 256]));
  writeFileSync(resolve(BUILD_DIR, 'installer-header.bmp'), encodeBmp24(renderHeaderBmp()));
  writeFileSync(resolve(BUILD_DIR, 'installer-sidebar.bmp'), encodeBmp24(renderSidebarBmp()));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  generateBuildAssets();
  console.log('[assets] build/icon.png, build/icon.ico, build/installer-header.bmp, build/installer-sidebar.bmp 생성 완료');
}

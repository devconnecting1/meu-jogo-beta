#!/usr/bin/env node
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync, statSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'sprites');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ---------------------------------------------------------------- CRC32 / PNG

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(canvas) {
  const { w, h, data } = canvas;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    data.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([
    PNG_MAGIC,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------- drawing

const C = (r, g, b, a = 255) => [r, g, b, a];

function makeCanvas(w, h) {
  return { w, h, data: Buffer.alloc(w * h * 4) };
}

function setPx(c, x, y, col) {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h) return;
  const i = (y * c.w + x) * 4;
  c.data[i] = col[0];
  c.data[i + 1] = col[1];
  c.data[i + 2] = col[2];
  c.data[i + 3] = col[3];
}

function fillRect(c, x, y, w, h, col) {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) setPx(c, xx, yy, col);
}

function strokeRect(c, x, y, w, h, col, t = 2) {
  fillRect(c, x, y, w, t, col);
  fillRect(c, x, y + h - t, w, t, col);
  fillRect(c, x, y, t, h, col);
  fillRect(c, x + w - t, y, t, h, col);
}

function roundedRect(c, x, y, w, h, r, col) {
  fillRect(c, x + r, y, w - 2 * r, h, col);
  fillRect(c, x, y + r, w, h - 2 * r, col);
  fillEllipse(c, x + r, y + r, r, r, col);
  fillEllipse(c, x + w - 1 - r, y + r, r, r, col);
  fillEllipse(c, x + r, y + h - 1 - r, r, r, col);
  fillEllipse(c, x + w - 1 - r, y + h - 1 - r, r, r, col);
}

function fillEllipse(c, cx, cy, rx, ry, col) {
  const x0 = Math.max(0, Math.floor(cx - rx));
  const x1 = Math.min(c.w - 1, Math.ceil(cx + rx));
  const y0 = Math.max(0, Math.floor(cy - ry));
  const y1 = Math.min(c.h - 1, Math.ceil(cy + ry));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const nx = (x + 0.5 - cx) / rx;
      const ny = (y + 0.5 - cy) / ry;
      if (nx * nx + ny * ny <= 1) setPx(c, x, y, col);
    }
  }
}

function fillCircle(c, cx, cy, r, col) {
  fillEllipse(c, cx, cy, r, r, col);
}

function ringEllipse(c, cx, cy, rx, ry, thickness, col) {
  const innerRx = Math.max(0.5, rx - thickness);
  const innerRy = Math.max(0.5, ry - thickness);
  const x0 = Math.max(0, Math.floor(cx - rx));
  const x1 = Math.min(c.w - 1, Math.ceil(cx + rx));
  const y0 = Math.max(0, Math.floor(cy - ry));
  const y1 = Math.min(c.h - 1, Math.ceil(cy + ry));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const ox = (px - cx) / rx;
      const oy = (py - cy) / ry;
      const ix = (px - cx) / innerRx;
      const iy = (py - cy) / innerRy;
      if (ox * ox + oy * oy <= 1 && ix * ix + iy * iy >= 1) setPx(c, x, y, col);
    }
  }
}

function fillPoly(c, pts, col) {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minY = Math.min(minY, p[1]);
    maxY = Math.max(maxY, p[1]);
  }
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(c.h - 1, Math.ceil(maxY));
  for (let y = y0; y <= y1; y++) {
    const sy = y + 0.5;
    const xs = [];
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[(i + 1) % pts.length];
      if ((ay <= sy && by > sy) || (by <= sy && ay > sy)) {
        xs.push(ax + ((sy - ay) / (by - ay)) * (bx - ax));
      }
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const sx0 = Math.max(0, Math.ceil(xs[i] - 0.5));
      const sx1 = Math.min(c.w - 1, Math.floor(xs[i + 1] - 0.5));
      for (let x = sx0; x <= sx1; x++) setPx(c, x, y, col);
    }
  }
}

function drawLine(c, x0, y0, x1, y1, col, thickness = 1) {
  x0 = Math.round(x0);
  y0 = Math.round(y0);
  x1 = Math.round(x1);
  y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  const half = Math.floor(thickness / 2);
  for (;;) {
    for (let oy = -half; oy < thickness - half; oy++)
      for (let ox = -half; ox < thickness - half; ox++) setPx(c, x0 + ox, y0 + oy, col);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

function outline(c, col, thickness = 1) {
  for (let t = 0; t < thickness; t++) {
    const src = Buffer.from(c.data);
    const at = (x, y) => src[(y * c.w + x) * 4 + 3];
    for (let y = 0; y < c.h; y++) {
      for (let x = 0; x < c.w; x++) {
        if (at(x, y) !== 0) continue;
        const touch =
          (x > 0 && at(x - 1, y) > 0) ||
          (x < c.w - 1 && at(x + 1, y) > 0) ||
          (y > 0 && at(x, y - 1) > 0) ||
          (y < c.h - 1 && at(x, y + 1) > 0);
        if (touch) setPx(c, x, y, col);
      }
    }
  }
}

const darker = (col, f = 0.65) => [
  Math.round(col[0] * f),
  Math.round(col[1] * f),
  Math.round(col[2] * f),
  255,
];
const lighter = (col, f = 0.35) => [
  Math.min(255, Math.round(col[0] + (255 - col[0]) * f)),
  Math.min(255, Math.round(col[1] + (255 - col[1]) * f)),
  Math.min(255, Math.round(col[2] + (255 - col[2]) * f)),
  255,
];

// ------------------------------------------------------------------ sprites

function drawHumanoid(c, body, head, opts = {}) {
  const cx = Math.floor(c.w / 2);
  const eye = opts.eye || C(20, 20, 20);
  // legs
  fillRect(c, cx - 9, c.h - 15, 7, 13, darker(body));
  fillRect(c, cx + 2, c.h - 15, 7, 13, darker(body));
  // arms
  fillRect(c, cx - 17, Math.floor(c.h * 0.42), 8, 6, body);
  fillRect(c, cx + 9, Math.floor(c.h * 0.42), 8, 6, body);
  // torso
  fillEllipse(c, cx, Math.floor(c.h * 0.58), 12, 13, body);
  // head
  fillCircle(c, cx, Math.floor(c.h * 0.28), 9, head);
  // eyes
  setPx(c, cx - 4, Math.floor(c.h * 0.28) - 1, eye);
  setPx(c, cx + 3, Math.floor(c.h * 0.28) - 1, eye);
}

function drawPlayer(c) {
  const body = C(70, 130, 220);
  const head = C(240, 200, 160);
  const cx = 24;
  fillRect(c, cx - 9, 34, 7, 10, C(45, 70, 140));
  fillRect(c, cx + 2, 34, 7, 10, C(45, 70, 140));
  fillRect(c, cx - 16, 20, 7, 12, body);
  fillRect(c, cx + 9, 20, 7, 12, body);
  fillEllipse(c, cx, 27, 12, 13, body);
  fillRect(c, cx - 12, 24, 24, 4, lighter(body, 0.3));
  fillCircle(c, cx, 13, 9, head);
  fillRect(c, cx - 9, 6, 18, 4, C(40, 60, 120)); // cap brim
  fillEllipse(c, cx, 7, 8, 5, C(50, 75, 150));
  setPx(c, cx - 4, 13, C(20, 20, 20));
  setPx(c, cx + 3, 13, C(20, 20, 20));
  outline(c, C(18, 28, 60));
}

function drawZombie(c, body, accent, opts = {}) {
  drawHumanoid(c, body, darker(body, 0.85), opts);
  // accent patch on torso
  fillEllipse(c, Math.floor(c.w / 2), Math.floor(c.h * 0.6), 6, 6, accent);
  outline(c, opts.outline || C(25, 35, 25));
}

function drawBoss(c, body, spikes, opts = {}) {
  const cx = Math.floor(c.w / 2);
  const cy = Math.floor(c.h / 2) + 4;
  const spikeCol = opts.spikeCol || C(235, 230, 215);
  const n = opts.spikeCount || 10;
  const rOut = opts.spikeOut || 44;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    const a1 = a - 0.16;
    const a2 = a + 0.16;
    fillPoly(
      c,
      [
        [cx + Math.cos(a1) * 26, cy + Math.sin(a1) * 24],
        [cx + Math.cos(a) * rOut, cy + Math.sin(a) * rOut],
        [cx + Math.cos(a2) * 26, cy + Math.sin(a2) * 24],
      ],
      spikes ? spikeCol : body,
    );
  }
  fillEllipse(c, cx, cy, 32, 30, body);
  fillEllipse(c, cx, cy + 8, 24, 16, darker(body, 0.85));
  // eyes
  fillEllipse(c, cx - 12, cy - 10, 7, 6, C(255, 245, 220));
  fillEllipse(c, cx + 12, cy - 10, 7, 6, C(255, 245, 220));
  fillCircle(c, cx - 12, cy - 10, 3, C(180, 30, 30));
  fillCircle(c, cx + 12, cy - 10, 3, C(180, 30, 30));
  // mouth
  fillRect(c, cx - 10, cy + 6, 20, 4, C(40, 10, 10));
  for (let i = 0; i < 5; i++) fillRect(c, cx - 9 + i * 4, cy + 6, 2, 3, C(240, 235, 220));
  outline(c, opts.outline || C(30, 10, 15));
}

function drawHouse(c, roofCol, opts = {}) {
  const { w, h } = c;
  const peak = Math.round(h * 0.18);
  const pts = [
    [2, h - 2],
    [2, peak],
    [Math.floor(w / 2), 2],
    [w - 3, peak],
    [w - 3, h - 2],
  ];
  fillPoly(c, pts, roofCol);
  // ridge + shingle lines
  const ridge = darker(roofCol, 0.75);
  drawLine(c, Math.floor(w / 2), 3, Math.floor(w / 2), h - 3, ridge, 2);
  for (let y = peak + 8; y < h - 6; y += 10) drawLine(c, 4, y, w - 5, y, ridge, 1);
  // door at bottom center
  const dw = Math.max(14, Math.round(w * 0.16));
  const dh = Math.max(18, Math.round(h * 0.14));
  fillRect(c, Math.floor(w / 2 - dw / 2), h - 2 - dh, dw, dh, C(110, 75, 45));
  strokeRect(c, Math.floor(w / 2 - dw / 2), h - 2 - dh, dw, dh, C(70, 45, 25), 2);
  setPx(c, Math.floor(w / 2 + dw / 2 - 4), h - 2 - Math.floor(dh / 2), C(240, 200, 60));
  if (opts.sign) {
    const sw = Math.round(w * 0.5);
    const sh = Math.max(16, Math.round(h * 0.1));
    const sx = Math.floor((w - sw) / 2);
    const sy = peak + 8;
    fillRect(c, sx, sy, sw, sh, opts.sign);
    strokeRect(c, sx, sy, sw, sh, darker(opts.sign, 0.6), 2);
    if (opts.cross) {
      const ccx = sx + Math.floor(sw / 2);
      const ccy = sy + Math.floor(sh / 2);
      fillRect(c, ccx - 2, ccy - 6, 5, 13, C(235, 240, 245));
      fillRect(c, ccx - 6, ccy - 2, 13, 5, C(235, 240, 245));
    }
  }
  outline(c, opts.outline || C(60, 35, 20));
}

function drawTree(c, leaf, leafLight) {
  const cx = Math.floor(c.w / 2);
  const trunk = C(110, 75, 45);
  fillRect(c, cx - 5, c.h - 34, 10, 32, trunk);
  fillRect(c, cx - 5, c.h - 34, 4, 32, darker(trunk, 0.8));
  fillEllipse(c, cx, Math.round(c.h * 0.4), c.w * 0.38, c.h * 0.3, leaf);
  fillEllipse(c, cx - c.w * 0.18, Math.round(c.h * 0.5), c.w * 0.24, c.h * 0.22, leaf);
  fillEllipse(c, cx + c.w * 0.18, Math.round(c.h * 0.5), c.w * 0.24, c.h * 0.22, leaf);
  fillEllipse(c, cx - c.w * 0.12, Math.round(c.h * 0.3), c.w * 0.16, c.h * 0.14, leafLight);
  fillEllipse(c, cx + c.w * 0.1, Math.round(c.h * 0.36), c.w * 0.12, c.h * 0.1, leafLight);
  outline(c, C(30, 60, 30));
}

function drawCar(c) {
  const body = C(200, 50, 50);
  roundedRect(c, 8, 6, 104, 48, 10, body);
  // wheels
  fillRect(c, 22, 2, 18, 6, C(25, 25, 28));
  fillRect(c, 80, 2, 18, 6, C(25, 25, 28));
  fillRect(c, 22, 52, 18, 6, C(25, 25, 28));
  fillRect(c, 80, 52, 18, 6, C(25, 25, 28));
  // cabin / glass
  roundedRect(c, 38, 14, 44, 32, 6, C(150, 200, 230));
  fillRect(c, 38, 28, 44, 4, darker(body, 0.8));
  fillRect(c, 44, 16, 32, 8, C(190, 225, 245));
  fillRect(c, 44, 36, 32, 8, C(120, 170, 200));
  // headlights / taillights
  fillRect(c, 106, 14, 6, 8, C(255, 240, 150));
  fillRect(c, 106, 38, 6, 8, C(255, 240, 150));
  fillRect(c, 8, 14, 5, 8, C(255, 90, 70));
  fillRect(c, 8, 38, 5, 8, C(255, 90, 70));
  // hood shade
  fillRect(c, 16, 10, 18, 40, lighter(body, 0.15));
  fillRect(c, 86, 10, 18, 40, darker(body, 0.9));
  outline(c, C(40, 15, 15));
}

function drawMotorcycle(c) {
  const cx = 36;
  fillCircle(c, 14, 28, 9, C(25, 25, 28));
  fillCircle(c, 14, 28, 4, C(90, 90, 95));
  fillCircle(c, 58, 28, 9, C(25, 25, 28));
  fillCircle(c, 58, 28, 4, C(90, 90, 95));
  roundedRect(c, 20, 16, 36, 14, 5, C(200, 50, 50)); // body
  fillRect(c, 26, 12, 18, 6, C(40, 40, 45)); // seat
  fillRect(c, 48, 14, 8, 6, C(160, 165, 170)); // tank top
  drawLine(c, 14, 28, 26, 22, C(120, 125, 130), 3); // forks
  drawLine(c, 54, 12, 62, 8, C(60, 60, 65), 3); // handlebar
  drawLine(c, 58, 28, 50, 20, C(120, 125, 130), 3);
  fillRect(c, 12, 18, 8, 5, C(255, 240, 150)); // headlight
  outline(c, C(30, 20, 20));
}

function drawBicycle(c) {
  ringEllipse(c, 14, 22, 11, 9, 2.5, C(30, 30, 35));
  ringEllipse(c, 50, 22, 11, 9, 2.5, C(30, 30, 35));
  const frame = C(50, 120, 200);
  drawLine(c, 14, 22, 32, 12, frame, 2);
  drawLine(c, 32, 12, 50, 22, frame, 2);
  drawLine(c, 14, 22, 34, 22, frame, 2);
  drawLine(c, 34, 22, 32, 12, frame, 2);
  drawLine(c, 34, 22, 50, 10, frame, 2);
  fillRect(c, 27, 8, 12, 4, C(35, 35, 40)); // seat
  drawLine(c, 50, 10, 54, 6, C(60, 60, 65), 2); // handlebar post
  drawLine(c, 49, 6, 59, 6, C(60, 60, 65), 2);
  fillCircle(c, 34, 22, 3, C(200, 200, 205)); // crank
  outline(c, C(25, 30, 40));
}

function drawWall(c, iron, horizontal) {
  const base = iron ? C(150, 155, 162) : C(160, 118, 72);
  const dark = darker(base, 0.7);
  const light = lighter(base, 0.18);
  fillRect(c, 0, 0, c.w, c.h, base);
  const long = horizontal ? c.w : c.h;
  const short = horizontal ? c.h : c.w;
  const lines = iron ? 2 : 3;
  for (let i = 1; i <= lines; i++) {
    const p = Math.round((short * i) / (lines + 1));
    if (horizontal) fillRect(c, 0, p, c.w, 1, dark);
    else fillRect(c, p, 0, 1, c.h, dark);
  }
  if (horizontal) {
    fillRect(c, 0, 0, c.w, 1, light);
  } else {
    fillRect(c, 0, 0, 1, c.h, light);
  }
  // seams / rivets
  if (iron) {
    for (let s = 12; s < long; s += 24) {
      if (horizontal) {
        fillRect(c, s, 3, 3, 3, C(90, 95, 100));
        fillRect(c, s, c.h - 6, 3, 3, C(90, 95, 100));
      } else {
        fillRect(c, 3, s, 3, 3, C(90, 95, 100));
        fillRect(c, c.w - 6, s, 3, 3, C(90, 95, 100));
      }
    }
  } else {
    for (let s = 20; s < long; s += 32) {
      if (horizontal) fillRect(c, s, 0, 2, c.h, darker(base, 0.8));
      else fillRect(c, 0, s, c.w, 2, darker(base, 0.8));
    }
  }
  const edge = iron ? C(70, 74, 80) : C(85, 58, 35);
  strokeRect(c, 0, 0, c.w, c.h, edge, 1);
}

function drawDoor(c, iron) {
  if (iron) {
    const base = C(155, 160, 168);
    fillRect(c, 2, 2, c.w - 4, c.h - 4, base);
    for (let y = 8; y < c.h - 8; y += 12) {
      fillRect(c, 5, y, c.w - 10, 3, darker(base, 0.75));
      fillRect(c, 5, y + 3, c.w - 10, 1, lighter(base, 0.25));
    }
    strokeRect(c, 2, 2, c.w - 4, c.h - 4, C(75, 80, 86), 2);
    fillCircle(c, c.w - 12, Math.floor(c.h / 2), 4, C(230, 200, 80));
    fillRect(c, c.w - 14, Math.floor(c.h / 2) - 1, 5, 3, C(180, 150, 50));
    outline(c, C(45, 48, 55));
  } else {
    const base = C(150, 105, 62);
    fillRect(c, 3, 3, c.w - 6, c.h - 6, base);
    strokeRect(c, 7, 8, c.w - 14, Math.floor(c.h / 2) - 12, darker(base, 0.75), 2);
    strokeRect(c, 7, Math.floor(c.h / 2) + 6, c.w - 14, Math.floor(c.h / 2) - 14, darker(base, 0.75), 2);
    fillRect(c, 3, 3, 3, c.h - 6, lighter(base, 0.2));
    fillCircle(c, c.w - 12, Math.floor(c.h / 2), 4, C(235, 200, 70));
    outline(c, C(70, 45, 25));
  }
}

function drawBarricade(c, iron) {
  const col = iron ? C(140, 145, 152) : C(150, 108, 65);
  const dk = darker(col, 0.65);
  if (iron) {
    drawLine(c, 6, 6, c.w - 7, c.h - 7, col, 7);
    drawLine(c, 6, c.h - 7, c.w - 7, 6, col, 7);
    drawLine(c, 6, 6, c.w - 7, c.h - 7, lighter(col, 0.25), 2);
    drawLine(c, 6, c.h - 7, c.w - 7, 6, lighter(col, 0.25), 2);
    for (const [x, y] of [
      [10, 10],
      [c.w - 11, 10],
      [10, c.h - 11],
      [c.w - 11, c.h - 11],
      [Math.floor(c.w / 2), Math.floor(c.h / 2)],
    ])
      fillCircle(c, x, y, 3, C(85, 90, 96));
    outline(c, C(55, 58, 64));
  } else {
    drawLine(c, 6, 6, c.w - 7, c.h - 7, col, 7);
    drawLine(c, 6, c.h - 7, c.w - 7, 6, col, 7);
    drawLine(c, 6, 6, c.w - 7, c.h - 7, lighter(col, 0.2), 2);
    drawLine(c, 6, c.h - 7, c.w - 7, 6, lighter(col, 0.2), 2);
    fillRect(c, 4, Math.floor(c.h / 2) - 2, c.w - 8, 4, dk);
    outline(c, C(70, 45, 25));
  }
}

function drawTurret(c) {
  const cx = Math.floor(c.w / 2);
  const cy = Math.floor(c.h / 2);
  fillRect(c, cx - 5, 4, 10, 22, C(95, 100, 108)); // barrel
  fillRect(c, cx - 5, 4, 3, 22, C(140, 145, 152));
  fillRect(c, cx - 7, 2, 14, 5, C(70, 74, 80)); // muzzle
  fillCircle(c, cx, cy + 6, 17, C(110, 116, 124));
  fillCircle(c, cx, cy + 6, 11, C(80, 86, 94));
  fillCircle(c, cx, cy + 6, 5, C(200, 160, 50));
  // treads / base
  fillRect(c, 6, c.h - 14, c.w - 12, 10, C(70, 74, 80));
  for (let x = 9; x < c.w - 9; x += 7) fillRect(c, x, c.h - 12, 4, 6, C(50, 54, 60));
  outline(c, C(35, 38, 45));
}

function drawTrap(c) {
  const cx = Math.floor(c.w / 2);
  const cy = Math.floor(c.h / 2);
  const n = 8;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const a1 = a - 0.22;
    const a2 = a + 0.22;
    fillPoly(
      c,
      [
        [cx + Math.cos(a1) * 12, cy + Math.sin(a1) * 12],
        [cx + Math.cos(a) * 22, cy + Math.sin(a) * 22],
        [cx + Math.cos(a2) * 12, cy + Math.sin(a2) * 12],
      ],
      C(190, 195, 200),
    );
  }
  fillCircle(c, cx, cy, 13, C(140, 60, 55));
  fillCircle(c, cx, cy, 8, C(90, 35, 35));
  fillCircle(c, cx, cy, 3, C(240, 210, 80));
  outline(c, C(50, 30, 30));
}

function drawCampfire(c) {
  const cx = Math.floor(c.w / 2);
  const cy = Math.floor(c.h / 2);
  drawLine(c, 5, c.h - 8, c.w - 6, c.h - 16, C(120, 80, 45), 6);
  drawLine(c, 6, c.h - 16, c.w - 5, c.h - 8, C(95, 62, 35), 6);
  drawLine(c, 5, c.h - 8, c.w - 6, c.h - 16, C(150, 105, 60), 2);
  // flame
  fillEllipse(c, cx, cy - 2, 9, 11, C(230, 110, 30));
  fillEllipse(c, cx, cy - 1, 6, 8, C(255, 190, 50));
  fillEllipse(c, cx, cy, 3, 5, C(255, 240, 160));
  fillPoly(
    c,
    [
      [cx, cy - 16],
      [cx + 5, cy - 6],
      [cx - 5, cy - 6],
    ],
    C(240, 140, 40),
  );
  outline(c, C(60, 30, 15));
}

function drawLamp(c) {
  const cx = Math.floor(c.w / 2);
  fillRect(c, cx - 2, 14, 5, c.h - 16, C(70, 74, 80));
  fillRect(c, cx - 2, 14, 2, c.h - 16, C(110, 115, 122));
  fillRect(c, cx - 6, c.h - 4, 13, 4, C(55, 58, 64));
  fillEllipse(c, cx, 10, 9, 7, C(255, 220, 90));
  fillEllipse(c, cx, 11, 6, 4, C(255, 245, 190));
  fillRect(c, cx - 9, 5, 18, 3, C(55, 58, 64));
  outline(c, C(35, 38, 45));
}

function drawCrate(c) {
  const base = C(170, 125, 72);
  fillRect(c, 2, 2, c.w - 4, c.h - 4, base);
  strokeRect(c, 2, 2, c.w - 4, c.h - 4, C(110, 78, 45), 3);
  drawLine(c, 5, 5, c.w - 6, c.h - 6, darker(base, 0.75), 2);
  drawLine(c, 5, c.h - 6, c.w - 6, 5, darker(base, 0.75), 2);
  fillRect(c, Math.floor(c.w / 2) - 6, Math.floor(c.h / 2) - 6, 13, 13, lighter(base, 0.15));
  strokeRect(c, Math.floor(c.w / 2) - 6, Math.floor(c.h / 2) - 6, 13, 13, C(110, 78, 45), 2);
  outline(c, C(70, 48, 25));
}

function drawTrash(c) {
  const base = C(140, 145, 150);
  fillPoly(
    c,
    [
      [7, 14],
      [c.w - 8, 14],
      [c.w - 11, c.h - 4],
      [10, c.h - 4],
    ],
    base,
  );
  fillRect(c, 4, 8, c.w - 8, 7, darker(base, 0.85));
  fillRect(c, Math.floor(c.w / 2) - 6, 4, 13, 5, base);
  strokeRect(c, 4, 8, c.w - 8, 7, C(85, 90, 96), 1);
  for (const x of [13, 20, 27]) fillRect(c, x, 16, 2, c.h - 22, darker(base, 0.8));
  outline(c, C(55, 58, 64));
}

function drawParcel(c) {
  const base = C(215, 185, 140);
  fillRect(c, 2, 2, c.w - 4, c.h - 4, base);
  strokeRect(c, 2, 2, c.w - 4, c.h - 4, C(150, 120, 80), 2);
  const ribbon = C(200, 60, 60);
  fillRect(c, Math.floor(c.w / 2) - 3, 2, 7, c.h - 4, ribbon);
  fillRect(c, 2, Math.floor(c.h / 2) - 3, c.w - 4, 7, ribbon);
  fillRect(c, Math.floor(c.w / 2) - 3, 2, 2, c.h - 4, lighter(ribbon, 0.25));
  // bow
  fillEllipse(c, Math.floor(c.w / 2) - 6, Math.floor(c.h / 2) - 6, 5, 4, ribbon);
  fillEllipse(c, Math.floor(c.w / 2) + 6, Math.floor(c.h / 2) - 6, 5, 4, ribbon);
  fillCircle(c, Math.floor(c.w / 2), Math.floor(c.h / 2) - 5, 3, darker(ribbon, 0.8));
  outline(c, C(90, 60, 40));
}

function drawDiamond(c) {
  const gold = C(250, 200, 50);
  fillPoly(
    c,
    [
      [12, 1],
      [23, 12],
      [12, 23],
      [1, 12],
    ],
    gold,
  );
  fillPoly(
    c,
    [
      [12, 1],
      [23, 12],
      [12, 12],
    ],
    lighter(gold, 0.3),
  );
  fillPoly(
    c,
    [
      [12, 12],
      [23, 12],
      [12, 23],
    ],
    darker(gold, 0.85),
  );
  outline(c, C(120, 85, 15));
}

function drawBullet(c) {
  fillRect(c, 1, 1, 9, 2, C(255, 225, 80));
  fillRect(c, 1, 1, 9, 1, C(255, 245, 170));
  fillPoly(
    c,
    [
      [9, 1],
      [11, 2],
      [9, 3],
    ],
    C(255, 170, 40),
  );
  outline(c, C(120, 80, 10));
}

function drawArrow(c) {
  fillRect(c, 1, 1, 11, 2, C(200, 170, 110));
  fillPoly(
    c,
    [
      [11, 0],
      [15, 2],
      [11, 4],
    ],
    C(220, 225, 230),
  );
  fillRect(c, 0, 0, 3, 4, C(160, 60, 50)); // fletching
  outline(c, C(60, 50, 30));
}

function drawDollar(c, cx, cy, col) {
  const t = 2;
  fillRect(c, cx - 5, cy - 6, 9, t, col);
  fillRect(c, cx - 5, cy - 6, t, 5, col);
  fillRect(c, cx - 5, cy - 1, 9, t, col);
  fillRect(c, cx + 2, cy - 1, t, 5, col);
  fillRect(c, cx - 5, cy + 4, 9, t, col);
  fillRect(c, cx - 1, cy - 9, t, 18, col);
}

function drawCoin(c) {
  const cx = Math.floor(c.w / 2);
  const cy = Math.floor(c.h / 2);
  fillCircle(c, cx, cy, 11, C(200, 150, 30));
  fillCircle(c, cx, cy, 9, C(255, 205, 60));
  fillCircle(c, cx - 3, cy - 3, 3, C(255, 235, 150));
  drawDollar(c, cx, cy, C(140, 100, 20));
  outline(c, C(110, 80, 15));
}

function drawShadow(c) {
  const cx = c.w / 2;
  const cy = c.h / 2;
  for (let y = 0; y < c.h; y++) {
    for (let x = 0; x < c.w; x++) {
      const nx = (x + 0.5 - cx) / (c.w / 2);
      const ny = (y + 0.5 - cy) / (c.h / 2);
      const d = Math.sqrt(nx * nx + ny * ny);
      if (d >= 1) continue;
      const t = 1 - d;
      const s = t * t * (3 - 2 * t); // smoothstep
      const a = Math.round(170 * s);
      setPx(c, x, y, [0, 0, 0, a]);
    }
  }
}

// ------------------------------------------------------------------ registry

const SPRITES = [
  ['player.png', 48, 48, drawPlayer],

  [
    'zombie1.png',
    48,
    48,
    (c) => drawZombie(c, C(90, 170, 80), C(60, 130, 55)),
  ],
  [
    'zombie2.png',
    56,
    56,
    (c) => drawZombie(c, C(150, 90, 200), C(190, 220, 70), { eye: C(220, 255, 90) }),
  ],
  [
    'zombie3.png',
    56,
    56,
    (c) => drawZombie(c, C(210, 70, 60), C(255, 140, 90), { eye: C(255, 240, 120) }),
  ],
  [
    'zombie4.png',
    56,
    56,
    (c) => drawZombie(c, C(140, 100, 65), C(90, 62, 40)),
  ],
  [
    'zombie5.png',
    64,
    48,
    (c) => {
      const body = C(50, 160, 160);
      const cx = 32;
      // crouched jumper: wide low body
      fillRect(c, 14, 32, 12, 10, darker(body));
      fillRect(c, 38, 32, 12, 10, darker(body));
      fillRect(c, 8, 18, 10, 8, body);
      fillRect(c, 46, 18, 10, 8, body);
      fillEllipse(c, cx, 26, 18, 11, body);
      fillEllipse(c, cx + 14, 14, 9, 9, darker(body, 0.85));
      setPx(c, cx + 16, 13, C(220, 255, 90));
      setPx(c, cx + 20, 13, C(220, 255, 90));
      fillEllipse(c, cx - 6, 24, 7, 6, C(40, 130, 130));
      outline(c, C(20, 45, 45));
    },
  ],

  [
    'boss1.png',
    96,
    96,
    (c) => drawBoss(c, C(140, 35, 35), true, { spikeCol: C(200, 70, 60) }),
  ],
  [
    'boss2.png',
    96,
    96,
    (c) => drawBoss(c, C(230, 120, 170), false, { spikeCount: 0, outline: C(80, 30, 55) }),
  ],
  [
    'boss3.png',
    96,
    96,
    (c) => drawBoss(c, C(130, 135, 140), false, { spikeCount: 0, outline: C(45, 48, 52) }),
  ],
  [
    'boss4.png',
    96,
    96,
    (c) =>
      drawBoss(c, C(175, 95, 40), true, {
        spikeCol: C(245, 235, 210),
        spikeCount: 14,
        spikeOut: 46,
        outline: C(55, 30, 12),
      }),
  ],

  ['house1.png', 107, 138, (c) => drawHouse(c, C(180, 80, 60))],
  ['house2.png', 171, 139, (c) => drawHouse(c, C(70, 110, 170))],
  ['house3.png', 202, 171, (c) => drawHouse(c, C(95, 150, 90))],
  ['house4.png', 267, 267, (c) => drawHouse(c, C(150, 110, 170))],

  [
    'shop.png',
    171,
    139,
    (c) => drawHouse(c, C(200, 130, 60), { sign: C(240, 170, 50) }),
  ],
  [
    'school.png',
    266,
    267,
    (c) => drawHouse(c, C(190, 160, 90), { sign: C(60, 100, 190) }),
  ],
  [
    'hospital.png',
    266,
    267,
    (c) => drawHouse(c, C(210, 215, 220), { sign: C(200, 60, 60), cross: true, outline: C(70, 75, 80) }),
  ],

  ['tree1.png', 64, 80, (c) => drawTree(c, C(70, 150, 70), C(110, 190, 95))],
  ['tree2.png', 72, 88, (c) => drawTree(c, C(55, 130, 60), C(95, 175, 85))],
  ['tree3.png', 80, 96, (c) => drawTree(c, C(45, 115, 55), C(85, 160, 80))],
  ['tree4.png', 88, 104, (c) => drawTree(c, C(40, 105, 70), C(80, 155, 100))],

  ['car.png', 120, 60, drawCar],
  ['motorcycle.png', 72, 40, drawMotorcycle],
  ['bicycle.png', 64, 32, drawBicycle],

  ['wall_h.png', 128, 16, (c) => drawWall(c, false, true)],
  ['wall_v.png', 16, 128, (c) => drawWall(c, false, false)],
  ['iron_wall_h.png', 128, 16, (c) => drawWall(c, true, true)],
  ['iron_wall_v.png', 16, 128, (c) => drawWall(c, true, false)],

  ['door.png', 48, 64, (c) => drawDoor(c, false)],
  ['iron_door.png', 48, 64, (c) => drawDoor(c, true)],

  ['barricade.png', 96, 32, (c) => drawBarricade(c, false)],
  ['iron_barricade.png', 96, 32, (c) => drawBarricade(c, true)],

  ['turret.png', 48, 48, drawTurret],
  ['trap.png', 48, 48, drawTrap],
  ['campfire.png', 40, 40, drawCampfire],
  ['lamp.png', 24, 48, drawLamp],

  ['crate.png', 48, 48, drawCrate],
  ['trash.png', 40, 48, drawTrash],
  ['parcel.png', 40, 40, drawParcel],

  ['item_generic.png', 24, 24, drawDiamond],
  ['bullet.png', 12, 4, drawBullet],
  ['arrow.png', 16, 4, drawArrow],
  ['ui_coin.png', 24, 24, drawCoin],
  ['shadow.png', 64, 32, drawShadow],
];

// ---------------------------------------------------------------------- main

mkdirSync(OUT_DIR, { recursive: true });

let failed = 0;
const rows = [];

for (const [name, w, h, draw] of SPRITES) {
  const canvas = makeCanvas(w, h);
  draw(canvas);
  const png = encodePNG(canvas);
  const path = join(OUT_DIR, name);
  writeFileSync(path, png);

  const buf = readFileSync(path);
  const size = statSync(path).size;
  const magicOK = buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC);
  const ok = magicOK && size > 0;
  if (!ok) failed++;
  rows.push(`${ok ? 'OK  ' : 'FAIL'} ${name.padEnd(22)} ${String(size).padStart(7)} bytes  ${w}x${h}`);
}

for (const r of rows) console.log(r);
console.log(`\n${rows.length} sprites written to ${OUT_DIR}`);
if (failed > 0) {
  console.error(`${failed} file(s) failed verification`);
  process.exit(1);
}
console.log('All PNGs verified (magic + nonzero size).');

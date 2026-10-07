import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

const W = 480;
const H = 480;
const BG: [number, number, number] = [26, 26, 46];
const FG: [number, number, number] = [243, 232, 200];

const GLYPHS: Record<string, string[]> = {
  M: ["#   #", "## ##", "# # #", "#   #", "#   #", "#   #", "#   #"],
  O: [" ### ", "#   #", "#   #", "#   #", "#   #", "#   #", " ### "],
  T: ["#####", "  #  ", "  #  ", "  #  ", "  #  ", "  #  ", "  #  "],
  D: ["#### ", "#   #", "#   #", "#   #", "#   #", "#   #", "#### "],
};

const pixels: Uint8Array = new Uint8Array(W * H * 3);
for (let i = 0; i < W * H; i++) {
  pixels[i * 3] = BG[0];
  pixels[i * 3 + 1] = BG[1];
  pixels[i * 3 + 2] = BG[2];
}

const word = "MOTD";
const scale = 18;
const glyphW = 5 * scale;
const gap = scale;
const totalW = word.length * glyphW + (word.length - 1) * gap;
const startX = Math.floor((W - totalW) / 2);
const startY = Math.floor((H - 7 * scale) / 2);

word.split("").forEach((ch, i) => {
  const glyph = GLYPHS[ch];
  const ox = startX + i * (glyphW + gap);
  glyph.forEach((row, y) => {
    row.split("").forEach((cell, x) => {
      if (cell !== "#") return;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = ox + x * scale + dx;
          const py = startY + y * scale + dy;
          const idx = (py * W + px) * 3;
          pixels[idx] = FG[0];
          pixels[idx + 1] = FG[1];
          pixels[idx + 2] = FG[2];
        }
      }
    });
  });
});

const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 3 + 1)] = 0;
  pixels.subarray(y * W * 3, (y + 1) * W * 3).forEach((v, i) => {
    raw[y * (W * 3 + 1) + 1 + i] = v;
  });
}

const crc32 = (buf: Buffer): number => {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
};

const chunk = (type: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 2;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);

mkdirSync("public", { recursive: true });
writeFileSync("public/card.png", png);
console.log(`public/card.png ${png.length} bytes`);

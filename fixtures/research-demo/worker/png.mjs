import { deflateSync } from 'node:zlib';

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

/** A real PNG bar chart (RGB, no dependencies). */
export function barChartPng(values, width = 360, height = 200) {
  const px = Buffer.alloc((width * 3 + 1) * height, 0xff);
  const max = Math.max(1, ...values);
  const barW = Math.floor((width - 40) / Math.max(1, values.length));
  const set = (x, y, [r, g, b]) => {
    const i = y * (width * 3 + 1) + 1 + x * 3;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
  };
  for (let y = 0; y < height; y++) px[y * (width * 3 + 1)] = 0; // filter byte
  for (let x = 20; x < width - 20; x++) set(x, height - 20, [60, 60, 60]);
  values.forEach((v, i) => {
    const h = Math.round(((height - 40) * v) / max);
    for (let x = 24 + i * barW; x < 20 + (i + 1) * barW - 4; x++) for (let y = height - 21; y > height - 21 - h; y--) set(x, y, [47, 95, 208]);
  });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(px)), chunk('IEND', Buffer.alloc(0))]);
}

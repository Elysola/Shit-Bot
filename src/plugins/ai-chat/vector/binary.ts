/** 二值量化：每一维按正负压成 1 bit（1024 维 → 128 字节），粗筛时用汉明距离近似比较 */

const POPCOUNT = new Uint8Array(256);
for (let i = 0; i < 256; i++) POPCOUNT[i] = (i & 1) + POPCOUNT[i >> 1];

export function toBinary(vec: Float32Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(vec.length / 8));
  for (let i = 0; i < vec.length; i++) {
    if (vec[i] > 0) out[i >> 3] |= 1 << (i & 7);
  }
  return out;
}

export function hamming(a: Uint8Array, b: Uint8Array): number {
  let d = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) d += POPCOUNT[a[i] ^ b[i]];
  return d;
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

/** SQLite BLOB → Float32Array（BLOB 的字节偏移不一定按 4 对齐，必要时拷贝一份） */
export function blobToFloat32(blob: Uint8Array): Float32Array {
  if (blob.byteOffset % 4 === 0) return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
  return new Float32Array(blob.slice().buffer);
}

import { createHash } from 'node:crypto';

export function shareHash(seed, name, nonce) {
  return createHash('sha256').update(`${seed}:${name}:${nonce}`).digest();
}

export function leadingZeroBits(digest) {
  let bits = 0;
  for (const byte of digest) {
    if (byte === 0) { bits += 8; continue; }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

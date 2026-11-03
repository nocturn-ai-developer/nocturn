// One hashing thread. It runs in short batches so a new job can reach it between them.
import { createHash, randomBytes } from 'node:crypto';
import { parentPort } from 'node:worker_threads';
import { leadingZeroBits } from './pow.mjs';

const BATCH = 5000;
const prefix = randomBytes(8).toString('hex');
let counter = 0;
let job = null;
let head = null; // "seed:name:prefix" as bytes, with room for the counter after it

parentPort.on('message', (next) => {
  job = next;
  head = null;
  if (!next) return;
  const start = Buffer.from(`${next.seed}:${next.name}:${prefix}`, 'latin1');
  head = Buffer.alloc(start.length + 16);
  start.copy(head);
  head.used = start.length;
});

// Same bytes as shareHash(seed, name, nonce), without building a new string for every try.
function batch() {
  if (job && head) {
    const { seed, difficulty } = job;
    for (let i = 0; i < BATCH; i += 1) {
      const tail = (counter += 1).toString(36);
      const length = head.used + head.write(tail, head.used, 'latin1');
      if (leadingZeroBits(createHash('sha256').update(head.subarray(0, length)).digest()) >= difficulty) parentPort.postMessage({ seed, nonce: `${prefix}${tail}` });
    }
    parentPort.postMessage({ hashes: BATCH });
  }
  setTimeout(batch, job ? 0 : 100);
}
batch();

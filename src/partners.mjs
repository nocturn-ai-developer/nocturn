import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { DATA_DIR, readJson, writeJson } from './config.mjs';

const FILE = join(DATA_DIR, 'partners.json');
const MAX_PARTNERS = 40;
const MAX_LOGO_BYTES = 256 * 1024;
const SIGNATURES = {
  png: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpeg: (b) => b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  webp: (b) => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
};

// Only checked bitmap formats get through: an SVG could carry script.
function validLogo(logo) {
  const match = typeof logo === 'string' && logo.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) return false;
  const bytes = Buffer.from(match[2], 'base64');
  return bytes.length <= MAX_LOGO_BYTES && SIGNATURES[match[1]](bytes);
}

export const partners = {
  list: () => readJson(FILE, []),
  add(rawName, logo) {
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (!name || name.length > 60) throw new Error('Enter a name of up to 60 characters');
    if (!validLogo(logo)) throw new Error('Use a PNG, JPG or WebP logo under 256 KB');
    const list = partners.list();
    if (list.length >= MAX_PARTNERS) throw new Error(`The list is limited to ${MAX_PARTNERS} entries`);
    list.push({ id: randomBytes(6).toString('hex'), name, logo });
    writeJson(FILE, list);
    return list;
  },
  remove(id) {
    const list = partners.list().filter((p) => p.id !== id);
    writeJson(FILE, list);
    return list;
  },
};

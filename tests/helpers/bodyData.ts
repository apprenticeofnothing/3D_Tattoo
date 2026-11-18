import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { parseBodyData, type BodyData, type BodyMeta } from '../../src/body/builder';

let cached: BodyData | null = null;
export function loadBodyDataSync(): BodyData {
  if (cached) return cached;
  const meta = JSON.parse(readFileSync('public/bodies/makehuman.json', 'utf8')) as BodyMeta;
  const buf = inflateSync(readFileSync('public/bodies/makehuman.bin.z'));
  const raw = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  cached = parseBodyData(meta, raw as ArrayBuffer);
  return cached;
}

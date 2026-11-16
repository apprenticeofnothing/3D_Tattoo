import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildZip, crc32 } from '../src/capture/zip';

describe('zip writer', () => {
  it('computes the standard CRC32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
  it('produces an archive that Python can read back byte for byte', async () => {
    const a = new TextEncoder().encode('hello zip');
    const b = new Uint8Array(5000); for (let i = 0; i < b.length; i++) b[i] = (i * 31) & 0xff;
    const blob = buildZip([{ name: 'ring1_001_h010.jpg', data: b }, { name: 'ring1_log.json', data: a }]);
    const dir = mkdtempSync(join(tmpdir(), 'zip-'));
    const file = join(dir, 't.zip');
    writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
    const out = execFileSync('python3', ['-I', '-c', `
import zipfile, sys, hashlib
z = zipfile.ZipFile(sys.argv[1]); print(z.testzip()); 
for i in z.infolist(): print(i.filename, i.file_size, hashlib.md5(z.read(i)).hexdigest())`, file]).toString();
    const lines = out.trim().split('\n');
    expect(lines[0]).toBe('None'); // testzip: no CRC errors
    const md5 = (u8: Uint8Array) => execFileSync('python3', ['-I', '-c', 'import sys,hashlib;print(hashlib.md5(sys.stdin.buffer.read()).hexdigest())'], { input: Buffer.from(u8) }).toString().trim();
    expect(lines[1]).toBe(`ring1_001_h010.jpg 5000 ${md5(b)}`);
    expect(lines[2]).toBe(`ring1_log.json 9 ${md5(a)}`);
  });
});

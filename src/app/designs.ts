// Registry of loaded designs: rasterised texture plus the source needed to
// save and restore it.

import { loadDesignFile, rasterizeSvg, type DesignImage } from '../design/raster';
import { TEST_PATTERN_WIDTH_CM, testPatternSvg } from '../design/testPattern';
import { newId, type DesignSource } from './project';

export interface DesignEntry { source: DesignSource; image: DesignImage; defaultWidthCm: number }

const readDataUrl = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result as string);
  r.onerror = () => reject(new Error('could not read file'));
  r.readAsDataURL(file);
});

export class DesignStore {
  readonly entries = new Map<string, DesignEntry>();

  get(id: string): DesignEntry | undefined { return this.entries.get(id); }

  async addFile(file: File): Promise<DesignEntry> {
    const isSvg = /\.svg$/i.test(file.name) || file.type === 'image/svg+xml';
    const source: DesignSource = { id: newId('design'), kind: isSvg ? 'svg' : 'bitmap', name: file.name, data: isSvg ? await file.text() : await readDataUrl(file) };
    const image = await loadDesignFile(file);
    return this.register(source, image);
  }

  async addTestPattern(): Promise<DesignEntry> {
    for (const e of this.entries.values()) if (e.source.name === 'test-pattern.svg') return e;
    const source: DesignSource = { id: newId('design'), kind: 'svg', name: 'test-pattern.svg', data: testPatternSvg() };
    const image = await rasterizeSvg(source.data, source.name);
    const e = this.register(source, image);
    e.defaultWidthCm = TEST_PATTERN_WIDTH_CM;
    return e;
  }

  /** Restore a design from saved data (keeps its id). */
  async addSource(source: DesignSource): Promise<DesignEntry> {
    const existing = this.entries.get(source.id);
    if (existing) return existing;
    let image: DesignImage;
    if (source.kind === 'svg') image = await rasterizeSvg(source.data, source.name);
    else {
      const blob = await (await fetch(source.data)).blob();
      image = await loadDesignFile(new File([blob], source.name, { type: blob.type }));
    }
    return this.register(source, image);
  }

  private register(source: DesignSource, image: DesignImage): DesignEntry {
    const e: DesignEntry = { source, image, defaultWidthCm: image.declaredWidthCm ?? 10 };
    this.entries.set(source.id, e);
    return e;
  }
}

// Turn an SVG or bitmap file into a GPU texture at a resolution high enough
// that thin lines stay crisp when zoomed in. Runs entirely in the browser.

import { CanvasTexture, LinearFilter, LinearMipmapLinearFilter, SRGBColorSpace, Texture } from 'three';

export interface DesignImage {
  name: string;
  texture: Texture;
  /** width / height */
  aspect: number;
  /** Pixel size of the rasterised texture. */
  width: number;
  height: number;
  kind: 'svg' | 'bitmap';
  /** Physical width in cm if the SVG declared it (mm/cm/in units), else undefined. */
  declaredWidthCm?: number;
}

const MAX_SIDE = /Mobi|Android|iPhone|iPad/.test(navigator.userAgent) ? 2048 : 4096;

function svgSize(svgText: string): { w: number; h: number; declaredWidthCm?: number } {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const svg = doc.documentElement;
  const vb = svg.getAttribute('viewBox')?.split(/[\s,]+/).map(Number);
  const parseLen = (s: string | null): { v: number; unit: string } | null => {
    if (!s) return null;
    const m = /^\s*([0-9.]+)\s*([a-z%]*)\s*$/i.exec(s);
    return m ? { v: parseFloat(m[1]), unit: m[2].toLowerCase() } : null;
  };
  const W = parseLen(svg.getAttribute('width')), H = parseLen(svg.getAttribute('height'));
  let w = W?.v ?? (vb && vb.length === 4 ? vb[2] : 1000);
  let h = H?.v ?? (vb && vb.length === 4 ? vb[3] : 1000);
  if (W && W.unit === '%') w = vb?.[2] ?? 1000;
  if (H && H.unit === '%') h = vb?.[3] ?? 1000;
  const toCm: Record<string, number> = { mm: 0.1, cm: 1, in: 2.54, pt: 2.54 / 72, pc: 2.54 / 6 };
  const declaredWidthCm = W && toCm[W.unit] ? W.v * toCm[W.unit] : undefined;
  return { w, h, declaredWidthCm };
}

function makeTexture(canvas: HTMLCanvasElement | ImageBitmap | HTMLImageElement): Texture {
  const tex = new CanvasTexture(canvas as HTMLCanvasElement);
  tex.colorSpace = SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;
  tex.anisotropy = 16;
  tex.needsUpdate = true;
  return tex;
}

async function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('could not decode image'));
    img.src = url;
  });
}

export async function rasterizeSvg(svgText: string, name = 'design.svg', longSide = MAX_SIDE): Promise<DesignImage> {
  const { w, h, declaredWidthCm } = svgSize(svgText);
  const aspect = w / h;
  const width = aspect >= 1 ? longSide : Math.round(longSide * aspect);
  const height = aspect >= 1 ? Math.round(longSide / aspect) : longSide;
  // Force explicit pixel dimensions so every browser rasterises at full size.
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const svg = doc.documentElement;
  if (!svg.getAttribute('viewBox')) svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  const blob = new Blob([new XMLSerializer().serializeToString(doc)], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0, width, height);
    return { name, texture: makeTexture(canvas), aspect, width, height, kind: 'svg', declaredWidthCm };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function loadBitmap(file: File): Promise<DesignImage> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
    return { name: file.name, texture: makeTexture(canvas), aspect: img.naturalWidth / img.naturalHeight, width: canvas.width, height: canvas.height, kind: 'bitmap' };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function loadDesignFile(file: File): Promise<DesignImage> {
  if (/\.svg$/i.test(file.name) || file.type === 'image/svg+xml') return rasterizeSvg(await file.text(), file.name);
  return loadBitmap(file);
}

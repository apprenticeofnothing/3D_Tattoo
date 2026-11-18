// The camera's 35 mm-equivalent focal length from a JPEG's EXIF data, so
// close-up photos can be corrected for perspective. Phones write it; some
// apps strip it, in which case a phone's main camera (26 mm) is assumed.

/** FocalLengthIn35mmFilm (EXIF tag 0xA405), or null. */
export function focal35FromJpeg(buf: ArrayBuffer): number | null {
  const d = new DataView(buf);
  if (d.byteLength < 4 || d.getUint16(0) !== 0xffd8) return null;
  let o = 2;
  while (o + 4 <= d.byteLength) {
    const marker = d.getUint16(o), len = d.getUint16(o + 2);
    if (marker === 0xffe1 && o + 10 <= d.byteLength && d.getUint32(o + 4) === 0x45786966) return fromTiff(d, o + 10, len - 8);
    if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) return null; // start of image data: no EXIF
    o += 2 + len;
  }
  return null;
}

function fromTiff(d: DataView, base: number, size: number): number | null {
  if (base + 8 > d.byteLength) return null;
  const le = d.getUint16(base) === 0x4949;
  const u16 = (p: number) => d.getUint16(base + p, le), u32 = (p: number) => d.getUint32(base + p, le);
  const entry = (ifd: number, tag: number): number | null => {
    if (ifd + 2 > size) return null;
    const n = u16(ifd);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (e + 12 > size) return null;
      if (u16(e) !== tag) continue;
      const type = u16(e + 2);
      return type === 3 ? u16(e + 8) : u32(e + 8);
    }
    return null;
  };
  const exifIfd = entry(u32(4), 0x8769);
  if (exifIfd === null) return null;
  const f35 = entry(exifIfd, 0xa405);
  return f35 && f35 > 5 && f35 < 400 ? f35 : null;
}

/** Focal length in pixels for an image of this size (35 mm equivalents refer to the 43.3 mm diagonal). */
export function focalPx(focal35: number, width: number, height: number): number {
  return (focal35 / 43.27) * Math.hypot(width, height);
}

/** A phone's main camera. */
export const DEFAULT_FOCAL_35 = 26;

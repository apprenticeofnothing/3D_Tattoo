// Built-in test design: a 10 x 10 cm sheet with a 1 cm grid, a 6 cm circle,
// an up arrow and an "R" so mirroring is visible. Known dimensions make it
// possible to check sizes on the skin with a tape measure.

export const TEST_PATTERN_WIDTH_CM = 10;

export function testPatternSvg(): string {
  const S = 100; // 1 unit = 1 mm
  const lines: string[] = [];
  for (let i = 0; i <= 10; i++) {
    const p = i * 10;
    const w = i === 0 || i === 10 || i === 5 ? 0.6 : 0.3;
    lines.push(`<line x1="${p}" y1="0" x2="${p}" y2="${S}" stroke="#111" stroke-width="${w}"/>`);
    lines.push(`<line x1="0" y1="${p}" x2="${S}" y2="${p}" stroke="#111" stroke-width="${w}"/>`);
  }
  // 5 mm ticks along the centre lines
  for (let i = 0; i <= 20; i++) {
    const p = i * 5;
    lines.push(`<line x1="${p}" y1="48.5" x2="${p}" y2="51.5" stroke="#111" stroke-width="0.3"/>`);
    lines.push(`<line x1="48.5" y1="${p}" x2="51.5" y2="${p}" stroke="#111" stroke-width="0.3"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}mm" height="${S}mm" viewBox="0 0 ${S} ${S}">
<rect x="0" y="0" width="${S}" height="${S}" fill="#ffffff" fill-opacity="0.35"/>
${lines.join('\n')}
<circle cx="50" cy="50" r="30" fill="none" stroke="#c0202a" stroke-width="1.2"/>
<circle cx="50" cy="50" r="1.2" fill="#c0202a"/>
<path d="M50 14 L46 20 L49 20 L49 28 L51 28 L51 20 L54 20 Z" fill="#1b4fd8"/>
<text x="62" y="25" font-family="Helvetica, Arial, sans-serif" font-size="12" font-weight="bold" fill="#1b4fd8">R</text>
<text x="4" y="97" font-family="Helvetica, Arial, sans-serif" font-size="4" fill="#111">10 cm grid 1 cm, circle 6 cm</text>
</svg>`;
}

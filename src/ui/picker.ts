// Body part picker: a bottom sheet with large buttons grouped by area.
import { REGIONS, type RegionDef } from '../body/regions';

export function createPicker(root: HTMLElement, onPick: (def: RegionDef) => void): { open(): void; close(): void } {
  const sheet = document.createElement('div');
  sheet.className = 'sheet hidden';
  sheet.innerHTML = `<div class="sheet-head"><span>Go to body part</span><button class="btn ghost" data-close aria-label="Close">Close</button></div><div class="sheet-body"></div>`;
  const body = sheet.querySelector('.sheet-body')!;
  const groups = new Map<string, RegionDef[]>();
  for (const r of REGIONS) groups.set(r.group, [...(groups.get(r.group) ?? []), r]);
  for (const [name, defs] of groups) {
    const h = document.createElement('h3'); h.textContent = name; body.appendChild(h);
    const grid = document.createElement('div'); grid.className = 'grid';
    for (const d of defs) {
      const b = document.createElement('button');
      b.className = 'btn region'; b.textContent = d.label; b.dataset.id = d.id;
      b.addEventListener('click', () => { onPick(d); close(); });
      grid.appendChild(b);
    }
    body.appendChild(grid);
  }
  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop hidden';
  const open = () => { sheet.classList.remove('hidden'); backdrop.classList.remove('hidden'); };
  const close = () => { sheet.classList.add('hidden'); backdrop.classList.add('hidden'); };
  sheet.querySelector('[data-close]')!.addEventListener('click', close);
  backdrop.addEventListener('click', close);
  root.append(backdrop, sheet);
  return { open, close };
}

// Minimal bottom sheet with large buttons, used for menus.

export interface SheetItem { label: string; hint?: string; onClick: () => void; danger?: boolean }

export function createSheet(root: HTMLElement, title: string): { open(items: SheetItem[]): void; close(): void } {
  const sheet = document.createElement('div');
  sheet.className = 'sheet hidden';
  sheet.innerHTML = `<div class="sheet-head"><span>${title}</span><button class="btn ghost" data-close aria-label="Close">Close</button></div><div class="sheet-body"></div>`;
  const body = sheet.querySelector('.sheet-body')!;
  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop hidden';
  const close = () => { sheet.classList.add('hidden'); backdrop.classList.add('hidden'); };
  const open = (items: SheetItem[]) => {
    body.innerHTML = '';
    const list = document.createElement('div'); list.className = 'menu';
    for (const it of items) {
      const b = document.createElement('button');
      b.className = 'btn menu-item' + (it.danger ? ' danger' : '');
      b.innerHTML = `<span>${it.label}</span>${it.hint ? `<small>${it.hint}</small>` : ''}`;
      b.addEventListener('click', () => { close(); it.onClick(); });
      list.appendChild(b);
    }
    body.appendChild(list);
    sheet.classList.remove('hidden'); backdrop.classList.remove('hidden');
  };
  sheet.querySelector('[data-close]')!.addEventListener('click', close);
  backdrop.addEventListener('click', close);
  root.append(backdrop, sheet);
  return { open, close };
}

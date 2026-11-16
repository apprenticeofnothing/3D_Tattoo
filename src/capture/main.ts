import '../style.css';
import './capture.css';
import { sharpness } from './blur';
import { addShot, allShots, clearShots, deleteShot, type Shot } from './store';
import { buildZip } from './zip';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>('video');
const overlay = $<HTMLCanvasElement>('overlay');
const RINGS = ['Ring 1 · knee height, camera tilted slightly up', 'Ring 2 · chest height, level', 'Ring 3 · above the head, tilted down', 'Close-ups · tattoo areas from several angles'];
const SECTORS = 36; // 10 degree sectors for the progress circle
const AUTO_STEP = 6; // degrees between automatic shots

let stream: MediaStream | null = null;
let ring = 0;
let heading: number | null = null;
let lastShotHeading: number | null = null;
let auto = false;
let busy = false;
const covered: boolean[][] = RINGS.map(() => new Array(SECTORS).fill(false));
let shots: Shot[] = [];
let lastSharp = 0;
const sharpHistory: number[] = [];

const grab = document.createElement('canvas');
const small = document.createElement('canvas'); small.width = 256; small.height = 144;

function setNote(t: string) { $('start-note').textContent = t; }

async function startCamera() {
  try {
    // Ask for the compass first (needs a user gesture on iOS).
    const DOE = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
    if (DOE.requestPermission) { try { await DOE.requestPermission(); } catch { /* denied: count only */ } }
    window.addEventListener('deviceorientationabsolute', onOrientation as EventListener, true);
    window.addEventListener('deviceorientation', onOrientation as EventListener, true);

    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 4096 }, height: { ideal: 3072 }, frameRate: { ideal: 30 } },
    });
    video.srcObject = stream;
    await video.play();
    const track = stream.getVideoTracks()[0];
    const s = track.getSettings();
    $('res').textContent = `${s.width} × ${s.height}`;
    $('intro').classList.add('hidden');
    $('hud').classList.remove('hidden');
    shots = await allShots();
    for (const sh of shots) if (sh.heading !== null) covered[sh.ring][sector(sh.heading)] = true;
    if (shots.length) ring = Math.min(RINGS.length - 1, shots[shots.length - 1].ring);
    updateHud();
    requestAnimationFrame(loop);
  } catch (err) {
    setNote(`Camera not available: ${(err as Error).message}. On iPhone this page must be opened over https or from the Mac's local server.`);
  }
}

function onOrientation(e: DeviceOrientationEvent & { webkitCompassHeading?: number; absolute?: boolean }) {
  if (typeof e.webkitCompassHeading === 'number') heading = e.webkitCompassHeading;
  else if (e.alpha !== null && e.alpha !== undefined) heading = (360 - e.alpha) % 360;
}
const sector = (h: number) => Math.floor(((h % 360) + 360) % 360 / (360 / SECTORS)) % SECTORS;

function updateHud() {
  const inRing = shots.filter((s) => s.ring === ring).length;
  $('ring-label').textContent = RINGS[ring];
  $('count').textContent = `${inRing} in this ring · ${shots.length} total`;
  $('heading').textContent = heading === null ? 'no compass' : `${Math.round(heading)}°`;
  const typical = sharpHistory.length ? [...sharpHistory].sort((a, b) => a - b)[Math.floor(sharpHistory.length / 2)] : 0;
  const ok = typical === 0 || lastSharp > typical * 0.5;
  $('sharp').textContent = lastSharp ? (ok ? 'sharp' : 'BLURRY, hold still') : '';
  $('sharp').className = ok ? 'ok' : 'warn';
  $('auto').classList.toggle('active', auto);
  $('next').textContent = ring < RINGS.length - 1 ? 'Next ring' : 'Done';
}

function drawOverlay() {
  const w = overlay.clientWidth, h = overlay.clientHeight;
  if (overlay.width !== w * devicePixelRatio) { overlay.width = w * devicePixelRatio; overlay.height = h * devicePixelRatio; }
  const ctx = overlay.getContext('2d')!;
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  ctx.clearRect(0, 0, w, h);
  // Framing guide: keep the whole body inside this box on rings 1-3.
  if (ring < 3) {
    ctx.strokeStyle = 'rgba(110,168,254,.8)'; ctx.lineWidth = 2; ctx.setLineDash([8, 8]);
    const mw = w * 0.08, mh = h * 0.06;
    ctx.strokeRect(mw, mh, w - 2 * mw, h - 2 * mh);
    ctx.setLineDash([]);
  }
  // Progress circle: sectors of the walk already photographed.
  const r = Math.min(w, h) * 0.12, cx = w - r - 16, cy = r + 56;
  for (let i = 0; i < SECTORS; i++) {
    const a0 = (i / SECTORS) * Math.PI * 2 - Math.PI / 2, a1 = ((i + 1) / SECTORS) * Math.PI * 2 - Math.PI / 2;
    ctx.beginPath(); ctx.arc(cx, cy, r, a0 + 0.02, a1 - 0.02);
    ctx.lineWidth = 8; ctx.strokeStyle = covered[ring][i] ? '#9ee6b0' : 'rgba(255,255,255,.25)'; ctx.stroke();
  }
  if (heading !== null) {
    const a = (heading / 360) * Math.PI * 2 - Math.PI / 2;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * r * 0.8, cy + Math.sin(a) * r * 0.8);
    ctx.lineWidth = 3; ctx.strokeStyle = '#ffd166'; ctx.stroke();
  }
  ctx.fillStyle = '#fff'; ctx.font = '600 14px -apple-system, sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(`${covered[ring].filter(Boolean).length}/${SECTORS}`, cx, cy + 5);
}

let frameCount = 0;
function loop() {
  if (!stream) return;
  drawOverlay();
  // Measure sharpness on a small copy a few times per second.
  if (frameCount++ % 6 === 0 && video.videoWidth) {
    const c = small.getContext('2d', { willReadFrequently: true })!;
    c.drawImage(video, 0, 0, small.width, small.height);
    lastSharp = sharpness(c, small.width, small.height);
    updateHud();
    if (auto && heading !== null && !busy) {
      const moved = lastShotHeading === null ? 999 : Math.abs(((heading - lastShotHeading + 540) % 360) - 180);
      const typical = sharpHistory.length ? [...sharpHistory].sort((a, b) => a - b)[Math.floor(sharpHistory.length / 2)] : 0;
      if (moved >= AUTO_STEP && (typical === 0 || lastSharp > typical * 0.5)) void shoot();
    }
  }
  requestAnimationFrame(loop);
}

async function shoot() {
  if (!stream || busy || !video.videoWidth) return;
  busy = true;
  try {
    grab.width = video.videoWidth; grab.height = video.videoHeight;
    grab.getContext('2d')!.drawImage(video, 0, 0);
    const blob = await new Promise<Blob>((res, rej) => grab.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), 'image/jpeg', 0.93));
    const inRing = shots.filter((s) => s.ring === ring).length;
    const shot: Omit<Shot, 'id'> = { ring, index: inRing, heading, sharp: lastSharp, width: grab.width, height: grab.height, at: Date.now(), blob };
    const id = await addShot(shot);
    shots.push({ id, ...shot });
    sharpHistory.push(lastSharp); if (sharpHistory.length > 30) sharpHistory.shift();
    if (heading !== null) { covered[ring][sector(heading)] = true; lastShotHeading = heading; }
    const thumb = $<HTMLImageElement>('thumb');
    thumb.src = URL.createObjectURL(blob); thumb.classList.remove('hidden');
    setTimeout(() => thumb.classList.add('hidden'), 1200);
    flash();
    updateHud();
  } finally { busy = false; }
}

function flash() { document.body.classList.add('flash'); setTimeout(() => document.body.classList.remove('flash'), 120); }

async function undoLast() {
  const last = shots.pop();
  if (!last) return;
  await deleteShot(last.id);
  // Recompute coverage for this ring.
  covered[last.ring].fill(false);
  for (const s of shots) if (s.ring === last.ring && s.heading !== null) covered[last.ring][sector(s.heading)] = true;
  lastShotHeading = null;
  updateHud();
}

async function exportZip() {
  const all = await allShots();
  if (!all.length) return;
  const byRing = new Map<number, Shot[]>();
  for (const s of all) byRing.set(s.ring, [...(byRing.get(s.ring) ?? []), s]);
  for (const [r, list] of byRing) {
    const entries = [];
    for (const s of list) {
      const h = s.heading === null ? 'h---' : `h${String(Math.round(s.heading)).padStart(3, '0')}`;
      entries.push({ name: `ring${r + 1}_${String(s.index + 1).padStart(3, '0')}_${h}.jpg`, data: new Uint8Array(await s.blob.arrayBuffer()), mtime: new Date(s.at) });
    }
    const log = list.map((s) => ({ ring: s.ring + 1, index: s.index + 1, heading: s.heading, sharpness: Math.round(s.sharp), width: s.width, height: s.height, at: new Date(s.at).toISOString() }));
    entries.push({ name: `ring${r + 1}_log.json`, data: new TextEncoder().encode(JSON.stringify(log, null, 1)) });
    const blob = buildZip(entries);
    const name = `scan-ring${r + 1}-${list.length}photos.zip`;
    const file = new File([blob], name, { type: 'application/zip' });
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
    if (nav.share && nav.canShare?.({ files: [file] })) {
      try { await nav.share({ files: [file], title: name }); continue; } catch { /* cancelled: download instead */ }
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
    await new Promise((r) => setTimeout(r, 800));
  }
}

$('start').addEventListener('click', () => void startCamera());
$('shoot').addEventListener('click', () => void shoot());
$('auto').addEventListener('click', () => { auto = !auto; lastShotHeading = null; updateHud(); });
$('next').addEventListener('click', () => { ring = Math.min(RINGS.length - 1, ring + 1); lastShotHeading = null; updateHud(); });
$('undo').addEventListener('click', () => void undoLast());
$('export').addEventListener('click', () => void exportZip());
$('clear').addEventListener('click', async () => { if (confirm('Delete all captured photos from this phone?')) { await clearShots(); shots = []; for (const c of covered) c.fill(false); updateHud(); } });
if (!navigator.mediaDevices?.getUserMedia) setNote('This browser cannot access the camera.');
else if (!window.isSecureContext) setNote('Camera needs a secure page (https or localhost).');

(window as unknown as { __cap: unknown }).__cap = { shoot, shots: () => shots, exportZip, setHeading: (h: number) => { heading = h; }, setRing: (r: number) => { ring = r; updateHud(); } };

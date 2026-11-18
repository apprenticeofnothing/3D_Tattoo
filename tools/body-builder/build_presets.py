"""Export the data for the in-browser body builder (MakeHuman-derived).

Inputs (downloaded once, read as data only; no code from them is run):
  * targets.npz  from the PyPI wheel makehuman==1.3.2
                 (makehuman/data/targets.npz, MakeHuman team, CC0, 2001-2020)
  * human_full_size.json  from the npm package makehuman-data@0.0.2
                 (public/data/models/, the MakeHuman hm08 base mesh with
                 skeleton weights, exported for three.js)

See docs/body-builder.md for how to fetch them. Run:

  python3 tools/body-builder/build_presets.py \
      --targets <path>/targets.npz --base <path>/human_full_size.json --out public/bodies

Output:
  public/bodies/makehuman.json   index: vertex/quad counts, parts, targets, presets
  public/bodies/makehuman.bin.z  zlib-compressed buffers: base positions (float32,
                                 metres), quads (uint16), part labels, material
                                 codes (skin/eye parts), then per target
                                 uint16 indices + int16 xyz deltas (1e-4 m units)

The six presets are found here by bisection on MakeHuman's weight slider so
that each body has the intended BMI at a reference height. The blending
rules below must stay identical to src/body/builder.ts.
"""

import argparse
import io
import json
import os
import re
import zipfile
import zlib

import numpy as np

DM_TO_M = 0.1          # MakeHuman units are decimetres
TARGET_SCALE = 1e-3    # compiled targets store int16 thousandths of a decimetre (= 1e-4 m)
DENSITY = 1010.0       # kg/m^3, whole-body average used for the BMI estimate

PARTS = ['head', 'neck', 'torso', 'shoulder.L', 'shoulder.R', 'upperarm.L', 'upperarm.R', 'forearm.L', 'forearm.R',
         'hand.L', 'hand.R', 'thigh.L', 'thigh.R', 'shin.L', 'shin.R', 'foot.L', 'foot.R']
MATERIALS = ['skin', 'sclera', 'iris', 'pupil']

# Detail sliders: id -> list of target stems (each has -decr and -incr variants).
DETAIL_TARGETS = {
    'shoulders': ['measure/measure-shoulder-dist'],
    'chestMuscle': ['torso/torso-muscle-pectoral'],
    'bust': ['measure/measure-bust-circ'],
    'waist': ['measure/measure-waist-circ'],
    'belly': ['stomach/stomach-pregnant'],
    'hips': ['measure/measure-hips-circ'],
    'buttocks': ['buttocks/buttocks-volume'],
    'vshape': ['torso/torso-vshape'],
    'torsoLength': ['measure/measure-napetowaist-dist'],
    'neck': ['measure/measure-neck-circ'],
    'upperArmSize': ['measure/measure-upperarm-circ'],
    'upperArmMuscle': ['armslegs/l-upperarm-muscle', 'armslegs/r-upperarm-muscle'],
    'forearmSize': ['armslegs/l-lowerarm-fat', 'armslegs/r-lowerarm-fat'],
    'forearmMuscle': ['armslegs/l-lowerarm-muscle', 'armslegs/r-lowerarm-muscle'],
    'armLength': ['measure/measure-upperarm-length', 'measure/measure-lowerarm-length'],
    'thighSize': ['measure/measure-thigh-circ'],
    'thighMuscle': ['armslegs/l-upperleg-muscle', 'armslegs/r-upperleg-muscle'],
    'calfSize': ['measure/measure-calf-circ'],
    'calfMuscle': ['armslegs/l-lowerleg-muscle', 'armslegs/r-lowerleg-muscle'],
    'legLength': ['measure/measure-upperleg-height', 'measure/measure-lowerleg-height'],
}

# id, name, sex, build, muscle, cup, firmness, target BMI at the reference height, reference height (cm)
PRESETS = [
    ('female-thin', 'Female · thin', 'female', 'thin', 0.45, 0.45, 0.55, 18.8, 166),
    ('female-athletic', 'Female · athletic', 'female', 'athletic', 0.95, 0.50, 0.65, 22.5, 166),
    ('female-overweight', 'Female · slightly overweight', 'female', 'overweight', 0.30, 0.60, 0.45, 27.5, 166),
    ('male-thin', 'Male · thin', 'male', 'thin', 0.40, 0.5, 0.5, 19.3, 179),
    ('male-athletic', 'Male · athletic', 'male', 'athletic', 1.00, 0.5, 0.5, 25.5, 179),
    ('male-overweight', 'Male · slightly overweight', 'male', 'overweight', 0.25, 0.5, 0.5, 29.0, 179),
]


class Targets:
    def __init__(self, path):
        self.z = zipfile.ZipFile(path)
        self.names = set(n[len('targets/'):-len('.index.npy')] for n in self.z.namelist() if n.endswith('.index.npy'))
        self.cache = {}

    def get(self, name):
        if name not in self.names:
            return None
        if name not in self.cache:
            idx = np.load(io.BytesIO(self.z.read(f'targets/{name}.index.npy')), allow_pickle=False).astype(np.int64)
            vec = np.load(io.BytesIO(self.z.read(f'targets/{name}.vector.npy')), allow_pickle=False).astype(np.int64)
            self.cache[name] = (idx, vec)
        return self.cache[name]


def three_way(v, lo, mid, hi):
    """MakeHuman's piecewise-linear weights for a 0..1 slider with a neutral middle."""
    v = min(1.0, max(0.0, v))
    if v < 0.5:
        return {lo: 1 - v / 0.5, mid: v / 0.5}
    return {mid: 1 - (v - 0.5) / 0.5, hi: (v - 0.5) / 0.5}


def macro_targets(gender, muscle, weight, cup, firmness, races=None):
    """(target name, weight) pairs for a young adult. Mirrors macroTargets() in builder.ts."""
    out = []
    genders = {'female': 1 - gender, 'male': gender}
    races = races or {'african': 1 / 3, 'asian': 1 / 3, 'caucasian': 1 / 3}
    mus = three_way(muscle, 'minmuscle', 'averagemuscle', 'maxmuscle')
    wei = three_way(weight, 'minweight', 'averageweight', 'maxweight')
    cups = three_way(cup, 'mincup', 'averagecup', 'maxcup')
    firms = three_way(firmness, 'minfirmness', 'averagefirmness', 'maxfirmness')
    for g, gw in genders.items():
        if gw <= 0:
            continue
        for r, rw in races.items():
            out.append((f'macrodetails/{r}-{g}-young', gw * rw))
        for m, mw in mus.items():
            for w, ww in wei.items():
                out.append((f'macrodetails/universal-{g}-young-{m}-{w}', gw * mw * ww))
                for c, cw in cups.items():
                    for f, fw in firms.items():
                        out.append((f'breast/{g}-young-{m}-{w}-{c}-{f}', gw * mw * ww * cw * fw))
    return [(n, w) for n, w in out if w > 1e-9]


def parse_base(path):
    d = json.load(open(path))
    verts = np.array(d['vertices'], dtype=np.float64).reshape(-1, 3)
    mats = [m['DbgName'] for m in d['materials']]
    nuv = len(d['uvs'])
    f = d['faces']
    quads, quad_mat = [], []
    i = 0
    while i < len(f):
        t = f[i]
        nv = 4 if t & 1 else 3
        vs = f[i + 1:i + 1 + nv]
        j = i + 1 + nv
        mat = None
        if t & 2:
            mat = f[j]; j += 1
        if t & 4: j += nuv
        if t & 8: j += nuv * nv
        if t & 16: j += 1
        if t & 32: j += nv
        if t & 64: j += 1
        if t & 128: j += nv
        if nv != 4:
            raise SystemExit('expected an all-quad base mesh')
        quads.append(vs)
        quad_mat.append(mats[mat] if mat is not None else 'body')
        i = j
    bones = [b['name'] for b in d['bones']]
    skin_idx = np.array(d['skinIndices'], dtype=np.int64).reshape(-1, 4)
    skin_w = np.array(d['skinWeights'], dtype=np.float64).reshape(-1, 4)
    return verts, np.array(quads, dtype=np.int64), quad_mat, bones, skin_idx, skin_w


def bone_part(name):
    n = name.replace('____head', '')
    side = '.L' if n.endswith('.L') else '.R' if n.endswith('.R') else ''
    base = n[:-2] if side else n
    if base.startswith('upperarm'):
        return 'upperarm' + side
    if base.startswith('lowerarm'):
        return 'forearm' + side
    if base.startswith(('wrist', 'metacarpal', 'finger', 'thumb', 'hand')):
        return 'hand' + side
    if base.startswith('shoulder'):
        return 'shoulder' + side
    if base.startswith('upperleg'):
        return 'thigh' + side
    if base.startswith('lowerleg'):
        return 'shin' + side
    if base.startswith(('foot', 'toe')):
        return 'foot' + side
    if base.startswith('neck'):
        return 'neck'
    if base.startswith(('spine', 'pelvis', 'root', 'breast', 'clavicle')):
        return 'torso'
    return 'head'


def signed_volume(p, tris):
    a, b, c = p[tris[:, 0]], p[tris[:, 1]], p[tris[:, 2]]
    return float(np.einsum('ij,ij->i', a, np.cross(b, c)).sum() / 6.0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--targets', required=True)
    ap.add_argument('--base', required=True)
    ap.add_argument('--out', required=True)
    args = ap.parse_args()

    base, quads, quad_mat, bones, skin_idx, skin_w = parse_base(args.base)
    T = Targets(args.targets)

    keep_groups = {'body', 'helper-l-eye', 'helper-r-eye'}
    keep = np.array([m in keep_groups for m in quad_mat])
    kept_mats = [m for m in quad_mat if m in keep_groups]
    q_orig = quads[keep]
    used = np.unique(q_orig)
    remap = -np.ones(len(base), dtype=np.int64)
    remap[used] = np.arange(len(used))
    q = remap[q_orig]
    nv = len(used)
    is_body = np.array([m == 'body' for m in kept_mats])

    part_of_bone = [bone_part(b) for b in bones]
    dom = skin_idx[used, np.argmax(skin_w[used], axis=1)]
    labels = np.array([PARTS.index(part_of_bone[b]) for b in dom], dtype=np.uint8)
    tris_body = np.concatenate([q[is_body][:, [0, 1, 2]], q[is_body][:, [0, 2, 3]]])

    def build_full(targets_w):
        p = base.copy()
        for name, w in targets_w:
            t = T.get(name)
            if t is None or len(t[0]) == 0:
                continue
            p[t[0]] += w * t[1] * TARGET_SCALE
        return p

    def shape(gender, muscle, weight, cup, firm):
        p = build_full(macro_targets(gender, muscle, weight, cup, firm))[used] * DM_TO_M
        p[:, 1] -= p[:, 1].min()
        p[:, 0] -= (p[:, 0].min() + p[:, 0].max()) / 2
        p[:, 2] -= (p[:, 2].min() + p[:, 2].max()) / 2
        return p

    def bmi_at(p, ref_h):
        s = ref_h / 100.0 / (p[:, 1].max() - p[:, 1].min())
        vol = abs(signed_volume(p * s, tris_body))
        return DENSITY * vol / (ref_h / 100.0) ** 2, vol

    # ---------- presets ----------
    preset_meta, report = [], []
    for pid, name, sex, build_name, muscle, cup, firm, target_bmi, ref_h in PRESETS:
        gender = 1.0 if sex == 'male' else 0.0
        lo, hi = 0.0, 1.0
        for _ in range(28):
            mid = (lo + hi) / 2
            bmi, _ = bmi_at(shape(gender, muscle, mid, cup, firm), ref_h)
            lo, hi = (mid, hi) if bmi < target_bmi else (lo, mid)
        weight = round((lo + hi) / 2, 4)
        p = shape(gender, muscle, weight, cup, firm)
        bmi, vol = bmi_at(p, ref_h)
        preset_meta.append({
            'id': pid, 'name': name, 'sex': sex, 'build': build_name,
            'params': {'gender': gender, 'muscle': muscle, 'weight': weight, 'breastSize': cup, 'breastFirmness': firm},
            'referenceHeightCm': ref_h, 'bmiAtReferenceHeight': round(bmi, 2), 'nativeHeightM': round(float(p[:, 1].max()), 4),
        })
        report.append(f'{pid:18s} weight={weight:.3f} muscle={muscle:.2f} native {p[:, 1].max() * 100:.1f} cm; at {ref_h} cm BMI {bmi:.1f}, {DENSITY * vol:.0f} kg')

    # ---------- material masks (eyes), computed on a neutral shape ----------
    material = np.zeros(nv, dtype=np.uint8)
    fem = shape(0.0, 0.5, 0.5, 0.5, 0.5)
    # Eyes: sclera, iris and pupil by angle from the forward direction.
    for grp in ('helper-l-eye', 'helper-r-eye'):
        vids = np.unique(q[np.array([m == grp for m in kept_mats])])
        c = fem[vids].mean(axis=0)
        d = fem[vids] - c
        d /= np.linalg.norm(d, axis=1, keepdims=True)
        material[vids] = MATERIALS.index('sclera')
        material[vids[d[:, 2] > 0.70]] = MATERIALS.index('iris')
        material[vids[d[:, 2] > 0.93]] = MATERIALS.index('pupil')

    # ---------- buffers ----------
    blobs, offset = [], 0

    def add(arr):
        nonlocal offset
        b = arr.tobytes()
        pad = (-len(b)) % 4
        blobs.append(b + b'\0' * pad)
        start = offset
        offset += len(b) + pad
        return start

    base_m = (base[used] * DM_TO_M).astype(np.float32)
    meta = {
        'version': 2,
        'topology': 'makehuman-hm08-body+eyes',
        'vertexCount': int(nv), 'quadCount': int(len(q)),
        'parts': PARTS, 'materials': MATERIALS,
        'deltaUnitM': TARGET_SCALE * DM_TO_M,
        'buffers': {
            'base': add(base_m), 'quads': add(q.astype(np.uint16)),
            'labels': add(labels), 'material': add(material), 'bodyQuad': add(is_body.astype(np.uint8)),
        },
        'targets': {},
    }
    needed = set()
    for g in ('female', 'male'):
        for r in ('african', 'asian', 'caucasian'):
            needed.add(f'macrodetails/{r}-{g}-young')
        for m in ('minmuscle', 'averagemuscle', 'maxmuscle'):
            for w in ('minweight', 'averageweight', 'maxweight'):
                needed.add(f'macrodetails/universal-{g}-young-{m}-{w}')
                for c in ('mincup', 'averagecup', 'maxcup'):
                    for f in ('minfirmness', 'averagefirmness', 'maxfirmness'):
                        needed.add(f'breast/{g}-young-{m}-{w}-{c}-{f}')
    for stems in DETAIL_TARGETS.values():
        for s in stems:
            needed.add(f'{s}-decr'); needed.add(f'{s}-incr')
    missing = []
    for name in sorted(needed):
        t = T.get(name)
        if t is None:
            missing.append(name)
            continue
        idx, vec = t
        k = remap[idx]
        ok = k >= 0
        k, vec = k[ok], vec[ok]
        if len(k) == 0:
            continue
        meta['targets'][name] = {'count': int(len(k)), 'index': add(k.astype(np.uint16)), 'delta': add(vec.astype(np.int16))}
    detail_missing = [n for n in missing if not n.startswith(('breast/', 'macrodetails/'))]
    if detail_missing:
        raise SystemExit(f'missing detail targets: {detail_missing}')
    meta['detailTargets'] = DETAIL_TARGETS
    meta['presets'] = preset_meta
    meta['source'] = ('MakeHuman 1.x hm08 base mesh (npm makehuman-data@0.0.2) and targets (PyPI makehuman==1.3.2, '
                      'CC0, MakeHuman team 2001-2020, makehumancommunity.org)')
    meta['license'] = 'CC0 1.0'
    raw = b''.join(blobs)
    meta['rawByteLength'] = len(raw)
    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, 'makehuman.bin.z'), 'wb') as fh:
        fh.write(zlib.compress(raw, 9))
    with open(os.path.join(args.out, 'makehuman.json'), 'w') as fh:
        json.dump(meta, fh, separators=(',', ':'))
    print('\n'.join(report))
    print(f'vertices {nv}, quads {len(q)}, targets {len(meta["targets"])} (absent/empty macro or breast combos: {len(missing)}), '
          f'raw {len(raw) / 1024:.0f} kB, compressed {os.path.getsize(os.path.join(args.out, "makehuman.bin.z")) / 1024:.0f} kB')
    print('material counts', {MATERIALS[i]: int((material == i).sum()) for i in range(len(MATERIALS))})


def is_vertex_of(q, mask, nv):
    out = np.zeros(nv, dtype=bool)
    out[np.unique(q[mask])] = True
    return out


if __name__ == '__main__':
    main()

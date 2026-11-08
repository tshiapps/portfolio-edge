#!/usr/bin/env python3
"""TSP ↔ Instagram / Getty matcher (runs on the Mac, started by TSP Uploader → Matching).

1. Embeds every site photo (plus Instagram-style 4:5 and 1:1 centre crops of it) and every Instagram image
   with DINOv2 on the Apple GPU — vectors are cached, so later runs only embed what's new.
2. For each Instagram image, the 10 most similar site photos are checked with SIFT keypoints + RANSAC
   (a similarity transform: scale / rotate / shift, i.e. crops and resizes) — survives filters and recrops,
   rejects look-alikes.
3. Decides: auto (clear winner), review (plausible / near-duplicate bursts), or no match.

Getty previews carry a watermark (a translucent logo, sometimes a credit strip): plain borders/strips are trimmed,
and the watermark's own keypoints simply find no partner in the site photo — RANSAC keeps the scene's.

Usage: ig_match.py manifest.json      (progress on stdout as "P stage done total" / "L message")
"""
import json, os, sys, time
import numpy as np

man = json.load(open(sys.argv[1]))
CACHE = man['cache']; os.makedirs(CACHE, exist_ok=True)
MODEL = man.get('model', 'dinov2')
TOPK = int(man.get('topk', 10))
SOURCE = man.get('source', 'ig')          # 'ig' | 'getty'
EXT = man.get('ext', man.get('ig', []))   # the outside images
OUTKEY = 'ig_id' if SOURCE == 'ig' else 'asset_id'
# Getty previews are small (~600 px) and watermarked: fewer agreeing points for the same photo
AUTO_MIN, PLAUSIBLE_MIN = (30, 12) if SOURCE == 'ig' else (22, 10)

def say(*a): print('L', *a, flush=True)
def prog(stage, done, total): print('P', stage, done, total, flush=True)

from PIL import Image, ImageOps
import cv2

def trim_bars(im):
    """cut flat strips off the edges (letterboxing, a stock site's credit/caption bar) — never more than 25% a side"""
    a = np.asarray(im.convert('L')).astype(np.float32); h, w = a.shape
    def run(lines, limit):
        n = 0
        for ln in lines:
            if n >= limit or ln.std() > 6: break
            n += 1
        return n if n >= 3 else 0
    top = run(a, h // 4); bottom = run(a[::-1], h // 4); left = run(a.T, w // 4); right = run(a.T[::-1], w // 4)
    if top or bottom or left or right:
        im = im.crop((left, top, w - right, h - bottom))
    return im

_ext_paths = set()
def load_rgb(path, max_side=1024):
    im = Image.open(path); im = ImageOps.exif_transpose(im).convert('RGB')
    if path in _ext_paths: im = trim_bars(im)
    if max(im.size) > max_side:
        im.thumbnail((max_side, max_side), Image.LANCZOS)
    return im

def crops(im):
    """the photo itself + the centre crops Instagram forces: 4:5 portrait, 1:1, and 1.91:1 for very wide shots"""
    w, h = im.size; out = [im]
    for ar in (4 / 5, 1.0, 1.91):
        if w / h > ar * 1.05:      # wider than the crop → trim the sides
            nw = int(h * ar); x = (w - nw) // 2; out.append(im.crop((x, 0, x + nw, h)))
        elif w / h < ar / 1.05 and ar <= 1.0:   # taller → trim top and bottom
            nh = int(w / ar); y = (h - nh) // 2; out.append(im.crop((0, y, w, y + nh)))
    return out

# ---------- embeddings ----------
class Embedder:
    def __init__(self):
        if MODEL == 'hist':  # tiny fallback (tests / no network): colour + layout signature
            self.dim = 3 * 64 + 256; return
        import torch
        from transformers import AutoImageProcessor, AutoModel
        self.torch = torch
        self.dev = 'mps' if torch.backends.mps.is_available() else 'cuda' if torch.cuda.is_available() else 'cpu'
        name = man.get('hf_model', 'facebook/dinov2-base')
        say(f'Model {name} on {self.dev.upper()}')
        self.proc = AutoImageProcessor.from_pretrained(name)
        self.net = AutoModel.from_pretrained(name).to(self.dev).eval()

    def __call__(self, ims):
        if MODEL == 'hist':
            out = []
            for im in ims:
                a = np.asarray(im.resize((64, 64))).astype(np.float32)
                hsv = np.asarray(im.convert('HSV').resize((64, 64))).astype(np.float32)
                hist = np.concatenate([np.histogram(hsv[..., c], 64, (0, 255))[0] for c in range(3)]).astype(np.float32)
                small = np.asarray(im.convert('L').resize((16, 16))).astype(np.float32).ravel()
                v = np.concatenate([hist / (hist.sum() + 1e-6), (small - small.mean()) / (small.std() + 1e-6) * 0.05])
                out.append(v / (np.linalg.norm(v) + 1e-9))
            return np.stack(out)
        t = self.torch
        with t.no_grad():
            x = self.proc(images=ims, return_tensors='pt').to(self.dev)
            h = self.net(**x).last_hidden_state
            v = t.cat([h[:, 0], h[:, 1:].mean(1)], dim=1)  # CLS + mean of patches
            v = t.nn.functional.normalize(v, dim=1)
        return v.cpu().numpy().astype(np.float32)

def embed_all(items, kind, emb):
    """items: [{id, path, key}] → {id: matrix (n_variants × d)}; cached per key"""
    cfile = os.path.join(CACHE, f'emb-{MODEL}-{kind}.npz')
    cache = {}
    if os.path.exists(cfile):
        with np.load(cfile, allow_pickle=True) as z: cache = z['d'].item()
    todo = [it for it in items if it['key'] not in cache]
    say(f'{kind}: {len(items) - len(todo)} cached, {len(todo)} to embed')
    B = 32; t0 = time.time()
    for i in range(0, len(todo), B):
        batch = todo[i:i + B]; ims, owners = [], []
        for it in batch:
            try: im = load_rgb(it['path'], 512)
            except Exception as e: say(f'skip {it["id"]}: {e}'); continue
            vs = crops(im) if kind == 'tsp' else [im]
            ims += vs; owners += [it['key']] * len(vs)
        if ims:
            vecs = emb(ims)
            for k in dict.fromkeys(owners):
                cache[k] = vecs[[j for j, o in enumerate(owners) if o == k]]
        prog(f'embed-{kind}', min(i + B, len(todo)), len(todo))
        if time.time() - t0 > 60:  # save as we go — a stopped run keeps its work
            np.savez(cfile, d=np.array(cache, dtype=object)); t0 = time.time()
    np.savez(cfile, d=np.array(cache, dtype=object))
    return {it['id']: cache[it['key']] for it in items if it['key'] in cache}

# ---------- geometric check ----------
sift = cv2.SIFT_create(nfeatures=2500 if SOURCE == 'ig' else 4000)  # extra room: watermark text eats keypoints
flann = cv2.FlannBasedMatcher(dict(algorithm=1, trees=5), dict(checks=48))
_feat = {}
_size = {}
def feat_size(path): return _size.get(path, (1024, 1024))
def features(path):
    if path in _feat: return _feat[path]
    im = np.asarray(load_rgb(path, 1024).convert('L'))
    kp, des = sift.detectAndCompute(im, None)
    r = (np.float32([k.pt for k in kp]) if kp else np.zeros((0, 2), np.float32), des)
    _size[path] = im.shape[:2]
    if len(_feat) > 4000: _feat.clear()
    _feat[path] = r
    return r

def inliers(a, b):
    (pa, da), (pb, db) = features(a), features(b)
    if da is None or db is None or len(da) < 8 or len(db) < 8: return 0
    m = flann.knnMatch(da, db, k=2)
    good = [x[0] for x in m if len(x) == 2 and x[0].distance < 0.75 * x[1].distance]
    if len(good) < 8: return 0
    src = pa[[g.queryIdx for g in good]]; dst = pb[[g.trainIdx for g in good]]
    M, mask = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=4.0, maxIters=4000, confidence=0.995)
    if M is None or mask is None: return 0
    # Instagram / Getty crop and resize but never rotate: a real match is (nearly) upright at a sane scale
    s = float(np.hypot(M[0, 0], M[1, 0])); ang = abs(float(np.degrees(np.arctan2(M[1, 0], M[0, 0]))))
    if not (0.25 < s < 4.0) or ang > 4: return 0
    keep = mask.ravel().astype(bool)
    # and the agreeing points are spread over the picture, not one small repeated pattern
    pts = dst[keep]
    if len(pts) >= 8:
        spread = np.ptp(pts, axis=0); h, w = feat_size(b)
        if spread[0] < 0.15 * w and spread[1] < 0.15 * h: return 0
    return int(keep.sum())

# ---------- run ----------
tsp = man['tsp']; ig = EXT
if SOURCE != 'ig': _ext_paths.update(it['path'] for it in ig)
decided = man.get('decided', {})  # outside id → {"confirmed": photo_id | None, "rejected": [photo_id]}
emb = Embedder()
T = embed_all(tsp, 'tsp', emb)
G = embed_all(ig, SOURCE, emb)
tsp_ids = [it['id'] for it in tsp if it['id'] in T]
tpath = {it['id']: it['path'] for it in tsp}
if not tsp_ids: say('No site photos to compare against'); json.dump({'results': []}, open(man['out'], 'w')); sys.exit(0)
counts = [len(T[i]) for i in tsp_ids]
mat = np.concatenate([T[i] for i in tsp_ids]); owner = np.repeat(np.arange(len(tsp_ids)), counts)

results = []; todo = [it for it in ig if it['id'] in G and not (decided.get(it['id']) or {}).get('confirmed')]
say(f'Checking {len(todo)} {"Instagram images" if SOURCE == "ig" else "Getty assets"} against {len(tsp_ids)} site photos')
for n, it in enumerate(todo):
    q = G[it['id']]
    sims = (mat @ q.T).max(axis=1)                       # best over the query's views
    best = np.full(len(tsp_ids), -1.0, np.float32); np.maximum.at(best, owner, sims)  # best over each photo's crops
    rej = set((decided.get(it['id']) or {}).get('rejected', []))
    ranked = [j for j in np.argsort(-best)[:TOPK * 4 + len(rej)] if tsp_ids[j] not in rej]
    cands = []
    for n_, j in enumerate(ranked):
        # look at the TOPK most similar; if none of them really lines up, widen the search (heavy edits fool the shortlist)
        if n_ >= TOPK and any(c['inliers'] >= PLAUSIBLE_MIN for c in cands): break
        pid = tsp_ids[j]
        cands.append({'photo_id': pid, 'cos': round(float(best[j]), 4), 'inliers': inliers(it['path'], tpath[pid])})
    cands.sort(key=lambda c: (-c['inliers'], -c['cos']))
    top = cands[0] if cands else None; second = cands[1]['inliers'] if len(cands) > 1 else 0
    out = []
    if top:
        clear = top['inliers'] >= AUTO_MIN and (second < AUTO_MIN // 2 or top['inliers'] >= 1.6 * second)
        plausible = top['inliers'] >= PLAUSIBLE_MIN or top['cos'] >= 0.80
        for i, c in enumerate(cands[:3]):
            c['score'] = round(min(1.0, c['inliers'] / 60) * 0.7 + max(0.0, c['cos']) * 0.3, 4)
            if i == 0 and clear: c['status'] = 'auto'; out.append(c)
            elif plausible and (c['inliers'] >= PLAUSIBLE_MIN or c['cos'] >= 0.80): c['status'] = 'review'; out.append(c)
    results.append({OUTKEY: it['id'], 'candidates': out})
    prog('verify', n + 1, len(todo))

json.dump({'results': results}, open(man['out'], 'w'))
auto = sum(1 for r in results if r['candidates'] and r['candidates'][0].get('status') == 'auto')
rev = sum(1 for r in results if r['candidates'] and r['candidates'][0].get('status') == 'review')
say(f'Done: {auto} matched, {rev} to review, {len(results) - auto - rev} with no match on the site')

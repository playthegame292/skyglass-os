# Generates an original Frutiger-Aero style wallpaper: "Aero Lagoon"
import sys, math, random
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
W, H = 1600, 960
rnd = random.Random(7)
yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
def lerp(a, b, t): return a + (b - a) * t
def grad(stops, t):
    t = np.clip(t, 0, 1); out = np.zeros(t.shape + (3,), np.float32)
    for (p0, c0), (p1, c1) in zip(stops, stops[1:]):
        m = (t >= p0) & (t <= p1); k = ((t - p0) / max(p1 - p0, 1e-6))[m][:, None]
        out[m] = np.array(c0) * (1 - k) + np.array(c1) * k
    return out
# sky
img = grad([(0, (6, 86, 196)), (.35, (40, 150, 235)), (.62, (150, 218, 255)), (1, (225, 248, 255))], yy / (H * .72))
# sun glow (upper right)
sx, sy = W * .78, H * .16
d = np.hypot(xx - sx, yy - sy)
glow = np.exp(-(d / 70) ** 2) * 1.0 + np.exp(-(d / 260) ** 2) * .55 + np.exp(-(d / 650) ** 2) * .25
# rays
ang = np.arctan2(yy - sy, xx - sx)
rays = (np.sin(ang * 16) * .5 + .5) ** 10 * np.exp(-(d / 650)) * .16
img = img + (np.array([255, 252, 235]) - img) * np.clip(glow + rays, 0, 1)[..., None]
# soft aurora-ish light band
band = np.exp(-((yy - (H * .42 + np.sin(xx / 260) * 40)) / 60) ** 2) * .10
img = img + (255 - img) * band[..., None]
# water (lower part) — aqua with horizontal ripples
horizon = H * .66
wt = (yy - horizon) / (H - horizon)
water = grad([(0, (60, 200, 235)), (.5, (12, 140, 205)), (1, (4, 70, 150))], wt)
ripple = (np.sin(yy / 3.2 + np.sin(xx / 90) * 2) * .5 + .5) ** 8 * np.clip(1 - wt, 0, 1) * .25
water = water + (255 - water) * ripple[..., None]
# sun reflection on water
refl = np.exp(-((xx - sx) / 110) ** 2) * np.clip(1 - wt * 1.3, 0, 1) * ((np.sin(yy / 2.5) * .5 + .5) ** 3) * .7
water = water + (255 - water) * refl[..., None]
img = np.where((yy >= horizon)[..., None], water, img)
im = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), 'RGB').convert('RGBA')

# glossy green hills on the left and right
def hill(path_pts, top, bottom, shine=True):
    layer = Image.new('RGBA', (W, H), (0, 0, 0, 0)); mask = Image.new('L', (W, H), 0)
    ImageDraw.Draw(mask).polygon(path_pts, fill=255)
    ys = np.linspace(0, 1, H)[:, None, None]
    g = (np.array(top) * (1 - ys) + np.array(bottom) * ys) * np.ones((1, W, 1))
    fill = Image.fromarray(g.astype(np.uint8), 'RGB').convert('RGBA'); fill.putalpha(mask)
    layer = Image.alpha_composite(layer, fill)
    if shine:  # bright rim near the ridge
        rim = mask.filter(ImageFilter.GaussianBlur(1)); inner = Image.new('L', (W, H), 0)
        ImageDraw.Draw(inner).polygon([(x, y + 26) for x, y in path_pts], fill=255)
        hl = np.clip(np.array(mask, np.float32) - np.array(inner, np.float32), 0, 255) * .55
        hl = Image.fromarray(hl.astype(np.uint8)).filter(ImageFilter.GaussianBlur(6))
        white = Image.new('RGBA', (W, H), (255, 255, 255, 0)); white.putalpha(hl)
        layer = Image.alpha_composite(layer, white)
    return layer
def curve(cx, w, peak, phase, n=160):
    # a smooth bump that sinks below the bottom edge on both sides: no cliffs
    pts = []
    for i in range(n + 1):
        x = -400 + (W + 800) * i / n
        y = H * 1.08 - (H * 1.08 - peak) * math.exp(-((x - cx) / w) ** 2) + 10 * math.sin(x / 140 + phase)
        pts.append((x, y))
    return pts + [(W + 400, H + 10), (-400, H + 10)]
im = Image.alpha_composite(im, hill(curve(120, 560, H * .50, 0), (150, 235, 90), (25, 120, 40)))
im = Image.alpha_composite(im, hill(curve(1640, 470, H * .60, 1), (140, 228, 85), (22, 115, 38)))
im = Image.alpha_composite(im, hill(curve(-80, 520, H * .70, 2), (185, 245, 110), (40, 150, 45)))
# glossy bubbles
def bubble(layer, cx, cy, r, tint=(170, 225, 255)):
    S = int(r * 2 + 8); b = np.zeros((S, S, 4), np.float32)
    y, x = np.mgrid[0:S, 0:S].astype(np.float32); c = S / 2
    dd = np.hypot(x - c, y - c) / r
    inside = dd <= 1
    edge = np.clip((dd - .72) / .28, 0, 1) ** 2
    a = np.where(inside, .10 + edge * .55, 0)
    col = np.array(tint, np.float32) * (1 - edge[..., None] * .2) + 255 * edge[..., None] * .2
    # specular highlight upper-left
    hd = np.hypot(x - (c - r * .38), (y - (c - r * .42)) * 1.25) / (r * .32)
    spec = np.clip(1 - hd, 0, 1) ** 1.5 * inside
    col = col * (1 - spec[..., None]) + 255 * spec[..., None]; a = np.maximum(a, spec * .95)
    # small lower-right glint
    gd = np.hypot(x - (c + r * .45), y - (c + r * .5)) / (r * .12)
    gl = np.clip(1 - gd, 0, 1) * inside
    col = col * (1 - gl[..., None]) + 255 * gl[..., None]; a = np.maximum(a, gl * .8)
    # antialias the rim
    a = a * np.clip((1 - dd) * r, 0, 1)
    b[..., :3] = col; b[..., 3] = a * 255
    bi = Image.fromarray(np.clip(b, 0, 255).astype(np.uint8), 'RGBA')
    layer.alpha_composite(bi, (int(cx - c), int(cy - c)))
bl = Image.new('RGBA', (W, H), (0, 0, 0, 0))
spots = [(1180, 300, 120), (1360, 520, 70), (990, 470, 46), (1460, 230, 38), (300, 260, 64), (180, 470, 30),
         (560, 150, 26), (1100, 140, 22), (820, 330, 18), (420, 420, 16), (1530, 640, 28), (640, 600, 34)]
for cx, cy, r in spots: bubble(bl, cx, cy, r)
im = Image.alpha_composite(im, bl)
# a few glowing sparkles
sp = Image.new('RGBA', (W, H), (255, 255, 255, 0)); dr = ImageDraw.Draw(sp)
for _ in range(28):
    x, y, r = rnd.uniform(0, W), rnd.uniform(0, H * .65), rnd.uniform(1, 2.6)
    dr.ellipse((x - r, y - r, x + r, y + r), fill=(255, 255, 255, 200))
im = Image.alpha_composite(im, sp.filter(ImageFilter.GaussianBlur(1.2)))
im.convert('RGB').save(sys.argv[1], quality=90, optimize=True, progressive=True)
print('saved', sys.argv[1])

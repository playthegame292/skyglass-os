#!/usr/bin/python3
"""android-fetch: download the Waydroid Android images fast (used by skyglass-android setup).

Waydroid's own downloader uses one connection, which SourceForge's mirrors throttle hard
(about 0.1 MB/s on a Pi). This splits each file into parts downloaded in parallel (about
15x faster on the same Wi-Fi), resumes after an interruption, checks the SHA-256 that
Waydroid's update server publishes, unpacks system.img / vendor.img and deletes the zips.

  android-fetch.py <images dir> [--work DIR] [--parts N] [--system VANILLA|GAPPS] [--vendor MAINLINE]
Prints progress lines; exits non-zero on failure (setup then falls back to waydroid init).
"""
import argparse
import hashlib
import json
import os
import shutil
import sys
import threading
import time
import urllib.request
import zipfile

OTA = {"system": "https://ota.waydro.id/system/lineage/waydroid_arm64/{}.json",
       "vendor": "https://ota.waydro.id/vendor/waydroid_arm64/{}.json"}
# Not a browser User-Agent: SourceForge answers browsers with its download web page (HTTP 200,
# no range support) instead of the file
UA = {"User-Agent": "skyglass-android/1.0 (curl-compatible)"}
CHUNK = 256 * 1024


def get(url, headers=None, timeout=30):
    return urllib.request.urlopen(urllib.request.Request(url, headers={**UA, **(headers or {})}), timeout=timeout)


def latest(kind, channel):
    with get(OTA[kind].format(channel)) as r:
        info = json.load(r)["response"][0]
    return info["filename"], info["url"], info["id"].lower(), int(info["size"])


def mirror(url):
    """SourceForge's /download page redirects to a mirror with a signed link: resolve it once."""
    with get(url, {"Range": "bytes=0-0"}) as r:
        return r.geturl()


def fetch_part(url, path, start, end, progress, errors):
    want = end - start + 1
    for attempt in range(8):
        have = os.path.getsize(path) if os.path.exists(path) else 0
        if have >= want:
            return
        try:
            with get(url, {"Range": f"bytes={start + have}-{end}"}, timeout=40) as r, open(path, "ab") as f:
                if r.status != 206:
                    raise OSError(f"mirror ignored the range request (HTTP {r.status})")
                while True:
                    b = r.read(CHUNK)
                    if not b:
                        break
                    f.write(b)
                    with progress["lock"]:
                        progress["done"] += len(b)
        except Exception as e:  # noqa: BLE001 - network hiccup: wait, resume where we stopped
            errors.append(str(e))
            time.sleep(min(30, 2 * (attempt + 1)))
    if (os.path.getsize(path) if os.path.exists(path) else 0) < want:
        raise OSError(f"part {os.path.basename(path)} kept failing: {errors[-1] if errors else '?'}")


def download(kind, channel, work, parts):
    name, url, sha, size = latest(kind, channel)
    zpath = os.path.join(work, name)
    if os.path.exists(zpath) and os.path.getsize(zpath) == size:
        print(f"{kind}: {name} already downloaded", flush=True)
    else:
        print(f"{kind}: {name} ({size / 1e6:.0f} MB) in {parts} parts", flush=True)
        real = mirror(url)
        step = -(-size // parts)
        ranges = [(i * step, min(size, (i + 1) * step) - 1) for i in range(parts) if i * step < size]
        paths = [f"{zpath}.part{i}" for i in range(len(ranges))]
        already = sum(min(os.path.getsize(p), e - s + 1) for p, (s, e) in zip(paths, ranges) if os.path.exists(p))
        progress, errors, failed = {"done": already, "lock": threading.Lock()}, [], []

        def run(i):
            try:
                fetch_part(real, paths[i], *ranges[i], progress, errors)
            except Exception as e:  # noqa: BLE001
                failed.append(str(e))
        threads = [threading.Thread(target=run, args=(i,), daemon=True) for i in range(len(ranges))]
        for t in threads:
            t.start()
        t0, d0 = time.time(), progress["done"]
        while any(t.is_alive() for t in threads):
            time.sleep(5)
            d = progress["done"]
            rate = (d - d0) / max(1e-6, time.time() - t0)
            left = (size - d) / rate / 60 if rate > 0 else 0
            print(f"{kind}: {d / 1e6:.0f}/{size / 1e6:.0f} MB  {rate / 1e6:.2f} MB/s  ~{left:.0f} min left", flush=True)
        if failed:
            raise SystemExit(f"{kind}: download failed: {failed[0]}")
        with open(zpath + ".tmp", "wb") as out:
            for p in paths:
                with open(p, "rb") as f:
                    shutil.copyfileobj(f, out, 4 << 20)
        os.replace(zpath + ".tmp", zpath)
        for p in paths:
            os.remove(p)
    print(f"{kind}: checking SHA-256…", flush=True)
    h = hashlib.sha256()
    with open(zpath, "rb") as f:
        for b in iter(lambda: f.read(4 << 20), b""):
            h.update(b)
    if h.hexdigest() != sha:
        os.remove(zpath)
        raise SystemExit(f"{kind}: checksum mismatch (download damaged), deleted it: run setup again")
    return zpath


def unpack(kind, zpath, images):
    target = os.path.join(images, f"{kind}.img")
    print(f"{kind}: unpacking {kind}.img…", flush=True)
    with zipfile.ZipFile(zpath) as z:
        member = next((m for m in z.namelist() if m.endswith(f"{kind}.img")), None)
        if not member:
            raise SystemExit(f"{kind}: no {kind}.img inside {os.path.basename(zpath)}")
        with z.open(member) as src, open(target + ".tmp", "wb") as dst:
            shutil.copyfileobj(src, dst, 4 << 20)
    os.replace(target + ".tmp", target)
    os.remove(zpath)   # lightweight: keep only the image, not the 1 GB of zips
    print(f"{kind}: ready ({os.path.getsize(target) / 1e6:.0f} MB)", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("images")
    ap.add_argument("--work", default="/var/cache/skyglass-android")
    ap.add_argument("--parts", type=int, default=8)
    ap.add_argument("--system", default="VANILLA")
    ap.add_argument("--vendor", default="MAINLINE")
    ap.add_argument("--only", choices=("system", "vendor"), help="just one image (testing)")
    a = ap.parse_args()
    os.makedirs(a.images, exist_ok=True)
    os.makedirs(a.work, exist_ok=True)
    for kind, channel in (("vendor", a.vendor), ("system", a.system)):
        if a.only and kind != a.only:
            continue
        if os.path.exists(os.path.join(a.images, f"{kind}.img")):
            print(f"{kind}: already there", flush=True)
            continue
        unpack(kind, download(kind, channel, a.work, max(1, min(16, a.parts))), a.images)
    shutil.rmtree(a.work, ignore_errors=True)
    print("done", flush=True)


if __name__ == "__main__":
    main()

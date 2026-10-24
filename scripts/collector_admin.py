#!/usr/bin/env python3
"""Admin tool for the speech collector. Standard library only.

    export SUPABASE_SERVICE_KEY=...        # Project settings -> API keys -> secret key. Never commit it, never put it in the website.

    python3 scripts/collector_admin.py summary
    python3 scripts/collector_admin.py download --out ~/collector_data [--skip-flagged] [--include-withdrawn]
    python3 scripts/collector_admin.py withdraw <participant-id-or-first-8-chars> [--yes]
    python3 scripts/collector_admin.py prune-orphans [--yes]

`download` writes a folder the Speech Trainer can read directly:
    <out>/<Label>/s<speaker10>_<round>.wav   (e.g. A/s5c5fb78b5f_3.wav)   16 kHz mono 16-bit PCM
    <out>/manifest.csv, <out>/speakers.csv     (full metadata, including quality measurements)
In the Trainer's Dataset page add <out> as a source; the file names follow its `speaker_take` pattern, so every
participant is treated as one speaker and the splits keep each person on one side.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

URL = os.environ.get("SUPABASE_URL", "https://vkoluuojtrsyagttzchx.supabase.co").rstrip("/")
BUCKET = "recordings"
BAD_FLAGS = {"too_quiet", "clipped", "too_short", "too_long"}
INVALID_FLAGS = {"no_speech", "wrong_content"}  # never exported


def key() -> str:
    k = os.environ.get("SUPABASE_SERVICE_KEY", "").strip()
    if not k:
        sys.exit("Set SUPABASE_SERVICE_KEY (the secret/service-role key) in your environment first. It is never stored in this project.")
    return k


def call(method: str, path: str, body=None, headers: dict | None = None, raw: bool = False):
    h = {"apikey": key(), **(headers or {})}
    if key().count(".") == 2:  # legacy JWT-style key; the newer sb_secret_… keys must not be sent as a Bearer token
        h["Authorization"] = f"Bearer {key()}"
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        h.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(f"{URL}{path}", data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            out = r.read()
            return out if raw else (json.loads(out) if out else None)
    except urllib.error.HTTPError as e:
        sys.exit(f"{method} {path} -> {e.code} {e.read().decode()[:300]}")


def rows(table: str, query: str = "") -> list[dict]:
    out, start = [], 0
    while True:
        part = call("GET", f"/rest/v1/{table}?{query}", headers={"Range-Unit": "items", "Range": f"{start}-{start + 999}"})
        out += part
        if len(part) < 1000:
            return out
        start += 1000


def list_folder(prefix: str) -> list[dict]:
    out, offset = [], 0
    while True:
        part = call("POST", f"/storage/v1/object/list/{BUCKET}", {"prefix": prefix, "limit": 1000, "offset": offset})
        out += part
        if len(part) < 1000:
            return out
        offset += 1000


def delete_objects(paths: list[str]):
    for i in range(0, len(paths), 100):
        call("DELETE", f"/storage/v1/object/{BUCKET}", {"prefixes": paths[i : i + 100]})


def fname(r: dict) -> str:
    return f"s{r['speaker_id'].replace('-', '')[:10]}_{r['round']}.wav"


def cmd_summary(_):
    sp, rec = rows("speakers"), rows("recordings")
    live = {s["id"] for s in sp if not s["withdrawn_at"]}
    print(f"participants: {len(sp)} ({len(sp) - len(live)} withdrawn)   recordings: {len(rec)}")
    by = Counter(r["speaker_id"] for r in rec)
    print("recordings per participant:", dict(sorted(Counter(by.values()).items())))
    print("per label:", dict(sorted(Counter(r["label"] for r in rec if r["speaker_id"] in live).items())))
    print("quality :", dict(Counter(r["quality_flag"] for r in rec)))
    for field in ("age_band", "gender", "first_language", "mic_type", "environment", "country", "campaign"):
        print(f"{field:15}", dict(Counter(s[field] or "-" for s in sp if s["id"] in live).most_common(12)))


def cmd_download(a):
    out = Path(a.out).expanduser()
    sp = {s["id"]: s for s in rows("speakers")}
    rec = [r for r in rows("recordings", "order=created_at") if (a.include_withdrawn or not sp[r["speaker_id"]]["withdrawn_at"])]
    rec = [r for r in rec if r["quality_flag"] not in INVALID_FLAGS]
    if a.skip_flagged:
        rec = [r for r in rec if r["quality_flag"] not in BAD_FLAGS]
    n_new = 0
    for r in rec:
        dest = out / r["label"] / fname(r)
        if dest.exists() and dest.stat().st_size > 44:
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(call("GET", f"/storage/v1/object/{BUCKET}/{urllib.parse.quote(r['storage_path'])}", raw=True))
        n_new += 1
    out.mkdir(parents=True, exist_ok=True)
    fields = ["file", "label", "round", "speaker_id", "display_name", "duration_ms", "peak_dbfs", "rms_dbfs", "noise_floor_dbfs", "snr_db", "clipped_fraction", "quality_flag", "retries", "device_label", "native_sample_rate", "endpoint_reason", "created_at"]
    with open(out / "manifest.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fields)
        w.writeheader()
        for r in rec:
            w.writerow({"file": f"{r['label']}/{fname(r)}", "display_name": sp[r["speaker_id"]]["display_name"], **{k: r.get(k) for k in fields if k not in ("file", "display_name")}})
    with open(out / "speakers.csv", "w", newline="") as f:
        cols = [c for c in next(iter(sp.values())).keys() if c not in ("user_agent",)] if sp else []
        w = csv.DictWriter(f, cols, extrasaction="ignore")
        w.writeheader()
        for s in sp.values():
            w.writerow(s)
    print(f"{len(rec)} recordings from {len({r['speaker_id'] for r in rec})} participants in {out}  ({n_new} newly downloaded)")


def find_speaker(token: str) -> dict:
    t = token.lower().replace("-", "")
    hits = [s for s in rows("speakers") if s["id"].replace("-", "").startswith(t)]
    if len(t) < 8 or len(hits) != 1:
        sys.exit(f"{len(hits)} participants match '{token}' (give at least the first 8 characters of the ID)")
    return hits[0]


def cmd_withdraw(a):
    s = find_speaker(a.speaker)
    rec = rows("recordings", f"speaker_id=eq.{s['id']}")
    files = [f"{s['id']}/{o['name']}" for o in list_folder(s["id"]) if o.get("name")]
    print(f"{s['display_name']!r} ({s['id']}): {len(rec)} recordings, {len(files)} stored files")
    if not a.yes:
        return print("Dry run. Add --yes to delete the files and the participant's rows for good.")
    delete_objects(files)
    call("DELETE", f"/rest/v1/speakers?id=eq.{s['id']}")
    print("Deleted. Remember to remove any copy you already downloaded or trained on (models already trained cannot be un-trained).")


def cmd_prune(a):
    known = {s["id"] for s in rows("speakers")}
    orphans = []
    for top in list_folder(""):
        if top.get("id") is None and top["name"] not in known:  # a folder whose participant no longer exists
            orphans += [f"{top['name']}/{o['name']}" for o in list_folder(top["name"]) if o.get("name")]
    print(f"{len(orphans)} stored files belong to participants that no longer exist")
    for p in orphans:
        print("  ", p)
    if orphans and a.yes:
        delete_objects(orphans)
        print("deleted")
    elif orphans:
        print("Dry run. Add --yes to delete them.")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("summary").set_defaults(f=cmd_summary)
    d = sub.add_parser("download")
    d.add_argument("--out", required=True)
    d.add_argument("--skip-flagged", action="store_true", help="leave out takes flagged too_quiet / clipped / too_short / too_long")
    d.add_argument("--include-withdrawn", action="store_true")
    d.set_defaults(f=cmd_download)
    w = sub.add_parser("withdraw")
    w.add_argument("speaker")
    w.add_argument("--yes", action="store_true")
    w.set_defaults(f=cmd_withdraw)
    o = sub.add_parser("prune-orphans")
    o.add_argument("--yes", action="store_true")
    o.set_defaults(f=cmd_prune)
    a = p.parse_args()
    a.f(a)


if __name__ == "__main__":
    main()

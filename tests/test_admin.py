"""Exercises scripts/collector_admin.py against a stub of the Supabase REST + Storage API (no network, no real key)."""
import json
import os
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

SP = [
    {"id": "5c5fb78b-5f34-4ebc-80cc-b8ec43f18211", "display_name": "Ada", "withdrawn_at": None, "age_band": "25-34", "gender": "female", "first_language": "isiZulu", "mic_type": "usb_mic", "environment": "quiet_room", "country": "South Africa", "campaign": "t1", "user_agent": "x"},
    {"id": "aaaaaaaa-0000-4000-8000-000000000001", "display_name": "Gone", "withdrawn_at": "2026-10-01T00:00:00Z", "age_band": "18-24", "gender": "male", "first_language": "English", "mic_type": "other", "environment": "noisy", "country": "South Africa", "campaign": "", "user_agent": "x"},
]
def rec(sp, label, rnd, flag="ok"):
    return {"speaker_id": sp, "label": label, "round": rnd, "storage_path": f"{sp}/{label}_r{rnd}.wav", "quality_flag": flag, "created_at": "2026-10-24T10:00:00Z", "duration_ms": 900, "peak_dbfs": -6, "rms_dbfs": -20, "noise_floor_dbfs": -60, "snr_db": 40, "clipped_fraction": 0, "retries": 0, "device_label": "mic", "native_sample_rate": 48000, "endpoint_reason": "endpoint"}
REC = [rec(SP[0]["id"], "A", 1), rec(SP[0]["id"], "One", 1), rec(SP[0]["id"], "B", 1, "too_quiet"), rec(SP[1]["id"], "A", 1)]
WAV = b"RIFF" + b"\0" * 60
DELETED = []

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, body, ctype="application/json"):
        b = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(200); self.send_header("Content-Type", ctype); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        assert self.headers["apikey"] == "svc-key"
        if self.path.startswith("/rest/v1/speakers"): return self._send(SP)
        if self.path.startswith("/rest/v1/recordings"): return self._send([r for r in REC if "speaker_id=eq." not in self.path or r["speaker_id"] in self.path])
        if self.path.startswith("/storage/v1/object/recordings/"): return self._send(WAV, "audio/wav")
        self.send_error(404)
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0)); body = json.loads(self.rfile.read(n) or b"{}")
        if self.path.startswith("/storage/v1/object/list/recordings"):
            if body["prefix"] == "": return self._send([{"name": SP[0]["id"], "id": None}, {"name": "dead0000-0000-4000-8000-000000000000", "id": None}])
            return self._send([{"name": "A_r1.wav", "id": "x"}])
        self.send_error(404)
    def do_DELETE(self):
        n = int(self.headers.get("Content-Length", 0)); body = json.loads(self.rfile.read(n) or b"{}") if n else {}
        DELETED.append((self.path, body)); self._send([])

def run(args, url):
    env = {**os.environ, "SUPABASE_SERVICE_KEY": "svc-key", "SUPABASE_URL": url}
    return subprocess.run([sys.executable, str(Path(__file__).parent.parent / "scripts" / "collector_admin.py"), *args], capture_output=True, text=True, env=env)

def test_admin():
    srv = HTTPServer(("127.0.0.1", 0), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{srv.server_port}"
    with tempfile.TemporaryDirectory() as d:
        r = run(["download", "--out", d], url); assert r.returncode == 0, r.stderr
        files = sorted(str(p.relative_to(d)) for p in Path(d).rglob("*.wav"))
        assert files == ["A/s5c5fb78b5f_1.wav", "B/s5c5fb78b5f_1.wav", "One/s5c5fb78b5f_1.wav"], files  # withdrawn participant excluded
        assert "file,label,round" in (Path(d) / "manifest.csv").read_text().splitlines()[0]
        r = run(["download", "--out", d + "/x", "--skip-flagged"], url); assert r.returncode == 0
        assert sorted(p.parent.name for p in Path(d, "x").rglob("*.wav")) == ["A", "One"]
        r = run(["summary"], url); assert "participants: 2 (1 withdrawn)" in r.stdout, r.stdout
    r = run(["prune-orphans"], url); assert "1 stored files" in r.stdout and "dead0000" in r.stdout and not DELETED
    r = run(["prune-orphans", "--yes"], url); assert DELETED[-1][1]["prefixes"] == ["dead0000-0000-4000-8000-000000000000/A_r1.wav"]
    DELETED.clear()
    r = run(["withdraw", "5C5FB78B"], url); assert "Dry run" in r.stdout and not DELETED
    r = run(["withdraw", "5C5FB78B", "--yes"], url); assert r.returncode == 0, r.stderr
    assert DELETED[0][1]["prefixes"] == [f"{SP[0]['id']}/A_r1.wav"] and DELETED[1][0] == f"/rest/v1/speakers?id=eq.{SP[0]['id']}"
    r = run(["withdraw", "5c5"], url); assert r.returncode != 0  # too short to be safe

if __name__ == "__main__":
    test_admin(); print("ok")

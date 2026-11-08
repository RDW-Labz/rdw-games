"""Cancel + rerun a GitHub Actions job that runs past a limit (Braden s78: 30 min on #108)."""
import json, subprocess, sys, time
from datetime import datetime, timezone
repo, run, name, limit = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
def gh(*a): return subprocess.run(["gh", *a], capture_output=True, text=True).stdout
while True:
    try:
        jobs = json.loads(gh("run", "view", run, "--repo", repo, "--json", "jobs"))["jobs"]
    except Exception as e:
        print("poll error", e, flush=True); time.sleep(60); continue
    j = next((x for x in jobs if x["name"] == name), None)
    if j is None: print("job not found", flush=True); time.sleep(60); continue
    if j["status"] == "completed":
        print(f"{name}: {j['conclusion']} at {datetime.now(timezone.utc):%H:%MZ}", flush=True); break
    started = j.get("startedAt") or ""
    if started.startswith("20"):
        age = (datetime.now(timezone.utc) - datetime.fromisoformat(started.replace("Z", "+00:00"))).total_seconds()
        if age > limit:
            log = gh("run", "view", "--job", str(j["databaseId"]), "--repo", repo, "--log")
            hits = [l[-200:] for l in log.splitlines() if any(k in l.lower() for k in ("websocket", "timeout", "faulthandler", "test_"))][-8:]
            print(f"HUNG {int(age)}s → cancel + rerun; last lines:", *hits, sep="\n", flush=True)
            gh("run", "cancel", run, "--repo", repo); time.sleep(45); gh("run", "rerun", run, "--repo", repo, "--failed")
            print("WEBSOCKET" if any("websocket" in h.lower() for h in hits) else "not websocket", flush=True); break
    time.sleep(60)

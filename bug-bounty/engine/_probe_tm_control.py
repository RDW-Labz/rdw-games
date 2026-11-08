import sqlite3, subprocess

db = sqlite3.connect("engine/state.db")
rows = list(db.execute(
    "select host,target,claimable from findings where target like '%trafficmanager.net' limit 200"))
non = [r for r in rows if r[2] == 0]
print("rows:", len(rows), "non-claimable:", len(non))
for host, target, _ in non[:14]:
    out = subprocess.run(["dig", "+short", target], capture_output=True, text=True).stdout.strip()
    print(f"{host[:38]:<40} {target[:44]:<46} -> {out[:50] or 'NXDOMAIN'}")

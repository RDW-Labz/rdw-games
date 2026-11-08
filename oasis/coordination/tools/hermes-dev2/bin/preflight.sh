#!/bin/bash
# Pre-flight for Hermes workers on dev2 (decision #384). Run as root:
#   sudo /opt/hermes-dev2/bin/preflight.sh
# 1. root's checks (groups, firewall rule, mounts, key file, proxy socket, unit props)
# 2. root, host network: which targets ARE reachable (so a block can be proved)
# 0. refuses while any job runs (it starts probe units and changes nothing
#    of theirs, but a live job must never share the box with a test)
# 3. hermes-w on the HOST network (its own transient unit, so systemd ends
#    every process it started): nft must drop it; the drop counter must go up
# 4. hermes-w-probe@sandbox: the job sandbox (private network + forwarder)
# 5. hermes-w-probe@iso-a and @iso-b at the same time: neither may see,
#    signal or read the other; each still uses its own folder
# 6. root against the live proxy: route, method, body and message tricks;
#    "nobody" (outside hermes-sock: the socket mode) and hermes-stranger (in
#    hermes-sock, not hermes-w: the proxy's SO_PEERCRED check)
# 7. end to end: one tiny job through the real `dispatch submit` as
#    hermes-sub, then status and fetch. It MUST run: dispatch only accepts
#    jobs inside the off-hours window, so run the pre-flight then. Outside
#    the window this row FAILS (there is no override: a root-only bypass
#    would test a different path than the Mac uses).
# 8. verdicts: PASS only when reachable outside AND blocked inside; a target
#    nothing listens on is "NOT TESTED", never PASS. Exits non-zero on any
#    FAIL, and on a NOT TESTED where the check is always testable.
set -euo pipefail
PATH=/usr/sbin:/usr/bin:/sbin:/bin
[[ $(id -u) -eq 0 ]] || { echo "run with sudo" >&2; exit 2; }
BIN=/opt/hermes-dev2/bin SBIN=/opt/hermes-dev2/sbin
live=$(find /var/lib/hermes-jobs/work -mindepth 1 -maxdepth 1 -name 'j-*' 2>/dev/null | wc -l)
units=$(systemctl list-units --type=service --state=active,activating --no-legend --plain 'hermes-w-job@*' 2>/dev/null | wc -l)
if (( live > 0 || units > 0 )); then
  echo "refusing: $live job folder(s) and $units job unit(s) are live; run the pre-flight when no job runs" >&2
  exit 2
fi
PROBE="python3 -I $BIN/preflight_probe.py"
probes=/var/lib/hermes-jobs/probe
rootdir=$(mktemp -d /run/hermes-preflight.XXXXXX)
cleanup() {
  systemctl stop 'hermes-w-probe@*.service' 'hermes-fwd@probe-*.service' 'hermes-precheck@*.service' 'hermes-pf-*.service' 2>/dev/null || true
  rm -rf --one-file-system "$probes" "$rootdir"
}
trap cleanup EXIT
rm -rf --one-file-system "$probes"
install -d -o root -g root -m 0755 "$probes"
for p in sandbox iso-a iso-b; do install -d -o hermes-w -g hermes-w -m 0700 "$probes/$p"; done
for f in outside sandbox hostuser iso-a iso-b tricks other e2e; do : >"$rootdir/$f.json"; done
# A short-lived unit as USER on the host network (no job sandbox: the name doesn't start with
# hermes-w-). When it ends, systemd stops everything it started; nothing else of hermes-w is touched.
as_unit() { local name=$1 user=$2; shift 2
  systemd-run --wait --pipe --collect --quiet --unit="hermes-pf-$name-$$" --uid="$user" --gid="$(id -g "$user")" \
    -p NoNewPrivileges=yes -p RuntimeMaxSec=120 -- "$@"; }
fail=0
check() { if [[ $2 == "$3" ]]; then echo "PASS                  $1"; else echo "FAIL                  $1 (want $2, got $3)"; fail=1; fi; }
conf() { sed -n "s/^$1=//p" /etc/hermes-dev2/config.conf | head -1; }

echo "== 1. root checks"
groups=" $(id -nG hermes-w) "
for g in docker sudo wheel adm; do check "hermes-w not in $g" absent "$([[ $groups == *" $g "* ]] && echo present || echo absent)"; done
check "hermes-w is in hermes-sock (the proxy socket group)" present "$([[ $groups == *" hermes-sock "* ]] && echo present || echo absent)"
check "nft table + hermes-w drop rule, no accept" ok "$("$SBIN/hermes-unit-precheck" probe >/dev/null 2>&1 && echo ok || echo missing)"
check "work area is a tmpfs" tmpfs "$(findmnt -n -o FSTYPE /var/lib/hermes-jobs/work || echo none)"
check "key file is root-only 0400" "root:root 400" "$(stat -c '%U:%G %a' /etc/hermes-proxy/model.key 2>/dev/null || echo missing)"
check "hermes-proxy running" active "$(systemctl is-active hermes-proxy.service || true)"
sock=$(conf PROXY_SOCKET)
check "proxy socket hermes-proxy:hermes-sock 660" "socket hermes-proxy:hermes-sock 660" "$(stat -c '%F %U:%G %a' "$sock" 2>/dev/null || echo missing)"
proxy_pid=$(systemctl show -p MainPID --value hermes-proxy.service)
check "the proxy process has no TCP listener (pid $proxy_pid)" none \
  "$([[ $proxy_pid -gt 0 ]] && ss -Hltnp 2>/dev/null | grep -q "pid=$proxy_pid," && echo present || { [[ $proxy_pid -gt 0 ]] && echo none || echo 'no proxy pid'; })"
check "cgroup v2 (needed for IPAddressDeny)" cgroup2fs "$(stat -fc %T /sys/fs/cgroup)"
for u in hermes-w-probe@sandbox.service hermes-w-job@j-00000000.service; do
  check "$u: PrivateNetwork" yes "$(systemctl show "$u" -p PrivateNetwork --value)"
  check "$u: PrivatePIDs" yes "$(systemctl show "$u" -p PrivatePIDs --value)"
  check "$u: runs as hermes-w" hermes-w "$(systemctl show "$u" -p User --value)"
  check "$u: IPAddressDeny set" yes "$(systemctl show "$u" -p IPAddressDeny --value | grep -q . && echo yes || echo no)"
  check "$u: AF_INET only" "AF_INET" "$(systemctl show "$u" -p RestrictAddressFamilies --value)"
  check "$u: PrivateIPC" yes "$(systemctl show "$u" -p PrivateIPC --value)"
done
check "hermes-fwd@probe-sandbox precheck dependency" present \
  "$(systemctl show hermes-fwd@probe-sandbox.service -p Requires | grep -Fq 'hermes-precheck@fwd-probe-sandbox.service' && echo present || echo absent)"
check "the watchdog's sandbox can write the work tmpfs" ok \
  "$(systemctl start hermes-watchdog@check-write.service >/dev/null 2>&1 && echo ok || echo 'no (journalctl -u hermes-watchdog@check-write)')"

echo "== 2. what root can reach from the host network"
$PROBE --outside "$rootdir/outside.json"

echo "== 3. hermes-w on the host network (outside any sandbox) must be dropped by nft"
uid=$(id -u hermes-w)
count() { nft list chain inet hermes_w output | python3 -I -c "import sys; sys.path.insert(0, '$BIN'); from hermes_dev2_common import drop_counter; print(drop_counter(sys.stdin.read(), $uid) or 0)"; }
before=$(count)
as_unit hostuser hermes-w $PROBE --host-user "$probes/sandbox/hostuser.json" || true
after=$(count)
check "nft drop counter went up (was $before, now $after)" yes "$([[ $after -gt $before ]] && echo yes || echo no)"
# No result stays an empty file: the verdicts count that as a required check that did not run.
$PROBE --collect "$probes/sandbox" hostuser.json "$rootdir/hostuser.json" || : >"$rootdir/hostuser.json"

echo "== 4. the job sandbox"
systemctl start hermes-w-probe@sandbox.service || true
$PROBE --collect "$probes/sandbox" inside.json "$rootdir/sandbox.json" \
  || { echo "FAIL                  sandbox probe produced no result (journalctl -u hermes-w-probe@sandbox -u hermes-fwd@probe-sandbox -n 50)"; fail=1; }

echo "== 5. two jobs at once: isolation"
systemctl start --no-block hermes-w-probe@iso-a.service hermes-w-probe@iso-b.service
ready=0
for _ in $(seq 150); do
  if $PROBE --collect "$probes/iso-a" ready.json /dev/null 2>/dev/null && $PROBE --collect "$probes/iso-b" ready.json /dev/null 2>/dev/null; then ready=1; break; fi
  sleep 0.2
done
# A oneshot unit's running ExecStart may show as MainPID or as ControlPID.
unit_pid() { local p; p=$(systemctl show -p MainPID --value "$1"); [[ $p -gt 0 ]] || p=$(systemctl show -p ControlPID --value "$1"); echo "$p"; }
pid_a=$(unit_pid hermes-w-probe@iso-a.service)
pid_b=$(unit_pid hermes-w-probe@iso-b.service)
if (( ready && pid_a > 0 && pid_b > 0 )); then
  $PROBE --give "$probes/iso-a" peer.json "{\"peer\": \"iso-b\", \"peer_host_pid\": $pid_b, \"peer_dir\": \"$probes/iso-b\"}"
  $PROBE --give "$probes/iso-b" peer.json "{\"peer\": \"iso-a\", \"peer_host_pid\": $pid_a, \"peer_dir\": \"$probes/iso-a\"}"
  for _ in $(seq 300); do
    if $PROBE --collect "$probes/iso-a" result.json /dev/null 2>/dev/null && $PROBE --collect "$probes/iso-b" result.json /dev/null 2>/dev/null; then break; fi
    sleep 0.2
  done
  # Both must still be the same, running processes now: then each was alive while the other checked it.
  overlapped=false
  [[ $(unit_pid hermes-w-probe@iso-a.service) == "$pid_a" && $(unit_pid hermes-w-probe@iso-b.service) == "$pid_b" ]] && overlapped=true
  $PROBE --give "$probes/iso-a" release ""
  $PROBE --give "$probes/iso-b" release ""
  for _ in $(seq 100); do
    systemctl is-active --quiet hermes-w-probe@iso-a.service hermes-w-probe@iso-b.service || break
    sleep 0.2
  done
  for p in iso-a iso-b; do $PROBE --collect "$probes/$p" result.json "$rootdir/$p.json" || : >"$rootdir/$p.json"; done
  [[ -s $rootdir/iso-a.json ]] && python3 -I -c "import json,sys; p=sys.argv[1]; d=json.load(open(p)); d['overlapped']=sys.argv[2]=='true'; json.dump(d, open(p,'w'))" "$rootdir/iso-a.json" "$overlapped"
else
  echo "FAIL                  isolation probes did not both start (journalctl -u 'hermes-w-probe@iso-*' -n 50)"; fail=1
fi

echo "== 6. the live proxy: tricks, and a stranger"
$PROBE --proxy-tricks "$sock" "$rootdir/tricks.json"
other=$(as_unit nobody nobody $PROBE --other-user "$sock" 2>/dev/null || echo "no result")
stranger=$(as_unit stranger hermes-stranger $PROBE --other-user "$sock" 2>/dev/null || echo "no result")
python3 -I -c 'import json,sys; json.dump({"other": sys.argv[1], "stranger": sys.argv[2]}, open(sys.argv[3], "w"))' \
  "$other" "$stranger" "$rootdir/other.json"

echo "== 7. end to end through the real dispatch (as hermes-sub)"
python3 -I - "$rootdir/e2e.json" "$(conf MODEL)" <<'PY'
import json, os, subprocess, sys, time, uuid
out, model = sys.argv[1], sys.argv[2]
sys.path.insert(0, "/opt/hermes-dev2/bin")
from datetime import datetime
from zoneinfo import ZoneInfo
from hermes_dev2_common import in_window, load_config
c = load_config()
local = datetime.now(ZoneInfo(c["WINDOW_TZ"]))
def done(d):
    json.dump(d, open(out, "w")); sys.exit(0)
if not in_window(local.hour, int(c["WINDOW_START"]), int(c["WINDOW_END"])):
    done({"skipped": f"outside the off-hours window (now {local:%H:%M}); run the pre-flight between "
                     f"{int(c['WINDOW_START']):02d}:00 and {int(c['WINDOW_END']):02d}:00"})
if os.path.lexists("/var/lib/hermes-jobs/STOP"):
    done({"skipped": "STOP file present"})
jid = "j-pf" + uuid.uuid4().hex[:16]
def dispatch(cmd, stdin=b""):
    p = subprocess.run(["runuser", "-u", "hermes-sub", "--", "env", "-i", "PATH=/usr/bin:/bin",
                        f"SSH_ORIGINAL_COMMAND={cmd}", "/opt/hermes-sub/bin/dispatch"],
                       input=stdin, capture_output=True, timeout=60)
    return p.stdout.decode(errors="replace").strip(), p.stderr.decode(errors="replace").strip()
res = {}
so, se = dispatch("submit", json.dumps({"id": jid, "model": model, "prompt": "Reply with the word ok."}).encode())
res["submit"] = so or se
if so == "ok":
    deadline = time.monotonic() + 300
    while time.monotonic() < deadline:
        so, _ = dispatch(f"status {jid}")
        if so.startswith("done"):
            break
        time.sleep(3)
    res["status"] = so
    data = subprocess.run(["runuser", "-u", "hermes-sub", "--", "env", "-i", "PATH=/usr/bin:/bin",
                           f"SSH_ORIGINAL_COMMAND=fetch {jid}", "/opt/hermes-sub/bin/dispatch"],
                          capture_output=True, timeout=60).stdout
    res["fetched_bytes"] = len(data)
    subprocess.run(["rm", "-rf", "--one-file-system", f"/var/lib/hermes-jobs/outbox/{jid}"])
done(res)
PY

echo "== 8. verdicts"
if [[ -s $rootdir/sandbox.json && -s $rootdir/outside.json ]]; then
  $PROBE --combine "$rootdir"/{outside,sandbox,hostuser,iso-a,iso-b,tricks,other,e2e}.json || fail=1
else
  fail=1
fi
if (( fail )); then
  echo "PRE-FLIGHT FAILED: do not start workers."
  grep -q '"skipped"' "$rootdir/e2e.json" 2>/dev/null \
    && echo "  (end-to-end not run: run the pre-flight between 22:00 and 06:00)"
  exit 1
fi
echo "PRE-FLIGHT PASSED. (NOT TESTED rows had no listener; read them.)"

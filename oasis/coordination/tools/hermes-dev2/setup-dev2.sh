#!/bin/bash
# setup-dev2.sh: Hermes workers on dev2 (decision #384). Braden reads this,
# then runs it on dev2 from this folder:
#
#   sudo ./setup-dev2.sh --dry-run --bundle ./hermes-bundle-1ac3f97-x86_64.tar.gz --mac-key "ssh-ed25519 AAAA... hermes-dev2"
#   sudo ./setup-dev2.sh --bundle ./hermes-bundle-1ac3f97-x86_64.tar.gz --mac-key "ssh-ed25519 AAAA... hermes-dev2"
#   options: --upstream-user NAME        (default: the owner of the live 127.0.0.1:8000 listener)
#
# The bundle is built OFF dev2 by the oasis repo's hermes-bundle CI workflow
# (RUNBOOK step 1): no downloaded build code ever runs on dev2. This script
# only checks its sha256 (BUNDLE_SHA256 in config.conf) and architecture,
# then unpacks it root-owned.
#
# Safe to run again (idempotent). It never reads, prints or stores the model
# key: it tells you the one command to put the key in place, and finishes
# (baseline speed + pre-flight) the next time you run it. It never touches
# any other user's files, Hermes install, services or firewall tables.
#
# What it does, in order:
#   1. checks: Linux, root, systemd >= 257 (PrivatePIDs: refuses anything
#      older), nft, python3 >= 3.9, runuser, ss; the bundle's sha256 and
#      architecture; the model listener: ONLY on 127.0.0.1:8000 (refuses
#      0.0.0.0 or [::]) and who owns it
#   2. users: hermes-w (worker, no login, no home of its own), hermes-sub
#      (SSH entry, forced command only, root-owned home), hermes-proxy (no
#      home), hermes-stranger (no login; in hermes-sock but NOT allowed by
#      the proxy: the pre-flight proves the peer check refuses it); group
#      hermes-sock; asserts hermes-w is in no docker/sudo/wheel/adm group;
#      warns if sshd's AllowUsers/AllowGroups would keep hermes-sub out
#   3. folders (root-owned, checked: no group/world write anywhere above them)
#   4. Hermes: unpack the verified bundle (hermes_bundle.py: no absolute
#      paths, no "..", no links leaving the bundle, no hard links, devices or
#      setuid; root-owned, plain modes) next to /opt/hermes-w/hermes-agent and
#      swap it in. Refuses while jobs run. Nothing is downloaded or built here
#   5. installs the scripts (the installed dispatch has its test hook
#      stripped), units, the work tmpfs (2 GB), sandbox drop-in, firewall,
#      sudoers; then `hermes --version` as hermes-w inside the job sandbox
#   6. hermes-sub's authorized_keys (root-owned): the Mac key, forced command
#   7. enables the work tmpfs, the firewall and the watchdog timer; the proxy
#      once the key is in
#   8. with the key in place: baseline speed, then the pre-flight
set -euo pipefail
PATH=/usr/sbin:/usr/bin:/sbin:/bin

PIN=1ac3f97fbe0958aa2743c0c26202b20b3b4e760e   # the commit the bundle was built from (.github/workflows/hermes-bundle.yml)
HERE=$(cd "$(dirname "$0")" && pwd)
DRY=0 MAC_KEY="" BUNDLE="" UPSTREAM_USER=""

usage() { echo "usage: sudo $0 [--dry-run] --bundle FILE --mac-key 'ssh-ed25519 AAAA... comment' [--upstream-user NAME]" >&2; exit 2; }
while (($#)); do
  case $1 in
    --dry-run) DRY=1 ;;
    --mac-key) MAC_KEY=${2:-}; shift ;;
    --bundle) BUNDLE=${2:-}; shift ;;
    --upstream-user) UPSTREAM_USER=${2:-}; shift ;;
    *) usage ;;
  esac
  shift
done

say() { printf '\n== %s\n' "$*"; }
# Every change goes through run: --dry-run prints it instead.
run() { if ((DRY)); then printf '  [dry-run] %s\n' "$*"; else "$@"; fi; }
# Generated files are made here before install; this avoids special device paths
# whose behavior differs between GNU coreutils and uutils.
stage() {
  if [[ -z ${STAGE:-} ]]; then
    STAGE=$(mktemp -d "${TMPDIR:-/tmp}/hermes-dev2.XXXXXX")
    chmod 0700 "$STAGE"
    trap 'rm -rf -- "$STAGE"' EXIT
  fi
  (($#)) || return 0
  local name=$1
  shift
  if ! "$@" >"$STAGE/$name"; then
    echo "refusing: could not produce staged $name" >&2
    exit 2
  fi
  [[ -s "$STAGE/$name" ]] || { echo "refusing: staged $name is empty" >&2; exit 2; }
}
# Install a staged file as root:root MODE at DEST, then check content, owner and mode.
# A dry run prints the install instead (the staged file was still made and checked).
install_staged() {
  local name=$1 dest=$2 mode=$3 actual
  if ((DRY)); then
    printf '  [dry-run] staged %s (%s bytes, checks ok)\n' "$name" "$(wc -c <"$STAGE/$name" | tr -d '[:space:]')"
    printf '  [dry-run] install %s %s (root root %s)\n' "$STAGE/$name" "$dest" "$mode"
    return 0
  fi
  install -o root -g root -m "$mode" "$STAGE/$name" "$dest"
  actual=$(stat -c '%U %G %a' "$dest" 2>/dev/null || true)
  if ! cmp -s "$STAGE/$name" "$dest" || [[ $actual != "root root ${mode#0}" ]]; then
    echo "refusing: $dest did not install as expected" >&2
    exit 2
  fi
}
conf() { sed -n "s/^$1=//p" "$HERE/config.conf" | head -1; }
MODEL=$(conf MODEL)

say "1. checks"
[[ $(uname -s) == Linux ]] || { echo "refusing: this script is for dev2 (Linux), not $(uname -s)" >&2; exit 2; }
((DRY)) || [[ $(id -u) -eq 0 ]] || { echo "run with sudo" >&2; exit 2; }
stage
[[ $MAC_KEY =~ ^(ssh-ed25519|ecdsa-sha2-nistp256)\ [A-Za-z0-9+/=]+(\ [A-Za-z0-9@._-]+)?$ ]] \
  || { echo "--mac-key must be one ssh-ed25519 or ecdsa-sha2-nistp256 public key line" >&2; exit 2; }
[[ -n $MODEL ]] || { echo "config.conf has no MODEL" >&2; exit 2; }
sdv=$(systemctl --version | awk 'NR==1{print $2}')
((sdv >= 257)) || { echo "refusing: systemd $sdv is older than 257. Workers need PrivatePIDs (each job its own PID namespace, so two jobs can't see or touch each other); upgrade systemd first." >&2; exit 2; }
for bin in nft python3 visudo runuser ss sshd systemd-run systemd-escape findmnt groupadd usermod; do
  command -v "$bin" >/dev/null || { echo "missing: $bin" >&2; exit 2; }
done
python3 -c 'import sys; sys.exit(sys.version_info < (3, 9))' || { echo "python3 >= 3.9 needed (zoneinfo)" >&2; exit 2; }
# The bundle: built off dev2, checked here before anything else changes.
[[ -n $BUNDLE && -f $BUNDLE && ! -L $BUNDLE ]] || { echo "--bundle FILE: the hermes-bundle-*.tar.gz from the CI run (RUNBOOK step 1)" >&2; exit 2; }
BUNDLE=$(readlink -f "$BUNDLE")
BUNDLE_SHA256=$(conf BUNDLE_SHA256) BUNDLE_ARCH=$(conf BUNDLE_ARCH)
python3 -I "$HERE/bin/hermes_bundle.py" --verify "$BUNDLE" "$BUNDLE_SHA256" "$BUNDLE_ARCH" || exit 2
if ! visudo -cf "$HERE/hermes-sub.sudoers" >&2; then
  echo "refusing: hermes-sub.sudoers does not parse under this sudo (visudo -cf)" >&2
  exit 2
fi
# The model listener and its owner (the proxy refuses to send the key to anyone else).
# It must listen ONLY on 127.0.0.1:8000: a 0.0.0.0 or [::] bind is refused.
read -r bind_problem listen_uid < <(python3 -I - "$HERE/bin" <<'PY'
import sys
sys.path.insert(0, sys.argv[1])
from hermes_dev2_common import listeners, upstream_bind_problem
binds = listeners(open("/proc/net/tcp").read(), open("/proc/net/tcp6").read(), 8000)
problem = upstream_bind_problem(binds, "127.0.0.1")
uids = {u for _, u in binds}
print("none" if problem is None or not binds else problem.replace(" ", "_"), uids.pop() if len(uids) == 1 else "")
PY
)
if [[ $bind_problem != none ]]; then echo "refusing: ${bind_problem//_/ }" >&2; exit 2; fi
if [[ -n $UPSTREAM_USER ]]; then
  UPSTREAM_UID=$(id -u "$UPSTREAM_USER") || { echo "no such user: $UPSTREAM_USER" >&2; exit 2; }
  [[ -z $listen_uid || $listen_uid == "$UPSTREAM_UID" ]] || { echo "refusing: 127.0.0.1:8000 is owned by uid $listen_uid, not $UPSTREAM_USER" >&2; exit 2; }
else
  [[ -n $listen_uid ]] || { echo "refusing: nothing listens on 127.0.0.1:8000 (start the model server, or pass --upstream-user)" >&2; exit 2; }
  UPSTREAM_UID=$listen_uid
fi
echo "  model listener 127.0.0.1:8000 owned by uid $UPSTREAM_UID ($(getent passwd "$UPSTREAM_UID" | cut -d: -f1)):"
ss -Hltnp 'sport = :8000' 2>/dev/null | sed 's/^/    /' || true
echo "  ok: Linux, systemd $sdv, nft, python3, bundle ${BUNDLE_SHA256:0:12} ($BUNDLE_ARCH), model $MODEL"

say "2. users"
mkuser() {  # name home shell create-home(yes|no)
  if id "$1" >/dev/null 2>&1; then echo "  $1 exists"; return; fi
  if [[ $4 == yes ]]; then run useradd --system --user-group --create-home --home-dir "$2" --shell "$3" "$1"
  else run useradd --system --user-group --no-create-home --home-dir "$2" --shell "$3" "$1"; fi
}
mkuser hermes-w /opt/hermes-w /usr/sbin/nologin no   # its "home" is root-owned: jobs use a throwaway HERMES_HOME
mkuser hermes-sub /opt/hermes-sub /bin/sh no      # sshd runs the forced command through this shell
mkuser hermes-proxy /nonexistent /usr/sbin/nologin no
mkuser hermes-stranger /nonexistent /usr/sbin/nologin no   # pre-flight only: in hermes-sock, refused by the proxy's peer check
getent group hermes-sock >/dev/null || run groupadd --system hermes-sock
for u in hermes-w hermes-stranger; do
  if ! ((DRY)) && ! id -nG "$u" | tr ' ' '\n' | grep -qx hermes-sock; then run usermod -aG hermes-sock "$u"; fi
done
if ! ((DRY)); then
  for g in docker sudo wheel adm; do
    if id -nG hermes-w | tr ' ' '\n' | grep -qx "$g"; then echo "refusing: hermes-w is in group $g; remove it (gpasswd -d hermes-w $g)" >&2; exit 2; fi
  done
  echo "  ok: hermes-w is in no docker/sudo/wheel/adm group"
fi
allow=$(sshd -T 2>/dev/null | awk '$1=="allowusers"||$1=="allowgroups"{print}')
if [[ -n $allow ]]; then
  echo "  WARNING: sshd has these limits; make sure hermes-sub is allowed, or the Mac can't log in:"
  echo "$allow" | sed 's/^/    /'
fi

say "3. folders (root-owned)"
run install -d -o root -g root -m 0755 /opt/hermes-dev2 /opt/hermes-dev2/bin /opt/hermes-dev2/sbin /etc/hermes-dev2 \
  /opt/hermes-sub /opt/hermes-sub/bin /opt/hermes-sub/.ssh /var/lib/hermes-jobs /opt/hermes-w
run install -d -o root -g root -m 0711 /var/lib/hermes-jobs/work
run install -d -o root -g hermes-sub -m 0750 /var/lib/hermes-jobs/outbox
run install -d -o root -g root -m 0700 /etc/hermes-proxy
if ! ((DRY)); then
  for d in / /opt /etc /var /var/lib /opt/hermes-w /opt/hermes-dev2 /opt/hermes-dev2/bin /opt/hermes-dev2/sbin /etc/hermes-dev2 \
           /opt/hermes-sub /opt/hermes-sub/bin /opt/hermes-sub/.ssh /var/lib/hermes-jobs /var/lib/hermes-jobs/work; do
    read -r owner mode < <(stat -c '%u %a' "$d")
    [[ $owner == 0 && ! -L $d ]] && (( (8#$mode & 8#022) == 0 )) \
      || { echo "refusing: $d must be a root-owned directory without group/world write (is uid $owner mode $mode)" >&2; exit 2; }
  done
  echo "  ok: every folder above the root wrappers is root-owned and not group/world writable"
fi

say "4. Hermes $PIN: the verified bundle, root-owned (nothing downloaded or built here)"
installed=/etc/hermes-dev2/installed-bundle.sha256
if [[ -d /var/lib/hermes-jobs/work ]]; then
  jobs_now=$(find /var/lib/hermes-jobs/work -mindepth 1 -maxdepth 1 -name 'j-*' 2>/dev/null | wc -l)
else
  jobs_now=0
fi
if [[ -x /opt/hermes-w/hermes-agent/.venv/bin/hermes && -s $installed && $(cat "$installed") == "$BUNDLE_SHA256" ]]; then
  echo "  bundle ${BUNDLE_SHA256:0:12} already installed"
elif (( jobs_now > 0 )); then
  echo "refusing: $jobs_now job(s) running; install the new bundle when they finish" >&2; exit 2
else
  run python3 -I "$HERE/bin/hermes_bundle.py" --install "$BUNDLE" "$BUNDLE_SHA256" "$BUNDLE_ARCH" /opt/hermes-w/hermes-agent
  stage installed-bundle.sha256 printf '%s\n' "$BUNDLE_SHA256"
  install_staged installed-bundle.sha256 "$installed" 0644
fi
run chown root:root /opt/hermes-w
run chmod 0755 /opt/hermes-w
if ! ((DRY)); then
  bad=$(find /opt/hermes-w \( ! -uid 0 -o -perm /0022 -o -perm /6000 \) ! -type l -print -quit)
  [[ -z $bad ]] || { echo "refusing: $bad is not root-owned, or is group/world writable or setuid" >&2; exit 2; }
  if sudo -u hermes-w test -w /opt/hermes-w/hermes-agent; then echo "refusing: hermes-w can write /opt/hermes-w/hermes-agent" >&2; exit 2; fi
  echo "  ok: /opt/hermes-w is root-owned and read-only for hermes-w"
fi

say "5. scripts, units, firewall, sudoers"
for f in hermes_dev2_common.py hermes_jobs_root.py hermes_proxy.py hermes_fwd.py watchdog.py preflight_probe.py preflight.sh hermes-job-run hermes-job-finish; do
  run install -o root -g root -m 0755 "$HERE/bin/$f" /opt/hermes-dev2/bin/
done
for f in hermes-job-start hermes-job-stop hermes-unit-precheck; do
  run install -o root -g root -m 0755 "$HERE/sbin/$f" /opt/hermes-dev2/sbin/
done
# The installed dispatch has its test hook stripped (it reads an env var to use a fake tree).
stage dispatch python3 -I "$HERE/bin/hermes_dev2_common.py" --strip-test-hook "$HERE/bin/dispatch.py"
if grep -q HERMES_DEV2_TEST_ROOT "$STAGE/dispatch" ||
   ! python3 -I -c 'import ast,sys; ast.parse(open(sys.argv[1]).read())' "$STAGE/dispatch"; then
  echo "refusing: the staged dispatch still has the test hook or does not parse" >&2
  exit 2
fi
install_staged dispatch /opt/hermes-sub/bin/dispatch 0755
((DRY)) || ! grep -q HERMES_DEV2_TEST_ROOT /opt/hermes-sub/bin/dispatch || { echo "refusing: the test hook is still in the installed dispatch" >&2; exit 2; }
run install -o root -g root -m 0644 "$HERE/bin/hermes_dev2_common.py" /opt/hermes-sub/bin/
run install -o root -g root -m 0644 "$HERE/config.conf" "$HERE/hermes-w.nft" /etc/hermes-dev2/
stage proxy.conf sed "s/^UPSTREAM_UID=.*/UPSTREAM_UID=$UPSTREAM_UID/" "$HERE/proxy.conf"
install_staged proxy.conf /etc/hermes-dev2/proxy.conf 0644
run install -o root -g root -m 0644 "$HERE"/systemd/*.service "$HERE"/systemd/*.timer "$HERE"/systemd/*.mount /etc/systemd/system/
run install -d -o root -g root -m 0755 /etc/systemd/system/hermes-w-.service.d
run install -o root -g root -m 0644 "$HERE/systemd/hermes-w-.service.d/10-sandbox.conf" /etc/systemd/system/hermes-w-.service.d/
run rm -f /etc/systemd/system/hermes-w-.service.d/20-private-pids.conf /etc/systemd/system/hermes-w-probe.service \
  /etc/systemd/system/hermes-watchdog.service /etc/hermes-dev2/hermes-w-install.nft   # older versions
# PrivatePIDs is in 10-sandbox.conf: always on (systemd >= 257 checked in step 1).
run install -o root -g root -m 0440 "$HERE/hermes-sub.sudoers" /etc/sudoers.d/hermes-sub
run systemctl daemon-reload
# hermes --version as hermes-w, inside the job sandbox (the hermes-w- prefix drop-in applies).
run systemd-run --wait --pipe --collect --quiet --unit="hermes-w-verify-$$" --uid=hermes-w --gid=hermes-w \
  -p PrivateNetwork=yes -p ProtectSystem=strict -p Environment=HOME=/tmp -p Environment=HERMES_HOME=/tmp/hermes \
  /opt/hermes-w/hermes-agent/.venv/bin/hermes --version

say "6. the Mac's key for hermes-sub (forced command only; root-owned, so hermes-sub can't edit it)"
line="restrict,command=\"/opt/hermes-sub/bin/dispatch\" $MAC_KEY"
stage authorized_keys printf '%s\n' "$line"
install_staged authorized_keys /opt/hermes-sub/.ssh/authorized_keys 0644

say "7. enable"
workmount=$(systemd-escape -p --suffix=mount /var/lib/hermes-jobs/work)
run systemctl daemon-reload
run systemctl enable --now "$workmount"
if ! ((DRY)) && [[ $(findmnt -n -o FSTYPE /var/lib/hermes-jobs/work) != tmpfs ]]; then echo "refusing: the work tmpfs did not mount" >&2; exit 2; fi
run systemctl enable --now hermes-firewall.service
run systemctl enable --now hermes-watchdog.timer   # runs hermes-watchdog@run.service
if [[ ! -s /etc/hermes-proxy/model.key ]]; then
  cat <<EOF

  The model key is not in place yet. Put it there yourself (it is never typed
  into this script, never echoed and never saved in shell history):

    sudo bash -c 'read -rsp "key for $MODEL: " k; echo; umask 077; printf %s "\$k" > /etc/hermes-proxy/model.key; unset k; chown root:root /etc/hermes-proxy/model.key; chmod 0400 /etc/hermes-proxy/model.key'

  Then run this script again (same arguments) to start the proxy, measure
  the baseline speed and run the pre-flight.
EOF
  ((DRY)) || exit 0
fi
if [[ -d /var/lib/hermes-jobs/work ]]; then
  running=$(find /var/lib/hermes-jobs/work -mindepth 1 -maxdepth 1 -name 'j-*' 2>/dev/null | wc -l)
else
  running=0
fi
run systemctl enable hermes-proxy.service
if (( running > 0 )); then
  echo "  $running job(s) running: not restarting hermes-proxy (run this again when they finish)"
else
  run systemctl restart hermes-proxy.service
fi

say "8. baseline speed and pre-flight"
if ((DRY)); then
  echo "  [dry-run] python3 -I /opt/hermes-dev2/bin/watchdog.py --rebaseline (only if no baseline yet)"
  echo "  [dry-run] /opt/hermes-dev2/bin/preflight.sh"
  exit 0
fi
sleep 2
[[ -s /var/lib/hermes-jobs/baseline.json ]] || python3 -I /opt/hermes-dev2/bin/watchdog.py --rebaseline
if (( running > 0 )); then
  echo "  $running job(s) running: skipping the pre-flight (it refuses while jobs run); run it when they finish"
  exit 0
fi
/opt/hermes-dev2/bin/preflight.sh

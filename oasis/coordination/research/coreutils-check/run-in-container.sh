#!/usr/bin/env bash
# Re-proves setup-dev2.sh's staged installs against the real Ubuntu 26.04 tools
# (uutils coreutils as `install`, sudo-rs 0.2.13) in Docker. Run on the Mac:
#   bash coordination/research/coreutils-check/run-in-container.sh
# Prints PASS/FAIL per check and exits non-zero on any FAIL. Fakes only, nothing secret.
set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
HERMES_DIR=$(cd -- "$SCRIPT_DIR/../../tools/hermes-dev2" && pwd)
[[ -r "$HERMES_DIR/setup-dev2.sh" ]] || { echo "missing hermes-dev2 at $HERMES_DIR" >&2; exit 2; }

# -i: without it the heredoc never reaches the container and the run "passes" doing nothing.
exec docker run -i --rm -v "$HERMES_DIR:/hermes-dev2:ro" ubuntu:resolute bash -s <<'CONTAINER'
set -Eeuo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
apt-get install -y -qq python3-minimal "sudo-rs=0.2.13-0ubuntu1.2" >/dev/null
chmod 0440 /etc/sudoers   # the image ships it 0644; dev2 has 0440
echo "tools: rust-coreutils $(dpkg-query -W -f='${Version}' rust-coreutils), $(install --version | head -1), sudo-rs $(dpkg-query -W -f='${Version}' sudo-rs)"

fail=0
check() { if "$@"; then echo "PASS $label"; else echo "FAIL $label"; fail=1; fi; }

# 1. The real dry run, from a copy whose fixed PATH puts dev2-only stubs first
#    (the same stubs as tests/test_setup_dry_run.py; real python3, find, cmp, stat, mktemp, install).
cp -a /hermes-dev2 /root/h
stubs=/root/stubs; mkdir -p "$stubs"
stub() { printf '#!/bin/sh\n%s\n' "$2" >"$stubs/$1"; chmod 0755 "$stubs/$1"; }
stub uname 'echo Linux'
stub systemctl '[ "${1:-}" = "--version" ] && echo "systemd 257"; exit 0'
stub ss 'exit 0'
stub sshd 'exit 0'
stub systemd-escape 'echo "var-lib-hermes\\x2djobs-work.mount"'
for t in nft runuser systemd-run findmnt groupadd usermod; do stub "$t" 'exit 0'; done
stub python3 'if [ "${2:-}" = "-" ]; then echo none; exit 0; fi
case "$*" in *hermes_bundle.py*--verify*) exit 0 ;; esac
exec /usr/bin/python3 "$@"'
sed -i "s|^PATH=/usr/sbin:/usr/bin:/sbin:/bin$|PATH=$stubs:/usr/sbin:/usr/bin:/sbin:/bin|" /root/h/setup-dev2.sh
: >/root/fake-bundle.tar.gz
set +e
bash /root/h/setup-dev2.sh --dry-run --bundle /root/fake-bundle.tar.gz \
  --mac-key 'ssh-ed25519 AAAAFAKE test' --upstream-user root >/root/dry.log 2>&1
dry_rc=$?
set -e
label="dry run exits 0 (rc=$dry_rc)"; check test "$dry_rc" -eq 0
for n in 1 2 3 4 5 6 7 8; do label="dry run prints step $n"; check grep -q "^== $n\. " /root/dry.log; done
for f in installed-bundle.sha256 dispatch proxy.conf authorized_keys; do
  label="dry run staged $f with checks ok"; check grep -q "staged $f ([0-9]* bytes, checks ok)" /root/dry.log
done
(( dry_rc == 0 )) || tail -20 /root/dry.log

# 2. The real stage + install_staged helpers from setup-dev2.sh, for real (DRY=0) into a fake root.
sed -n '/^stage() {/,/^}$/p; /^install_staged() {/,/^}$/p' /hermes-dev2/setup-dev2.sh >/root/helpers.sh
cat >/root/install-check.sh <<'SH'
#!/bin/bash
set -euo pipefail
DRY=0
source /root/helpers.sh
dest=$1
stage dispatch /usr/bin/python3 -I /hermes-dev2/bin/hermes_dev2_common.py --strip-test-hook /hermes-dev2/bin/dispatch.py
! grep -q HERMES_DEV2_TEST_ROOT "$STAGE/dispatch"
install_staged dispatch "$dest/dispatch" 0755
stage proxy.conf sed 's/^UPSTREAM_UID=.*/UPSTREAM_UID=0/' /hermes-dev2/proxy.conf
install_staged proxy.conf "$dest/proxy.conf" 0644
stage authorized_keys printf '%s\n' 'restrict,command="/opt/hermes-sub/bin/dispatch" ssh-ed25519 AAAAFAKE test'
install_staged authorized_keys "$dest/authorized_keys" 0644
stage installed-bundle.sha256 printf '%s\n' fake-sha256
install_staged installed-bundle.sha256 "$dest/installed-bundle.sha256" 0644
[[ $(stat -c '%U %G %a' "$dest/dispatch") == "root root 755" ]]
stage_dir=$STAGE
echo "$stage_dir" >"$dest/stage-path"
SH
chmod 0755 /root/install-check.sh
mkdir -p /root/dest-root /root/dest-sudo
label="install_staged as root (uutils install)"; check /root/install-check.sh /root/dest-root
label="staging dir removed on exit"; check test ! -e "$(cat /root/dest-root/stage-path)"
# As setup runs on dev2: `sudo ./setup-dev2.sh` from a normal user, through sudo-rs.
useradd -m admin-fake
printf 'admin-fake ALL=(root) NOPASSWD: /root/install-check.sh\n' >/etc/sudoers.d/admin-fake
chmod 0440 /etc/sudoers.d/admin-fake
chmod 0711 /root
label="install_staged via sudo-rs from a normal user"
check runuser -u admin-fake -- sudo -n /root/install-check.sh /root/dest-sudo
label="sudo copy matches root copy"; check cmp -s /root/dest-root/dispatch /root/dest-sudo/dispatch

# 3. A tampered staged file is refused (content check is real).
cat >/root/tamper-check.sh <<'SH'
#!/bin/bash
set -euo pipefail
DRY=0
source /root/helpers.sh
stage x printf 'one\n'
install() { command install "$@"; printf 'two\n' >"${@: -1}"; }   # simulate a bad install
install_staged x /root/dest-root/x 0644
SH
set +e; bash /root/tamper-check.sh >/root/tamper.log 2>&1; t_rc=$?; set -e
label="tampered install refused (rc=$t_rc)"; check test "$t_rc" -eq 2
label="tampered install says refusing"; check grep -q 'refusing: /root/dest-root/x did not install as expected' /root/tamper.log

if (( fail )); then echo 'CONTAINER TEST FAILED'; exit 1; fi
echo 'CONTAINER TEST PASSED'
CONTAINER

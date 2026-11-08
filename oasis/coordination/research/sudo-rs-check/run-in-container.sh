#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
HERMES_DIR=$(cd -- "$SCRIPT_DIR/../../tools/hermes-dev2" && pwd)

[[ -r "$HERMES_DIR/hermes-sub.sudoers" ]] || {
  echo "missing hermes-dev2 context at $HERMES_DIR" >&2
  exit 2
}

exec docker run -i --rm \
  -v "$HERMES_DIR:/hermes-dev2:ro" \
  ubuntu:resolute bash -s -- <<'CONTAINER'
set -Eeuo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update

want_version=0.2.13-0ubuntu1.2
if apt-cache madison sudo-rs | awk -v want="$want_version" '$3 == want { found=1 } END { exit found ? 0 : 1 }'; then
  apt-get install -y "sudo-rs=$want_version"
else
  echo "sudo-rs=$want_version is unavailable; installing the repository candidate" >&2
  apt-get install -y sudo-rs
  echo "installed sudo-rs version: $(dpkg-query -W -f='${Version}' sudo-rs)" >&2
fi

# The ubuntu:resolute image ships /etc/sudoers 0644; sudo-rs visudo -c wants 0440 (dev2 has 0440).
chmod 0440 /etc/sudoers

getent group hermes-sock >/dev/null || groupadd --system hermes-sock
make_user() {
  local name=$1 home=$2 shell=$3
  if ! id "$name" >/dev/null 2>&1; then
    useradd --system --no-create-home --home-dir "$home" --shell "$shell" "$name"
  fi
}
make_user hermes-w /nonexistent /usr/sbin/nologin
make_user hermes-sub /opt/hermes-sub /bin/sh
make_user hermes-proxy /nonexistent /usr/sbin/nologin
make_user hermes-stranger /nonexistent /usr/sbin/nologin
usermod -aG hermes-sock hermes-w
usermod -aG hermes-sock hermes-stranger

install -d -o root -g root -m 0755 /opt/hermes-dev2/sbin /opt/hermes-sub /etc/sudoers.d
make_stub() {
  local path=$1
  install -o root -g root -m 0755 /dev/stdin "$path" <<'STUB'
#!/bin/sh
printf 'stub argv_count=%s' "$#"
i=1
for arg in "$@"; do
  printf ' arg%s=%s' "$i" "$arg"
  i=$((i + 1))
done
printf '\n'
STUB
}
make_stub /opt/hermes-dev2/sbin/hermes-job-start
make_stub /opt/hermes-dev2/sbin/hermes-job-stop
install -o root -g root -m 0440 /hermes-dev2/hermes-sub.sudoers /etc/sudoers.d/hermes-sub

fail=0
expect_rc() {
  local label=$1 expected=$2
  shift 2
  local output rc
  set +e
  output=$("$@" 2>&1)
  rc=$?
  set -e
  if [[ $expected == pass && $rc -eq 0 ]] || [[ $expected == deny && $rc -ne 0 ]]; then
    echo "PASS $label (rc=$rc)"
  else
    echo "FAIL $label (wanted $expected, rc=$rc)"
    fail=1
  fi
  [[ -z $output ]] || printf '%s\n' "$output"
}

echo "sudo: $(readlink -f /usr/bin/sudo) $(dpkg-query -W -f='${Version}' sudo-rs)"
expect_rc 'visudo -c' pass visudo -c
expect_rc 'visudo -c -f /etc/sudoers.d/hermes-sub' pass visudo -c -f /etc/sudoers.d/hermes-sub
expect_rc 'sudo -n -l -U hermes-sub' pass sudo -n -l -U hermes-sub

sub_sudo() {
  runuser -u hermes-sub -- env -i \
    HOME=/opt/hermes-sub PATH=/usr/bin:/bin \
    /usr/bin/sudo -n "$@"
}

expect_rc 'start: no arguments allowed' pass sub_sudo /opt/hermes-dev2/sbin/hermes-job-start
expect_rc 'start: one argument denied' deny sub_sudo /opt/hermes-dev2/sbin/hermes-job-start job-id
expect_rc 'start: one empty-string argument denied' deny sub_sudo /opt/hermes-dev2/sbin/hermes-job-start ''

expect_rc 'stop: one job id allowed' pass sub_sudo /opt/hermes-dev2/sbin/hermes-job-stop j-abcdef12
# The stop rule lists no args (any args allowed by sudo); the wrapper validates its one job id itself.
expect_rc 'stop: no arguments reach the wrapper' pass sub_sudo /opt/hermes-dev2/sbin/hermes-job-stop
expect_rc 'stranger: start denied' deny runuser -u hermes-stranger -- /usr/bin/sudo -n /opt/hermes-dev2/sbin/hermes-job-start
expect_rc 'sub: other command denied' deny sub_sudo /usr/bin/id

if (( fail )); then
  echo 'CONTAINER TEST FAILED'
  exit 1
fi
echo 'CONTAINER TEST PASSED'
CONTAINER

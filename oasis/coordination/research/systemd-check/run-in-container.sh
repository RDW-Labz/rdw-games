#!/bin/bash
# Re-prove the systemd namespace/precheck behavior in Ubuntu resolute.
set -euo pipefail

IMAGE=oasis-systemd-check:resolute
HERE=$(cd "$(dirname "$0")" && pwd)
HERMES=$(cd "$HERE/../../tools/hermes-dev2" && pwd)
CONTAINER=""
failures=0

cleanup() {
  if [[ -n $CONTAINER && -z ${KEEP:-} ]]; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

docker build -t "$IMAGE" - <<'DOCKERFILE'
FROM ubuntu:resolute
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends systemd systemd-sysv python3 nftables bash \
    && rm -rf /var/lib/apt/lists/*
DOCKERFILE

CONTAINER=$(docker run -d ${KEEP:+--name systemd-check} --privileged --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  --tmpfs /run --tmpfs /run/lock \
  -v "$HERMES:/h:ro" "$IMAGE" /sbin/init)

for _ in $(seq 1 60); do
  state=$(docker exec "$CONTAINER" systemctl is-system-running 2>/dev/null || true)
  if [[ $state == running || $state == degraded ]]; then
    break
  fi
  sleep 1
done
[[ $state == running || $state == degraded ]] || {
  echo "FAIL container systemd did not become running (state: $state)"
  exit 1
}

docker exec -i "$CONTAINER" bash -s <<'EOF'
set -euo pipefail
PATH=/usr/sbin:/usr/bin:/sbin:/bin

for user in hermes-w hermes-proxy hermes-sub; do
  getent passwd "$user" >/dev/null || useradd --system --no-create-home --shell /usr/sbin/nologin "$user"
done
install -d -o root -g root -m 0755 /opt/hermes-dev2/sbin /opt/hermes-dev2/bin /etc/hermes-dev2
find /h/sbin -maxdepth 1 -type f -exec install -m 0755 {} /opt/hermes-dev2/sbin/ \;
install -m 0644 /h/bin/*.py /opt/hermes-dev2/bin/
install -m 0755 /h/bin/hermes-job-run /h/bin/hermes-job-finish /opt/hermes-dev2/bin/
install -m 0644 /h/config.conf /h/hermes-w.nft /etc/hermes-dev2/
install -d -o hermes-proxy -g hermes-proxy -m 0755 /run/hermes-proxy
install -d -o root -g root -m 0711 /var/lib/hermes-jobs/work
install -d -o root -g hermes-sub -m 0750 /var/lib/hermes-jobs/outbox
install -d -o root -g root -m 0755 /opt/hermes-w/hermes-agent   # the bundle is not needed: hermes-job-run just fails

install -m 0644 /h/systemd/*.service /etc/systemd/system/
install -d -o root -g root -m 0755 /etc/systemd/system/hermes-w-.service.d
install -m 0644 /h/systemd/hermes-w-.service.d/10-sandbox.conf /etc/systemd/system/hermes-w-.service.d/
if [[ -f '/h/systemd/var-lib-hermes\x2djobs-work.mount' ]]; then
  install -m 0644 '/h/systemd/var-lib-hermes\x2djobs-work.mount' /etc/systemd/system/
fi
systemctl daemon-reload
if systemctl start 'var-lib-hermes\x2djobs-work.mount'; then
  :
else
  mount -t tmpfs -o size=2G,mode=0711,uid=0 tmpfs /var/lib/hermes-jobs/work
fi
systemctl start hermes-firewall.service
echo "setup: firewall $(systemctl is-active hermes-firewall.service); work $(findmnt -n -o FSTYPE /var/lib/hermes-jobs/work || echo none)"
EOF

show_result() {
  docker exec "$CONTAINER" systemctl show "$1" -p Result --value 2>/dev/null || true
}

check() {
  local label=$1 evidence=$2
  if [[ $evidence == PASS:* ]]; then
    printf 'PASS %s: %s\n' "$label" "${evidence#PASS:}"
  else
    printf 'FAIL %s: %s\n' "$label" "${evidence#FAIL:}"
    docker exec "$CONTAINER" journalctl -u 'hermes-precheck@*' --no-pager -o cat -n 4 2>/dev/null | sed 's/^/  precheck: /' || true
    failures=$((failures + 1))
  fi
}

reason_ok() { docker exec "$CONTAINER" journalctl -u "$1" --no-pager -o cat 2>/dev/null | grep -Fq "$2"; }

start_and_journal() {
  local unit=$1
  docker exec "$CONTAINER" systemctl start "$unit" >/dev/null 2>&1 || true
  docker exec "$CONTAINER" journalctl -u "$unit" --no-pager -n 80 2>/dev/null || true
}

start_and_journal hermes-fwd@j-0000abcd.service >/tmp/hermes-fwd.log
fwd_pre=$(show_result hermes-precheck@fwd-j-0000abcd.service)
fwd_203=$(docker exec "$CONTAINER" journalctl -u hermes-precheck@fwd-j-0000abcd.service -u hermes-fwd@j-0000abcd.service -u hermes-fwd@probe-sandbox.service --no-pager 2>/dev/null | grep -E '203/EXEC|status=203' || true)
if [[ $fwd_pre == success && -z $fwd_203 ]]; then
  check "forwarder precheck" "PASS:Result=$fwd_pre; no 203/EXEC"
else
  check "forwarder precheck" "FAIL:Result=${fwd_pre:-unknown}; ${fwd_203:-missing success evidence}"
fi
echo "  forwarder evidence: $(tail -1 /tmp/hermes-fwd.log 2>/dev/null || true)"

start_and_journal hermes-w-probe@sandbox.service >/tmp/hermes-probe.log
probe_pre=$(show_result hermes-precheck@probe-sandbox.service)
probe_203=$(docker exec "$CONTAINER" journalctl -u hermes-precheck@probe-sandbox.service -u hermes-w-probe@sandbox.service -u hermes-fwd@probe-sandbox.service --no-pager 2>/dev/null | grep -E '203/EXEC|status=203' || true)
if [[ $probe_pre == success && -z $probe_203 ]]; then
  check "probe precheck" "PASS:Result=$probe_pre; no 203/EXEC"
else
  check "probe precheck" "FAIL:Result=${probe_pre:-unknown}; ${probe_203:-missing success evidence}"
fi
echo "  probe evidence: $(tail -1 /tmp/hermes-probe.log 2>/dev/null || true)"

docker exec "$CONTAINER" bash -c 'install -d -o hermes-w -g hermes-w -m 0700 /var/lib/hermes-jobs/work/j-0000abcd'
start_and_journal hermes-w-job@j-0000abcd.service >/tmp/hermes-job.log
job_pre=$(show_result hermes-precheck@job-j-0000abcd.service)
job_203=$(docker exec "$CONTAINER" journalctl -u hermes-precheck@job-j-0000abcd.service -u hermes-w-job@j-0000abcd.service -u hermes-fwd@probe-sandbox.service --no-pager 2>/dev/null | grep -E '203/EXEC|status=203' || true)
if [[ $job_pre == success && -z $job_203 ]]; then
  check "job precheck" "PASS:Result=$job_pre; no 203/EXEC"
else
  check "job precheck" "FAIL:Result=${job_pre:-unknown}; ${job_203:-missing success evidence}"
fi
echo "  job evidence: $(tail -1 /tmp/hermes-job.log 2>/dev/null || true)"

docker exec "$CONTAINER" systemctl stop hermes-fwd@j-0000beef.service hermes-precheck@fwd-j-0000beef.service >/dev/null 2>&1 || true
docker exec "$CONTAINER" systemctl reset-failed hermes-fwd@j-0000beef.service hermes-precheck@fwd-j-0000beef.service >/dev/null 2>&1 || true
docker exec "$CONTAINER" nft delete table inet hermes_w
start_and_journal hermes-fwd@j-0000beef.service >/tmp/hermes-fwd-refused.log
bad_fwd_pre=$(show_result hermes-precheck@fwd-j-0000beef.service)
bad_fwd_log=$(docker exec "$CONTAINER" journalctl -u hermes-fwd@j-0000beef.service --no-pager -n 80 2>/dev/null)
if [[ $bad_fwd_pre == exit-code && $bad_fwd_log =~ Dependency\ failed|not\ started ]] && reason_ok hermes-precheck@fwd-j-0000beef.service "refused: the hermes-w firewall table"; then
  check "missing firewall blocks forwarder" "PASS:precheck Result=$bad_fwd_pre; dependency failed"
else
  check "missing firewall blocks forwarder" "FAIL:precheck Result=${bad_fwd_pre:-unknown}; no dependency failure evidence"
fi

docker exec "$CONTAINER" systemctl stop hermes-firewall.service >/dev/null 2>&1 || true
docker exec "$CONTAINER" systemctl start hermes-firewall.service >/dev/null
docker exec "$CONTAINER" touch /var/lib/hermes-jobs/STOP
docker exec "$CONTAINER" systemctl stop hermes-w-job@j-0000stop.service hermes-precheck@job-j-0000stop.service >/dev/null 2>&1 || true
docker exec "$CONTAINER" systemctl reset-failed hermes-w-job@j-0000stop.service hermes-precheck@job-j-0000stop.service >/dev/null 2>&1 || true
start_and_journal hermes-w-job@j-0000stop.service >/tmp/hermes-job-stop.log
stop_pre=$(show_result hermes-precheck@job-j-0000stop.service)
stop_job_log=$(cat /tmp/hermes-job-stop.log)
if [[ $stop_pre == exit-code ]] && grep -Eiq 'Dependency failed|not started' <<<"$stop_job_log" && reason_ok hermes-precheck@job-j-0000stop.service "refused: STOP file present"; then
  check "STOP blocks job" "PASS:precheck Result=$stop_pre"
else
  check "STOP blocks job" "FAIL:precheck Result=${stop_pre:-unknown}; job dependency did not fail"
fi
docker exec "$CONTAINER" rm -f /var/lib/hermes-jobs/STOP

# With the work tmpfs gone, the precheck refuses. (Starting a job unit itself remounts
# the tmpfs first via RequiresMountsFor=, checked separately below.)
docker exec "$CONTAINER" bash -c 'systemctl stop "var-lib-hermes\\x2djobs-work.mount"; umount /var/lib/hermes-jobs/work 2>/dev/null; true' >/dev/null 2>&1
docker exec "$CONTAINER" systemctl reset-failed hermes-precheck@job-j-0000mount.service >/dev/null 2>&1 || true
docker exec "$CONTAINER" systemctl start hermes-precheck@job-j-0000mount.service >/dev/null 2>&1 || true
mount_pre=$(show_result hermes-precheck@job-j-0000mount.service)
if [[ $mount_pre == exit-code ]] && reason_ok hermes-precheck@job-j-0000mount.service "refused: the size-capped work tmpfs is not mounted"; then
  check "precheck refuses without the work tmpfs" "PASS:precheck Result=$mount_pre"
else
  check "precheck refuses without the work tmpfs" "FAIL:precheck Result=${mount_pre:-unknown}"
fi
start_and_journal hermes-w-job@j-0000mnt2.service >/tmp/hermes-job-mount.log
fstype=$(docker exec "$CONTAINER" findmnt -n -o FSTYPE /var/lib/hermes-jobs/work 2>/dev/null || true)
if [[ $fstype == tmpfs ]]; then
  check "job start remounts the work tmpfs first" "PASS:fstype=$fstype"
else
  check "job start remounts the work tmpfs first" "FAIL:fstype=${fstype:-none}"
fi

# Every end of a job runs hermes-job-finish@<id> (root, host namespaces): the reply
# lands in outbox/<id>/ and the work folder is deleted. ExecStart is replaced by a
# drop-in only to choose how the job ends; the units and the finish code are real.
job_end() {
  local id=$1 how=$2 run=""
  case $how in
    success) run='/bin/sh -c "echo FAKE-reply > reply.txt"' ;;
    stop) run='/bin/sleep 300' ;;
  esac
  docker exec -i "$CONTAINER" bash -s "$id" "$run" <<'SH'
id=$1 run=$2
if [[ -n $run ]]; then
  d=/run/systemd/system/hermes-w-job@$id.service.d; mkdir -p "$d"
  printf '[Service]\nExecStart=\nExecStart=%s\n' "$run" >"$d/zz.conf"
  systemctl daemon-reload
fi
install -d -o hermes-w -g hermes-w -m 0700 "/var/lib/hermes-jobs/work/$id"
SH
  if [[ $how == stop ]]; then
    docker exec "$CONTAINER" systemctl start --no-block "hermes-w-job@$id.service"
    for _ in $(seq 1 20); do
      [[ $(docker exec "$CONTAINER" systemctl is-active "hermes-w-job@$id.service" 2>/dev/null || true) == active ]] && break
      sleep 0.5
    done
    docker exec "$CONTAINER" /opt/hermes-dev2/sbin/hermes-job-stop "$id" >/dev/null 2>&1 || true
  else
    docker exec "$CONTAINER" systemctl start "hermes-w-job@$id.service" >/dev/null 2>&1 || true
  fi
  # Wait until the finish unit has actually run and exited (Result=success also
  # shows for a unit that has not started yet).
  for _ in $(seq 1 40); do
    [[ $(docker exec "$CONTAINER" systemctl show -p ExecMainExitTimestampMonotonic --value "hermes-job-finish@$id.service" 2>/dev/null) =~ ^[1-9] ]] && break
    sleep 0.5
  done
  local fin outbox work trace
  fin=$(show_result "hermes-job-finish@$id.service")
  # systemctl show prints Result=success for a unit that does not exist; require it loaded.
  [[ $(docker exec "$CONTAINER" systemctl show -p LoadState --value "hermes-job-finish@$id.service" 2>/dev/null) == loaded ]] || fin="not-loaded"
  outbox=$(docker exec "$CONTAINER" bash -c "ls /var/lib/hermes-jobs/outbox/$id 2>/dev/null | tr '\n' ' '")
  work=$(docker exec "$CONTAINER" bash -c "test -e /var/lib/hermes-jobs/work/$id && echo left || echo deleted")
  trace=$(docker exec "$CONTAINER" journalctl -u "hermes-job-finish@$id.service" -u "hermes-w-job@$id.service" --no-pager -o cat 2>/dev/null | grep -E 'Traceback|FileNotFoundError|NAMESPACE|status=203' | head -1 || true)
  if [[ $fin == success && -n $outbox && $work == deleted && -z $trace ]]; then
    check "job $how publishes and cleans up" "PASS:finish=$fin; outbox: $outbox; work $work"
  else
    check "job $how publishes and cleans up" "FAIL:finish=${fin:-none}; outbox: ${outbox:-empty}; work $work; ${trace:-}"
  fi
}
job_end j-0000end1 failure
job_end j-0000end2 success
job_end j-0000end3 stop

docker exec "$CONTAINER" systemctl --version | head -1
if (( failures )); then
  echo "systemd check FAILED ($failures)"
  exit 1
fi
echo "systemd check PASSED"

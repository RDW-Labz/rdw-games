# Hermes workers on dev2: runbook

Decision #384. Sonnet 5.5 orchestrates; Hermes (NousResearch/hermes-agent, MIT, pinned `1ac3f97`) runs every worker job on dev2 against the one model named by `MODEL` in `config.conf`. Each job runs in a **private network namespace** with only a loopback device, so it has no path to OpenBao, the logins broker, any other listener, docker, tailscale, DNS, GitHub or the internet. Its one way out is its own forwarder, which reaches the key-holding proxy's Unix socket.

You run every step on dev2 yourself. The orchestrator never touches dev2. Nothing here touches the `dev2` user's own Hermes or any other user's files.

## How a job flows

```
Mac: swarm ──spawns──► mac/bin/hermes (hermes-remote)
                          │ ssh hermes-sub@dev2 "submit"   (only {id, model, prompt}; dedicated key, forced command)
dev2:                     ▼
   dispatch (hermes-sub) ── friendly refusals: window, STOP, disk, MAX_WORKERS, model ≠ MODEL
      │ sudo /opt/hermes-dev2/sbin/hermes-job-start  (job JSON on stdin; root re-checks it all under a lock,
      │                                               creates work/<id>/ itself, never follows a link)
      ▼
   hermes-fwd@<id>.service   hermes-w, owns the job's private network namespace,
      │                       relays 127.0.0.1:8001 (inside it) → /run/hermes-proxy/proxy.sock
   hermes-w-job@<id>.service hermes-w, joins that namespace; AF_INET only; /run, /var/lib, /opt, /srv hidden
      │ Hermes --oneshot --toolsets none --provider custom --model MODEL
      ▼
   hermes-proxy (Unix socket, peer must be hermes-w or root; MODEL only; checks the
      │           owner of 127.0.0.1:8000 before it adds the key) → the model server
      ▼
   hermes-job-finish (root): reply → a new outbox/<id>/ (root:hermes-sub 0750), work folder deleted
Mac: hermes-remote polls status, fetches the reply, prints it to swarm unchanged
```

**What protects a job:** its private network namespace (only `lo`), the systemd IP filter, `AF_INET`-only sockets (no Unix or IPv6 sockets), its own PID namespace (`PrivatePIDs`, so two jobs can't see, signal or read each other), its own IPC namespace (`PrivateIPC`) and a private 16 MB `/dev/shm` (no shared memory or message queue reaches another job or the host), a hidden `/etc`, `/opt`, `/run`, `/var/lib` and `/srv`, and a 2 GB tmpfs work area (`/tmp` 256 MB), so a job can't fill dev2's disk. Host nftables rules don't apply inside a private network namespace: the `inet hermes_w` table is the wall for any `hermes-w` process on dev2's **host** network (a stray process). Each job, forwarder and probe still checks, as root, that the table and its drop rule are loaded; if something flushed it (for example `systemctl reload nftables`), no new work starts until setup reloads it.

**Jobs that die early** (the forwarder or the proxy didn't start, so the job failed on a dependency and its cleanup never ran) are reaped by the watchdog (every 30 s) and by the next start: the Mac gets `done 125 failed: <reason>` instead of waiting 25 minutes.

The root precheck runs in its own `hermes-precheck@<kind>-<id>.service` with the host mount and network namespaces, because systemd 259 runs a `+ ExecStartPre` inside the worker namespaces where `/opt/hermes-dev2/sbin` and the host nft table are hidden.

## One-time setup

**Hermes is built off dev2.** The oasis repo's `hermes-bundle` CI workflow builds the pinned hermes-agent (`1ac3f97`) with CPython 3.14.7 (python-build-standalone, pinned by sha256) and `uv sync --locked --no-build` (every dependency a prebuilt wheel), laid out for `/opt/hermes-w/hermes-agent`. dev2 only checks the file's sha256 and architecture and unpacks it. No downloaded build code ever runs on dev2. Right after the sync, the workflow checks out this repo and runs `bin/bundle_sources_check.py`: it fails the build unless every installed package traces to `https://pypi.org/simple` (only hermes-agent itself is local, editable); it then runs `bin/drop_uv_build_timestamps.py` to strip uv's own build-timestamp file from each dist-info, so the bundle tarball is byte-for-byte reproducible.

1. **Build the bundle (on GitHub, once per pin):** RDW-Labz/oasis → Actions → **hermes-bundle** → Run workflow. Or from the Mac:
   ```
   gh workflow run hermes-bundle.yml --repo RDW-Labz/oasis
   gh run watch --repo RDW-Labz/oasis "$(gh run list --repo RDW-Labz/oasis --workflow hermes-bundle.yml --limit 1 --json databaseId -q '.[0].databaseId')"
   gh run download --repo RDW-Labz/oasis --name hermes-bundle --dir ~/Downloads/hermes-bundle
   cat ~/Downloads/hermes-bundle/*.sha256
   ```
   The run's summary page also shows the `BUNDLE_SHA256=` line.
2. **Paste the sha256 into this folder's `config.conf`** (`BUNDLE_SHA256=` followed by the 64 characters). Setup refuses to install without it, and on any mismatch.
3. **On the Mac, make the dedicated key** (no passphrase prompt in jobs; the key can only run `dispatch`):
   ```
   ssh-keygen -t ed25519 -f ~/.ssh/hermes-dev2 -C hermes-dev2 -N ''
   cat ~/.ssh/hermes-dev2.pub
   ```
4. **Copy this folder and the bundle to dev2** (any user you normally use):
   ```
   scp -r coordination/tools/hermes-dev2 <you>@10.10.10.220:~/hermes-dev2
   scp ~/Downloads/hermes-bundle/hermes-bundle-*-x86_64.tar.gz <you>@10.10.10.220:~/hermes-dev2/
   ```
5. **On dev2, read `setup-dev2.sh`, then dry-run it.** It needs systemd 257 or newer (dev2 has 259; older is refused, because each job needs its own PID namespace) and the model server listening on `127.0.0.1:8000` only (a `0.0.0.0` or `[::]` listener is refused). It checks the bundle's sha256 and architecture first:
   ```
   cd ~/hermes-dev2
   sudo ./setup-dev2.sh --dry-run --bundle ./hermes-bundle-1ac3f97-x86_64.tar.gz --mac-key "ssh-ed25519 AAAA... hermes-dev2"
   ```
   The dry run prints the owner of the `127.0.0.1:8000` listener (and its process). **Check that it's the model server.** If not, or if nothing is listening yet, pass `--upstream-user <the user that runs the model server>`.
   Setup stages generated files in a root-only temporary directory and checks each install; if a previous run stopped in step 5, re-run setup (it is safe to repeat).
6. **Run it for real.** It creates the users (`hermes-w`, `hermes-sub`, `hermes-proxy`, and `hermes-stranger`, a no-login user the pre-flight uses to prove the proxy's peer check), unpacks the bundle root-owned, installs the units and firewall, checks `hermes --version` inside the job sandbox, and stops to ask for the key:
   ```
   sudo ./setup-dev2.sh --bundle ./hermes-bundle-1ac3f97-x86_64.tar.gz --mac-key "ssh-ed25519 AAAA... hermes-dev2"
   ```
7. **Put the model key in place** with the hidden prompt the script prints (nothing echoed, nothing in history). The file is root-only, mode 0400, and only the proxy gets it, as a systemd credential.
8. **Run the script again, between 22:00 and 06:00 Chicago time** (same arguments). It starts the proxy, measures the baseline speed (median of 3 probes) and runs the pre-flight. **No line may say FAIL.** The end-to-end check only runs inside that window (dispatch refuses jobs outside it), and outside it that row FAILS: workers must not start until one real job has gone through. Read every NOT TESTED line: it means nothing was listening there, so that block wasn't proved. On any FAIL, stop and send me the output.
9. **On the Mac, trust dev2's host key once:** `ssh -i ~/.ssh/hermes-dev2 hermes-sub@10.10.10.220 status j-00000000` answers `unknown`.

**A new pin later:** change `HERMES_PIN` in the workflow and `PIN` in `setup-dev2.sh` together (a held PR), run the workflow, paste the new sha256, copy, run setup. Setup refuses to swap Hermes while jobs run.

## What the pre-flight checks

A blocked target is **PASS** only when root reaches it from dev2's host network **and** the worker sandbox can't. If root can't reach it either, it is **NOT TESTED (no listener)**, never PASS.

| Check | Must |
|---|---|
| from the sandbox: OpenBao `10.10.10.220:8200`; loopback `8200`, `8420`, `8093`, `3000`, `22`, `4322`, `4323`; the model directly on `127.0.0.1:8000`; LAN `:22`, `:8420`; docker bridge `172.20.0.1`; tailscale `100.78.45.14`; `1.1.1.1:443`; `github.com:443` | blocked |
| from the sandbox: DNS over UDP (`1.1.1.1:53`, `127.0.0.53:53`) and DNS lookups | blocked |
| from the sandbox: host Unix sockets (dbus, tailscaled, resolved, docker) and any `AF_UNIX` socket at all | refused |
| from the sandbox: network interfaces | only `lo` |
| from the sandbox: reading `/etc/hermes-proxy/model.key` | not readable |
| `hermes-w` on the HOST network (outside the sandbox): every target | dropped by nft, and the nft drop counter goes up |
| through the forwarder and proxy: `/v1/models` | lists exactly `MODEL` |
| one tiny chat completion for `MODEL` | returns |
| a chat call for any other model | 403 |

| from the sandbox: IPv6 sockets; UDP sends to the LAN, docker and the internet | refused / unreachable |
| from the sandbox: `/etc/shadow`, `/var/log/syslog`, the key, `/root` | not readable |
| **two jobs at once** (`hermes-w-probe@iso-a` and `@iso-b`): each tries the other's PID in `/proc`, a signal, `/proc/<pid>/root` and `cwd`, its folder, its marker file, its `/tmp`, its `/dev/shm` file, its SysV message queue, the outbox and the work area | all unreachable, while each still uses its own folder, `/tmp`, `/dev/shm` and queue; both running at the same time is checked |
| the live proxy, from root: `?query`, `//`, `..`, other methods and routes, a duplicate `model` key, the model in another case, `model` only nested, JSON with a comment, an `image_url` content part, `tool_calls` in a message, a `tool` role | refused (404/405/400/403) |
| the live proxy, from `nobody` (outside `hermes-sock`) | kept out by the socket's mode |
| the live proxy, from `hermes-stranger` (in `hermes-sock`, not `hermes-w`) | connects, then refused by the proxy's peer check (`SO_PEERCRED`) |
| the watchdog unit's sandbox (`hermes-watchdog@check-write`) | can write the work tmpfs (it reaps there) |
| **end to end**: one tiny job through the real `dispatch submit` as `hermes-sub`, then `status` and `fetch`. Only possible inside 22:00–06:00; outside it this row **FAILS** | `ok`, `done 0`, output fetched |

Root's own checks: `hermes-w` is in no docker/sudo/wheel/adm group and is in `hermes-sock`; the firewall table has its drop rule and no accept; the work area is a tmpfs; the key file is `root:root 400`; the proxy runs, its socket is `hermes-proxy:hermes-sock 660`, and the proxy process (by its PID) has no TCP listener; cgroup v2 is mounted (needed for `IPAddressDeny`); the probe and job units run as `hermes-w` with `PrivateNetwork`, `PrivatePIDs`, `PrivateIPC`, `IPAddressDeny` and `AF_INET` only. The pre-flight refuses to run while any job is live, and ends only processes it started itself (each probe runs as its own short-lived unit).

**NOT TESTED** is fine only where nothing listens. Every other check is always testable: if one of those didn't run, the pre-flight fails. The end-to-end check is never NOT TESTED: outside 22:00–06:00 it fails with "end-to-end not run: run the pre-flight between 22:00 and 06:00". There is no override (a root-only bypass would test a different path than the Mac uses).

Re-run it any time: `sudo /opt/hermes-dev2/bin/preflight.sh`.

## Running the test

- **Workers:** 2 to start (`MAX_WORKERS=2` in `/etc/hermes-dev2/config.conf`). Raise it only after the speed step below. Change it with `sudo nano /etc/hermes-dev2/config.conf`; nothing needs restarting.
- **When:** jobs start only 22:00–05:59 America/Chicago. A job that starts at 05:50 may finish after 06:00 (each job is capped at 20 minutes).
- **From the Mac,** for the test run only:
  ```
  PATH="$PWD/coordination/tools/hermes-dev2/mac/bin:$PATH" node ~/.project-swarm/current/tools/swarm.mjs doctor hermes
  PATH="$PWD/coordination/tools/hermes-dev2/mac/bin:$PATH" node ~/.project-swarm/current/tools/swarm.mjs --root <worktree> run <manifest>
  ```
  Each job in the manifest: `"agent": "hermes"` and `"model"` equal to `MODEL` in `config.conf`.
- **Watch on dev2:** `journalctl -fu 'hermes-w-job@*' -u 'hermes-fwd@*'` and `journalctl -fu hermes-proxy`. A dropped SSH link doesn't stop a job; `hermes-remote` reconnects and keeps polling.

## Stop rules and how to stop

The watchdog runs every 30 seconds. It stops every job and writes `/var/lib/hermes-jobs/STOP` (with the reason) when:
- free RAM (MemAvailable) is under **8 GB**;
- disk free is under **20 GB**;
- model speed is under **50% of the baseline** (probed at most every 2 minutes, only while jobs run).

- **Stop by hand:** `sudo touch /var/lib/hermes-jobs/STOP` (new jobs refused), and `sudo systemctl stop 'hermes-w-job@*'` (running jobs stopped).
- **Resume:** read the reason with `cat /var/lib/hermes-jobs/STOP`, then `sudo rm /var/lib/hermes-jobs/STOP`.
- **New baseline** (only on purpose, e.g. after a model change): `sudo python3 -I /opt/hermes-dev2/bin/watchdog.py --rebaseline`.
- **Changing the model:** edit `MODEL` in this folder's `config.conf` (a held PR), copy it to dev2, run `setup-dev2.sh` again, then rebaseline.

## Metrics to record per ticket

| Measure | Where |
|---|---|
| Cost | Sonnet seat `$` from `coordination/tools/seat_cost.py`; dev2 tokens at $0 |
| Time to green PR | dispatch → PR open with CI green |
| Review rounds | resubmits + the seat's hand edits |
| First-pass check | first reply passes tests, typecheck, lint and mutation unchanged? |
| Model speed | `last-probe.json` tokens/s vs `baseline.json`, at 1, 2 (then 3, 4) workers |
| Median job time | from the `hermes-w-job@*` journal start/stop lines |
| Max workers before slowdown | the highest count with median job time < 1.5× the 1-worker time and speed ≥ 50% of baseline |
| RAM free | `free -g` during the run (stop rule at 8 GB) |

## Uninstall

```
sudo touch /var/lib/hermes-jobs/STOP
sudo systemctl stop 'hermes-w-job@*' 'hermes-fwd@*' 'hermes-w-probe@*' 'hermes-precheck@*'
sudo systemctl disable --now hermes-watchdog.timer hermes-proxy.service hermes-firewall.service
sudo nft delete table inet hermes_w 2>/dev/null || true
sudo systemctl disable --now 'var-lib-hermes\x2djobs-work.mount'
sudo pkill -KILL -u hermes-w; sudo pkill -KILL -u hermes-sub   # userdel refuses while either has a process
sudo systemctl reset-failed 'hermes-w-job@*' 'hermes-fwd@*' 'hermes-w-probe@*' 'hermes-precheck@*' 'hermes-watchdog@*' 'hermes-pf-*' hermes-proxy.service hermes-firewall.service 2>/dev/null || true
sudo rm -f /etc/systemd/system/hermes-{proxy,firewall}.service '/etc/systemd/system/hermes-watchdog@.service' /etc/systemd/system/hermes-watchdog.timer \
  /etc/systemd/system/hermes-w-job@.service /etc/systemd/system/hermes-w-probe@.service /etc/systemd/system/hermes-fwd@.service /etc/systemd/system/hermes-precheck@.service \
  '/etc/systemd/system/var-lib-hermes\x2djobs-work.mount' \
  /etc/sudoers.d/hermes-sub
sudo rm -rf /etc/systemd/system/hermes-w-.service.d /opt/hermes-dev2 /etc/hermes-dev2 /var/lib/hermes-jobs /run/hermes-proxy
sudo shred -u /etc/hermes-proxy/model.key 2>/dev/null; sudo rm -rf /etc/hermes-proxy
sudo systemctl daemon-reload
sudo userdel hermes-w; sudo userdel hermes-sub; sudo userdel hermes-proxy; sudo userdel hermes-stranger; sudo groupdel hermes-sock
sudo rm -rf --one-file-system /opt/hermes-w /opt/hermes-sub   # Hermes (the root-owned bundle) and the SSH entry
sudo rm -rf /var/empty/hermes-proxy   # only if an older version made it
rm -rf ~/hermes-dev2                   # the copy you ran setup from, and the bundle file
```
Left on purpose: journal lines (they age out with the journal) and any core dumps systemd-coredump kept (none expected: `LimitCORE=0`).
On the Mac: `rm ~/.ssh/hermes-dev2 ~/.ssh/hermes-dev2.pub`, and remove dev2's `hermes-sub` line from `~/.ssh/known_hosts` if you like.

## Files

| File | Installed to | Runs as |
|---|---|---|
| `setup-dev2.sh` | (run from this folder) | root, by Braden |
| `config.conf` | `/etc/hermes-dev2/config.conf` (MODEL and every knob) | read by all tools |
| `proxy.conf` | `/etc/hermes-dev2/proxy.conf` (upstream + `UPSTREAM_UID`, filled in by setup) | hermes-proxy |
| `bin/dispatch.py` | `/opt/hermes-sub/bin/dispatch`, with its test hook stripped | hermes-sub (SSH forced command) |
| `bin/hermes_bundle.py` | (run from this folder by setup) | root: checks the bundle's sha256 and architecture, unpacks it safely |
| `../../../.github/workflows/hermes-bundle.yml` | (GitHub Actions, the oasis repo) | builds the bundle off dev2 |
| `bin/bundle_sources_check.py`, `bin/drop_uv_build_timestamps.py` | (run from a checkout of this repo, by the CI job) | the pypi-only guard and the reproducibility fix, never installed to dev2 |
| `sbin/hermes-job-start`, `hermes-job-stop` | `/opt/hermes-dev2/sbin/` | root via sudoers (only these two) |
| `sbin/hermes-unit-precheck` | `/opt/hermes-dev2/sbin/` | root, via `hermes-precheck@<kind>-<id>.service` in the host mount and network namespaces |
| `bin/hermes-job-run` | `/opt/hermes-dev2/bin/` | hermes-w, sandboxed |
| `bin/hermes_fwd.py` | `/opt/hermes-dev2/bin/` | hermes-w, per-job forwarder |
| `bin/hermes-job-finish`, `hermes_jobs_root.py` | `/opt/hermes-dev2/bin/` | root (`hermes-job-finish@<id>.service`, started by the job unit on every end; the reaper in start and the watchdog) |
| `bin/hermes_proxy.py` | `/opt/hermes-dev2/bin/` | hermes-proxy |
| `bin/watchdog.py` | `/opt/hermes-dev2/bin/` | root (`hermes-watchdog@run` from the timer, every 30 s; `@check-write` from the pre-flight) |
| `bin/preflight.sh`, `preflight_probe.py` | `/opt/hermes-dev2/bin/` | root / hermes-w on the host / hermes-w sandboxed |
| `hermes-sub.sudoers` | `/etc/sudoers.d/hermes-sub` | dev2 uses sudo-rs; setup checks the file with visudo before changing anything; `coordination/research/sudo-rs-check/run-in-container.sh` re-proves it in Docker |
| `systemd/*` (units, the sandbox drop-in with `PrivatePIDs`, the 2 GB work tmpfs mount), `hermes-w.nft` | `/etc/...` | — |
| `mac/bin/hermes` | stays on the Mac; first on PATH for test runs | you |
| `tests/` | Mac only: `cd tests && python3 -m unittest` | — |

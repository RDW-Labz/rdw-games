"""Static checks on the files only dev2 can run: firewall, units, sudoers, setup, wrappers, model setting."""

import os
import re
import subprocess
import unittest

from _load import HERE, config

CFG = config()


def read(rel):
    return (HERE / rel).read_text()


def directives(text):
    return [line.strip() for line in text.splitlines() if line.strip() and not line.strip().startswith("#")]


def tool_files():
    for path in sorted(HERE.rglob("*")):
        rel = path.relative_to(HERE)
        if path.is_file() and rel.parts[0] != "tests" and "__pycache__" not in rel.parts:
            yield rel



SANDBOX_KEYS = ("User=", "Group=", "PrivateNetwork=", "TemporaryFileSystem=", "ProtectSystem=",
                "PrivatePIDs=", "PrivateIPC=", "PrivateDevices=", "NoNewPrivileges=", "RestrictNamespaces=",
                "CapabilityBoundingSet=", "AmbientCapabilities=", "BindReadOnlyPaths=", "BindPaths=")

class FirewallTest(unittest.TestCase):
    def test_default_drop_for_hermes_w_no_accept_at_all(self):
        rules = directives(read("hermes-w.nft"))
        self.assertEqual([r for r in rules if r.endswith("accept") and "policy" not in r], [])
        self.assertEqual([r for r in rules if r.endswith("drop")], ['meta skuid "hermes-w" counter drop'])
        self.assertIn("table inet hermes_w {", rules)  # own table, IPv4 + IPv6
        self.assertNotIn("flush ruleset", read("hermes-w.nft"))

    def test_docs_say_nft_is_the_host_wall_not_the_job_wall(self):
        for rel in ("hermes-w.nft", "systemd/hermes-firewall.service"):
            text = read(rel)
            self.assertIn("host nftables rules don't", text.replace("\n#", ""), rel)
            self.assertNotIn("second wall", text, rel)
            self.assertNotIn("Every worker unit\n# Requires= this, so no job", text, rel)

    def test_no_install_time_network_at_all(self):
        # Round 4: Hermes is built off dev2, so no install step downloads anything there.
        self.assertFalse((HERE / "hermes-w-install.nft").exists())
        self.assertNotIn("nft -f \"$HERE/hermes-w-install.nft\"", read("setup-dev2.sh"))


class UnitTest(unittest.TestCase):
    def test_job_sandbox_dropin(self):
        d = directives(read("systemd/hermes-w-.service.d/10-sandbox.conf"))
        for want in ["User=hermes-w", "PrivateNetwork=yes", "RestrictAddressFamilies=AF_INET", "IPAddressDeny=any",
                     "IPAddressAllow=127.0.0.1", "PrivatePIDs=yes", "NoNewPrivileges=yes", "CapabilityBoundingSet=",
                     "ProtectSystem=strict", "ProtectHome=tmpfs", "SystemCallFilter=@system-service",
                     "ProtectProc=invisible", "MemoryMax=3G", "CPUQuota=200%", "TasksMax=64", "RuntimeMaxSec=20min",
                     "LimitCORE=0", "PrivateIPC=yes"]:
            self.assertIn(want, d)
        self.assertFalse([x for x in d if "AF_UNIX" in x or "AF_INET6" in x])  # no Unix or IPv6 sockets at all
        self.assertNotIn("PrivateTmp=yes", d)  # disk-backed; /tmp is a size-capped tmpfs instead
        tmpfs = next(x for x in d if x.startswith("TemporaryFileSystem=")).split("=", 1)[1].split()
        for hidden in ("/run", "/var/lib", "/opt", "/srv"):
            self.assertIn(hidden, tmpfs)  # host sockets, service state and other jobs' folders out of view
        self.assertIn("/etc:size=4M,mode=0755", tmpfs)  # /etc hidden, only an allow-list bound back
        self.assertIn("/tmp:size=256M,mode=1777", tmpfs)  # disk cap for /tmp
        binds = " ".join(x for x in d if x.startswith("BindReadOnlyPaths="))
        for path in ("/opt/hermes-w/hermes-agent", "/opt/hermes-dev2/bin", "/etc/hermes-dev2", "/etc/passwd", "/etc/ld.so.cache"):
            self.assertIn(path, binds)
        for secret in ("/etc/shadow", "/etc/hermes-proxy", "/etc/sudoers"):
            self.assertNotIn(secret + " ", binds + " ")
        hidden = next(x for x in d if x.startswith("InaccessiblePaths="))
        for path in ("-/etc/hermes-proxy", "-/var/log", "-/var/www", "-/var/snap", "-/var/backups"):
            self.assertIn(path, hidden)

    def test_job_unit(self):
        d = directives(read("systemd/hermes-w-job@.service"))
        for want in ["JoinsNamespaceOf=hermes-fwd@%i.service", "BindsTo=hermes-fwd@%i.service",
                     "Requires=hermes-firewall.service hermes-fwd@%i.service", "Wants=hermes-proxy.service",
                     "Requires=hermes-precheck@job-%i.service", "After=hermes-precheck@job-%i.service",
                     "RequiresMountsFor=/var/lib/hermes-jobs/work",
                     "BindPaths=/var/lib/hermes-jobs/work/%i",
                     "ExecStart=/opt/hermes-dev2/bin/hermes-job-run %i",
                     "OnSuccess=hermes-job-finish@%i.service", "OnFailure=hermes-job-finish@%i.service"]:
            self.assertIn(want, d)
        self.assertFalse([x for x in d if "hermes-unit-precheck" in x])
        self.assertFalse([x for x in d if x.startswith("ExecStopPost")])  # systemd 259 runs it inside the sandbox
        self.assertFalse([x for x in d if x.startswith("Condition")])  # a skipped unit would leak its folder
        self.assertFalse([x for x in d if x.startswith("Requires=") and "hermes-proxy" in x])  # a proxy restart must not stop jobs

    def test_work_area_is_a_capped_tmpfs(self):
        d = directives(read("systemd/var-lib-hermes\\x2djobs-work.mount"))
        self.assertIn("Where=/var/lib/hermes-jobs/work", d)
        self.assertIn("Type=tmpfs", d)
        opts = next(x for x in d if x.startswith("Options=")).split("=", 1)[1].split(",")
        self.assertIn("size=2G", opts)
        self.assertIn("mode=0711", opts)
        self.assertIn("uid=0", opts)

    def test_probe_unit_is_the_job_sandbox_with_its_own_forwarder(self):
        d = directives(read("systemd/hermes-w-probe@.service"))
        self.assertIn("JoinsNamespaceOf=hermes-fwd@probe-%i.service", d)
        self.assertIn("Requires=hermes-precheck@probe-%i.service", d)
        self.assertIn("After=hermes-precheck@probe-%i.service", d)
        self.assertFalse([x for x in d if "hermes-unit-precheck" in x])
        self.assertIn("ExecStart=/usr/bin/python3 -I /opt/hermes-dev2/bin/preflight_probe.py --probe %i /var/lib/hermes-jobs/probe/%i", d)
        names = os.listdir(HERE / "systemd")
        self.assertTrue({"hermes-w-job@.service", "hermes-w-probe@.service"} <= set(names))
        for other in ("hermes-proxy.service", "hermes-firewall.service", "hermes-watchdog@.service", "hermes-fwd@.service"):
            self.assertIn(other, names)
            self.assertFalse(other.startswith("hermes-w-"), other)  # the job drop-in must not hit these

    def test_forwarder_unit(self):
        d = directives(read("systemd/hermes-fwd@.service"))
        for want in ["User=hermes-w", "PrivateNetwork=yes", "RestrictAddressFamilies=AF_INET AF_UNIX", "PrivatePIDs=yes",
                     "PrivateIPC=yes", "BindReadOnlyPaths=/run/hermes-proxy /opt/hermes-dev2/bin /etc/hermes-dev2",
                     "BindReadOnlyPaths=/etc/passwd /etc/group /etc/nsswitch.conf /etc/hosts /etc/ld.so.cache /etc/ld.so.conf",
                     "StopWhenUnneeded=yes",
                     "Requires=hermes-precheck@fwd-%i.service", "After=hermes-precheck@fwd-%i.service",
                     "IPAddressDeny=any", "LimitCORE=0",
                     "Wants=hermes-proxy.service"]:
            self.assertIn(want, d)
        self.assertFalse([x for x in d if "hermes-unit-precheck" in x])
        tmpfs = next(x for x in d if x.startswith("TemporaryFileSystem="))
        for want in ("/run", "/etc:size=4M,mode=0755", "/dev/shm:size="):
            self.assertIn(want, tmpfs)  # the job's /etc allow-list, and its own /dev/shm
        self.assertIn("-/var/snap", next(x for x in d if x.startswith("InaccessiblePaths=")))
        self.assertIn("-/dev/mqueue", next(x for x in d if x.startswith("InaccessiblePaths=")))
        self.assertFalse([x for x in d if x.startswith(("Requires=", "BindsTo=")) and "hermes-proxy" in x])

    def test_precheck_unit_is_unsandboxed_and_oneshot(self):
        d = directives(read("systemd/hermes-precheck@.service"))
        self.assertIn("Type=oneshot", d)
        self.assertIn("RemainAfterExit=no", d)
        self.assertIn("ExecStart=/opt/hermes-dev2/sbin/hermes-unit-precheck %i", d)
        for key in SANDBOX_KEYS:
            self.assertFalse([x for x in d if x.startswith(key)], key)

    def test_finish_unit_is_unsandboxed_and_oneshot(self):
        d = directives(read("systemd/hermes-job-finish@.service"))
        self.assertIn("Type=oneshot", d)
        self.assertIn("RemainAfterExit=no", d)
        self.assertIn("ExecStart=/opt/hermes-dev2/bin/hermes-job-finish %i", d)
        for key in SANDBOX_KEYS:
            self.assertFalse([x for x in d if x.startswith(key)], key)

    def test_no_unit_runs_a_privileged_command_inside_a_sandbox(self):
        # systemd 259 runs "+"/"!" Exec commands inside the unit's mount and network
        # namespaces; root work goes in its own unsandboxed unit instead.
        for path in sorted((HERE / "systemd").rglob("*")):
            if path.is_file():
                for line in directives(path.read_text()):
                    self.assertNotRegex(line, r"^Exec\w+=[-@:]*[+!]", f"{path.name}: {line}")

    def test_workers_have_no_sandboxed_precheck(self):
        for rel in ("systemd/hermes-fwd@.service", "systemd/hermes-w-job@.service", "systemd/hermes-w-probe@.service"):
            self.assertNotIn("ExecStartPre=+", read(rel), rel)

    def test_proxy_unit(self):
        d = directives(read("systemd/hermes-proxy.service"))
        for want in ["LoadCredential=model.key:/etc/hermes-proxy/model.key", "User=hermes-proxy",
                     "SupplementaryGroups=hermes-sock", "RuntimeDirectory=hermes-proxy", "RuntimeDirectoryPreserve=yes",
                     "LimitCORE=0", "IPAddressAllow=127.0.0.1"]:
            self.assertIn(want, d)
        self.assertNotIn("SupplementaryGroups=hermes-w", d)

    def test_proxy_has_no_tcp_listener(self):
        src = read("bin/hermes_proxy.py")
        self.assertIn("socketserver.UnixStreamServer", src)
        self.assertNotIn("ThreadingHTTPServer", src)
        self.assertNotIn("TCPServer", src)
        self.assertNotIn("PROXY_PORT", src)
        self.assertIn('SOCKET_GROUP = "hermes-sock"', src)

    def test_runner_takes_model_and_endpoint_from_config(self):
        run = read("bin/hermes-job-run")
        for want in ["get MODEL", "get JOB_PROXY_URL", "--provider custom", "--toolsets none", "--safe-mode"]:
            self.assertIn(want, run)
        self.assertNotIn("8000", run)


class SudoersTest(unittest.TestCase):
    def test_exactly_two_wrappers_start_takes_no_args(self):
        d = directives(read("hermes-sub.sudoers"))
        grants = [x for x in d if x.startswith("hermes-sub ")]
        self.assertEqual(grants, ['hermes-sub ALL=(root) NOPASSWD: /opt/hermes-dev2/sbin/hermes-job-start "", /opt/hermes-dev2/sbin/hermes-job-stop'])
        joined = "\n".join(d)
        for bad in ("systemctl", "*", "ALL=(ALL", "SETENV", "env_keep"):
            self.assertNotIn(bad, joined)
        self.assertEqual([x for x in d if x.startswith("Defaults:")], ["Defaults:hermes-sub env_reset, !setenv"])
        self.assertNotIn("requiretty", joined)
        self.assertIn("!setenv", joined)

    def test_sudoers_check_is_pre_change_and_not_dry_run_wrapped(self):
        t = read("setup-dev2.sh")
        check = 'visudo -cf "$HERE/hermes-sub.sudoers"'
        self.assertIn(check, t)
        line = next(line.strip() for line in t.splitlines() if check in line)
        self.assertEqual(line, f"if ! {check} >&2; then")
        self.assertNotIn("run visudo", t)
        self.assertLess(t.index('hermes_bundle.py" --verify'), t.index(check))
        self.assertLess(t.index(check), t.index('say "2. users"'))

    def test_wrappers_live_under_opt_never_usr_local(self):
        for rel in tool_files():
            self.assertNotIn("/usr/local/sbin", (HERE / rel).read_text(errors="replace"), rel)

    def test_root_tools_call_systemctl_by_absolute_path(self):
        for rel in ("sbin/hermes-job-start", "sbin/hermes-job-stop", "bin/hermes_jobs_root.py", "bin/watchdog.py", "bin/dispatch.py"):
            text = read(rel)
            self.assertNotRegex(text, r'(?<![/\w])["\[]systemctl["\s]', rel)
            self.assertNotRegex(text, r"(?m)^\s*(exec\s+)?systemctl\b", rel)

    def test_stop_wrapper_stops_a_starting_job_too(self):
        text = read("sbin/hermes-job-stop")
        self.assertIn("active|activating|reloading)", text)

    def test_wrappers_validate_ids(self):
        for w in ("sbin/hermes-job-stop", "bin/hermes-job-run"):
            self.assertIn("^j-[a-z0-9]{8,62}$", read(w), w)
        for bad in ["../../etc", "x", "preflight", "j-UPPERCASE00", "j-0123456789abcdef extra"]:
            p = subprocess.run(["bash", str(HERE / "sbin/hermes-job-stop"), *bad.split()], capture_output=True, text=True)
            self.assertEqual(p.returncode, 2, bad)

    def test_python_tools_use_isolated_system_python(self):
        for rel in tool_files():
            first = (HERE / rel).read_text(errors="replace").splitlines()[:1]
            if rel.parts[0] == "mac":
                continue  # runs on the Mac, not dev2: the Mac's python3, whatever PATH gives
            if first and first[0].startswith("#!") and "python" in first[0]:
                self.assertEqual(first[0], "#!/usr/bin/python3 -I", rel)


class SetupTest(unittest.TestCase):
    text = read("setup-dev2.sh")

    def test_no_key_material_and_hidden_key_prompt(self):
        self.assertNotRegex(self.text, r"sk-[A-Za-z0-9]{8,}")
        self.assertNotRegex(self.text, r"Bearer [A-Za-z0-9]")
        self.assertIn("read -rsp", self.text)
        self.assertIn('key for $MODEL', self.text)
        self.assertIn("chmod 0400 /etc/hermes-proxy/model.key", self.text)

    def test_refuses_on_a_mac(self):
        p = subprocess.run(["bash", str(HERE / "setup-dev2.sh"), "--dry-run", "--mac-key", "ssh-ed25519 AAAAFAKE test"],
                           capture_output=True, text=True)
        self.assertEqual(p.returncode, 2)
        self.assertIn("not Darwin", p.stderr)

    def test_dry_run_order_and_pin(self):
        t = self.text
        self.assertIn('run() { if ((DRY)); then', t)
        self.assertIn("PIN=1ac3f97fbe0958aa2743c0c26202b20b3b4e760e", t)
        self.assertNotRegex(t, r"usermod[^\n]*-aG[^\n]*docker")
        # The bundle is checked before anything on dev2 changes, and installed before the firewall.
        order = [t.index(x) for x in ('hermes_bundle.py" --verify', 'say "2. users"', 'hermes_bundle.py" --install',
                                      "enable --now hermes-firewall.service")]
        self.assertEqual(order, sorted(order))

    def test_no_downloaded_build_code_runs_on_dev2(self):
        t = self.text
        for gone in ("git clone", "uv sync", "--uv", "sandboxed", "hermes_w_install", "pkill", "UV_PYTHON_INSTALL_DIR",
                     "status --porcelain", "core.fsmonitor"):
            self.assertNotIn(gone, t, gone)
        self.assertIn("--bundle) BUNDLE=", t)
        self.assertIn('BUNDLE_SHA256=$(conf BUNDLE_SHA256) BUNDLE_ARCH=$(conf BUNDLE_ARCH)', t)
        self.assertIn("refusing: $jobs_now job(s) running; install the new bundle when they finish", t)
        self.assertIn("/etc/hermes-dev2/installed-bundle.sha256", t)
        self.assertIn("! -uid 0 -o -perm /0022 -o -perm /6000", t)  # all root-owned, no group/world write, no setuid
        self.assertIn("if sudo -u hermes-w test -w /opt/hermes-w/hermes-agent", t)
        verify = t[t.index('--unit="hermes-w-verify-$$"') - 80:]
        self.assertIn("--uid=hermes-w", verify[:400])
        self.assertIn("/opt/hermes-w/hermes-agent/.venv/bin/hermes --version", verify[:600])
        self.assertLess(t.index('install -o root -g root -m 0644 "$HERE/systemd/hermes-w-.service.d/10-sandbox.conf"'),
                        t.index('--unit="hermes-w-verify-$$"'))  # the sandbox drop-in is in place first

    def test_installed_dispatch_has_no_test_hook(self):
        t = self.text
        self.assertIn('--strip-test-hook "$HERE/bin/dispatch.py"', t)
        self.assertIn("refusing: the test hook is still in the installed dispatch", t)
        self.assertNotIn('"$HERE/bin/dispatch.py" /opt/hermes-sub/bin/dispatch', t)  # never the raw copy

    def test_version_gate_and_model_bind(self):
        t = self.text
        self.assertIn("((sdv >= 257))", t)
        self.assertIn("refusing: systemd $sdv is older than 257", t)
        self.assertNotIn("((sdv >= 247))", t)
        self.assertNotIn("20-private-pids.conf\" /etc", t)
        self.assertIn("upstream_bind_problem", t)

    def test_ownership_fixes(self):
        self.assertIn("mkuser hermes-proxy /nonexistent /usr/sbin/nologin no", self.text)
        self.assertIn("groupadd --system hermes-sock", self.text)
        self.assertIn('usermod -aG hermes-sock "$u"', self.text)
        self.assertIn("stage authorized_keys", self.text)
        self.assertIn("install -d -o root -g hermes-sub -m 0750 /var/lib/hermes-jobs/outbox", self.text)
        self.assertNotIn("-o hermes-sub -g hermes-sub", self.text)  # hermes-sub owns nothing root later touches
        self.assertIn("must be a root-owned directory without group/world write", self.text)
        self.assertIn("mkuser hermes-w /opt/hermes-w /usr/sbin/nologin no", self.text)  # no home of its own
        self.assertIn("mkuser hermes-stranger /nonexistent /usr/sbin/nologin no", self.text)
        self.assertIn("for u in hermes-w hermes-stranger; do", self.text)
        self.assertIn("/var/lib/hermes-jobs /opt/hermes-w", self.text)  # root-owned 0755

    def test_generated_files_use_staging_and_checked_installs(self):
        paths = [HERE / "setup-dev2.sh", HERE / "bin" / "preflight.sh"] + [p for p in (HERE / "sbin").glob("*") if p.is_file()]
        for path in paths:
            source = path.read_text(errors="replace")
            self.assertNotIn("/dev/stdin", source, path)
            self.assertNotIn("/dev/fd", source, path)
            self.assertNotRegex(source, r"\|\s*install\b", path)
        for name in ("installed-bundle.sha256", "dispatch", "proxy.conf", "authorized_keys"):
            self.assertIn(f'stage {name}', self.text)
            self.assertRegex(self.text, rf"install_staged {re.escape(name)} \S+ 0[67][54][54]\n", name)
        # The one install of a staged file is followed by the content + owner/mode check.
        helper = self.text[self.text.index("install_staged() {"):]
        install = helper.index('install -o root -g root -m "$mode" "$STAGE/$name" "$dest"')
        self.assertGreater(helper.find('cmp -s "$STAGE/$name" "$dest"', install), install)
        self.assertIn('[[ $actual != "root root ${mode#0}" ]]', helper)
        self.assertIn("chmod 0700 \"$STAGE\"", self.text)
        self.assertIn("trap 'rm -rf -- \"$STAGE\"' EXIT", self.text)

    def test_checks_uv_sshd_upstream_and_mount(self):
        for want in ["--bundle)", "sshd -T", "allowusers", "UPSTREAM_UID",
                     "--upstream-user", "systemd-escape -p --suffix=mount /var/lib/hermes-jobs/work",
                     'enable --now "$workmount"']:
            self.assertIn(want, self.text)

    def test_bash_syntax(self):
        for f in ("setup-dev2.sh", "bin/preflight.sh", "bin/hermes-job-run", "sbin/hermes-job-stop"):
            self.assertEqual(subprocess.run(["bash", "-n", str(HERE / f)]).returncode, 0, f)


class ModelSettingTest(unittest.TestCase):
    def test_model_is_one_setting(self):
        self.assertEqual(CFG["MODEL"], "qwen3.8-flash-next-iq2_xs")
        ids = {CFG["MODEL"], "llama-moe3"}
        for rel in tool_files():
            if str(rel) == "config.conf":
                continue
            text = (HERE / rel).read_text(errors="replace")
            for model_id in ids:
                self.assertNotIn(model_id, text, f"{rel} names a model; read MODEL from config.conf instead")

    def test_every_tool_reads_it(self):
        for rel in ("bin/hermes_proxy.py", "bin/dispatch.py", "sbin/hermes-job-start", "bin/watchdog.py",
                    "bin/preflight_probe.py", "mac/bin/hermes", "bin/hermes-job-run", "setup-dev2.sh"):
            self.assertRegex(read(rel), r"MODEL", rel)


class WorkflowTest(unittest.TestCase):
    """The hermes-bundle CI workflow: builds the pinned commit off dev2, locked and
    no-build, with outputs and actions pinned the way RUNBOOK.md promises."""

    @classmethod
    def setUpClass(cls):
        cls.path = HERE.parent.parent.parent / ".github" / "workflows" / "hermes-bundle.yml"
        cls.text = cls.path.read_text()

    def test_file_exists_at_the_documented_path(self):
        self.assertTrue(self.path.exists(), self.path)

    def test_pinned_to_the_same_commit_as_setup(self):
        pin = "1ac3f97fbe0958aa2743c0c26202b20b3b4e760e"
        self.assertIn(f"HERMES_PIN: {pin}", self.text)
        self.assertIn(pin, (HERE / "setup-dev2.sh").read_text())  # the two pins are changed together
        self.assertIn('test "$(git -C "$src" rev-parse HEAD)" = "$HERMES_PIN"', self.text)

    def test_uv_sync_locked_no_build(self):
        self.assertIn("uv sync --locked --no-build", self.text)
        self.assertNotIn("uv sync --locked --quiet", self.text)  # round-3 style (builds sdists) is gone here

    def test_sync_keeps_the_pinned_project_uv_config(self):
        # UV_NO_CONFIG drops the pinned pyproject's [tool.uv] (exclude-newer,
        # overrides): --locked then re-resolves and fails (run 38612709654).
        self.assertNotIn("UV_NO_CONFIG:", self.text)

    def test_outputs_bundle_and_sha256(self):
        self.assertIn("sha256sum", self.text)
        self.assertRegex(self.text, r"\.sha256")
        upload = self.text[self.text.index("uses: actions/upload-artifact"):]
        self.assertIn("${{ runner.temp }}/${{ env.BUNDLE_NAME }}", upload[:400])
        self.assertIn("${{ runner.temp }}/${{ env.BUNDLE_NAME }}.sha256", upload[:400])
        self.assertIn("if-no-files-found: error", upload[:400])

    def test_every_action_is_pinned_by_a_40_hex_sha(self):
        uses = re.findall(r"^\s*(?:-\s*)?uses:\s*(\S+)", self.text, re.MULTILINE)
        self.assertTrue(uses)  # the workflow does use at least one action
        for ref in uses:
            self.assertRegex(ref, r"@[0-9a-f]{40}(\s*#.*)?$", ref)

    def test_minimal_permissions(self):
        m = re.search(r"^permissions:\n((?:^ {2}.*\n)+)", self.text, re.MULTILINE)
        self.assertIsNotNone(m, "no top-level permissions: block")
        body = m.group(1)
        self.assertEqual(body.strip(), "contents: read")
        self.assertNotIn("write-all", self.text)
        self.assertNotIn("id-token", self.text)

    def test_manual_trigger_only(self):
        on = self.text[self.text.index("\non:"):self.text.index("\npermissions:")]
        self.assertIn("workflow_dispatch", on)
        for bad in ("push:", "pull_request:", "schedule:"):
            self.assertNotIn(bad, on)

    def test_refuses_anything_but_x86_64(self):
        self.assertIn('test "$(uname -m)" = x86_64', self.text)

    def test_no_git_directory_in_the_bundle(self):
        self.assertIn('test ! -e "$DEST/.git"', self.text)

    def test_checks_out_this_repo_first_without_persisting_credentials(self):
        checkout = self.text[self.text.index("uses: actions/checkout"):]
        self.assertIn("persist-credentials: false", checkout[:200])
        self.assertLess(self.text.index("uses: actions/checkout"), self.text.index("Refuse anything but x86_64"))

    def test_pypi_only_guard_runs_after_sync_and_before_the_tarball(self):
        sync = self.text.index("uv sync --locked --no-build (every dependency must be a prebuilt wheel)")
        guard = self.text.index("Every installed package came from pypi.org (only hermes-agent itself is local)")
        tarball = self.text.index("Deterministic tarball and its sha256")
        self.assertLess(sync, guard)
        self.assertLess(guard, tarball)
        step = self.text[guard:tarball]
        self.assertIn("direct_url.json", (HERE / "bin" / "bundle_sources_check.py").read_text())
        self.assertIn("pypi.org/simple", (HERE / "bin" / "bundle_sources_check.py").read_text())
        self.assertIn("bundle_sources_check.py", step)
        self.assertIn('"$DEST/.venv/lib/python3.14/site-packages" "$DEST/uv.lock" "$DEST"', step)

    def test_build_timestamp_dropped_before_the_tarball(self):
        unpacker = self.text.index("Nothing a careful unpacker would refuse")
        tarball = self.text.index("Deterministic tarball and its sha256")
        step = self.text[unpacker:tarball]
        self.assertIn("drop_uv_build_timestamps.py", step)
        self.assertIn("uv_cache.json", step)
        self.assertLess(step.index("drop_uv_build_timestamps.py"), step.index("rm -rf -- .pytest_cache"))


class RunbookTest(unittest.TestCase):
    def test_uninstall_is_complete(self):
        text = read("RUNBOOK.md")
        uninstall = text[text.index("## Uninstall"):]
        for want in ["reset-failed", "hermes-fwd@.service", "/opt/hermes-dev2", "/etc/sudoers.d/hermes-sub",
                     "userdel hermes-w", "/var/lib/hermes-jobs", "/etc/hermes-proxy", "nft delete table inet hermes_w",
                     "pkill -KILL -u hermes-w", "groupdel hermes-sock", "x2djobs-work.mount",
                     "/opt/hermes-w", "userdel hermes-stranger", "hermes-watchdog@.service", "hermes-pf-*",
                     "hermes-precheck@*"]:
            self.assertIn(want, uninstall)
        self.assertLess(uninstall.index("pkill -KILL -u hermes-w"), uninstall.index("userdel hermes-w"))


if __name__ == "__main__":
    unittest.main()

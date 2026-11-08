#!/bin/bash
# usage: repro.sh old|new  — real (non-dry) setup-dev2.sh in ubuntu:resolute under sudo-rs, dev2-only bits stubbed
set -euo pipefail
cd "$(dirname "$0")"  # expects old/ and new/ beside it: git archive <ref> coordination/tools/hermes-dev2 | tar x -C old
docker run -i --rm -v "$PWD/$1/coordination/tools/hermes-dev2:/h:ro" ubuntu:resolute bash -s <<'C'
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null; apt-get install -y -qq python3-minimal sudo-rs=0.2.13-0ubuntu1.2 util-linux >/dev/null
chmod 0440 /etc/sudoers
cp -a /h /home-h; chmod -R a+rX /home-h
S=/stubs; mkdir -p $S
st(){ printf '#!/bin/sh\n%s\n' "$2" > $S/$1; chmod 755 $S/$1; }
st systemctl '[ "${1:-}" = "--version" ] && echo "systemd 257"; exit 0'
for t in nft systemd-run sshd ss; do st $t 'exit 0'; done
st findmnt 'echo tmpfs'
st systemd-escape 'echo var-lib-hermes-work.mount'
st python3 'if [ "${2:-}" = "-" ]; then echo none; exit 0; fi
case "$*" in *hermes_bundle.py*--verify*) exit 0;; *hermes_bundle.py*--install*) mkdir -p /opt/hermes-w/hermes-agent/.venv/bin; printf "#!/bin/sh\necho hermes 0\n" > /opt/hermes-w/hermes-agent/.venv/bin/hermes; chmod 755 /opt/hermes-w/hermes-agent/.venv/bin/hermes; exit 0;; esac
exec /usr/bin/python3 "$@"'
sed -i "s|^PATH=/usr/sbin:/usr/bin:/sbin:/bin$|PATH=$S:/usr/sbin:/usr/bin:/sbin:/bin|" /home-h/setup-dev2.sh
useradd -m admin; printf 'admin ALL=(ALL) NOPASSWD: ALL\n' > /etc/sudoers.d/admin; chmod 0440 /etc/sudoers.d/admin
: > /tmp/bundle.tar.gz; chmod 644 /tmp/bundle.tar.gz
# Like dev2: a person types `sudo ./setup-dev2.sh ...` in a terminal (pty via script(1)).
runuser -u admin -- script -qec "sudo bash /home-h/setup-dev2.sh --bundle /tmp/bundle.tar.gz --mac-key 'ssh-ed25519 AAAAFAKE test' --upstream-user root </dev/null; echo SETUP_RC=\$?" /dev/null </dev/null 2>&1 | tr -d '\r' | grep -E '^== |refusing|install:|Error|rror:|SETUP_RC|dry-run|No such' | head -40
echo "dispatch: $(stat -c '%U %G %a %s' /opt/hermes-sub/bin/dispatch 2>&1)"
C

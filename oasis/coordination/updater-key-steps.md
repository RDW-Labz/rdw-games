# Tauri updater signing key — Braden-only steps

No signing key was generated or read for this handoff. Braden must perform the
following on the Windows release machine, from `repos/desktop-app`.

1. Create a private, user-only destination and generate the keypair. The
   password is entered at Tauri's hidden prompt; do not put it in the command
   line or a shell history.

   ```powershell
   New-Item -ItemType Directory -Force "$env:USERPROFILE\.tauri" | Out-Null
   npx tauri signer generate --write-keys "$env:USERPROFILE\.tauri\oasis-rig.key"
   ```

   `--write-keys` (`-w`) writes the private key to that path. The command prints
   the public key; it is safe to copy that public value. Do not paste the
   private key into a terminal command, log, ticket, or repository.

2. Store the private-key value in the existing agent-core OS-keychain CLI. Open
   the generated file locally, copy its contents, then run this from
   `repos/desktop-app` and paste only at the hidden `Value (hidden):` prompt:

   ```powershell
   uv run --project ..\agent-core secrets set updater.tauri.private_key
   ```

   Store the signer password separately through the same hidden prompt:

   ```powershell
   uv run --project ..\agent-core secrets set updater.tauri.private_key_password
   ```

   The CLI requires an interactive TTY and rejects piped input, so do not use
   `Get-Content`, redirection, or an environment variable to supply the value.
   It prints only `Stored in the OS keychain.` on success. Keep the generated
   file protected and remove it through the normal secure file-removal process
   after confirming the keychain entry; never commit it.

3. Replace the placeholder at
   `repos/desktop-app/src-tauri/tauri.conf.json` →
   `plugins.updater.pubkey` with the public key printed in step 1. Leave the
   private key out of this file. Verify that the value is no longer the
   `PLACEHOLDER_...` string before a signed release.

## Verified evidence

- `repos/desktop-app/node_modules/.bin/tauri signer generate --help` (installed
  CLI, Tauri CLI 2.x) lists `-w, --write-keys <WRITE_KEYS>`, `-p, --password`,
  `-f, --force`, and `--ci`; this guide uses the interactive path and does not
  pass a password on the command line.
- `repos/agent-core/pyproject.toml` exposes `secrets = "anorak.secrets_cli:main"`.
  `repos/agent-core/src/anorak/secrets_cli.py` implements `secrets set NAME`,
  calls `getpass.getpass("Value (hidden): ")`, rejects non-TTY stdin, and never
  formats operation exceptions.
- The current updater destination is
  `repos/desktop-app/src-tauri/tauri.conf.json` at
  `plugins.updater.pubkey`; it still contains the placeholder until Braden
  supplies the public key.

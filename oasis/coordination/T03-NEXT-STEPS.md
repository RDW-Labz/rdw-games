# T03 — the remaining clicks

Both registrations are created. Microsoft has seven delegated permissions saved.
Google has its four scopes saved, Gmail/Calendar/Drive APIs enabled, and your
company account listed as the only tester. Google stays in Testing.

## 1. Store three IDs privately

**Completed:** all three stored IDs passed local format validation. Braden also
stored `oauth.google.client_secret` and authorized the probe to read it through T02.
One authorized rerun included it only in Google's token request: Microsoft passed;
Google returned `invalid_client` on the one authorized attempt under the revised
error-field rule. Exit 1. No value or raw response was logged. T03 remains incomplete
and its PR remains draft. No further live attempt was made this turn.

The entry instructions below are reference only; no replacement ID is requested.

Open Terminal. Run this first:

```sh
cd /Users/prime/Documents/repos-projects/oasis/repos/agent-core
```

Run each command separately. After it asks for a value, copy the matching value
from the browser, paste into Terminal, and press Enter. Nothing appears while you
paste; that is expected. Do not paste any IDs into chat.

1. In the Microsoft OASIS Overview tab, copy **Application (client) ID**:

   ```sh
   .venv/bin/secrets set oauth.microsoft.client_id
   ```

2. From the same tab, copy **Directory (tenant) ID**:

   ```sh
   .venv/bin/secrets set oauth.microsoft.tenant_id
   ```

3. In Google's **Clients** page, find **OASIS desktop** and copy its **Client ID**:

   ```sh
   .venv/bin/secrets set oauth.google.client_id
   ```

4. Google client secret (already stored and authorized):

   ```sh
   .venv/bin/secrets set oauth.google.client_secret
   ```

No credential JSON download is needed. Never paste values into chat. Real sign-in
and authenticated token exchange remain in T11.

Browser safety rules blocked Codex from controlling Terminal, so this entry step
requires you. The commands use the existing T02 private-entry helper.

## 2. Microsoft administrator (T03b)

Your current Microsoft account's **Grant admin consent for Cluer Holdings** button
is disabled. Sign into Microsoft Entra with an authorized Cluer Holdings administrator
account, then open **App registrations → OASIS → API permissions**.
Tell Codex **Admin account ready**. Codex can prepare the consent step and request
the browser's required action-time approval. Do not change account roles as a workaround.

## 3. Google verification (T03b)

The proposed public OASIS home and privacy pages are not published. Existing company
tools remain private. Google verification is not submitted: it also needs a genuine
consent-and-scope demonstration. T03b blocks T11 Gmail connect, not T03. Resolve
any dependency on unfinished T11 work with Braden during T03b; no sign-in
demonstration has been fabricated.

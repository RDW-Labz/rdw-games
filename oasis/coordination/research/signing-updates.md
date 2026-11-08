# Signing and updates for OASIS (2026-09-28)

## 1. Apple (macOS arm64)

- Apple Developer Program: **$99/year**, same price for Individual or Organization. Individual enrolls in days (Apple ID, card, photo ID). Organization needs a **D-U-N-S number** (free to get, but lookup/verification often takes **1-3 weeks**) plus a phone verification that the legal entity exists and that the enroller can bind it. Org account is what lets the app publish under "Cluer Holdings" instead of a personal name. [Apple: Program enrollment](https://developer.apple.com/help/account/membership/program-enrollment/), [Apple: Programs](https://developer.apple.com/programs/) — read 2026-09-28.
- Certificate needed: **Developer ID Application** (for apps distributed outside the Mac App Store). Only the account's "Account Holder" role can create it. [Tauri: macOS signing](https://v2.tauri.app/distribute/sign/macos/) — read 2026-09-28.
- Notarization via `notarytool`, two auth options:
  - **Apple ID + app-specific password** — quick to set up, but the password is tied to one person and must be rotated on team changes.
  - **App Store Connect API key** (.p8 + key id + issuer id) — no per-person password, centrally rotatable, works headlessly in CI. Recommended for GitHub Actions.
  [Tauri: macOS signing](https://v2.tauri.app/distribute/sign/macos/), [Apple Developer Forums](https://developer.apple.com/forums/topics/code-signing-topic/code-signing-topic-notarization) — read 2026-09-28.
- **Stapling**: after notarization passes, `xcrun stapler staple` attaches the ticket to the .app so Gatekeeper can check it offline; without it Gatekeeper phones Apple on first launch.
- **Hardened runtime** (`--options runtime`) plus a secure timestamp is required or the Notary Service rejects the build outright. A Tauri app (WKWebView-based) commonly needs entitlements `com.apple.security.cs.allow-jit` (for the webview's JS engine) and, if it loads any unsigned dylib/plugin, `com.apple.security.cs.disable-library-validation`. [Apple: Hardened Runtime](https://developer.apple.com/documentation/security/hardened-runtime) — read 2026-09-28.
- **Notarization time**: automated service, typically finishes in **a few minutes** (often under 15). Forum reports occasionally show multi-hour or stuck submissions during Apple-side incidents — don't plan a release around instant turnaround. [Apple Developer Forums](https://developer.apple.com/forums/thread/813586) — read 2026-09-28.

## 2. Windows code signing

- Since **June 1, 2023** the CA/Browser Forum requires all code-signing private keys (OV and EV alike) to live on a hardware token or HSM (FIPS 140-2 Level 2+) — a plain downloadable .pfx cert is no longer issued for new orders.
- **OV vs EV**: EV does deeper legal-entity + phone vetting and costs more, but since Microsoft removed EV's special SmartScreen treatment (Feb 2024), **OV and EV now build SmartScreen reputation the same way** — by clean download volume of that exact file/publisher over time. EV is still required for kernel-mode driver signing, not needed here. From **Feb 27, 2026** max cert validity drops to 459 days for all vendors.
- Cost/lead time per year (approximate, street prices vary by reseller):

| Item | Cost/yr | Lead time | Source |
|---|---|---|---|
| Sectigo OV | ~$210-230 | 1-3 business days | [Sectigo](https://www.sectigo.com/ssl-certificates-tls/code-signing) |
| Sectigo EV | ~$450 | 3-10 business days | [SSL Insights](https://sslinsights.com/best-code-signing-certificate-providers/) |
| DigiCert OV | ~$400 | 1-3 business days | [Certera](https://certera.com/code-signing/digicert-code-signing-certificate) |
| DigiCert EV | ~$560-580 | 3-10 business days | [SignMyCode](https://signmycode.com/digicert-ev-code-signing) |
| SSL.com OV | lower than DigiCert | 1-3 business days | [SSL.com](https://www.ssl.com/products/software-integrity/code-signing/) |
| SSL.com EV | $299-499 (cheapest EV) | 3-10 business days | [SSL.com EV](https://www.ssl.com/products/software-integrity/code-signing/ev/) |
| GlobalSign | ~€249/yr | 1-3 business days (OV) | [Vendr](https://www.vendr.com/marketplace/globalsign) |
| Certum Cloud OV | ~$108-116/yr | 1-3 business days | [SSLmentor](https://www.sslmentor.com/certum/certumcodecloud) |
| Certum Cloud EV | ~$226/yr | 3-10 business days | [SSLmentor](https://www.sslmentor.com/certum/certumcodecloudev) |
| Microsoft Trusted Signing / Azure Artifact Signing | $9.99/mo for 5,000 signs, +$0.005/extra | days, but only if eligible (see below) | [Azure pricing](https://azure.microsoft.com/en-us/products/artifact-signing), [Artifact Signing FAQ](https://learn.microsoft.com/en-us/azure/artifact-signing/faq) |

Read 2026-09-28.

- **Trusted Signing / Azure Artifact Signing eligibility**: business must be in the **US, Canada, EU, or UK**, and organizations need a **verifiable business history of 3+ years** (no documented exception path for younger companies); individuals can instead verify with Microsoft Authenticator + Verified ID (AU10TIX face/ID check). It **never issues EV certs**. [Microsoft Q&A: 3-year rule](https://learn.microsoft.com/en-us/answers/questions/2261318/is-there-any-exception-process-for-the-azure-trust) — read 2026-09-28.
- **Works in GitHub Actions without a physical token**: Azure Artifact Signing (built for cloud/CI use), DigiCert KeyLocker, SSL.com eSigner, Sectigo-on-Google-Cloud-KMS, and Certum SimplySign all offer cloud HSM signing reachable from a hosted runner. A physical USB token cannot be plugged into a GitHub-hosted runner; it would need a self-hosted runner with the token attached. [Forelens](https://forelens.com/blog/github-actions-code-signing-with-azure-key-vault-hsm-rbac-oidc-and-managed-identity/), [dev.to](https://dev.to/katz/building-a-cost-effective-windows-code-signing-pipeline-sectigo-google-cloud-kms-on-github-2ghf) — read 2026-09-28.

## 3. Tauri 2 updater

- The updater plugin has **its own signing keypair**, separate from Apple/Windows code-signing certs. Generate with `tauri signer generate` (minisign-format key). The private key + its password must be passed as env vars (`TAURI_SIGNING_PRIVATE_KEY`, `..._PASSWORD`) at build time — **not** via a `.env` file, and never committed. [Tauri: Updater plugin](https://v2.tauri.app/plugin/updater/) — read 2026-09-28.
- Build with `"createUpdaterArtifacts": true`. This produces, per platform, an update archive plus a `.sig` file: macOS `app.tar.gz`, Windows NSIS/MSI installer, Linux AppImage.
- Endpoint: either a **static `latest.json`** (version, notes, pub_date, per-platform url+signature) hosted anywhere, including a GitHub Releases URL like `.../releases/latest/download/latest.json`; or a **dynamic server** that answers `204` (no update) or `200` with the same JSON shape, supporting `{{current_version}}`, `{{target}}`, `{{arch}}` template variables. [Tauri updater docs](https://github.com/tauri-apps/tauri-docs/blob/v2/src/content/docs/plugin/updater.mdx) — read 2026-09-28.
- On macOS, the updater downloads and Tauri-signature-checks the `.app.tar.gz`, then swaps it in; the app inside **still needs its own Apple notarization/hardened-runtime signature** for Gatekeeper — Tauri's signature proves the update payload wasn't tampered with, it does not satisfy Gatekeeper on its own.
- On Windows, the updater runs the signed NSIS/MSI installer silently; that installer still needs the OS Authenticode signature (from section 2) or SmartScreen will interfere at install time.
- **Lost key**: if the updater private key is lost, you cannot sign new updates that the public key baked into already-shipped binaries will accept — existing installs silently stop auto-updating. Recovery means shipping a new public key and asking users to reinstall by hand. Back the key up before the first signed release.

## 4. What Braden must buy or create, in order

| # | Item | Cost | Lead time |
|---|---|---|---|
| 1 | Apple Developer Program, Organization | $99/yr | 1-3 weeks (D-U-N-S + verification) |
| 2 | Windows signing method (pick one, see Catches) | $0-450/yr | same day to 10 business days |
| 3 | Tauri updater keypair | free | minutes |
| 4 | GitHub Actions secrets (Apple API key, Windows signing creds, updater key) | free | minutes, after 1-3 exist |

## Catches

- If Cluer Holdings has no D-U-N-S number yet, request one at dnb.com before enrolling as an Organization — this is the longest lead time in the whole plan.
- Trusted Signing/Azure Artifact Signing needs a **3-year-old business**; if Cluer Holdings is younger, that path is blocked and a CA vendor OV cert (SSL.com/Sectigo/Certum with cloud HSM) is the fallback — check company age before picking a Windows signing vendor.
- The June-2023 CA/B rule means no vendor sells a plain downloadable Windows cert anymore; a physical USB token cannot be used from GitHub-hosted runners — must choose a cloud-HSM signing product from the vendor, not the basic token SKU.
- Hardened runtime + notarization is mandatory, not optional — an unsigned/unnotarized Tauri build simply refuses to launch on any other Mac via Gatekeeper, even for internal testing.
- Losing the Tauri updater private key silently breaks auto-update for every previously shipped install — generate and back it up (e.g., password manager) before the very first signed release, not after.
- EV buys no SmartScreen advantage since Feb 2024 — don't pay the EV premium expecting faster trust; OV plus cloud HSM is enough.
- New Windows publishers will still see SmartScreen "unknown publisher" warnings for a while after the first signed release regardless of cert type; reputation only builds from real download volume over time.

## Checklist for Braden

1. Get a D-U-N-S number for Cluer Holdings if none exists (free, dnb.com) — 1-3 weeks lead time, start first.
2. Enroll in the Apple Developer Program as an Organization — $99/yr, finishes once D-U-N-S verification clears.
3. Check Cluer Holdings' business age: if 3+ years, create an Azure Artifact Signing account (~$10-15/mo); if younger, buy an OV code-signing certificate with cloud HSM from SSL.com, Sectigo, or Certum (~$110-400/yr) — 1-3 business days.
4. In Apple Developer account, create an App Store Connect API key (.p8) for CI notarization — a few minutes once step 2 is done.
5. Generate the Tauri updater signing keypair locally (`tauri signer generate`) and store the private key + password somewhere durable (password manager) before any signed release — minutes, do this before step 6.
6. Add all of the above as GitHub Actions secrets (Apple API key/issuer/team ID, Windows signing credentials, Tauri updater private key/password) — minutes, once 1-5 exist.

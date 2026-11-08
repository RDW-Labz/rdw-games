# Subdomain Takeover: `wixdemo.xola.com` — Dangling CNAME to unclaimed Wix edge

**Program:** Xola Vulnerability Disclosure Program — https://www.xola.com/vdp (policy last updated 2024-05-28)
**Official channel:** security@xola.com
**Asset:** `wixdemo.xola.com` (and `www.wixdemo.xola.com`)
**Bug class:** Subdomain takeover (dangling DNS record → unclaimed third-party hosting)
**Severity:** Medium — CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N (6.1)
**Researcher:** Michael Cluer
**Date found:** 2026-11-01

---

## 1. Summary

`wixdemo.xola.com` is a Xola-owned DNS record in the `xola.com` zone (Route 53) that is
CNAMEd to Wix's hosting edge (`www66.wixdns.net`). No Wix site is attached to that record any
more, so the host resolves to a Wix edge node that answers every request with Wix's
**"Reconnect Your Domain — This domain isn't connected to a site"** error page
(`errorCode: ConnectYourDomain`, HTTP 404).

That state — a DNS record pointing at a Wix edge with no site bound to it — is the documented
fingerprint for a claimable Wix domain. A Wix account can add `wixdemo.xola.com` as a custom
domain; Wix validates ownership purely by DNS, and the CNAME it would ask for is already in
place. The claimant's site is then served on a host inside `xola.com`, with a Wix-issued,
publicly trusted TLS certificate for `wixdemo.xola.com` / `www.wixdemo.xola.com` (already issued
today — see evidence 01).

Result: an attacker can serve arbitrary content — e.g. a Xola-branded credential-harvesting
page — from `https://wixdemo.xola.com`, a URL that looks entirely legitimate and inherits
`xola.com`'s brand and any `*.xola.com` trust decisions.

## 2. Steps to reproduce

1. Resolve the record and walk the chain:

   ```console
   $ dig +noall +answer wixdemo.xola.com CNAME
   wixdemo.xola.com.            196  IN  CNAME  www66.wixdns.net.
   www66.wixdns.net.            214  IN  CNAME  cdn1.wixdns.net.
   cdn1.wixdns.net.             214  IN  CNAME  td-ccm-neg-87-45.wixdns.net.
   td-ccm-neg-87-45.wixdns.net. 7114 IN  A      34.149.87.45
   ```

   `wixdemo` lives in the Xola-controlled `xola.com` zone (`NS: ns-1861.awsdns-40.co.uk,
   ns-3.awsdns-00.com, ns-956.awsdns-55.net, ns-1200.awsdns-22.org` — Route 53).

2. Request the host:

   ```console
   $ curl -sSI https://wixdemo.xola.com/
   HTTP/2 404
   content-type: text/html; charset=utf-8
   server: Pepyaka
   x-wix-request-id: 1793559419.582614317511486
   content-length: 2356
   ```

3. Open `https://wixdemo.xola.com/` in a browser. The page renders:

   > **Reconnect Your Domain | Wix.com**
   > This domain isn't connected to a site

   and the page's inline state block contains the vulnerable-state marker:

   ```js
   window.__ERROR_DATA__ = {
     errorCode: 'ConnectYourDomain',
     serverErrorCode: '404',
     brand: 'wix',
     requestId: '1793559383.574660712711487'
   };
   ```

4. TLS is already provisioned for the name, so the takeover would be served over valid HTTPS:

   ```console
   $ openssl s_client -connect wixdemo.xola.com:443 -servername wixdemo.xola.com | openssl x509 -noout -subject -issuer -dates -ext subjectAltName
   subject=CN=wixdemo.xola.com
   issuer=C=US, O=Google Trust Services, CN=WR1
   notBefore=Oct  3 12:34:18 2026 GMT
   notAfter=Jan  1 12:34:17 2027 GMT
   X509v3 Subject Alternative Name:
       DNS:wixdemo.xola.com, DNS:www.wixdemo.xola.com
   ```

## 3. Proof of concept (attacker's steps)

Xola's DNS already satisfies Wix's ownership check, so no DNS change by the attacker is needed:

1. Create a Wix account and a site whose content is a phishing page (e.g. a "Xola seller login"
   form posting credentials to the attacker).
2. In **Domains → Connect a domain you already own**, enter `wixdemo.xola.com`.
   Wix asks for a CNAME to `pointing.wixdns.net` / `www66.wixdns.net` — already present — so
   validation passes for anyone who can resolve the name.
3. Publish. `https://wixdemo.xola.com/` now serves the attacker's content with a valid
   certificate, and stays that way until Xola removes the record or files a reclaim with Wix.

*Researcher note: I did not create a Wix account or complete the claim. Doing so would have
taken over a live third-party asset, which is outside the bounds of good-faith research. The
DNS state, the provider error fingerprint, and Wix's DNS-based ownership model are sufficient to
demonstrate the vulnerability; steps 1–3 are the standard, documented Wix flow.*

**Provider caveat (stated for accuracy):** Wix is classified as an "edge case" provider because
one of its subdomain paths requires the parent domain to sit in the same Wix account, which could
block an arbitrary third party in some flows. Two things still make this reportable as-is: the
record is genuinely dangling (no Wix site is attached, and Wix's own UI offers to "Reconnect" it),
and the only party who can resolve the ambiguity — Wix support / the account that previously held
it — is one email away. Regardless of claimability, an orphaned `xola.com` CNAME pointing at a
third-party edge that serves a provider error page is a DNS-hygiene defect that should be removed.

## 4. Impact

- **Brand abuse / phishing**: attackers host credential-harvesting or malware pages at a
  `xola.com` URL. Users and mail filters trust the registrable domain.
- **Trust-boundary bypass**: anything that allow-lists `*.xola.com` (CSP `frame-src`/`connect-src`,
  OAuth `redirect_uri` prefixes, corporate proxy allow-lists, SSO cookie scope) treats the
  attacker's content as first-party.
- **Cookie scoping**: a hostile page on a subdomain can plant cookies for `.xola.com` (cookie
  tossing / session fixation) and, for non-HttpOnly cookies, read them.
- **Reputation / SEO**: persistent untrusted content on the corporate domain.

No user data was accessed, and no requests beyond single ordinary `GET /` were made to the
host while investigating.

## 5. Remediation

1. **Remove the DNS record immediately**: delete the `wixdemo` CNAME in the `xola.com` Route 53
   zone (and `www.wixdemo` if it is a separate record). This alone stops the takeover.
2. If `wixdemo` is still needed, re-add it only after re-attaching it to a Wix site owned by
   Xola, and confirm the edge returns a live site rather than the `ConnectYourDomain` page.
3. **Sweep the zone** for other CNAMEs pointing at third-party hosting edges with no live
   origin (Wix, Netlify, Vercel, Railway, GitHub Pages, Heroku, S3/CloudFront, Azure, HubSpot).
   In the same pass I found other Xola records pointing at providers that are currently
   *connected* (HubSpot `sites.hubspot.net`, Zendesk, Wix-free) — they are fine today, but the
   risk recurs every time a vendor site is decommissioned.
4. Add a decommissioning checklist item: **delete DNS before deleting the vendor site**, and
   monitor for dangling-CNAME fingerprints in CI.

## 6. References

- Wix takeover fingerprint (`ConnectYourDomain` = claimable):
  https://subdomainchecker.com/subdomain-takeover/wix
- can-i-take-over-xyz, Wix entry (marked "Edge case", fingerprint
  "Looks Like This Domain Isn't Connected To A Website Yet!"):
  https://github.com/EdOverflow/can-i-take-over-xyz#wix
- Wix support — connecting a domain by pointing (DNS-based ownership proof):
  https://support.wix.com/en/article/dns-records-needed-to-connect-your-domain-to-wix
- Wix support — connecting a subdomain to a site:
  https://support.wix.com/en/article/connecting-a-subdomain-to-a-site-in-your-wix-account
- Xola VDP (scope: "any digital assets owned, operated, or maintained by Xola"):
  https://www.xola.com/vdp

## 7. Disclosure terms

Reported in good faith under the Xola VDP and its safe-harbour clause. I request at least 90
days before any public discussion of this issue, and I am happy to test any fix Xola deploys.

## Appendix — evidence files

| File | Contents |
| --- | --- |
| `evidence/01-dns.txt` | `dig` CNAME chain + TLS certificate details |
| `evidence/02-headers.txt` | Full `curl -I https://wixdemo.xola.com/` response headers |
| `evidence/03-raw-body.html` | Raw 2,356-byte body incl. `window.__ERROR_DATA__` (`ConnectYourDomain`) |
| `evidence/04-rendered-dom.html` | Post-JS DOM of the Wix "Reconnect Your Domain" page |
| `evidence/05-rendered-page.png` | Screenshot of the dangling-domain page |
| `evidence/06-rendered-text.txt` | Visible text extracted from the rendered page |

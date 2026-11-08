# Bounded T03 review

User authorizes fixing the probe (not changing IDs), at most TWO live attempts, then report.
T03 acceptance is now IDs stored + Microsoft passes + Google probe passes. T03b owns
Google verification/public pages/Microsoft admin consent and gates T11 Gmail acceptance.

Worker is read-only, no network/shell/keychain/browser access. Do not expose or ask for
credentials. Only copied files are allowed. Root owns all code/test changes and all live
requests. Planning docs have a separate native owner; do not edit anything.

Observed current behavior: Microsoft fake-refresh probe gets HTTP400 invalid_grant.
Google ID now passes format, but fake-refresh probe gets HTTP400 invalid_request.
No raw provider response/description was retained. Do not infer a missing secret as fact.

Official Google native-app documentation (reviewed live by root):
https://developers.google.com/identity/protocols/oauth2/native-app
- Authorization endpoint uses code_challenge/code_challenge_method.
- Token code exchange takes client_id, code, code_verifier, grant_type=authorization_code,
  redirect_uri; client_secret is labeled optional. Loopback redirect supported for Desktop.
- Refresh token exchange takes client_id, refresh_token, grant_type=refresh_token,
  optional client_secret. Redirect and PKCE challenge are not refresh parameters.

Proposed fix: preserve Microsoft fake-refresh request. Google uses a deliberately fake
authorization code, a fixed obvious fake verifier 43-128 RFC7636 unreserved characters,
redirect_uri=http://127.0.0.1, and grant_type=authorization_code. No auth URL is opened,
no callback listener, no actual code/token/secret; this is still readiness-only. Do not
put code_challenge on token endpoint. Preserve exactly HTTP400 invalid_grant as success;
other errors/token-bearing responses still fail. Docs state no authenticated validation.

Review proposed fix against copied source/tests. Return concrete risks, meaningful
regression tests, any reason to change request fields. No production edits. Root will run
pytest, ruff, strict mypy, then bounded live attempts and inspect this review before push.

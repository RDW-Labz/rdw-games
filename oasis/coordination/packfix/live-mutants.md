# packlive: mutants (all run for real, 2026-09-30)

Each mutant was applied to the committed fix, the named test was run, and the file was restored from git.

| # | Repo | Deliberate break | Test run | Result |
|---|---|---|---|---|
| M1 | desktop-app | `img-src 'self' data: blob:` back to `img-src 'self' data:` (the shipped a862fbd CSP) | tests/livePacksCsp.test.tsx | 3/3 failed (CSP check, Coworkers cards, orb load): killed |
| M2 | desktop-app | `blob:` moved from `img-src` into `connect-src` | tests/livePacksCsp.test.tsx | 3/3 failed: killed (a real WKWebView also refuses it) |
| M3 | desktop-app | `blob:` only in `default-src`, `img-src` left without it | tests/livePacksCsp.test.tsx | 3/3 failed: killed (a real WKWebView also refuses it, since `img-src` overrides) |
| M4 | desktop-app | client asks `/avatars/{id}/thumb` instead of `thumb.png` | tests/livePacksCsp.test.tsx | Coworkers test failed (routes not in the capture): killed |
| A1 | agent-core | bundled row `preview=True` to `False` (the pre-#85 bug) | tests/test_avatar_bundled_live_routes.py | failed `assert False is True`: killed |
| A2 | agent-core | thumb route `content_type="image/png"` to `application/octet-stream` | tests/test_avatar_bundled_live_routes.py | failed on Content-Type: killed |
| A3 | agent-core | bundled `pack_tier` returns `"standard"` | tests/test_avatar_bundled_live_routes.py | failed on `{id, tier:"animated"}`: killed |
| A4 | agent-core | CORS `Access-Control-Allow-Origin` set only on JSON responses | tests/test_avatar_bundled_live_routes.py | failed `KeyError: 'Access-Control-Allow-Origin'` on thumb.png: killed |

8/8 killed.

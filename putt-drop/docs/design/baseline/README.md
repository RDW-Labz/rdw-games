# Putt Drop design baseline

| Field | Value |
| --- | --- |
| Date | 2026-10-12 |
| Branch | `job/pd-measure-9` |
| Git commit (parent) | `c494699b85e196649d6802cc76fb303e99d1e057` |
| Screens | [screens/index.html](./screens/index.html) |
| Perf JSON | [perf.json](./perf.json) |

Baseline captured from the working tree on this branch (hooks + scripts; not committed per job instructions).

## Test results

| Check | Result |
| --- | --- |
| `npx vitest run` | **73** tests passed (4 files) |
| `npm run check-levels` | **34.98 s** total |
| `npm run smoke` | **ok** (Chromium + WebKit iOS flows) |

## Performance (Chromium Pixel 7, CPU throttle ×4)

| Metric | Value |
| --- | --- |
| menuInteractiveMs (median of 3 cold loads) | 347 ms |
| fpsPutt avg / p5 (2 s after full-power putt, hole 1) | 20.9 / 13.4 |
| fpsMenuTransition avg / p5 | 11.3 / 6.3 |
| fpsResult avg / p5 (forceResult par) | 11.6 / 7.7 |
| layoutJumps (canvas rect changes after first paint) | 0 |
| heapMB after hole 1 | 17.74 |
| heapMB after 10 holes + putts | 28.30 |
| heap growth MB | 10.57 |

## Bundle (`build/web`)

| Asset | Raw | Gzip |
| --- | ---: | ---: |
| **Total JS** | 1,761,981 B | 409,812 B (~400.2 KiB) |
| `assets/index-I1zyEKWd.js` | 1,759,796 B | 408,761 B |
| `assets/web-Bg5D2IL7.js` | 940 B | 465 B |
| `assets/web-GETB06jQ.js` | 1,245 B | 586 B |
| **Fonts** | 436,116 B | 233,711 B |
| **All assets** | 2,208,174 B | 648,026 B |

## Screenshots per device

15 states × 3 profiles = **45** PNGs in `screens/`:

- `iphone-15` — WebKit iPhone 15
- `iphone-se` — WebKit iPhone SE
- `pixel-7` — Chromium Pixel 7

## MISSING states (not implemented yet)

These are listed in `screens/index.html` and tracked here for visibility:

- first-time hint
- unlock screen (dedicated flow; holes grid has an unlock panel only)
- offline/error states

## Regenerate

```bash
npm run build
npm run capture -- docs/design/baseline/screens
npm run perf -- docs/design/baseline/perf.json
```

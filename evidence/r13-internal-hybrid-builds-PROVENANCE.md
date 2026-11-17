# R13 — `internal-hybrid-builds/` prototype: audit and disposition

Audited 2026-11-16 during the game-repos consolidation, before the directory was removed
from this repo (decision matrix R13: "keep `source/` only if R3's audit says it is unique").

## What it was

The shelf *prototype*: a PS-style dashboard (`index.html`), phone-as-controller page
(`pad.html`), static server + save/input relay (`serve.py`), two hybrids (`games/`), and
`source/` — 105 MB of *raw upstream clone trees* (96 MB of it `source/`, 44 KB `games/`).
Its own README lists "expose at game.cluerholdings.com" as a roadmap item; the live KAOS
shelf (`kaos/src/hybrid` @ `kaos-launch`) fulfilled that, which is why R1 supersedes it.

## Uniqueness finding — not unique first-party content

`source/` is 12 dumps of **public upstream third-party repos**, 9,649 files, no `.git` in
any of them and no first-party (Cluer/Michael) markers anywhere in the tree:

| Dir | Files | Size | What the README says it is |
|---|---|---|---|
| `2010-rust-rewrite-mashup` | 2,899 | 32 MB | MW2 + Skate 3 + Minecraft mashup, Rust |
| `ai-game-modding-guides` | 31 | 376 KB | guides for AI-built modding projects |
| `ArkWeb` | 89 | 932 KB | ArkWeb swing/portal port |
| `awesome-game-mashups` | 34 | 408 KB | curated "games rebuilt inside other games" index |
| `er-mario` | 234 | 3.8 MB | Elden Ring × Mario mod (Rust, libsm64) |
| `ghidra-mcp` | 606 | 9.8 MB | Ghidra MCP server |
| `iw4L` | 1,522 | 19 MB | open-source MW2 (2009) runtime, Rust |
| `rea` | 1,960 | 16 MB | RE analysis bridge |
| `skate3clone` | 218 | 4.7 MB | Skate 3 Bevy preservation project |
| `SkateGM` | 1,569 | 14 MB | Skate 3 in Garry's Mod |
| `SkyCraft` | 136 | 1.3 MB | SkyCraft |
| `universal-modder` | 351 | 4.0 MB | universal modding tool |

The live site's `kaos/work/site/source/` holds a 4 MB *subset* of 8 of these (selected
files only). R13 held the whole trees, including four upstreams the site never copied
(`ai-game-modding-guides`, `awesome-game-mashups`, `rea`, `universal-modder`).

Not reproducible exactly: the `.git` directories were stripped when these were dumped, so
**no commit is pinned** and "re-clone the upstream" yields today's HEAD, not these bytes.
That is the only reason they are archived rather than simply discarded.

## Disposition

- Directory removed from this repo (it is third-party code; 105 MB of it, and this repo is
  public — shipping vendored upstream trees here serves nothing).
- Full tree preserved byte-exact, outside git:
  `/home/cluer/workspace/archive/R13-rdw-games-internal-hybrid-builds-2026-11-16.tar.zst`
  (21 MB compressed, 105 MB uncompressed)
  sha256 `46acb16df4fa6a697dcd81e3e2ab1f9b075dff94d29640004284dc3aecf1b702`
- Restore: `tar -I zstd -xf that-archive.tar.zst` into a scratch dir, then `python3 serve.py`.

# ddnet — provenance

Everything this repository claims about the title, in one file. Regenerate with `python3 tools/ports-provenance.py`.

| field | value |
|---|---|
| upstream | https://github.com/ddnet/ddnet |
| license | Zlib |
| pinned commit | `00955a3` (2026-10-23) — Fix various issues of emoticon selector and spectator mode (#13032) |
| local clone | `/home/cluer/crg/games/ddnet` |
| artifact | `/home/cluer/crg/games/ddnet/build/DDNet` |
| artifact type | binary |
| size | 11,426,640 bytes (11.4 MB) |
| sha256 | `be9f1d8259750d03d7a242fdcbb77fd76f2ea0b2ad20b5aa81988417693e9880` |
| package / version | `org.ddnet.client` 20.1.1 |
| ABIs in the artifact | arm64-v8a, armeabi-v7a, x86, x86_64 |

## Build recipe (the commands actually run)

```sh
cd /home/cluer/crg/games/ddnet
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release && ninja -C build
```

## Install

Desktop build: run `/home/cluer/crg/games/ddnet/build/DDNet`. A 132 MB Android APK (org.

## Notes

A 132 MB Android APK (org.ddnet.client 20.1.1) also exists at /home/cluer/projects/cloned-free-games/apks/ddnet.apk. The verified artifact here is the desktop binary. Practice and local servers play offline; public servers need the network, so it is the one title whose best mode is online.

## Licence

Zlib. The upstream licence text is authoritative and lives in the clone at `/home/cluer/crg/games/ddnet`; this repository carries no copy of it and vendors none of the source.

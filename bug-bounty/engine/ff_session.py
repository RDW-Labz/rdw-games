#!/usr/bin/env python3
"""Keep a visible Firefox window open on a set of tabs, using the shared lane profile.

  WAYLAND_DISPLAY=wayland-1 XDG_RUNTIME_DIR=/run/user/1000 MOZ_ENABLE_WAYLAND=1 \
    python3 engine/ff_session.py https://bugcrowd.com/user/sign_in https://login.microsoft.com/device

The window belongs to the human from here on: log in, approve a device code, whatever is needed. The
profile (engine/profiles/ff) keeps those sessions for later automation. Exits when the window closes,
so the profile lock is released cleanly.
"""
from __future__ import annotations

import sys
import time

from engine.ff import Firefox


def main() -> int:
    urls = sys.argv[1:] or ["about:blank"]
    ff = Firefox(headless=False)
    ff.goto(urls[0], wait=1.5)
    for u in urls[1:]:
        ff.driver.execute_script("window.open(arguments[0], '_blank')", u)
        time.sleep(1.5)
    print("ready:", ff.url, "| tabs:", len(ff.driver.window_handles), flush=True)
    try:
        while ff.driver.window_handles:
            time.sleep(4)
    except Exception:
        pass
    finally:
        ff.close()
    print("window closed — profile released", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())

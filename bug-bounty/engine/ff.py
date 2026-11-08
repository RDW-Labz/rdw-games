#!/usr/bin/env python3
"""Firefox lane for browser work: a persistent, sign-in-able Firefox driven by geckodriver.

The Brave/CDP lane is the human's daily browser; this one is a separate profile that can hold its own
logins and survives restarts. Same shape as engine/cdp_tab.py so probes port over easily.

  from engine.ff import Firefox
  with Firefox() as ff:
      ff.goto("https://hackerone.com/reports/4169021")
      print(ff.js("document.title"))
      ff.fill("#comment\\[message\\]", "text")
      ff.click_text("Post comment")

  python3 engine/ff.py --selftest          # headless smoke test
  python3 engine/ff.py --open <url>        # headful, keeps running until you close the window

Profile lives in engine/profiles/ff so sessions persist between runs. Set FF_HEADLESS=1 to run without
a window (default is headful: sign-in flows and 2FA need a visible window).
"""
from __future__ import annotations

import argparse
import os
import pathlib
import sys
import time

from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys

PROFILE = pathlib.Path(__file__).resolve().parent / "profiles" / "ff"
GECKO = os.environ.get("GECKODRIVER") or str(pathlib.Path.home() / ".local/bin/geckodriver")


class Firefox:
    def __init__(self, headless: bool | None = None, profile: pathlib.Path | None = None) -> None:
        self.profile = pathlib.Path(profile or PROFILE)
        self.profile.mkdir(parents=True, exist_ok=True)
        opts = Options()
        opts.add_argument("-profile")
        opts.add_argument(str(self.profile))
        opts.set_preference("marionette.port", 2828)
        opts.set_preference("dom.webdriver.enabled", False)  # Google refuses sign-in to WebDriver-flagged browsers
        opts.set_preference("marionette.enabled", True)
        opts.set_preference("browser.tabs.warnOnClose", False)
        opts.set_preference("browser.startup.page", 0)
        opts.set_preference("dom.webnotifications.enabled", False)
        opts.set_preference("media.peerconnection.enabled", False)
        opts.set_preference("signon.rememberSignons", True)
        want_headless = os.environ.get("FF_HEADLESS") == "1" if headless is None else headless
        if want_headless:
            opts.add_argument("-headless")
        self.driver = webdriver.Firefox(options=opts, service=Service(GECKO))
        self.driver.set_page_load_timeout(90)

    # -- navigation ---------------------------------------------------------------------------
    def goto(self, url: str, wait: float = 0.0) -> "Firefox":
        self.driver.get(url)
        if wait:
            time.sleep(wait)
        return self

    @property
    def url(self) -> str:
        return self.driver.current_url

    @property
    def title(self) -> str:
        return self.driver.title

    def text(self, selector: str = "body") -> str:
        try:
            return self.driver.find_element(By.CSS_SELECTOR, selector).text
        except Exception:
            return ""

    # -- DOM ----------------------------------------------------------------------------------
    def js(self, expr: str):
        """Evaluate JS in the page. Wrap bodies as '(() => {...})()' — a bare arrow returns itself."""
        return self.driver.execute_script(f"return {expr}" if not expr.strip().startswith("return") else expr)

    def els(self, selector: str):
        return self.driver.find_elements(By.CSS_SELECTOR, selector)

    def wait_for(self, selector: str, timeout: float = 30) -> bool:
        end = time.time() + timeout
        while time.time() < end:
            if self.els(selector):
                return True
            time.sleep(0.5)
        return False

    # -- interaction --------------------------------------------------------------------------
    def fill(self, selector: str, value: str) -> bool:
        """Set a controlled input's value the way a human would, so React/Vue see it."""
        ok = self.js("""(() => {
          const el = document.querySelector(%s);
          if (!el) return false;
          el.focus();
          const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const set = Object.getOwnPropertyDescriptor(proto, 'value').set;
          set.call(el, %s);
          el.dispatchEvent(new Event('input', {bubbles: true}));
          el.dispatchEvent(new Event('change', {bubbles: true}));
          return el.value.length > 0;
        })()""" % (repr(selector), repr(value)))
        return bool(ok)

    def click(self, selector: str) -> bool:
        found = self.els(selector)
        if not found:
            return False
        self.js(f"document.querySelector({selector!r}).scrollIntoView({{block:'center'}})")
        time.sleep(0.3)
        found[0].click()
        return True

    def click_text(self, text: str, selector: str = "button,a,[role=button]") -> str:
        hit = self.js("""(() => {
          const want = %s;
          const el = Array.from(document.querySelectorAll(%s))
            .find(e => (e.innerText || '').trim().toLowerCase() === want.toLowerCase());
          if (!el) return 'missing';
          el.scrollIntoView({block: 'center'});
          el.click();
          return 'clicked';
        })()""" % (repr(text), repr(selector)))
        return str(hit)

    def press(self, selector: str, *keys: str) -> None:
        el = self.driver.find_element(By.CSS_SELECTOR, selector)
        el.click()
        for k in keys:
            el.send_keys(getattr(Keys, k.upper(), k))

    def shot(self, path: str) -> str:
        self.driver.save_screenshot(path)
        return path

    # -- lifecycle ----------------------------------------------------------------------------
    def close(self) -> None:
        try:
            self.driver.quit()
        except Exception:
            pass

    def __enter__(self) -> "Firefox":
        return self

    def __exit__(self, *exc) -> None:
        self.close()


def selftest() -> int:
    os.environ.setdefault("FF_HEADLESS", "1")
    with Firefox() as ff:
        ff.goto("https://example.com", wait=1)
        print("title   :", ff.title)
        print("h1      :", ff.text("h1"))
        print("js      :", ff.js("(() => document.querySelectorAll('a').length)()"))
        print("profile :", ff.profile)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--open")
    a = ap.parse_args()
    if a.selftest or not a.open:
        return selftest()
    ff = Firefox(headless=False)
    ff.goto(a.open)
    print("firefox up:", ff.url, "— close the window to release the profile")
    try:
        while True:
            time.sleep(5)
            if not ff.driver.window_handles:
                break
    except Exception:
        pass
    finally:
        ff.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())

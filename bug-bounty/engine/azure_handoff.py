#!/usr/bin/env python3
"""Drive the Azure self-serve sign-up to the payment step, then stop.

The card is the one thing this script must never touch, so it does the opposite of a normal automation:
it clicks "Send notification" so the phone prompt goes out, waits for the identity check to clear, and
then parks on the payment form — printing what it sees and handing the keyboard over. The browser stays
open in the foreground so a human can type; the process only reports.

  python3 engine/azure_handoff.py            # launch, click, wait, park
  python3 engine/azure_handoff.py --probe    # report the current page without clicking
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.support.ui import WebDriverWait

ROOT = Path(__file__).resolve().parent.parent
PROFILE = ROOT / "engine/profiles/azure"
SIGNUP = "https://signup.azure.com/signup?offer=ms-azr-0003P"


def driver() -> webdriver.Firefox:
    o = Options()
    o.add_argument("-profile")
    o.add_argument(str(PROFILE))
    o.add_argument("--new-instance")
    o.binary_location = "/usr/lib/firefox/firefox"
    d = webdriver.Firefox(options=o)
    d.set_window_size(1280, 900)
    return d


def describe(d: webdriver.Firefox) -> str:
    try:
        title = d.title
    except Exception:
        title = "?"
    url = d.current_url
    body = ""
    try:
        body = d.find_element(By.TAG_NAME, "body").text[:600].replace("\n", " | ")
    except Exception:
        pass
    return f"url={url}\ntitle={title}\nbody={body}"


def click_text(d: webdriver.Firefox, label: str) -> bool:
    for by, sel in ((By.XPATH, f"//button[contains(., '{label}')]"),
                    (By.XPATH, f"//input[@type='submit' and contains(@value, '{label}')]"),
                    (By.XPATH, f"//a[contains(., '{label}')]")):
        try:
            el = d.find_element(by, sel)
            if el.is_displayed():
                d.execute_script("arguments[0].scrollIntoView({block:'center'});", el)
                el.click()
                return True
        except Exception:
            continue
    return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--probe", action="store_true")
    ap.add_argument("--wait", type=int, default=600, help="seconds to watch for the payment step")
    a = ap.parse_args()

    d = driver()
    try:
        if not a.probe:
            d.get(SIGNUP)
            WebDriverWait(d, 60).until(lambda x: x.execute_script("return document.readyState") == "complete")
            time.sleep(4)
        print("--- page ---")
        print(describe(d))
        if a.probe:
            return 0

        if "send notification" in d.find_element(By.TAG_NAME, "body").text.lower():
            ok = click_text(d, "Send notification")
            print(f"\nSend notification clicked: {ok} — approve the prompt on your phone")
        else:
            print("\nno phone prompt on this page; continuing to watch")

        deadline = time.time() + a.wait
        last = ""
        while time.time() < deadline:
            time.sleep(5)
            try:
                body = d.find_element(By.TAG_NAME, "body").text
            except Exception:
                continue
            low = body.lower()
            if "card" in low or "payment" in low or "credit" in low:
                print("\nCARD FORM IS UP — your keyboard. Fields seen:")
                for row in body.splitlines():
                    if row.strip():
                        print("   ", row.strip()[:90])
                print("\nparking; the browser stays open for you.")
                return 0
            if low != last:
                last = low
                print("   …", body[:160].replace("\n", " | "))
        print("\ntimed out waiting for the payment step")
        return 1
    finally:
        # the browser is deliberately left running for the human
        pass


if __name__ == "__main__":
    sys.exit(main())

# Windows checks for Darren (kept by the orchestrator; results back to Braden)

Same shape as `mac-checks.md`. Darren's Windows desktop is the first test machine (#315). Rule #316: one link, one click, one "Run anyway", the app opens; no terminal, no Python, no second download, no settings to change. Each row says what a pass looks like in plain words and what to screenshot on a fail. Darren writes the Status column (or tells Braden, who writes it).

| Ticket | What to check | Build | Status |
|---|---|---|---|

## T74 first run (do these in order, in one sitting; aim: under 5 minutes, no help from Braden)

| Step | What to check | Pass looks like | If it fails, screenshot | Status |
|---|---|---|---|---|
| 1. Download | Click the link Braden sent. | `OASIS-Setup.exe` shows in the browser's download tray, and nothing else is asked for. | The browser's download tray or its warning. | |
| 2. SmartScreen | Open the download. | A blue "Windows protected your PC" screen; **More info** then **Run anyway** are both there. Nothing asks for an admin password. | The blue screen exactly as shown (whole screen). | |
| 3. Install | Click **Run anyway**. | The installer runs by itself and OASIS opens: an orb on the desktop and a "Get started" window. Under a minute. No terminal window, no second download. | Whatever is on screen when it stops (an error, a black window, or nothing). | |
| 4. Name | Type your name where "Get started" asks. | It accepts the name and moves on. It asks for nothing else (no key, no address, no port). | The screen that asks for more than a name. | |
| 5. Connect Outlook | Click **Connect** for Outlook, then for Outlook Calendar; sign in with your work account in the browser window that opens. | Both rows show "Connected". | The Connect row that is not "Connected", and any browser error. | |
| 6. One test chat | In Chat, send: "What's on my calendar today?" | A reply in plain words within a minute, about your real calendar. | The chat window with the message and whatever came back (or the empty wait). | |
| 7. Quit and reopen | Right-click the orb, **Quit**. Then open OASIS from the Start menu. | The orb goes away on Quit and no OASIS or python process stays in Task Manager. On reopen the same chat is still there. | Task Manager's Details tab filtered to "python" or "OASIS" after Quit. | |
| 8. Time | How long from clicking the link to the first reply? | Under 5 minutes, with no message to Braden in between. | (none; just write the minutes) | |

Build: `OASIS-Setup.exe` from the `windows-installer` job (desktop-app 0.2.0, agent-core 0.7.49 bundled). Braden sends the link; the orchestrator fills the Build column with the run's commit when it does.

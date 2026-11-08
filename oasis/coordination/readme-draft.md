# OASIS — start here

This is a plain-words guide to OASIS: what it is, how it works, what the pieces are, how we build it, and where things live on your Mac. No background needed.

## 1. What OASIS is

OASIS gives every Cluer Holdings employee a personal AI agent — a computer helper that can look things up and take actions for you, not just answer questions — that knows them and knows their job. It is meant to feel like a coworker that lives on your computer and steadily takes the repeat, boring parts of your day off your plate, not a chat window you type questions into. It learns who you are and how the company works, notices the tasks you do over and over, and offers to take them over. It never acts on its own for anything risky; it asks first and waits for a yes. The end goal is simple: install one app, spend about an hour telling it about your job, connect your tools with a few clicks, and from that day on you have a coworker that gets more useful every week.

## 2. How it works

Working today: the Rig, the local service, ask-first, and the Mail/Calendar/Teams reads. Everything else below is planned.

**The Rig on your desk.** The Rig is the app you actually see and touch. Most of the time it is just the orb: a small round button that floats above your other windows, like a chat bubble you can click from anywhere, or drag anywhere you like, or open with a keyboard shortcut even from inside a full-screen app. Click it and a quick box slides open for a short back-and-forth chat. For the slower things — connecting a new tool, reading your activity log, seeing your profile, going through onboarding, changing a setting — there is a full app you open when you need it. Day to day, the orb and the quick box are all most people ever use.

**The service behind it.** The Rig does not do the actual thinking or acting itself. It talks to one local service — a program that runs quietly in the background on your own Mac — and that service is the part that plans, remembers, and carries out the work. The Rig never talks to your mail, your calendar, or any outside website directly; it only ever talks to this one local service, and the service does the rest. Every task that service runs follows the same fixed pattern, called the loop: plan a small step, do it, check the result against something other than itself (a test, a comparison, or a second check), and either carry on or stop and ask. That one shape covers everything from answering a quick question to running a task with several steps.

**The connectors.** A connector is the link between your agent and one outside tool.

**Connected and working:** Outlook mail (read; send, reply and move only after a Yes card), Outlook Calendar (read; changes only after a Yes), Teams (read-only until v2; it cannot send), Gmail (connected for testing; Google sign-in is still in test mode).

**In the catalog, not yet live:** OneDrive, Google Drive, Google Calendar, QuickBooks (read-only by design; so far only tested on fake data).

You turn one on by clicking Connect and then Allow on that tool's own sign-in screen — you never type a password into the agent itself. Once you allow it, the login token (a small saved credential that proves you're signed in) is kept in the Mac's keychain, the same locked, built-in place macOS already keeps your other passwords, never in a plain file anyone could read. Cluer registers itself once with each tool's provider (Microsoft or Google); after that one-time step, every employee only ever sees the click-Allow part.

**The skills.** A skill is one job the agent knows how to do, like pulling together a weekly report. Each skill is written down in a small file called `skill.yaml`, which says what the skill does, how to check that it worked, and which of its steps are risky. Before a skill is trusted, it is tested against real past examples, and every version is kept, so it's always clear what changed and easy to roll back if a new version does worse. Skills come in two tiers: shared skills any employee's agent can use, and personal skills built around one person's own habits; a personal skill that turns out useful for more than one person can be promoted to a shared one. Adding a skill to an agent, or dropping one, is a one-line change to a list, never new code.

**The nightly loop (planned).** Two things happen every night without anyone asking. The Scoreboard — itself an automated agent — reads the day's logs and works out numbers like hours given back that week, how often a proposal gets a yes, how often a skill's own check passes on the first try, and whether spend is climbing. What it does with those numbers depends on how safe the change is:

- Small, safe tuning (switching a skill to a cheaper model that does just as well, or quietly retiring a proposal type that keeps getting told no) it does on its own, and logs the change.
- A finding that needs a person's judgment (spend in one area is climbing, with no skill covering it yet) becomes a plain-worded proposal in that person's daily note.
- A bigger problem (a skill's success rate has fallen since a recent version) becomes a ticket for Braden, with the failing runs attached.
- Anything urgent, like spend crossing a set line, is a message to Braden the same hour.

Separately, a nightly run checks that the core agent software still builds cleanly and passes its own tests; new software only goes onto anyone's Mac after that nightly check has come back clean, and Braden checks that clean result himself before installing anything new.

**Ask-first, and pause.** Some steps are risky — sending an email, paying money, deleting something, signing as you. Before doing one of these, the agent stops and shows a Yes card: a small approval message in plain words with a Yes and a No button, and it waits for your answer. Which steps count as risky is written into that skill's own file ahead of time, never decided by the agent in the moment, so the same skill always asks in the same place. A few steps — paying, signing, deleting, sending money — are never allowed to stop asking, no matter how many times you've said yes before, and no step can stop asking at all until it has been tested against being tricked by a bad web page or email. You can also press pause at any time, from the orb or the full app, which stops the agent watching or acting until you turn it back on. From the very first screen, the agent explains what it will never do: act without a yes, share your data outside the company, or hide what it did — everything it does is visible in your activity log.

## 3. The repos

Each piece of OASIS lives in its own repo (a separate, self-contained code project). This keeps a problem in one piece from breaking another — a broken watcher, say, can never take down someone's agent. Every repo shares the same layout (`README.md`, `AGENTS.md`, `CHANGELOG.md`, `docs/`, `src/`, `tests/`, and a `.github/workflows/ci.yml` file that runs its automated checks on every proposed change). Repo names, in italics below, are the plain names used on GitHub; the word in parentheses after each one is its codename, the name people actually use for it in conversation. Both names come from the book Ready Player One.

### agent-core (Anorak)

**What it is.** The guide inside every agent: the loop runner (the routine that plans a step, does it, checks it, and knows when to stop), memory, the switch that lets the agent use different AI models, the secrets interface (the one doorway to the Mac keychain), and the Scoreboard skill (planned). The background service the Rig talks to — `rig-service` — runs from here.

**What's in it.** Agent shell, loop runner, memory store, model switch, secrets interface, Scoreboard skill, network event logging.

**Build phase.** Phase 0 (foundations).

**How it talks to the others.** It installs pinned, checked copies of `connectors`, `playbooks` and `skills` into its own runtime (one command, checked against a lock file, so a tampered or mismatched copy is refused). The Rig (`desktop-app`) talks only to this repo's local service, never to any other repo directly.

**More detail.** Storing a secret goes through a small command-line tool built here (`secrets set`, `secrets list`, `secrets delete`); the value is only ever typed at a hidden prompt, never shown or logged, and there is no command that prints a stored value back out. Every use is written to a private audit file (`secrets-events.jsonl`) that records who did what and when, but never the value itself.

**Tests.** Standard checks (see How we build).

**On Braden's Mac.** 0.7.29 (main 4c933ed, rig-service)

### connectors (Gates)

**What it is.** The one-click connector catalog: the list of every outside tool the agent can plug into, the company's own app registrations with Microsoft and Google, and the connect flows employees click through.

**What's in it.** Catalog format, app registrations, connect flows.

**Connected and working:** Outlook mail (read; send, reply and move only after a Yes card), Outlook Calendar (read; changes only after a Yes), Teams (read-only until v2; it cannot send), Gmail (connected for testing; Google sign-in is still in test mode).

**In the catalog, not yet live:** OneDrive, Google Drive, Google Calendar, QuickBooks (read-only by design; so far only tested on fake data).

**Build phase.** Phase 1 (Amber's agent).

**How it talks to the others.** It depends on the secrets vault (today, `agent-core`'s keychain interface) to store and read login tokens safely; the Rig's Connect tiles trigger its connect flows.

**More detail.** A readiness probe script checks that the Microsoft and Google app registrations are actually working, using fake sign-in data rather than a real account, and writes what it found (never the actual IDs or provider responses) to its own audit file, `registration-events.jsonl`.

**Tests.** Standard checks (see How we build).

**On Braden's Mac.** 0.5.1 (inside rig-service); 0.5.2 merged, not yet running

### skills (Almanac)

**What it is.** Shared and personal skills, the file formats they follow, and the test runner that checks a skill before it's trusted.

**What's in it.** Skill folder format, test runner, shared and personal skills.

**Build phase.** Phase 0 (foundations).

**How it talks to the others.** `agent-core` installs a pinned copy of this repo so an agent's skill list always points at tested, versioned skills, not loose files.

**More detail.** This repo is still early: the basic scaffolding and a smoke check are in place, and the three starter skills and the full test runner are still to come.

**Tests.** Standard checks (see How we build).

**On Braden's Mac.** 0.2.1.post1 (inside rig-service)

### playbooks (Garage)

**What it is.** The written playbooks, the shared plan and decisions log, the reusable repo template, and the onboarding script every new agent uses.

**What's in it.** Playbooks, plan, decisions, agent-template, onboarding script.

**Build phase.** Phase 1 (Amber's agent).

**How it talks to the others.** Every other repo's shared layout and its reusable template come from here; `agent-core` installs a pinned copy at runtime.

**More detail.** A file here called `ventures.yaml` is the single, agreed list of every venture's short code and full name; every profile file elsewhere only ever stores the short codes and looks the rest up here, so a venture's name only has to be corrected in one place.

**Tests.** Standard checks (see How we build).

**On Braden's Mac.** 0.2.4 (inside rig-service)

### desktop-app (Rig)

**What it is.** The app on your desk: the orb, the quick box, the full app, the installer, and the browser extension.

**What's in it.** Tauri (a small, cross-platform desktop app framework) shell, orb, side panel, full app, installer, auto-update, browser extension.

**Build phase.** Phase 0, as a thin version; the full version comes in Phase 4.

**How it talks to the others.** It talks only to `agent-core`'s local service, over a local connection on the same Mac; it never talks to `connectors`, `skills` or any other repo directly.

**More detail.** Setting up the whole stack by hand on a Mac (rather than just installing the finished app) has its own walkthrough in this repo's `docs/mac-quickstart.md`.

**Tests.** Standard checks (see How we build).

**On Braden's Mac.** OASIS.app b7d43e1

### remote (Zemeckis)

**What it is (planned).** The watcher: it records the steps you take once, using a local proxy (a small program that sits between your apps and the internet to see the traffic), strips out anything secret with a scrubber, and turns the rest into a macro — a saved button you can press again.

**What's in it.** Local proxy, scrubber, macro format, replay, editor, MCP server (a way of exposing a macro to the agent as one tool it can call).

**Build phase.** Phase 0 (foundations).

**How it talks to the others.** It uses `agent-core`'s secrets interface for any sign-in it needs during replay; a macro it records becomes a personal skill inside `skills`.

**More detail.** The scrubber is the part built first and tested hardest: it masks out secrets before a trace can be written to disk at all, and it is checked against 200 sample traces on every change, so nothing merges if even one of them leaks.

**Tests.** Standard checks (see How we build).

**On Braden's Mac.** not running

### rag-pipeline (Journals)

**What it is (planned).** The company's shared, searchable memory, planned for later in the build: one drawer (a dedicated section of storage) per part of the business, retrieval (the part that finds the right answer, called Curator), the role gate (the rule that decides who is allowed to see what), and the routers that choose which AI model or tool handles a request.

**What's in it.** Drawer schema, ingest, retrieval, role gate, model and tool routers, network graph store.

**Build phase.** Phase 3 (the shared pipeline).

**How it talks to the others.** It depends on `agent-core`; once built, every agent's questions about company data will run through it instead of local files.

**More detail.** This repo comes later on purpose — the agents are built and used first, so what they actually need from a shared memory is learned before it is built, rather than guessed in advance. When it is built, the plan is one drawer per part of the business, plus one shared drawer for what's common across all of them:

- Cluer Holdings (the parent company; shared docs, finance, HR)
- RDW, LLC (owns the retail locations)
- Bin-There Bought That (retail)
- Alpena Trucking
- Wayne Kelley Trucking
- JMAC Construction
- Gold Run LLC
- Glory Road (boat charter)
- Evage LLC (recycling)

**Tests.** Standard checks (see How we build).

**On Braden's Mac.** not running

### agent-amber (Art3mis)

**What it is (planned).** The first employee agent, built for the COO. It holds her role file (a description of her job and how she works), her settings, her list of skills, and her own private macros.

**What's in it.** Role file, config, skill list, private-drawer macros, made from the shared agent template.

**Build phase.** Phase 1 (Amber's agent).

**How it talks to the others.** It depends on `agent-core`, `remote`, `skills` and `connectors` — everything a working agent needs.

**More detail.** This agent starts as a watcher and note-taker before it is trusted to do anything on its own: it reads and observes first, proposes what it could take over, and only starts running a task once it has been told yes.

**Tests.** Standard checks (see How we build).

**On Braden's Mac.** not running

### agent-michael (Parzival)

**What it is (planned).** The second employee agent, same shape as `agent-amber`, built from the same template with a different role file for the owner-level view of the company.

**What's in it.** Same layout as `agent-amber`: role file, config, skill list, private-drawer macros.

**Build phase.** Phase 2 (the owner's agent).

**How it talks to the others.** Same dependencies as `agent-amber`: `agent-core`, `remote`, `skills` and `connectors`.

**More detail.** Everything generic built for the first agent — the shell, the memory store, the model switch, and every general-purpose skill — carries over here unchanged; only the role file and the questions it leans on differ.

**Tests.** Standard checks (see How we build).

**On Braden's Mac.** not running

### oasis (this workspace)

**What it is.** Not a product repo — this folder is where the whole build is planned and coordinated: the plan, the decisions log, the tickets, and the coordination files the build crew uses day to day.

**What's in it.** `docs/PLAN.md`, `docs/DECISIONS.md`, `docs/TICKETS.md`, `docs/CODENAMES.md`, `AGENTS.md`, ready-to-use prompts, a skeleton for each of the nine repos above, and the script that first pushed each skeleton to GitHub.

**How it talks to the others.** It is where the other nine repos started: a script reads the skeleton folders here and pushes each one as a new repo's first commit. This whole workspace — `docs/`, `README.md`, `AGENTS.md`, and `coordination/` — is the private GitHub repo [RDW-Labz/oasis](https://github.com/RDW-Labz/oasis).

**Tests.** none — it is not a code repo with its own automated checks.

**On Braden's Mac.** —

## 4. How we build

The building of OASIS follows the same loop discipline described above: a goal with a written finish line, one small step at a time, a check that is not just the AI grading its own work, and a pause to ask a person when something is risky or has failed too many times. That is as true of the AI workers building a repo as it is of an agent doing a task for an employee.

OASIS's own code is built by a small swarm of AI workers (bounded jobs handed out and checked by one lead seat, rather than one long open-ended conversation). The orchestrator plans and hands out the work; it does not write the code itself. Every job names exactly which files that one worker may write, so two jobs never collide over the same file. After a batch of jobs finishes, the orchestrator runs every check itself — a worker saying "done" is never taken on trust. The tool that runs this swarm is called project-swarm; it is Braden's own build crew, separate from the OASIS product and not one of the repos above.

Work is also matched to how hard it is: small bookkeeping jobs (writing a summary, filling in a form file) go to a cheap, fast AI model; ordinary code and tests against a clear, written contract go to a mid-tier model; and a genuinely hard problem with no clear answer yet goes to the most capable model, as one carefully named job rather than a habit. The moment one piece of work is waiting on something — a test run, a review, an answer from Braden — the next independent piece of work starts rather than the swarm sitting idle. Once a week, Braden gets a one-screen list of everything that merged since the last one.

**Tickets.** Work is broken into tickets, tracked in `docs/TICKETS.md`, each with a plain "done when" line — a one-sentence test for whether the ticket is actually finished (for example, "Braden connects Gmail and Outlook with clicks only"). A ticket only closes once that line is checked true, not just claimed.

**Decisions.** Every choice that shapes the build is written down in `docs/DECISIONS.md` as one numbered line with the reason for it. If a later choice changes an earlier one, a new numbered line is added; nothing already decided is silently rewritten.

**Handoffs.** Long-running AI sessions get slower and more expensive the longer they go, so work is handed off cleanly between sessions instead of stretched out. `coordination/TASK.md` always holds the current job, written so a fresh session can pick it up without having read anything else. `coordination/HANDOFF.md` records what is done, what is in flight, and what is next. After the tenth piece of work that writes code in one session, that session stops and hands off rather than pushing further.

**Merge rules.** A change only merges once two things are both true:

- Every one of its automated checks is green.
- Its pull request (the proposed change, put up for review before it becomes part of the real codebase) includes a "Mutation check" section — proof that the tests would actually catch the problem if the new safeguard were broken on purpose, one way at a time.

For ordinary changes, the orchestrator merges its own pull requests once both of those are true. Some changes are treated more carefully: anything touching secrets, an ask-first gate, the scrubber, or the way the Rig updates itself is marked **needs-Braden**. Those are still checked and merged the same way, but Braden is told about each one afterward in exactly three lines: what changed, what it could break, and the proof that it does not. Even then, the orchestrator never restarts the background service or reinstalls the app on Braden's own Mac from one of these changes — that step is always left for Braden to do himself.

Before any new build of the app, or any new background service that includes a newer `agent-core`, goes onto a Mac at all, the swarm first checks that the overnight build of `agent-core` came back clean; if it did not, nothing new gets built or installed, and Braden is told in one line.

**Standard checks.** Every repo's automated checks, run on every proposed change:

Python repos (`agent-core`, `connectors`, `skills`, `playbooks`, `remote`, `rag-pipeline`, `agent-amber`, `agent-michael`):

```
uv sync --locked
uv run pytest -q
uv run ruff check
uv run mypy --strict src
```

`desktop-app`:

```
npm ci
npm run lint
npm test
npm run typecheck
npm run build
cargo fmt --all --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
npm run tauri build -- --no-bundle
```

## 5. Where things live on a Mac

`~/.oasis/` is a folder on your Mac that belongs to OASIS alone. The Rig is only allowed to read files inside this one folder, never anywhere else on your machine, which keeps its reach easy to see and easy to trust.

Inside it, each person gets their own drawer at `~/.oasis/drawers/<person>/` — a private folder that only that person's own Mac account can open. It holds four kinds of things: their **profile** (the role file describing who they are, their job and their preferences, which they can always read and correct), their **notes** (their own written notes plus things the agent has observed and asked to save), their saved **chats**, and their **macros** (recorded, repeatable tasks, which hold real client names and task data and so never leave this private folder). None of this is ever put into git (the version-control system the OASIS code itself lives in); it stays only on that person's own Mac.

Secrets — logins and tokens for connected tools — never sit in a file at all. They live only in the macOS keychain, the same locked, built-in vault macOS already uses for your other passwords.

What the agent actually does is written to an activity and audit log under `~/Library/Application Support/OASIS/` — for example `connector-events.jsonl`, a plain log file with one event per line, which records that an email was sent or a file was read, but never the email's own subject or text.

The app itself installs at `/Applications/OASIS.app`, like any other Mac application.

## 6. Links

- [The tickets](docs/TICKETS.md)
- [The decisions log](docs/DECISIONS.md)
- [The full plan](docs/PLAN.md)
- [Mac checks for Braden](coordination/mac-checks.md)
- [All OASIS repos on GitHub](https://github.com/RDW-Labz?q=topic%3Aoasis)

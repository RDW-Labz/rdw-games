import subprocess, pathlib, sys
UV="/private/tmp/oasis-t01-tools/bin/uv"
A="src/anorak/local_service_adapters.py"
M=[
("pending text not applied",A,"            core_text = PENDING_PLAN_TEXT\n","            core_text = answer\n"),
("old narrow CLAIM_PATTERNS (no noun-first)",A,"""    re.compile(
        rf"(?:^|[.!?]\\s+)(?:your\\s+)?(?:email|message|reply|mail)\\s+\"""","""    re.compile(
        rf"(?!x)x(?:^|[.!?]\\s+)(?:your\\s+)?(?:email|message|reply|mail)\\s+\""""),
("noun-first without sentence anchor",A,"""rf"(?:^|[.!?]\\s+)(?:your\\s+)?(?:email|message|reply|mail)\\s+\"""","""rf"(?:your\\s+)?(?:email|message|reply|mail)\\s+\""""),
("noun-first without by/from guard",A,"""        rf"(?!\\s+(?:by|from)\\b)",\n""",""),
("has-been pattern removed",A,"""        rf"\\b(?:has|have)\\s+(?:been\\s+{_CLAIM_VERBS}|gone\\s+out)\\b",""","""        rf"(?!x)x",""" ),
("CLAIM_NONE_TEXT -> preview text",A,"            core_text = CLAIM_NONE_TEXT\n","            core_text = \"Here's the preview.\"\n"),
("claim guard off (no plan)",A,"        elif patterns_matched:\n            # T27c/T27d","        elif False:\n            # T27c/T27d"),
("Teams do-tool offered",A,"            if not (t.kind == \"do\" and t.connector == \"teams\")\n","            if True\n"),
("Teams reads hidden too",A,"            if not (t.kind == \"do\" and t.connector == \"teams\")\n","            if not (t.connector == \"teams\")\n"),
("instruction sentence removed",A,"""    "You cannot send or post Teams messages yet; if asked, say exactly: I can't send Teams "
    "messages yet."\n""","""    ""\n"""),
("Teams guard off",A,"        elif any(pattern.search(answer) for pattern in _TEAMS_SEND_PATTERNS):","        elif False:"),
("Teams guard un-anchored (I anywhere)",A,"""    rf"(?:\\bI(?:{_APOS}ll|{_APOS}ve|\\s+can|\\s+will|\\s+have)?\"""","""    rf"(?:\\bI\\b[^.?!]{{0,60}}(?:{_APOS}ll|{_APOS}ve|\\s+can|\\s+will|\\s+have)?\""""),
("Teams guard any-subject verb",A,"""    rf"(?:\\bI(?:{_APOS}ll|{_APOS}ve|\\s+can|\\s+will|\\s+have)?\"""","""    rf"(?:\\b\\w+(?:{_APOS}ll|{_APOS}ve|\\s+can|\\s+will|\\s+have)?\""""),
("Teams guard straight apostrophe only",A,"_APOS = \"['’]\"","_APOS = \"[']\""),
("Teams guard no Sent-sentence pattern",A,"""        r"(?:^|[.!?]\\s+)(?:all\\s+)?(?:sent|posted)\\b[^.?!]{0,60}\\bteams\\b",""","""        r"(?!x)x",""" ),
("Teams guard crosses sentences",A,"""        rf"{_TEAMS_FIRST_PERSON_VERB}[^.?!]{{0,60}}\\bteams\\b",""","""        rf"{_TEAMS_FIRST_PERSON_VERB}.{{0,60}}\\bteams\\b","""),
("Teams guard before claim guard w/ plan",A,"        if plan:\n            # T27d (decision #123): a plan/preview","        if plan and False:\n            # T27d (decision #123): a plan/preview"),
("user text into system (#73)",A,"        messages.append(Message(\"user\", text))\n        # T27d","        messages[0] = Message(\"system\", messages[0].content + \"\\n\" + text)\n        messages.append(Message(\"user\", text))\n        # T27d"),
]
only=sys.argv[1:]
for name,f,a,b in M:
    if only and name not in only: continue
    p=pathlib.Path(f); s=p.read_text(); n=s.count(a)
    if n!=1: print(f"SKIP({n}) {name}",flush=True); continue
    p.write_text(s.replace(a,b,1))
    try: r=subprocess.run([UV,"run","--no-sync","pytest","-q","-x","-p","no:cacheprovider"],capture_output=True,text=True,timeout=900)
    finally: p.write_text(s)
    print(f"{'KILLED' if r.returncode!=0 else 'SURVIVED'} {name}",flush=True)
print("DONE")

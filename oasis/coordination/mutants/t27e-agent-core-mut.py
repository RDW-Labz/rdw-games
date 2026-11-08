import subprocess, pathlib, sys
UV="/private/tmp/oasis-t01-tools/bin/uv"
A="src/anorak/local_service_adapters.py"
T="tests/test_chat_search_first.py"
NEW="""                        messages.pop()
                        messages[0] = Message("system", system + "\\n\\n" + SEARCH_FIRST_NUDGE)
"""
M=[
("nudge back to user role",A,NEW,"""                        messages.append(Message("user", SEARCH_FIRST_NUDGE))
"""),
("nudge also in first request system",A,"""        messages = [Message("system", system)]
        if summary_text""","""        messages = [Message("system", system + "\\n\\n" + SEARCH_FIRST_NUDGE)]
        if summary_text"""),
("asking reply kept in retry context",A,"                        messages.pop()\n",""),
("Teams-refusal skip removed",A,"                    and not is_teams_refusal\n",""),
("Teams-pattern skip removed (text only)",A,"""    return TEAMS_SEND_UNAVAILABLE_TEXT in text or any(
        pattern.search(text) for pattern in _TEAMS_SEND_PATTERNS
    )""","""    return TEAMS_SEND_UNAVAILABLE_TEXT in text"""),
("nudge fires twice",A,"                        nudge_fired = True\n","                        nudge_fired = False\n"),
("echo helper weakened",T,"""    assert SEARCH_FIRST_NUDGE not in reply
    assert SEARCH_FIRST_NUDGE[:40] not in reply
""","""    return
"""),
("ack list emptied",T,"""        "i understand",
        "got it",
        "i appreciate the reminder",
        "understood",
        "noted",
""",""),
("person text into system (#73)",A,"        messages.append(Message(\"user\", text))\n        # T27d","        messages[0] = Message(\"system\", messages[0].content + \"\\n\" + text)\n        messages.append(Message(\"user\", text))\n        # T27d"),
("tool output into system (#73)",A,"""                seen_calls.add(call.id)
                messages.append(""","""                seen_calls.add(call.id)
                messages[0] = Message("system", messages[0].content + "\\n" + output)
                messages.append("""),
]
only=sys.argv[1:]
for name,f,a,b in M:
    if only and name not in only: continue
    p=pathlib.Path(f); s=p.read_text(); n=s.count(a)
    if n!=1: print(f"SKIP({n}) {name}",flush=True); continue
    p.write_text(s.replace(a,b,1))
    try: r=subprocess.run([UV,"run","--no-sync","pytest","-q","-x","-p","no:cacheprovider"],capture_output=True,text=True,timeout=900,env={**__import__("os").environ,"PYTHONDONTWRITEBYTECODE":"1"})
    finally: p.write_text(s)
    print(f"{'KILLED' if r.returncode!=0 else 'SURVIVED'} {name}",flush=True)
print("DONE")

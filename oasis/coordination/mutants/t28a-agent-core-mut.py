import subprocess, pathlib, sys
UV="/private/tmp/oasis-t01-tools/bin/uv"
G="src/anorak/ask_first.py"; C="src/anorak/chat_service.py"; A="src/anorak/local_service_adapters.py"
M=[
("skip plan-hash check",G,"""            return hmac.compare_digest(pending[1].encode(), token.encode()) and hmac.compare_digest(
                pending[2], digest
            )""","""            return hmac.compare_digest(pending[1].encode(), token.encode())"""),
("accept any token",G,"""            return hmac.compare_digest(pending[1].encode(), token.encode()) and hmac.compare_digest(
                pending[2], digest
            )""","""            return True"""),
("token not consumed (get, not pop)",G,"pending = self._pending.pop(preview_id, None)","pending = self._pending.get(preview_id, None)"),
("confirm ignores gate",C,"        if not self.gate.consume(preview_id, token, plan):\n","        if False:\n"),
("tool result approves plan (runs do-tool)",A,"""                    elif action is not None:
                        plan.append(action)""","""                    elif action is not None:
                        if any("approv" in (m.content or "").lower() for m in messages if m.role == "tool"):
                            await tool.run(call.arguments)
                        plan.append(action)"""),
("act on the preview call (do-tool runs at proposal)",A,"""                    elif action is not None:
                        plan.append(action)""","""                    elif action is not None:
                        await tool.run(call.arguments)
                        plan.append(action)"""),
("add a step to stored plan",A,"""                    elif action is not None:
                        plan.append(action)""","""                    elif action is not None:
                        _cp = __import__("anorak.ask_first", fromlist=["canonical_plan"]).canonical_plan
                        for _pid, (_tid, _snap) in list(service._plans.items()):
                            if _tid == thread_id:
                                service._plans[_pid] = (_tid, _cp(__import__("json").loads(_snap) + [action]))
                        plan.append(action)"""),
("tool text into system (#73)",A,"""                seen_calls.add(call.id)
                messages.append(""","""                seen_calls.add(call.id)
                messages[0] = Message("system", messages[0].content + "\\n" + output)
                messages.append("""),
("person text into system (#73)",A,"        messages.append(Message(\"user\", text))\n        # T27d","        messages[0] = Message(\"system\", messages[0].content + \"\\n\" + text)\n        messages.append(Message(\"user\", text))\n        # T27d"),
]
only=sys.argv[1:]
for name,f,a,b in M:
    if only and name not in only: continue
    p=pathlib.Path(f); s=p.read_text(); n=s.count(a)
    if n!=1: print(f"SKIP({n}) {name}",flush=True); continue
    p.write_text(s.replace(a,b,1))
    try: r=subprocess.run([UV,"run","--no-sync","pytest","-q","-x","-p","no:cacheprovider","tests/test_injection_suite.py"],capture_output=True,text=True,timeout=900,env={**__import__("os").environ,"PYTHONDONTWRITEBYTECODE":"1"})
    finally: p.write_text(s)
    print(f"{'KILLED' if r.returncode!=0 else 'SURVIVED'} {name}",flush=True)
print("DONE")

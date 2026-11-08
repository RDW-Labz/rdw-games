import subprocess, pathlib
H="src/components/useStickToBottom.ts"; C="src/components/Chat.tsx"; Q="src/quick/QuickApp.tsx"; P="src/components/PreviewCard.tsx"; S="scripts/preview-screens.ts"
M=[
("card-top rule off (hook)",H,"    if (card) {\n","    if (card && false) {\n"),
("card top uses scrollHeight (no scrollTop offset)",H,"const cardTop = cardRect.top - containerRect.top + el.scrollTop;","const cardTop = cardRect.top - containerRect.top;"),
("card-top for short cards too",H,"      if (cardRect.height > el.clientHeight) {","      if (true) {"),
("card never consumed (stale card reused)",C,"    pendingCardKeyRef.current = null;\n","\n"),
("quick: preview key never set",Q,"if (event.type === 'preview') pendingCardKeyRef.current =","if (false) pendingCardKeyRef.current ="),
("chat: preview key never set",C,"if (event.type === 'preview') pendingCardKeyRef.current =","if (false) pendingCardKeyRef.current ="),
("hint only when pending again",P,"{body && !compact && overflowing ? <p","{body && !compact && overflowing && false ? <p"),
("old hint wording",P,"Scroll to read the full email.","Scroll to read the full text."),
("hint in quick box too",P,"{body && !compact && overflowing ? <p","{body && overflowing ? <p"),
("harness exit 0 on failure",S,"  return screens.some((screen) => screen.consoleErrors.length > 0) ? 1 : 0;","  return 0;"),
("harness summary empty",S,"    .filter((screen) => screen.consoleErrors.length > 0)","    .filter(() => false)"),
]
for name,f,a,b in M:
    p=pathlib.Path(f); s=p.read_text(); n=s.count(a)
    if n!=1: print(f"SKIP({n}) {name}",flush=True); continue
    p.write_text(s.replace(a,b,1))
    try: r=subprocess.run(["npx","vitest","run","--bail=1","--reporter=dot"],capture_output=True,text=True,timeout=600)
    finally: p.write_text(s)
    print(('KILLED' if r.returncode else 'SURVIVED'), name, flush=True)

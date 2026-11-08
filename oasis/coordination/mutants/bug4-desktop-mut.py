import subprocess, pathlib
H="src/components/useStickToBottom.ts"; C="src/components/Chat.tsx"; Q="src/quick/QuickApp.tsx"
M=[
("48 px threshold ignored",H,"el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD_PX","el.scrollHeight - el.scrollTop - el.clientHeight <= 0"),
("pill never shows",H,"      setShowPill(true);\n      return;","      return;"),
("pill click does nothing (chat)",C,"<NewMessagePill onClick={scrollToBottom} />","<NewMessagePill onClick={() => {}} />"),
("pill click keeps pill",H,"    setShowPill(false);\n    const el = ref.current;","    const el = ref.current;"),
("own send doesn't scroll (chat)",C,"    setMessages((prev) => [...prev, { id: `you-${prev.length}`, from: 'you', text }]);\n    scrollToBottom();","    setMessages((prev) => [...prev, { id: `you-${prev.length}`, from: 'you', text }]);"),
("own send doesn't scroll (quick)",Q,"    setMessages((prev) => [...prev, { id: `you-${prev.length}`, from: 'you', text }]);\n    scrollToBottom();","    setMessages((prev) => [...prev, { id: `you-${prev.length}`, from: 'you', text }]);"),
("reduced motion ignored",H,"const behavior = reducedMotion() ? 'auto' : 'smooth';","const behavior = 'smooth' as ScrollBehavior;"),
("tall-card rule off",H,"if (addedHeight > el.clientHeight && addedHeight > 0) {","if (false) {"),
("scrolled-up still auto-scrolls",H,"    if (!stuckRef.current) {\n      lastHeightRef.current","    if (false) {\n      lastHeightRef.current"),
("intermediate programmatic events unstick",H,"      if (programmatic.reached?.()) clearProgrammatic(programmatic, el);\n      return;","      clearProgrammatic(programmatic, el);\n      return;"),
("programmatic never ends",H,"      if (programmatic.reached?.()) clearProgrammatic(programmatic, el);","      void 0;"),
("programmatic timeout never clears",H,"  state.timer = setTimeout(() => clearProgrammatic(state, el), PROGRAMMATIC_SCROLL_TIMEOUT_MS);","  state.timer = null;"),
("scrollend ignored",H,"  el.addEventListener('scrollend', handleScrollEnd);",""),
("card rendered after text (chat)",C,"<Fragment key={message.id}>{renderPlans(index, 'preview')}","<Fragment key={message.id}>"),
("card rendered after text (quick)",Q,"<Fragment key={message.id}>{renderPlans(index, 'preview')}","<Fragment key={message.id}>"),
("plan_report de-dup broken (chat)",C,"{message.from === 'agent' && visiblePlans.some((block) => block.frame.type === 'plan_report'","{false && visiblePlans.some((block) => block.frame.type === 'plan_report'"),
("plan_report de-dup broken (quick)",Q,"{message.from === 'agent' && visiblePlans.some((block) => block.frame.type === 'plan_report'","{false && visiblePlans.some((block) => block.frame.type === 'plan_report'"),
("report rendered before text (chat)",C,"</li>}{renderPlans(index, 'plan_report')}</Fragment>","</li>}</Fragment>"),
("streaming text doesn't count (quick)",Q,"messages.length + plans.length + reply.length","messages.length + plans.length"),
]
for name,f,a,b in M:
    p=pathlib.Path(f); s=p.read_text(); n=s.count(a)
    if n!=1: print(f"SKIP({n}) {name}",flush=True); continue
    p.write_text(s.replace(a,b,1))
    try: r=subprocess.run(["npx","vitest","run","--bail=1","--reporter=dot"],capture_output=True,text=True,timeout=600)
    finally: p.write_text(s)
    print(('KILLED' if r.returncode else 'SURVIVED'), name, flush=True)

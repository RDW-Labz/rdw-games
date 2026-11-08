import subprocess, pathlib, os, sys
A="src/App.tsx"; C="src/styles.css"; L="src/orb/looks.ts"; E="src/orb/avatarEngine.ts"; R="src/components/ChatRail.tsx"
K="scripts/check-contrast.ts"; T="src/design/theme.ts"; S="src/design/sound.ts"
M=[
("banner never shown",A,"const pauseBanner = status?.paused ? (","const pauseBanner = false ? ("),
("banner shown when not paused",A,"const pauseBanner = status?.paused ? (","const pauseBanner = true ? ("),
("banner Resume removed",A,"      <button type=\"button\" onClick={togglePause} disabled={pauseBusy}>Resume</button>\n    </section>","    </section>"),
("pause button gold outline removed",C,".app-rail .app-rail__pause { color: var(--oasis-text); min-height: var(--oasis-space-6); border: var(--oasis-size-2px) solid var(--oasis-accent); }",".app-rail .app-rail__pause { color: var(--oasis-text); min-height: var(--oasis-space-6); }"),
("paused no longer beats service state",L,"  if (status.paused) return 'paused';\n",""),
("paused appearance off",E,"return paused ? pausedAppearance(elapsed, reducedMotion) : undefined;","return undefined;"),
("reduced motion still breathes",E,"const breath = reducedMotion ? 0 :","const breath = false ? 0 :"),
("Untitled chat mapping removed",R,"? 'Untitled chat' : title","? title : title"),
("Chats search + New chat not one row",C,".chat-rail__tools { display: flex;",".chat-rail__tools { display: block;"),
("contrast gate off",K,"pair.ratio < pair.minimum","pair.ratio < 0"),
("theme override ignored",T,"return value === 'light' || value === 'dark' ? value : 'system';","return 'system';"),
("sound on by default",S,"return localStorage.getItem('sound') === 'true';","return localStorage.getItem('sound') !== 'false';"),
]
X=pathlib.Path(__file__).with_suffix(".extra")
if X.exists(): M+=[tuple(x.split("\t")) for x in X.read_text().splitlines() if x.strip()]
M.append(("remount: top-anchored cards back in their own array","src/quick/QuickApp.tsx","          {[\n            ...renderPlans(-1),\n","          {renderPlans(-1)}{[\n"))
env={**os.environ,"VITEST_SKIP_INSTALL_CHECKS":"1"}
for name,f,a,b in M:
    p=pathlib.Path(f); s=p.read_text(); n=s.count(a)
    if n!=1: print(f"SKIP({n}) {name}",flush=True); continue
    p.write_text(s.replace(a,b,1))
    try: r=subprocess.run(["npx","vitest","run"],capture_output=True,text=True,timeout=900,env=env)
    finally: p.write_text(s)
    print(f"{'KILLED' if r.returncode!=0 else 'SURVIVED'} {name}",flush=True)
print("DONE")

import subprocess, pathlib
S="src/styles.css"; Q="src/quick/quick.css"
M=[
("chat wrap rows unsized",S,".chat__list-wrap {\n  display: grid;\n  grid-template-rows: minmax(0, 1fr);\n",".chat__list-wrap {\n  display: grid;\n"),
("chat wrap cols unsized",S,"  grid-template-columns: minmax(0, 1fr);\n  flex: 1;\n  min-height: 0;\n}\n\n.chat__list-wrap > *","  flex: 1;\n  min-height: 0;\n}\n\n.chat__list-wrap > *"),
("quick wrap rows unsized",Q,".quick__list-wrap {\n  display: grid;\n  grid-template-rows: minmax(0, 1fr);\n",".quick__list-wrap {\n  display: grid;\n"),
("quick wrap cols unsized",Q,"  grid-template-columns: minmax(0, 1fr);\n  flex: 1;","  flex: 1;"),
("list align-self center again",S,"  align-self: stretch;\n  justify-self: center;","  align-self: center;"),
("full composer shrinkable",S,".app-main .chat__composer {\n  flex-shrink: 0;\n",".app-main .chat__composer {\n"),
("quick composer shrinkable",Q,"  display: flex;\n  flex-shrink: 0;\n  gap: var(--oasis-size-0-35rem);","  display: flex;\n  gap: var(--oasis-size-0-35rem);"),
("pill overlap cell removed",S,".chat__list-wrap > * {\n  grid-area: 1 / 1;",".chat__list-wrap > * {\n"),
]
for name,f,a,b in M:
    p=pathlib.Path(f); s=p.read_text(); n=s.count(a)
    if n!=1: print(f"SKIP({n}) {name}",flush=True); continue
    p.write_text(s.replace(a,b,1))
    try: r=subprocess.run(["npx","vitest","run","--bail=1","--reporter=dot"],capture_output=True,text=True,timeout=600)
    finally: p.write_text(s)
    print(('KILLED' if r.returncode else 'SURVIVED'), name, flush=True)

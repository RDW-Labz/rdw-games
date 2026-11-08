import subprocess, pathlib, sys, os
S="tools/swarm.mjs"; I="tools/install.mjs"
M=[
("update/version allow --root",S,"if(rootIndex!==-1&&['version','update'].includes(args[0]))fail(","if(false&&rootIndex!==-1&&['version','update'].includes(args[0]))fail("),
("seeding overwrites existing files",I,"{flag:'wx'});\n   added.push(to);","{flag:'w'});\n   added.push(to);"),
("pointer block appended every time (not replaced)",I,"  after=before.slice(0,start)+block+before.slice(end+AGENT_END.length);","  after=before+'\\n'+block;"),
("pointer clobbers user text",I,"else after=before?before+(before.endsWith('\\n')?'':'\\n')+'\\n'+rendered.slice(rendered.indexOf(AGENT_START)):rendered;","else after=rendered;"),
("malformed markers accepted",I,"throw Error(`Malformed project-swarm markers: ${relative}`);","void 0;"),
]
env={**os.environ,"HOME":os.path.abspath(".tmp-e2e/muthome"),"TMPDIR":os.path.abspath(".tmp-e2e/muttmp"),"SWARM_LIVE_DIR":os.path.abspath(".tmp-e2e/mutlive")}
for d in ("muthome","muttmp","mutlive"): os.makedirs(f".tmp-e2e/{d}",exist_ok=True)
for name,f,a,b in M:
    p=pathlib.Path(f); s=p.read_text(); n=s.count(a)
    if n!=1: print(f"SKIP({n}) {name}",flush=True); continue
    p.write_text(s.replace(a,b,1))
    try: r=subprocess.run(["npm","test"],capture_output=True,text=True,timeout=900,env=env)
    finally: p.write_text(s)
    print(f"{'KILLED' if r.returncode!=0 else 'SURVIVED'} {name}",flush=True)
print("DONE")

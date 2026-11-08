import subprocess, pathlib, sys
UV="/private/tmp/oasis-t01-tools/bin/uv"
V="src/almanac/validate.py"
R6='if pending and (category == "write" or step_id in risky_steps or step_id in always_ask):'
M=[
('rule1 unknown tool allowed',V,'        if category is None:\n','        if category is None and False:\n'),
('model prefix off',V,'    if name.startswith("model."):\n        return "model"\n',''),
('tool name keeps args',V,'return do.split("(", 1)[0].strip()','return do.strip()'),
('rule2 read without reader ok',V,'if category == "read" and role != "reader":','if False:'),
('rule3 reader write ok',V,'if role == "reader" and category == "write":','if False:'),
('rule4 unroled model ok',V,'if category == "model" and role is None and pending:','if False:'),
('rule5 critic non-model ok',V,'            if category != "model":\n','            if False:\n'),
('rule5 missing reader ok',V,'                    if reader_id not in seen:','                    if False:'),
('rule5 non-reader id ok',V,'                    if check_id not in readers:','                    if False:'),
('rule5 dup ok',V,'                    if check_id in seen:','                    if False:'),
('rule5 empty checks ok',V,'if not isinstance(checks, list) or not checks:','if not isinstance(checks, list):'),
('rule6 write after reader ok',V,R6,'if pending and (step_id in risky_steps or step_id in always_ask):'),
('rule6 risky after reader ok',V,R6,'if pending and (category == "write" or step_id in always_ask):'),
('rule6 always_ask after reader ok',V,R6,'if pending and (category == "write" or step_id in risky_steps):'),
('critic does not clear U',V,'        if role == "critic":\n            pending.clear()\n',''),
('reader not pending',V,'            pending.add(step_id)\n',''),
('rule7 bad role ok',V,'if role is not None and role not in _VALID_ROLES:','if False:'),
('rule7 checks non-critic ok',V,'if checks is not None and role != "critic":','if False:'),
('cli always 0',V,'        if errors:\n            exit_code = 1\n',''),
]
only=sys.argv[1:]; out=[]
for name,f,a,b in M:
    if only and name not in only: continue
    p=pathlib.Path(f); s=p.read_text(); n=s.count(a)
    if n!=1: out.append(f"SKIP({n}) {name}"); print(out[-1],flush=True); continue
    p.write_text(s.replace(a,b,1))
    try: r=subprocess.run([UV,"run","--no-sync","pytest","-q","-x","-p","no:cacheprovider"],capture_output=True,text=True,timeout=600)
    finally: p.write_text(s)
    out.append(f"{'KILLED' if r.returncode!=0 else 'SURVIVED'} {name}"); print(out[-1],flush=True)
print("DONE")

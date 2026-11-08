import subprocess, pathlib, sys
UV="/private/tmp/oasis-t01-tools/bin/uv"
L="src/anorak/loop.py"
M=[
('any role accepted',L,'if has_role and role not in ("reader", "critic"):','if False:'),
('checks on non-critic accepted',L,'            if role != "critic":\n                raise','            if False:\n                raise'),
('non-list checks accepted',L,'not isinstance(raw_checks, list)\n','False\n'),
('empty checks accepted',L,'                or not raw_checks\n','                or False\n'),
('duplicate checks accepted',L,'if len(set(raw_checks)) != len(raw_checks):','if False:'),
('unknown/later id accepted',L,'if check_id not in seen_ids:','if False:'),
('non-reader id accepted',L,'if roles[check_id] != "reader":','if roles.get(check_id, "reader") != "reader" and False:'),
('critic without checks accepted',L,'        elif role == "critic":\n            raise','        elif False:\n            raise'),
('extra unknown key accepted',L,'if not _STEP_KEYS <= keys or keys - _STEP_OPTIONAL_KEYS:','if not _STEP_KEYS <= keys:'),
('role dropped from Step',L,'parsed.append(Step(step_id, s["do"], role, checks))','parsed.append(Step(step_id, s["do"], None, checks))'),
('checks dropped from Step',L,'parsed.append(Step(step_id, s["do"], role, checks))','parsed.append(Step(step_id, s["do"], role, ()))'),
('generic message (no step id)',L,'    except _StepFieldError as exc:\n        raise ValueError(str(exc)) from None\n',''),
('seen_ids recorded early (self-check)',L,'        parsed.append(Step(step_id, s["do"], role, checks))\n        seen_ids.add(step_id)\n        roles[step_id] = role\n','        parsed.append(Step(step_id, s["do"], role, checks))\n        seen_ids.add(step_id)\n        roles[step_id] = "reader"\n'),
]
only=sys.argv[1:]; out=[]
for name,f,a,b in M:
    if only and name not in only: continue
    p=pathlib.Path(f); s=p.read_text(); n=s.count(a)
    if n!=1: out.append(f"SKIP({n}) {name}"); print(out[-1],flush=True); continue
    p.write_text(s.replace(a,b,1))
    try: r=subprocess.run([UV,"run","--no-sync","pytest","-q","-x","-p","no:cacheprovider","tests/test_loop_roles.py","tests/test_loop.py","tests/test_loop_prior.py","tests/test_skill_tools.py","tests/test_daily_summary.py"],capture_output=True,text=True,timeout=600)
    finally: p.write_text(s)
    out.append(f"{'KILLED' if r.returncode!=0 else 'SURVIVED'} {name}"); print(out[-1],flush=True)
print("DONE")

import subprocess, pathlib, os
UV="/private/tmp/oasis-t01-tools/bin/uv"
L="src/anorak/local_service.py"
M=[
("first_name key removed from /status",L,'                "first_name": self._first_name(),\n',''),
("full name instead of first word",L,"_optional_plain_text(words[0][:_FIRST_NAME_MAX_CHARS]","_optional_plain_text(' '.join(words)[:_FIRST_NAME_MAX_CHARS]"),
("control characters not stripped",L,"words = name.translate(_STRIP_CONTROL).split()","words = name.split()"),
("load errors propagate",L,"        except Exception:\n            return None\n\n    def _service_state","        except ZeroDivisionError:\n            return None\n\n    def _service_state"),
("blank name gives empty string",L,"            if not words:\n                return None","            if not words:\n                return ''"),
("no length cap",L,"(words[0][:_FIRST_NAME_MAX_CHARS], _FIRST_NAME_MAX_CHARS * 4)","(words[0], 100000)"),
]
env={**os.environ,"PYTHONDONTWRITEBYTECODE":"1"}
for name,f,a,b in M:
    p=pathlib.Path(f); s=p.read_text(); n=s.count(a)
    if n!=1: print(f"SKIP({n}) {name}",flush=True); continue
    p.write_text(s.replace(a,b,1))
    try: r=subprocess.run([UV,"run","--no-sync","pytest","-q","-x","-p","no:cacheprovider","tests/test_local_service.py","tests/test_service_cli.py"],capture_output=True,text=True,timeout=900,env=env)
    finally: p.write_text(s)
    print(f"{'KILLED' if r.returncode!=0 else 'SURVIVED'} {name}",flush=True)
print("DONE")

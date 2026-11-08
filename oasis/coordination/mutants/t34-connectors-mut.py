import subprocess, pathlib, sys
UV="/private/tmp/oasis-t01-tools/bin/uv"
GR="src/gates/graph_read.py"; GW="src/gates/graph_write.py"; GA="src/gates/google_api.py"
M=[
('_ACTIONS drops send_mail','src/gates/audit.py','        "send_mail",\n',''),
('_ACTIONS drops reply_mail','src/gates/audit.py','        "reply_mail",\n',''),
('_ACTIONS drops move_mail','src/gates/audit.py','        "move_mail",\n',''),
('_ACTIONS drops search_mail','src/gates/audit.py','        "search_mail",\n',''),
('gmail_send no started',GA,'audit.append_event(connector.name, person, "send_mail", "started", operation_id)','None'),
('gmail_send no succeeded',GA,'audit.append_event(connector.name, person, "send_mail", "succeeded", operation_id)','None'),
('gmail_reply skips failed',GA,'audit.append_event(connector.name, person, "reply_mail", "failed", operation_id)','None'),
('gmail_move no succeeded',GA,'audit.append_event(connector.name, person, "move_mail", "succeeded", operation_id)','None'),
('gcal_delete no started',GA,'audit.append_event(connector.name, person, "delete_event", "started", operation_id)','None'),
('drive_share no started',GA,'audit.append_event(connector.name, person, "share_file", "started", operation_id)','None'),
('outlook move_mail skips succeeded',GW,'audit.append_event(connector.name, person, "move_mail", "succeeded", operation_id)','None'),
('outlook reply_mail skips failed',GW,'audit.append_event(connector.name, person, "reply_mail", "failed", operation_id)','None'),
('address in record','src/gates/audit.py','"data": {"connector": connector, "person": person},','"data": {"connector": connector, "person": person, "to": "pat@example.test"},'),
('gmail_send different op ids',GA,'audit.append_event(connector.name, person, "send_mail", "succeeded", operation_id)','audit.append_event(connector.name, person, "send_mail", "succeeded", str(uuid.uuid4()))'),
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

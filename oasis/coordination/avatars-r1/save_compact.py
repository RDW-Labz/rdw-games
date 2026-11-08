"""save_compact.py <theme> "idx:HHMMSS idx:nsfw ..." — job ids come from jobs.json; URL prefix is fixed."""
import json, os, sys
PRE = "https://d8j0ntlcm91z4.cloudfront.net/user_3IpmhCUzzK8mE7oJBXXabQzQplr/hf_20260928_"
theme, spec = sys.argv[1], sys.argv[2]
ids = json.load(open('jobs.json'))[theme]
R = json.load(open('results.json')) if os.path.exists('results.json') else {}
out = {}
for tok in spec.split():
    i, v = tok.split(':'); i = int(i)
    if v.isdigit():
        out[str(i)] = {'job_id': ids[i], 'status': 'completed', 'url': f"{PRE}{v}_{ids[i]}.png"}
    else:
        out[str(i)] = {'job_id': ids[i], 'status': v, 'url': None}
R[theme] = out; json.dump(R, open('results.json', 'w'), indent=1)
print(theme, len(out), [k for k, x in out.items() if x['status'] != 'completed'])

"""Append jobs_wait output (stdin JSON) for one theme to results.json."""
import json, os, sys
theme = sys.argv[1]
data = json.load(sys.stdin)
p = 'results.json'
R = json.load(open(p)) if os.path.exists(p) else {}
R[theme] = {str(j['index']): {'job_id': j['job_id'], 'status': j['status'], 'url': j.get('result_url')} for j in data['jobs']}
json.dump(R, open(p, 'w'), indent=1)
print(theme, {s: sum(1 for v in R[theme].values() if v['status'] == s) for s in set(v['status'] for v in R[theme].values())})

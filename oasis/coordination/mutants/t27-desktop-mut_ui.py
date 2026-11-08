import subprocess, pathlib
PC="src/components/PreviewCard.tsx"; PR="src/components/PlanReport.tsx"; SC="src/lib/serviceClient.ts"
M=[
("card double-send guard removed",PC,"    if (sent.current || submitted || result) return;\n    sent.current = true;","    if (submitted || result) return;"),
("client dedupe removed",SC,"      if (confirmed.has(key)) return;\n",""),
("No sends yes",PC,"onClick={() => choose('no')}","onClick={() => choose('yes')}"),
("confirm payload extra key",PC,"token: preview.token, answer: next });","token: preview.token, answer: next, text: preview.summary } as ConfirmFrame);"),
("confirm uses wrong token",PC,"token: preview.token, answer: next","token: preview.preview_id, answer: next"),
("Undo double-send guard removed",PR,"      if (sent.current || submitted) return;\n      sent.current = true;","      if (submitted) return;"),
("Undo sends plan preview id",PR,"preview_id: undo.preview_id, token: undo.token","preview_id: threadId, token: undo.token"),
("Undo sends no",PR,"token: undo.token, answer: 'yes' }","token: undo.token, answer: 'no' }"),
("http links allowed",PR,"new URL(link).protocol === 'https:'","/^https?:$/.test(new URL(link).protocol)"),
("quick opens externally",PR,"if (onOpenFullChat) { onOpenFullChat(); return; } ",""),
("done without ok",PC,"{outcome.ok === true ? '✓' :","{outcome ? '✓' :"),
("Yes before plan",PC,"""    <ol className="plan-card__steps">""","""    {!result ? <div className="plan-card__actions"><button className="plan-card__yes" type="button" onClick={() => choose('yes')}>Yes</button></div> : null}\n    <ol className="plan-card__steps">"""),
("expired keeps buttons",PC,"      {!result ? <div className=\"plan-card__actions\">","      {result?.type !== 'confirmed' ? <div className=\"plan-card__actions\">"),
("unknown frames passed through",SC,"if (parsed && ['chunk', 'done', 'error', 'preview', 'confirmed', 'declined', 'expired', 'plan_report'].includes(parsed.type)) onEvent(parsed);","if (parsed) onEvent(parsed);"),
("report text rendered as HTML",PR,"""  return <section className="plan-card plan-report\"""","""  return <section dangerouslySetInnerHTML={undefined} className="plan-card plan-report\""""),
]
for name,f,a,b in M:
    p=pathlib.Path(f); s=p.read_text(); n=s.count(a)
    if n!=1: print(f"SKIP({n}) {name}",flush=True); continue
    p.write_text(s.replace(a,b,1))
    try: r=subprocess.run(["npx","vitest","run","--bail=1","--reporter=dot"],capture_output=True,text=True,timeout=600)
    finally: p.write_text(s)
    print(('KILLED' if r.returncode else 'SURVIVED'), name, flush=True)

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { href, go } from '@/lib/router';
import { useEnter, useScrollReveal } from '@/lib/motion';
import { useToast } from '@/lib/toast';
import type { Category, Lesson, LessonInput, QuizQuestion } from '@/lib/types';
import { Button, EmptyNote, Field, LoadingSheet, Toggle } from '@/components/ui/kit';
import { Container, Folder, PageHero } from '@/components/ui/layout';
import { Confirm, Modal } from '@/components/ui/Modal';
import { Check, Clipboard, Cross, Edit, Eye, Hand as HandGlyph, Loop, Minus, Plus, Trash } from '@/components/ui/Glyph';
import { LessonDetail } from '@/components/employee/LessonDetail';
import { IsoArt, kindForCategory } from '@/components/art/IsoArt';


export function Lessons({ route }: { route: string[] }) {
  if (route[1] === 'preview' && route[2]) return <LessonDetail lessonId={route[2]} preview />;
  return <Library startNew={route[1] === 'new'} />;
}

function Library({ startNew }: { startNew: boolean }) {
  const toast = useToast();
  const [cats, setCats] = useState<Category[] | null>(null);
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [editing, setEditing] = useState<Lesson | 'new' | null>(startNew ? 'new' : null);
  const [managingCats, setManagingCats] = useState(false);
  const [confirm, setConfirm] = useState<{ kind: 'retrain' | 'delete'; lesson: Lesson } | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useEnter<HTMLDivElement>([cats === null]);
  const listRef = useScrollReveal<HTMLDivElement>([cats, lessons]);

  const load = useCallback(async () => {
    const [c, l] = await Promise.all([api.categories(), api.lessons()]);
    setCats(c);
    setLessons(l);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function runConfirm() {
    if (!confirm) return;
    setBusy(true);
    try {
      if (confirm.kind === 'retrain') {
        await api.requireRetraining(confirm.lesson.id);
        toast.push(`Everyone retakes “${confirm.lesson.title}”`);
      } else {
        await api.deleteLesson(confirm.lesson.id);
        toast.push(`Deleted “${confirm.lesson.title}”`);
      }
      await load();
      setConfirm(null);
    } catch {
      toast.push('That did not work. Try again.', 'error');
    }
    setBusy(false);
  }

  return (
    <div ref={ref}>
      <PageHero size="lg" title="Lesson library" left={`${lessons.length} lessons`} right={`${cats?.length ?? 0} categories`}>
        <Button variant="cream" onClick={() => setManagingCats(true)} icon={<Clipboard size={14} />} tile="#283f7d">
          Categories
        </Button>
      </PageHero>

      <Container>
        <div ref={listRef}>
          {cats === null ? (
            <LoadingSheet />
          ) : cats.length === 0 ? (
            <EmptyNote title="Start with a category." note="like Floor Safety or Checkout">
              <Button onClick={() => setManagingCats(true)}>Add a category</Button>
            </EmptyNote>
          ) : (
            cats.map((cat, ci) => {
              const list = lessons.filter((l) => l.category_id === cat.id);
              return (
                <Folder key={cat.id} tab={`Section ${String(ci + 1).padStart(2, '0')}`} tone={ci % 2 ? 'deep' : 'manila'} className="mt-20">
                  <div className="mb-8 flex items-end justify-between gap-4">
                    <div>
                      <h2 className="title text-[34px] md:text-[52px]">{cat.name}</h2>
                      {cat.description && <p className="lede mt-2 text-[16px] md:text-[18px]">{cat.description}</p>}
                    </div>
                    <IsoArt kind={kindForCategory(cat.name)} size={140} className="-mt-6 hidden md:block" />
                  </div>
                  {list.length === 0 ? (
                    <p className="mono border border-dashed border-ink-dash/60 px-4 py-6 text-center text-[13px] text-ink-2">No lessons in this category yet.</p>
                  ) : (
                    <div className="grid gap-x-5 gap-y-8 pt-2 sm:grid-cols-2 lg:grid-cols-3">
                      {list.map((l, i) => {
                        const rot = [-1.2, 0.9, -0.5, 1.3, -0.9][(i + ci) % 5];
                        const updated = l.version > 1;
                        return (
                          <article key={l.id} data-reveal className="relative flex min-h-[300px] flex-col bg-[#f4eee4] p-6 pt-7 text-ink transition-transform duration-700 ease-joe-out hover:z-[2] hover:-translate-y-2" style={{ transform: `rotate(${rot}deg)`, boxShadow: 'var(--shadow-sheet)', border: '1px solid rgba(66,66,66,.18)' }}>
                            <div className="flex items-start justify-between gap-3">
                              <span className="mono text-[12px] uppercase tracking-[0.06em] text-ink-2">{l.quiz_questions.length} questions</span>
                              {l.requires_practical && (
                                <span className="mono flex items-center gap-1 text-[11px] uppercase tracking-[0.05em] text-navy">
                                  <HandGlyph size={12} /> Hands-on
                                </span>
                              )}
                            </div>
                            <h3 className="mt-4 min-h-[2.1em] text-[26px] font-medium leading-[1.05] tracking-[-0.03em]">{l.title}</h3>
                            <p className="mt-3 text-[15px] leading-snug text-[#575757]">{l.summary}</p>
                            <dl className="mt-4 grid grid-cols-3 border-y border-dashed border-ink-dash/50 py-2.5">
                              {[
                                ['Steps', String(l.instructions.split('\n').filter(Boolean).length)],
                                ['Pass', `${l.passing_score}/${l.quiz_questions.length}`],
                                ['Ver', `v${l.version}`],
                              ].map(([k, v]) => (
                                <div key={k} className="border-r border-dashed border-ink-dash/40 px-2 first:pl-0 last:border-r-0">
                                  <dt className="mono text-[10px] uppercase tracking-[0.06em] text-ink-2">{k}</dt>
                                  <dd className="mono mt-0.5 text-[15px] text-ink">{v}</dd>
                                </div>
                              ))}
                            </dl>
                            {updated && (
                              <span className="mono mt-3 inline-flex w-fit items-center gap-1.5 bg-signal-orange px-2 py-1 text-[11px] uppercase tracking-[0.05em] text-white" style={{ borderRadius: 2 }}>
                                <Loop size={11} /> Updated · staff retraining
                              </span>
                            )}
                            <div className="mt-auto flex items-start gap-2 pt-6">
                              <Button size="sm" variant="cream" onClick={() => setEditing(l)} icon={<Edit size={12} />} className="flex-1 justify-center" style={{ height: 44 }}>
                                Edit
                              </Button>
                              {[
                                { k: 'Preview', icon: <Eye size={15} />, href: href(`lessons/preview/${l.id}`), cls: '' },
                                { k: 'Retrain', icon: <Loop size={15} />, on: () => setConfirm({ kind: 'retrain', lesson: l }), cls: '!text-navy' },
                                { k: 'Delete', icon: <Trash size={15} />, on: () => setConfirm({ kind: 'delete', lesson: l }), cls: '!text-[#b2352c]' },
                              ].map((a) => (
                                <span key={a.k} className="flex flex-col items-center gap-1">
                                  {a.href ? (
                                    <a href={a.href} className={`square-btn !h-11 !w-11 ${a.cls}`} aria-label={`${a.k} ${l.title}`}>
                                      {a.icon}
                                    </a>
                                  ) : (
                                    <button onClick={a.on} className={`square-btn !h-11 !w-11 ${a.cls}`} aria-label={`${a.k} ${l.title}`}>
                                      {a.icon}
                                    </button>
                                  )}
                                  <span className="mono text-[10.5px] uppercase tracking-[0.05em] text-ink-2">{a.k}</span>
                                </span>
                              ))}
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  )}
                </Folder>
              );
            })
          )}
        </div>
      </Container>

      {editing && cats && (
        <LessonEditor
          lesson={editing === 'new' ? null : editing}
          categories={cats}
          onClose={() => {
            setEditing(null);
            if (startNew) go('lessons');
          }}
          onSaved={load}
        />
      )}
      <CategoriesManager open={managingCats} categories={cats ?? []} onClose={() => setManagingCats(false)} onSaved={load} />
      <Confirm
        open={!!confirm}
        onClose={() => setConfirm(null)}
        busy={busy}
        danger
        title={confirm?.kind === 'retrain' ? 'Require retraining?' : 'Delete this lesson?'}
        confirmLabel={confirm?.kind === 'retrain' ? 'Everyone retakes it' : 'Delete lesson'}
        onConfirm={runConfirm}
        body={
          confirm?.kind === 'retrain' ? (
            <>Everyone assigned <b className="text-ink">{confirm?.lesson.title}</b> will need to read it again, retake the quiz and sign. Hands-on sign-offs stay.</>
          ) : (
            <>This removes <b className="text-ink">{confirm?.lesson.title}</b>, its assignments and everyone&rsquo;s progress on it. This can&rsquo;t be undone.</>
          )
        }
      />
    </div>
  );
}

const blankQ = (): QuizQuestion => ({ question: '', options: ['', ''], answer_index: 0 });

function LessonEditor({ lesson, categories, onClose, onSaved }: { lesson: Lesson | null; categories: Category[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const [f, setF] = useState<LessonInput>(() => ({
    category_id: lesson?.category_id ?? categories[0]?.id ?? '',
    title: lesson?.title ?? '',
    summary: lesson?.summary ?? '',
    instructions: lesson?.instructions ?? '',
    video_url: lesson?.video_url ?? '',
    screenshot_urls: lesson?.screenshot_urls ?? [],
    requires_practical: lesson?.requires_practical ?? false,
    practical_notes: lesson?.practical_notes ?? '',
    quiz_questions: lesson?.quiz_questions?.length ? lesson.quiz_questions : [blankQ()],
    passing_score: lesson?.passing_score ?? 1,
    sort_order: lesson?.sort_order ?? 0,
  }));
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof LessonInput>(k: K, v: LessonInput[K]) => setF((s) => ({ ...s, [k]: v }));
  const setQ = (i: number, q: Partial<QuizQuestion>) => set('quiz_questions', f.quiz_questions.map((x, j) => (j === i ? { ...x, ...q } : x)));

  const problems = [
    !f.title.trim() && 'Add a title',
    f.quiz_questions.some((q) => !q.question.trim() || q.options.some((o) => !o.trim())) && 'Fill in every question and answer',
    f.passing_score > f.quiz_questions.length && 'Passing score is higher than the number of questions',
  ].filter(Boolean) as string[];

  async function save() {
    if (problems.length) return;
    setBusy(true);
    try {
      await api.saveLesson({ ...f, passing_score: Math.max(1, f.passing_score) }, lesson?.id);
      toast.push(lesson ? 'Lesson saved' : 'Lesson created');
      await onSaved();
      onClose();
    } catch {
      toast.push('Could not save the lesson.', 'error');
    }
    setBusy(false);
  }

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={lesson ? 'Edit lesson' : 'New lesson'}
      kicker={lesson ? `Version ${lesson.version}` : 'Draft'}
      footer={
        <>
          {problems.length > 0 && <span className="hand col-span-2 mr-auto self-center text-[15px] text-[#b2352c]">{problems[0]}</span>}
          <Button variant="cream" icon={false} onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy || problems.length > 0} icon={<Check size={14} />}>
            {busy ? 'Saving…' : 'Save lesson'}
          </Button>
        </>
      }
    >
      <div className="space-y-10">
        <section className="space-y-5">
          <div className="label text-ink">01 · Basics</div>
          <div className="grid gap-5 md:grid-cols-[1fr_1.4fr]">
            <Field label="Category">
              <select className="field" value={f.category_id} onChange={(e) => set('category_id', e.target.value)}>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Title">
              <input className="field" value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="e.g. Pallet jack basics" />
            </Field>
          </div>
          <Field label="Summary" hint="one sentence">
            <input className="field" value={f.summary} onChange={(e) => set('summary', e.target.value)} placeholder="What they will be able to do" />
          </Field>
          <Field label="Steps" hint="one step per line">
            <textarea className="field min-h-[150px]" value={f.instructions} onChange={(e) => set('instructions', e.target.value)} placeholder={'Check the forks…\nCenter the forks…'} />
          </Field>
        </section>

        <section className="space-y-5 border-t border-dashed border-ink-dash/50 pt-8">
          <div className="label text-ink">02 · Media</div>
          <Field label="Video link" hint="YouTube or uploaded file URL">
            <input className="field" value={f.video_url} onChange={(e) => set('video_url', e.target.value)} placeholder="https://youtube.com/watch?v=…" />
          </Field>
          <Field label="Diagrams + screenshots" hint="one image URL per line">
            <textarea className="field min-h-[80px] font-mono text-[13px]" value={f.screenshot_urls.filter((u) => !u.startsWith('data:')).join('\n')} onChange={(e) => set('screenshot_urls', [...f.screenshot_urls.filter((u) => u.startsWith('data:')), ...e.target.value.split('\n').map((s) => s.trim()).filter(Boolean)])} placeholder="https://…" />
          </Field>
        </section>

        <section className="space-y-5 border-t border-dashed border-ink-dash/50 pt-8">
          <div className="label text-ink">03 · Hands-on</div>
          <Toggle checked={f.requires_practical} onChange={(v) => set('requires_practical', v)} label="Needs a hands-on sign-off" sub="A manager watches them do the task before they qualify." />
          {f.requires_practical && (
            <Field label="What the manager checks">
              <input className="field" value={f.practical_notes} onChange={(e) => set('practical_notes', e.target.value)} placeholder="e.g. Moves a full pallet 30 ft and parks forks-down" />
            </Field>
          )}
        </section>

        <section className="border-t border-dashed border-ink-dash/50 pt-8">
          <div className="mb-5 flex items-center justify-between">
            <div className="label text-ink">04 · Quiz</div>
            <label className="mono flex items-center gap-2 text-[12px] text-ink-2">
              Pass with
              <input type="number" min={1} max={f.quiz_questions.length} value={f.passing_score} onChange={(e) => set('passing_score', Number(e.target.value))} className="field !h-9 !w-16 !px-2 text-center" />
              of {f.quiz_questions.length}
            </label>
          </div>
          <ol className="space-y-5">
            {f.quiz_questions.map((q, qi) => (
              <li key={qi} className="relative border border-ink-rule/30 bg-sheet-2 p-4 md:p-5" style={{ borderRadius: 2 }}>
                <div className="flex items-start gap-3">
                  <span className="mono mt-2.5 flex h-7 w-7 flex-none items-center justify-center bg-ink text-[12px] text-white" style={{ borderRadius: 2 }}>
                    {qi + 1}
                  </span>
                  <input className="field" value={q.question} onChange={(e) => setQ(qi, { question: e.target.value })} placeholder="Question" aria-label={`Question ${qi + 1}`} />
                  <button type="button" onClick={() => set('quiz_questions', f.quiz_questions.filter((_, j) => j !== qi))} disabled={f.quiz_questions.length === 1} className="square-btn mt-1 flex-none disabled:opacity-30" aria-label="Remove question">
                    <Trash size={13} />
                  </button>
                </div>
                <div className="mt-3 space-y-2 pl-10">
                  {q.options.map((o, oi) => (
                    <div key={oi} className="flex items-center gap-2">
                      <button type="button" onClick={() => setQ(qi, { answer_index: oi })} className="choice-box !h-10 !w-10" style={q.answer_index === oi ? { background: '#5a7d4a', color: '#fff', borderStyle: 'solid', borderColor: 'transparent' } : undefined} aria-label={`Mark answer ${String.fromCharCode(65 + oi)} correct`} aria-pressed={q.answer_index === oi}>
                        {q.answer_index === oi ? <Check size={14} /> : String.fromCharCode(65 + oi)}
                      </button>
                      <input className="field !h-10" value={o} onChange={(e) => setQ(qi, { options: q.options.map((x, j) => (j === oi ? e.target.value : x)) })} placeholder={`Answer ${String.fromCharCode(65 + oi)}`} />
                      <button type="button" disabled={q.options.length <= 2} onClick={() => setQ(qi, { options: q.options.filter((_, j) => j !== oi), answer_index: q.answer_index >= oi && q.answer_index > 0 ? q.answer_index - 1 : q.answer_index })} className="text-ink-3 hover:text-ink disabled:opacity-20" aria-label="Remove answer">
                        <Minus size={14} />
                      </button>
                    </div>
                  ))}
                  <div className="flex items-center justify-between pt-1">
                    {q.options.length < 5 ? (
                      <button type="button" onClick={() => setQ(qi, { options: [...q.options, ''] })} className="mono flex items-center gap-1.5 text-[12px] text-navy hover:underline">
                        <Plus size={11} /> Add answer
                      </button>
                    ) : (
                      <span />
                    )}
                    <span className="hand text-[13px]">tap a letter to mark the right answer</span>
                  </div>
                </div>
              </li>
            ))}
          </ol>
          <button type="button" onClick={() => set('quiz_questions', [...f.quiz_questions, blankQ()])} className="mono mt-4 flex w-full items-center justify-center gap-2 border border-dashed border-ink-dash/60 py-4 text-[13px] text-ink-2 transition-colors hover:bg-sheet-2 hover:text-ink" style={{ borderRadius: 2 }}>
            <Plus size={12} /> Add question
          </button>
        </section>
      </div>
    </Modal>
  );
}

function CategoriesManager({ open, categories, onClose, onSaved }: { open: boolean; categories: Category[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [edit, setEdit] = useState<{ id: string; name: string; description: string } | null>(null);
  const [del, setDel] = useState<Category | null>(null);
  const [busy, setBusy] = useState(false);

  async function add() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await api.addCategory(name.trim(), desc.trim());
      setName('');
      setDesc('');
      toast.push('Category added');
      await onSaved();
    } catch {
      toast.push('Could not add it. That name may already exist.', 'error');
    }
    setBusy(false);
  }
  async function saveEdit() {
    if (!edit) return;
    setBusy(true);
    try {
      await api.updateCategory(edit.id, edit.name.trim(), edit.description.trim());
      setEdit(null);
      await onSaved();
    } catch {
      toast.push('Could not save.', 'error');
    }
    setBusy(false);
  }
  async function remove() {
    if (!del) return;
    setBusy(true);
    try {
      await api.deleteCategory(del.id);
      toast.push(`Deleted ${del.name}`);
      setDel(null);
      await onSaved();
    } catch {
      toast.push('Could not delete.', 'error');
    }
    setBusy(false);
  }

  return (
    <>
      <Modal open={open && !del} onClose={onClose} title="Categories" kicker="Lesson library">
        <ul className="mb-8">
          {categories.map((c, i) => (
            <li key={c.id} className="flex items-center gap-3 border-b border-dashed border-ink-dash py-3">
              <span className="mono flex h-7 w-7 flex-none items-center justify-center border border-ink-rule text-[11px]" style={{ borderRadius: 2 }}>
                {String(i + 1).padStart(2, '0')}
              </span>
              {edit?.id === c.id ? (
                <div className="flex flex-1 flex-col gap-2 md:flex-row">
                  <input className="field !h-10" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} aria-label="Category name" />
                  <input className="field !h-10" value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} aria-label="Description" />
                  <div className="flex gap-2">
                    <button onClick={saveEdit} disabled={busy} className="square-btn !text-[#5a7d4a]" aria-label="Save">
                      <Check size={14} />
                    </button>
                    <button onClick={() => setEdit(null)} className="square-btn" aria-label="Cancel">
                      <Cross size={12} />
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="min-w-0 flex-1">
                    <div className="text-[17px] font-medium tracking-tightish">{c.name}</div>
                    {c.description && <div className="truncate text-[13px] text-ink-2">{c.description}</div>}
                  </div>
                  <button onClick={() => setEdit({ id: c.id, name: c.name, description: c.description })} className="square-btn" aria-label={`Edit ${c.name}`}>
                    <Edit size={13} />
                  </button>
                  <button onClick={() => setDel(c)} className="square-btn !text-[#b2352c]" aria-label={`Delete ${c.name}`}>
                    <Trash size={13} />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
        <div className="space-y-4">
          <div className="label text-ink">Add a category</div>
          <div className="grid gap-3 md:grid-cols-2">
            <input className="field" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
            <input className="field" placeholder="Short description" value={desc} onChange={(e) => setDesc(e.target.value)} />
          </div>
          <Button onClick={add} disabled={busy || !name.trim()} icon={<Plus size={14} />}>
            Add category
          </Button>
        </div>
      </Modal>
      <Confirm open={!!del} onClose={() => setDel(null)} busy={busy} danger title={`Delete ${del?.name}?`} confirmLabel="Delete category" onConfirm={remove} body="Every lesson in this category — and everyone's progress on them — is deleted too." />
    </>
  );
}

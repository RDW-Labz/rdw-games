import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useEnter } from '@/lib/motion';
import { useToast } from '@/lib/toast';
import type { Assignment, Category, Lesson, Profile } from '@/lib/types';
import { Button, EmptyNote, Field, Hand, LoadingSheet, Segmented, Stamp } from '@/components/ui/kit';
import { Container, Folder, PageHero } from '@/components/ui/layout';
import { Confirm } from '@/components/ui/Modal';
import { Plus, Trash, Users, Badge, Pin, Check, Minus, Calendar } from '@/components/ui/Glyph';

/** Same matching rule the database view uses (empty job/location = any). */
function reaches(a: Pick<Assignment, 'assignee_id' | 'job_title' | 'location'>, p: Profile) {
  if (!p.active || p.role !== 'employee') return false;
  if (a.assignee_id) return a.assignee_id === p.id;
  if (!p.job_title) return false;
  return (a.job_title === '' || a.job_title === p.job_title) && (a.location === '' || a.location === p.location);
}

/* Due date: a drafted field that opens the native picker, plus quick picks. */
function DueField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const iso = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const plus = (days: number) => iso(new Date(Date.now() + days * 86400000));
  const eom = () => { const d = new Date(); return iso(new Date(d.getFullYear(), d.getMonth() + 1, 0)); };
  const label = value ? new Date(value + 'T12:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : 'No due date';
  const quick: [string, string][] = [['+1 week', plus(7)], ['+2 weeks', plus(14)], ['End of month', eom()]];
  return (
    <div>
      <span className="field-label">
        <span>Due date</span>
        <span className="normal-case tracking-normal text-ink-3">optional</span>
      </span>
      <div className="relative">
        <button type="button" onClick={() => { const el = ref.current; if (!el) return; try { el.showPicker(); } catch { el.focus(); } }} className="field flex items-center justify-between text-left">
          <span className={`mono text-[14px] ${value ? 'text-ink-strong' : 'text-[#a29c92]'}`}>{label}</span>
          <span className="flex h-7 w-7 items-center justify-center bg-navy text-white" style={{ borderRadius: 2 }}>
            <Calendar size={13} />
          </span>
        </button>
        <input ref={ref} type="date" value={value} onChange={(e) => onChange(e.target.value)} className="pointer-events-none absolute inset-0 opacity-0" tabIndex={-1} aria-label="Due date" />
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {quick.map(([l, v]) => (
          <button key={l} type="button" onClick={() => onChange(v)} className={`mono h-8 border px-2.5 text-[12px] transition-colors ${value === v ? 'border-navy bg-navy text-white' : 'border-ink-rule/30 bg-sheet text-ink hover:bg-white'}`} style={{ borderRadius: 2 }}>
            {l}
          </button>
        ))}
        {value && (
          <button type="button" onClick={() => onChange('')} className="mono h-8 px-2 text-[12px] text-ink-2 hover:text-ink">
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

export function Assign() {
  const toast = useToast();
  const [lessons, setLessons] = useState<Lesson[] | null>(null);
  const [cats, setCats] = useState<Category[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [lessonId, setLessonId] = useState('');
  const [mode, setMode] = useState<'group' | 'person'>('group');
  const [job, setJob] = useState('');
  const [loc, setLoc] = useState('');
  const [person, setPerson] = useState('');
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<Assignment | null>(null);
  const ref = useEnter<HTMLDivElement>([lessons === null]);

  const load = useCallback(async () => {
    const [l, c, a, p] = await Promise.all([api.lessons(), api.categories(), api.assignments(), api.profiles()]);
    setLessons(l);
    setCats(c);
    setAssignments(a);
    setProfiles(p);
    setLessonId((cur) => {
      if (cur) return cur;
      // open on a lesson that still has people without it, so the main action is live
      const staffNow = p.filter((x) => x.active && x.role === 'employee' && x.job_title);
      const open = l.find((les) => staffNow.some((x) => !a.some((as) => as.lesson_id === les.id && reaches(as, x))));
      return open?.id ?? l[0]?.id ?? '';
    });
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const staff = profiles.filter((p) => p.active && p.role === 'employee');
  const jobs = Array.from(new Set(staff.map((p) => p.job_title).filter(Boolean))).sort();
  const locs = Array.from(new Set(staff.map((p) => p.location).filter(Boolean))).sort();
  const draft = { assignee_id: mode === 'person' ? person || null : null, job_title: mode === 'group' ? job : '', location: mode === 'group' ? loc : '' };
  const draftReach = mode === 'person' && !person ? [] : staff.filter((p) => reaches(draft, p));
  const forLesson = assignments.filter((a) => a.lesson_id === lessonId);
  const covered = useMemo(() => new Set(staff.filter((p) => forLesson.some((a) => reaches(a, p))).map((p) => p.id)), [staff, forLesson]);
  const lesson = lessons?.find((l) => l.id === lessonId);
  const newPeople = draftReach.filter((p) => !covered.has(p.id)).length;

  function audience(a: Assignment) {
    if (a.assignee_id) return profiles.find((p) => p.id === a.assignee_id)?.full_name ?? 'One person';
    if (!a.job_title && !a.location) return 'Everyone, all locations';
    return [a.job_title || 'All jobs', a.location || 'all locations'].join(' · ');
  }

  async function create() {
    if (!lessonId || (mode === 'person' && !person)) return;
    setBusy(true);
    try {
      await api.createAssignment({ lesson_id: lessonId, ...draft, due_date: due || null });
      toast.push(`Assigned to ${draftReach.length} ${draftReach.length === 1 ? 'person' : 'people'}`);
      setDue('');
      await load();
    } catch {
      toast.push('Could not assign. It may already exist.', 'error');
    }
    setBusy(false);
  }
  async function remove() {
    if (!removing) return;
    setBusy(true);
    try {
      await api.deleteAssignment(removing.id);
      toast.push('Assignment removed');
      setRemoving(null);
      await load();
    } catch {
      toast.push('Could not remove it.', 'error');
    }
    setBusy(false);
  }

  return (
    <div ref={ref}>
      <PageHero size="lg" title="Assign training" left="who learns what" right="by job, place or person" />
      <Container>
        {lessons === null ? (
          <LoadingSheet />
        ) : lessons.length === 0 ? (
          <EmptyNote title="Make a lesson first." note="then come back here to assign it" />
        ) : (
          <div className="grid items-start gap-8 lg:grid-cols-[1fr_1.05fr]">
            <div className="relative px-5 pb-8 pt-7 md:px-10 md:pt-8" style={{ background: 'var(--sheet-modal)', border: '1px solid rgba(66,66,66,.3)', boxShadow: 'var(--shadow-sheet)', transform: 'rotate(-0.6deg)', borderRadius: 2 }} data-pop data-rot="-0.6">
              <div className="grain-local" style={{ opacity: 0.15 }} />
              <div className="relative space-y-5">
                <div className="flex items-baseline justify-between gap-3">
                  <h2 className="title text-[26px] md:text-[30px]">New assignment</h2>
                  <span className="label">Lesson → who → when</span>
                </div>
                <Field label="Lesson">
                  <select className="field" value={lessonId} onChange={(e) => setLessonId(e.target.value)}>
                    {cats.map((c) => (
                      <optgroup key={c.id} label={c.name}>
                        {lessons.filter((l) => l.category_id === c.id).map((l) => (
                          <option key={l.id} value={l.id}>
                            {l.title}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </Field>
                <Segmented value={mode} onChange={setMode} options={[{ value: 'group', label: 'By job / location' }, { value: 'person', label: 'One person' }]} />
                {mode === 'group' ? (
                  <div className="grid gap-4 md:grid-cols-2">
                    <Field label="Job">
                      <select className="field" value={job} onChange={(e) => setJob(e.target.value)}>
                        <option value="">All jobs</option>
                        {jobs.map((j) => (
                          <option key={j}>{j}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Location">
                      <select className="field" value={loc} onChange={(e) => setLoc(e.target.value)}>
                        <option value="">All locations</option>
                        {locs.map((l) => (
                          <option key={l}>{l}</option>
                        ))}
                      </select>
                    </Field>
                  </div>
                ) : (
                  <Field label="Person">
                    <select className="field" value={person} onChange={(e) => setPerson(e.target.value)}>
                      <option value="">Choose someone…</option>
                      {staff.filter((p) => p.job_title).map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.full_name} — {p.job_title}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                <DueField value={due} onChange={setDue} />

                <div>
                  <Button onClick={create} disabled={busy || (mode === 'person' && !person) || newPeople === 0} icon={newPeople === 0 && draftReach.length ? <Check size={14} /> : <Plus size={14} />} full>
                    {busy ? 'Assigning…' : newPeople ? `Assign to ${newPeople} new ${newPeople === 1 ? 'person' : 'people'}` : draftReach.length ? 'Everyone here has it' : 'Assign training'}
                  </Button>
                  {draftReach.length > 0 && newPeople < draftReach.length && (
                    <p className="mono mt-2 text-[12px] text-ink-2">{newPeople === 0 ? 'Everyone in this group already has it — pick another group or lesson.' : `${draftReach.length - newPeople} in this group already ${draftReach.length - newPeople === 1 ? 'has' : 'have'} it and won’t get a duplicate.`}</p>
                  )}
                </div>
                <div className="border-t border-dashed border-ink-dash/50 pt-5">
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <span className="label">Reaches</span>
                    <span className="hand text-[15px]">
                      {draftReach.length} {draftReach.length === 1 ? 'person' : 'people'}
                      {draftReach.length > 0 && newPeople !== draftReach.length ? ` · ${newPeople} new` : ''}
                    </span>
                  </div>
                  <div className="flex min-h-[44px] flex-wrap gap-1.5">
                    {draftReach.length === 0 ? (
                      <span className="mono text-[12px] text-ink-3">{mode === 'person' ? 'Choose someone above.' : 'Nobody matches yet.'}</span>
                    ) : (
                      draftReach.map((p) => (
                        <span key={p.id} className="flex items-center gap-1.5 border py-1 pl-1 pr-2" style={{ borderRadius: 2, background: '#fffaf0', borderColor: 'rgba(40,63,125,.25)' }} title={covered.has(p.id) ? 'Already assigned' : 'New'}>
                          <Stamp name={p.full_name} size={24} />
                          <span className="text-[13px] text-navy">{p.full_name.split(' ')[0]}</span>
                          <span className={`mono text-[10px] uppercase ${covered.has(p.id) ? 'text-ink-3' : 'text-signal-orange2'}`}>{covered.has(p.id) ? 'has it' : 'new'}</span>
                        </span>
                      ))
                    )}
                  </div>

                </div>
              </div>
            </div>

            <Folder tab="Assigned" className="!mt-10 lg:!mt-[34px]">
              <div className="mb-6">
                <Hand rot={-3} size={16} className="mb-2 block">
                  currently assigned
                </Hand>
                <h2 className="title text-[28px] md:text-[36px]">{lesson?.title}</h2>
                <p className="mono mt-2 text-[12px] text-ink-2">
                  {covered.size} of {staff.filter((p) => p.job_title).length} active staff
                </p>
              </div>
              {forLesson.length === 0 ? (
                <p className="mono border border-dashed border-ink-dash/60 px-4 py-6 text-center text-[13px] text-ink-2">Not assigned to anyone yet.</p>
              ) : (
                <ul>
                  {forLesson.map((a) => {
                    const n = staff.filter((p) => reaches(a, p)).length;
                    const Icon = a.assignee_id ? Badge : !a.job_title && !a.location ? Users : a.location && !a.job_title ? Pin : Users;
                    return (
                      <li key={a.id} className="grid grid-cols-[auto_1fr_auto] items-center gap-3 border-b border-dashed border-ink-dash py-4">
                        <span className="flex h-9 w-9 items-center justify-center bg-navy text-white" style={{ borderRadius: 2 }}>
                          <Icon size={15} />
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-[17px] font-medium tracking-tightish">{audience(a)}</span>
                          <span className="mono block text-[12px] text-ink-2">
                            {n} {n === 1 ? 'person' : 'people'}
                            {a.due_date ? ` · due ${new Date(a.due_date + 'T12:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : ''}
                          </span>
                        </span>
                        <button onClick={() => setRemoving(a)} className="square-btn !text-[#b2352c]" aria-label={`Remove assignment for ${audience(a)}`}>
                          <Trash size={13} />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              <div className="mt-10">
                <div className="mb-3 flex items-end justify-between">
                  <span className="label text-ink">Who has it</span>
                  <Hand rot={-3} size={15}>
                    {covered.size} of {staff.filter((p) => p.job_title).length}
                  </Hand>
                </div>
                <ul className="grid gap-x-6 sm:grid-cols-2">
                  {staff.filter((p) => p.job_title).map((p) => {
                    const has = covered.has(p.id);
                    return (
                      <li key={p.id} className="flex items-center gap-2.5 border-b border-dashed border-ink-dash/50 py-2.5">
                        <Stamp name={p.full_name} size={26} dim={!has} />
                        <span className="min-w-0 flex-1">
                          <span className={`block truncate text-[15px] tracking-tightish ${has ? 'text-ink' : 'text-ink-2'}`}>{p.full_name}</span>
                          <span className="mono block truncate text-[11px] text-ink-3">{p.job_title}</span>
                        </span>
                        <span className={`flex h-6 w-6 flex-none items-center justify-center ${has ? 'bg-[#5a7d4a] text-white' : 'border border-dashed border-ink-rule/40 text-ink-3'}`} style={{ borderRadius: 2 }} title={has ? 'Assigned' : 'Not assigned'}>
                          {has ? <Check size={11} /> : <Minus size={10} />}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </Folder>
          </div>
        )}
      </Container>
      <Confirm open={!!removing} onClose={() => setRemoving(null)} busy={busy} danger title="Remove this assignment?" confirmLabel="Remove" onConfirm={remove} body={<>People reached only by <b className="text-ink">{removing ? audience(removing) : ''}</b> stop seeing this lesson. Their past progress is kept.</>} />
    </div>
  );
}

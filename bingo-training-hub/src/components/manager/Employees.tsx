import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { href } from '@/lib/router';
import { useEnter, useScrollReveal } from '@/lib/motion';
import { useToast } from '@/lib/toast';
import { statusOf, isOverdue, pct } from '@/lib/status';
import type { EmployeeTrainingRow, Profile } from '@/lib/types';
import { Button, DueTag, EmptyNote, Field, Hand, LoadingSheet, Ruler, Segmented, Stamp, StatusTag, Toggle, Display } from '@/components/ui/kit';
import { Container, Folder, PageHero } from '@/components/ui/layout';
import { Modal } from '@/components/ui/Modal';
import { ArrowLeft, Check, Edit, Hand as HandGlyph, Search } from '@/components/ui/Glyph';
import { useFloorData } from './data';

type Filter = 'active' | 'setup' | 'managers' | 'inactive';

export function Employees({ route }: { route: string[] }) {
  const sub = route[1];
  const { rows, profiles, reload } = useFloorData();
  if (sub && sub !== 'setup') return <EmployeeDetail id={sub} rows={rows} profiles={profiles} reload={reload} />;
  return <Roster rows={rows} profiles={profiles} reload={reload} initial={sub === 'setup' ? 'setup' : 'active'} />;
}

function Roster({ rows, profiles, reload, initial }: { rows: EmployeeTrainingRow[] | null; profiles: Profile[]; reload: () => Promise<void>; initial: Filter }) {
  const [filter, setFilter] = useState<Filter>(initial);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Profile | null>(null);
  const ref = useEnter<HTMLDivElement>([rows === null]);
  const listRef = useScrollReveal<HTMLDivElement>([rows, filter, q]);

  const counts = {
    active: profiles.filter((p) => p.active && p.role === 'employee' && p.job_title).length,
    setup: profiles.filter((p) => p.active && p.role === 'employee' && (!p.job_title || !p.location)).length,
    managers: profiles.filter((p) => p.role === 'manager').length,
    inactive: profiles.filter((p) => !p.active).length,
  };
  const list = profiles
    .filter((p) => {
      if (filter === 'active') return p.active && p.role === 'employee' && p.job_title;
      if (filter === 'setup') return p.active && p.role === 'employee' && (!p.job_title || !p.location);
      if (filter === 'managers') return p.role === 'manager';
      return !p.active;
    })
    .filter((p) => [p.full_name, p.job_title, p.location].join(' ').toLowerCase().includes(q.toLowerCase()));

  return (
    <div ref={ref}>
      <PageHero size="lg" title="Roster" left={`${counts.active} on the floor`} right={counts.setup ? `${counts.setup} ${counts.setup === 1 ? 'needs' : 'need'} setup` : 'everyone set up'} />
      <Container>
        <div className="grid gap-3 md:grid-cols-[1fr_auto]" data-rise>
          <label className="relative block">
            <Search size={16} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-ink-2" />
            <input className="field pl-11" placeholder="Search name, job or location" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search employees" />
          </label>
          <div className="grid grid-cols-2 gap-1.5 md:hidden">
            {(
              [
                ['active', 'Active', counts.active],
                ['setup', 'Needs setup', counts.setup],
                ['managers', 'Managers', counts.managers],
                ['inactive', 'Inactive', counts.inactive],
              ] as const
            ).map(([v, l, n]) => (
              <button key={v} onClick={() => setFilter(v)} aria-pressed={filter === v} className={`mono flex h-11 items-center justify-between border px-3 text-[13px] ${filter === v ? 'border-navy bg-navy text-white' : 'border-ink-rule/30 bg-sheet-2 text-ink'}`} style={{ borderRadius: 2 }}>
                {l}
                <span className={filter === v ? 'text-white/70' : 'text-ink-3'}>{n}</span>
              </button>
            ))}
          </div>
          <div className="hidden md:block md:w-[560px]">
            <Segmented
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'active', label: `Active ${counts.active}` },
                { value: 'setup', label: `Setup ${counts.setup}` },
                { value: 'managers', label: `Managers ${counts.managers}` },
                { value: 'inactive', label: `Inactive ${counts.inactive}` },
              ]}
            />
          </div>
        </div>

        <div ref={listRef}>
          <Folder tab={{ active: 'Active staff', setup: 'Needs setup', managers: 'Managers', inactive: 'Inactive' }[filter]} className="mt-16">
            {rows === null ? (
              <LoadingSheet />
            ) : list.length === 0 ? (
              <EmptyNote title={q ? 'No one matches that search.' : 'No one here.'} note={filter === 'setup' ? 'everyone has a job and location' : undefined} />
            ) : (
              <ul>
                <li className="label hidden grid-cols-[48px_1.3fr_1fr_1.2fr_96px] gap-4 border-b border-ink-rule pb-3 md:grid">
                  <span />
                  <span>Name</span>
                  <span>Job · location</span>
                  <span>Qualified</span>
                  <span className="text-right">Edit</span>
                </li>
                {list.map((p) => {
                  const er = (rows ?? []).filter((r) => r.employee_id === p.id);
                  const qd = er.filter((r) => statusOf(r) === 'qualified').length;
                  const late = er.filter(isOverdue).length;
                  return (
                    <li key={p.id} data-reveal className="grid grid-cols-[48px_1fr_auto] items-center gap-x-4 gap-y-2 border-b border-dashed border-ink-dash py-4 md:grid-cols-[48px_1.3fr_1fr_1.2fr_96px]">
                      <Stamp name={p.full_name} size={42} dim={!p.active || !p.job_title} />
                      <a href={href(`employees/${p.id}`)} className="group min-w-0">
                        <span className="block truncate text-[18px] font-medium tracking-tightish group-hover:underline group-hover:decoration-dotted group-hover:underline-offset-4 md:text-[20px]">{p.full_name}</span>
                        <span className="mono block text-[12px] leading-snug text-ink-2 md:hidden">
                          {p.job_title || 'No job yet'}
                          {p.location && <span className="block text-ink-3">{p.location}</span>}
                        </span>
                      </a>
                      <span className="hidden min-w-0 md:block">
                        <span className="block truncate text-[15px]">{p.job_title || <span className="hand text-[15px] text-signal-orange2">set a job</span>}</span>
                        <span className="mono block truncate text-[12px] text-ink-2">{p.location || '—'}</span>
                      </span>
                      <span className="col-span-3 row-start-2 md:col-span-1 md:row-start-auto">
                        {p.role === 'manager' ? (
                          <span className="tag text-navy">Manager</span>
                        ) : er.length ? (
                          <>
                            <Ruler value={pct(qd, er.length)} tone={qd === er.length ? '#5a7d4a' : '#283f7d'} height={9} ticks={false} />
                            <span className="mono mt-1.5 flex justify-between text-[11px] text-ink-2">
                              <span>
                                {qd}/{er.length}
                              </span>
                              {late > 0 && (
                                <span className="tag !h-[22px] !text-[11px] text-[#a52d25]">
                                  <span className="tag-dot bg-[#c8382f] !h-[12px] !w-[12px]" />
                                  {late} overdue
                                </span>
                              )}
                            </span>
                          </>
                        ) : (
                          <span className="mono text-[12px] text-ink-3">No lessons</span>
                        )}
                      </span>
                      <span className="col-start-3 row-start-1 flex justify-end md:col-start-auto md:row-start-auto">
                        <button onClick={() => setEditing(p)} className="square-btn" aria-label={`Edit ${p.full_name}`}>
                          <Edit size={14} />
                        </button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Folder>
        </div>
      </Container>
      <EditEmployee profile={editing} profiles={profiles} onClose={() => setEditing(null)} onSaved={reload} />
    </div>
  );
}

function EmployeeDetail({ id, rows, profiles, reload }: { id: string; rows: EmployeeTrainingRow[] | null; profiles: Profile[]; reload: () => Promise<void> }) {
  const emp = profiles.find((p) => p.id === id);
  const [editing, setEditing] = useState(false);
  const ref = useEnter<HTMLDivElement>([!!emp]);
  const er = useMemo(() => (rows ?? []).filter((r) => r.employee_id === id), [rows, id]);
  const groups = er.reduce<Record<string, EmployeeTrainingRow[]>>((a, r) => ((a[r.category_name] ??= []).push(r), a), {});
  const qd = er.filter((r) => statusOf(r) === 'qualified').length;

  if (!emp) {
    return (
      <Container className="pt-[140px]">
        <LoadingSheet rows={3} />
      </Container>
    );
  }
  return (
    <div ref={ref}>
      <Container className="pt-[96px] md:pt-[120px]">
        <a href={href('employees')} className="mono group inline-flex items-center gap-2 text-[13px] text-ink-2 hover:text-ink" data-rise>
          <ArrowLeft size={14} className="transition-transform duration-500 ease-joe-out group-hover:-translate-x-1" /> Roster
        </a>
        <div className="mt-8 grid items-end gap-8 md:grid-cols-[1fr_380px]">
          <div>
            <div className="mb-4 flex items-center gap-3" data-rise>
              <Stamp name={emp.full_name} size={52} dim={!emp.active} />
              <div className="label">{emp.role === 'manager' ? 'Manager' : 'Employee'}{emp.active ? '' : ' · inactive'}</div>
            </div>
            <Display text={emp.full_name} className="text-[clamp(48px,8vw,112px)]" />
            <div className="mt-4 flex flex-wrap gap-x-6 gap-y-1">
              <Hand rot={-3} size={19}>
                {`${emp.job_title || 'no job set'} · ${emp.location || 'no location set'}`}
              </Hand>
            </div>
          </div>
          <div className="sheet p-5" data-pop data-rot="1" style={{ transform: 'rotate(1deg)' }}>
            <div className="flex items-start justify-between">
              <span className="label">Qualified</span>
              <button onClick={() => setEditing(true)} className="mono flex items-center gap-1.5 text-[12px] text-navy hover:underline">
                <Edit size={12} /> Edit profile
              </button>
            </div>
            <div className="mt-2 flex items-end gap-2">
              <span className="display tabular text-[64px] leading-[0.8]">
                {pct(qd, er.length)}
                <span className="mono ml-0.5 align-top text-[18px] text-ink-2">%</span>
              </span>
              <span className="mono mb-1 ml-auto text-[13px] text-ink-2">
                {qd}/{er.length}
              </span>
            </div>
            <div className="mt-4">
              <Ruler value={pct(qd, er.length)} tone={qd === er.length && er.length ? '#5a7d4a' : '#283f7d'} />
            </div>
          </div>
        </div>

        {rows === null ? (
          <div className="mt-16">
            <LoadingSheet />
          </div>
        ) : er.length === 0 ? (
          <div className="mt-16">
            <EmptyNote title="No lessons assigned." note={emp.job_title ? 'assign some from the Assign page' : 'set a job + location first'} />
          </div>
        ) : (
          Object.entries(groups).map(([cat, list], gi) => (
            <Folder key={cat} tab={cat} tone={gi % 2 ? 'deep' : 'manila'} className="mt-20">
              <ul>
                <li className="label hidden grid-cols-[1.6fr_1fr_0.8fr_0.8fr_1fr] gap-4 border-b border-ink-rule pb-3 md:grid">
                  <span>Lesson</span>
                  <span>Quiz</span>
                  <span>Signed</span>
                  <span>Hands-on</span>
                  <span className="text-right">Status</span>
                </li>
                {list.map((r) => (
                  <li key={r.assignment_id} className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-2 border-b border-dashed border-ink-dash py-4 md:grid-cols-[1.6fr_1fr_0.8fr_0.8fr_1fr]">
                    <span className="min-w-0">
                      <span className="block truncate text-[17px] font-medium tracking-tightish md:text-[19px]">{r.lesson_title}</span>
                      <span className="mt-1 flex gap-2">
                        <DueTag due={statusOf(r) === 'qualified' ? null : r.due_date} />
                      </span>
                    </span>
                    <span className="mono hidden text-[13px] md:block">{r.quiz_total ? <span className={r.quiz_passed ? 'text-ink' : 'text-[#b2352c]'}>{r.quiz_score}/{r.quiz_total} {r.quiz_passed ? 'pass' : 'fail'}</span> : <span className="text-ink-3">—</span>}</span>
                    <span className="hidden md:block">{r.acknowledged ? <Tick /> : <span className="mono text-[13px] text-ink-3">—</span>}</span>
                    <span className="hidden md:block">{r.requires_practical ? r.practical_signed_off ? <Tick /> : <span className="mono inline-flex items-center gap-1.5 text-[12px] text-navy"><HandGlyph size={13} /> waiting</span> : <span className="mono text-[13px] text-ink-3">n/a</span>}</span>
                    <span className="flex justify-end">
                      <StatusTag status={statusOf(r)} />
                    </span>
                  </li>
                ))}
              </ul>
            </Folder>
          ))
        )}
      </Container>
      <EditEmployee profile={editing ? emp : null} profiles={profiles} onClose={() => setEditing(false)} onSaved={reload} />
    </div>
  );
}

function Tick() {
  return (
    <span className="inline-flex h-[22px] w-[22px] items-center justify-center bg-[#5a7d4a] text-white" style={{ borderRadius: 2 }}>
      <Check size={12} />
    </span>
  );
}

function EditEmployee({ profile, profiles, onClose, onSaved }: { profile: Profile | null; profiles: Profile[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const [f, setF] = useState({ full_name: '', role: 'employee' as Profile['role'], job_title: '', location: '', active: true });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (profile) setF({ full_name: profile.full_name, role: profile.role, job_title: profile.job_title, location: profile.location, active: profile.active });
  }, [profile]);
  const jobs = Array.from(new Set(profiles.map((p) => p.job_title).filter(Boolean))).sort();
  const locs = Array.from(new Set(profiles.map((p) => p.location).filter(Boolean))).sort();

  async function save() {
    if (!profile) return;
    setBusy(true);
    try {
      await api.updateEmployee(profile.id, f);
      toast.push(`Saved ${f.full_name}`);
      await onSaved();
      onClose();
    } catch {
      toast.push('Could not save changes.', 'error');
    }
    setBusy(false);
  }

  return (
    <Modal
      open={!!profile}
      onClose={onClose}
      title="Edit employee"
      kicker={profile?.full_name}
      footer={
        <>
          <Button variant="cream" icon={false} onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy || !f.full_name.trim()} icon={<Check size={14} />}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Field label="Full name">
          <input className="field" value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} />
        </Field>
        <Field label="Role">
          <Segmented value={f.role} onChange={(v) => setF({ ...f, role: v })} options={[{ value: 'employee', label: 'Employee' }, { value: 'manager', label: 'Manager' }]} />
        </Field>
        <div className="grid gap-5 md:grid-cols-2">
          <Field label="Job title" hint="type a new one or pick">
            <input className="field" list="jobs" value={f.job_title} onChange={(e) => setF({ ...f, job_title: e.target.value })} placeholder="e.g. Lotting Specialist" />
            <datalist id="jobs">{jobs.map((j) => <option key={j} value={j} />)}</datalist>
          </Field>
          <Field label="Location">
            <input className="field" list="locs" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} placeholder="e.g. Harrison, AR" />
            <datalist id="locs">{locs.map((l) => <option key={l} value={l} />)}</datalist>
          </Field>
        </div>
        <div className="border-t border-dashed border-ink-dash/50 pt-5">
          <Toggle checked={f.active} onChange={(v) => setF({ ...f, active: v })} label="Active" sub="Inactive people keep their history but get no new training." />
        </div>
      </div>
    </Modal>
  );
}

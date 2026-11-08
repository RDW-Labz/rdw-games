import { useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { href } from '@/lib/router';
import { useEnter, useScrollReveal } from '@/lib/motion';
import { useToast } from '@/lib/toast';
import { statusOf, isOverdue, pct, STATUS } from '@/lib/status';
import type { EmployeeTrainingRow } from '@/lib/types';
import { Button, DueTag, EmptyNote, Hand, LinkButton, LoadingSheet, Ruler, Stamp, Stat, StatusTag, Tape } from '@/components/ui/kit';
import { Container, Folder, PageHero } from '@/components/ui/layout';
import { Check, Chevron, Eye } from '@/components/ui/Glyph';
import { useFloorData } from './data';
import { IsoArt } from '@/components/art/IsoArt';

export function Overview() {
  const { profile } = useAuth();
  const toast = useToast();
  const { rows, profiles, reload } = useFloorData();
  const [signing, setSigning] = useState<string | null>(null);
  const ref = useEnter<HTMLDivElement>([rows === null]);
  const listRef = useScrollReveal<HTMLDivElement>([rows]);

  const employees = profiles.filter((p) => p.role === 'employee' && p.active);
  const needsSetup = employees.filter((p) => !p.job_title || !p.location);
  const r = rows ?? [];
  const stats = useMemo(
    () => ({
      total: r.length,
      qualified: r.filter((x) => statusOf(x) === 'qualified').length,
      retrain: r.filter((x) => statusOf(x) === 'retrain').length,
      overdue: r.filter(isOverdue).length,
    }),
    [r]
  );
  const pending = r.filter((x) => statusOf(x) === 'signoff');
  const attention = r.filter((x) => isOverdue(x) || ['failed', 'retrain'].includes(statusOf(x))).slice(0, 8);

  async function signOff(row: EmployeeTrainingRow) {
    if (!profile) return;
    setSigning(row.assignment_id);
    try {
      await api.signOff(row.employee_id, row.lesson_id, profile.id);
      toast.push(`${row.employee_name.split(' ')[0]} is signed off on ${row.lesson_title}`);
      await reload();
    } catch {
      toast.push('Could not sign off. Try again.', 'error');
    }
    setSigning(null);
  }

  const today = new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

  return (
    <div ref={ref}>
      <PageHero size="lg" title="Floor overview" left={today} right={pending.length ? `${pending.length} sign-off${pending.length > 1 ? 's' : ''} waiting` : 'all clear'} />

      <Container>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat value={stats.total} label="Assigned" />
          <Stat value={stats.qualified} label="Qualified" tone="#5a7d4a" note={`${pct(stats.qualified, stats.total)}%`} />
          <Stat value={stats.retrain} label="Retrain" tone="#ec633d" />
          <Stat value={stats.overdue} label="Overdue" tone="#c8382f" />
        </div>
      </Container>

      {/* Waiting on you — the navy "letter" section */}
      <section data-dark className="relative mt-10 overflow-hidden py-10 md:mt-16 md:py-20" style={{ background: '#20386c' }}>
        <div className="grain-local" style={{ opacity: 0.22 }} />
        <div className="pointer-events-none absolute right-6 top-8 hidden opacity-95 2xl:block" style={{ transform: 'rotate(8deg)' }}>
          <IsoArt kind="check" size={150} />
        </div>
        <Container className="relative">
          <div className="mb-6 flex flex-wrap items-end justify-between gap-4 text-white md:mb-10">
            <div>
              <Hand rot={-3} size={17} color="rgba(255,255,255,.7)" className="mb-2 block">
                waiting on you
              </Hand>
              <h2 className="title text-[32px] text-white md:text-[56px]">Hands-on sign-offs</h2>
            </div>
            <p className="hidden max-w-[360px] text-[15px] leading-relaxed text-white/70 md:block">Watch the person do the task on the floor. If it&rsquo;s right, sign them off.</p>
          </div>
          {rows === null ? (
            <LoadingSheet rows={2} />
          ) : pending.length === 0 ? (
            <div className="flex items-center gap-4 border border-dashed border-white/30 px-6 py-8 text-white/80">
              <span className="flex h-10 w-10 items-center justify-center bg-[#5a7d4a] text-white" style={{ borderRadius: 2 }}>
                <Check size={16} />
              </span>
              <span className="text-[17px]">No one is waiting. Nice.</span>
            </div>
          ) : (
            <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
              {pending.map((row, i) => (
                <div key={row.assignment_id} className="relative bg-[#ebe4da] p-5 text-ink" style={{ transform: `rotate(${[-1.2, 0.8, -0.4][i % 3]}deg)`, boxShadow: '9px 6px 0 rgba(0,0,0,.2)', borderRadius: 2 }} data-pop data-rot={[-1.2, 0.8, -0.4][i % 3]}>
                  <Tape className="-top-2 left-1/2 -translate-x-1/2" rot={i % 2 ? 4 : -4} />
                  <div className="flex items-center gap-3">
                    <Stamp name={row.employee_name} size={40} />
                    <div className="min-w-0">
                      <div className="truncate text-[17px] font-medium tracking-tightish">{row.employee_name}</div>
                      <div className="mono truncate text-[12px] text-ink-2">
                        {row.job_title} · {row.location.split(',')[0]}
                      </div>
                    </div>
                  </div>
                  <div className="mt-4 border-t border-dashed border-ink-dash/60 pt-3">
                    <div className="label">Task</div>
                    <div className="mt-1 text-[20px] font-medium leading-tight tracking-tightish">{row.lesson_title}</div>
                    <div className="mono mt-2 text-[12px] text-ink-2">
                      Quiz {row.quiz_score}/{row.quiz_total} · signed
                    </div>
                  </div>
                  <div className="mt-5 flex gap-2">
                    <Button onClick={() => signOff(row)} disabled={signing === row.assignment_id} icon={<Check size={14} />} tile="#5a7d4a" className="flex-1">
                      {signing === row.assignment_id ? 'Signing…' : 'Sign off'}
                    </Button>
                    <a href={href(`lessons/preview/${row.lesson_id}`)} className="square-btn !h-12 !w-12" title="What to check" aria-label="Open lesson">
                      <Eye size={14} />
                    </a>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Container>
      </section>

      <Container>
        <div ref={listRef}>
          {needsSetup.length > 0 && (
            <div className="relative mt-14 flex flex-col gap-4 border border-dashed border-ink-dash bg-sheet-2/70 p-5 md:flex-row md:items-center md:justify-between" data-reveal>
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 items-center justify-center bg-signal-orange text-white" style={{ borderRadius: 2 }}>
                  !
                </span>
                <div>
                  <div className="text-[17px] font-medium tracking-tightish">
                    {needsSetup.length === 1 ? '1 new sign-up needs' : `${needsSetup.length} new sign-ups need`} a job and location
                  </div>
                  <div className="text-[14px] text-ink-2">{needsSetup.map((p) => p.full_name).join(', ')} won&rsquo;t see training until you set them up.</div>
                </div>
              </div>
              <LinkButton href={href('employees/setup')} variant="cream" size="sm">
                Set up
              </LinkButton>
            </div>
          )}

          {attention.length > 0 && (
            <Folder tab="Needs attention" tone="deep" className="mt-20">
              <div className="mb-4 flex items-end justify-between">
                <h2 className="title text-[30px] md:text-[44px]">Behind or stuck</h2>
                <Hand rot={-3} size={16}>overdue, failed, retrain</Hand>
              </div>
              <ul>
                {attention.map((row) => (
                  <li key={row.assignment_id + row.employee_id} data-reveal>
                    <a href={href(`employees/${row.employee_id}`)} className="group -mx-3 grid min-h-[64px] grid-cols-[auto_1fr_auto] items-start gap-4 border-b border-dashed border-ink-dash px-3 py-4 transition-colors duration-300 hover:bg-[#20386c]/[0.04] md:items-center">
                      <Stamp name={row.employee_name} size={34} />
                      <span className="min-w-0">
                        <span className="block text-[17px] font-medium leading-snug tracking-tightish md:truncate md:text-[19px]">
                          {row.employee_name}
                          <span className="hidden text-[#575757] md:inline"> · {row.lesson_title}</span>
                        </span>
                        <span className="block text-[15px] leading-snug tracking-tightish text-[#6b6458] md:hidden">{row.lesson_title}</span>
                      </span>
                      <span className="flex items-center gap-2">
                        <span className="hidden gap-2 md:flex">
                          <StatusTag status={statusOf(row)} />
                          <DueTag due={row.due_date} />
                        </span>
                        <span className="flex h-10 w-10 items-center justify-center border border-ink-rule/30 bg-sheet text-navy-3 transition-transform duration-500 ease-joe-out group-hover:-rotate-90" style={{ borderRadius: 2 }}>
                          <Chevron size={12} />
                        </span>
                      </span>
                      <span className="col-span-3 -mt-1 flex flex-wrap gap-1.5 md:hidden">
                        <StatusTag status={statusOf(row)} compact />
                        <DueTag due={row.due_date} />
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </Folder>
          )}

          <Folder tab="Roster" className="mt-20">
            <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
              <h2 className="title text-[30px] md:text-[44px]">Progress by person</h2>
              <LinkButton href={href('employees')} variant="cream" size="sm">
                All employees
              </LinkButton>
            </div>
            {rows === null ? (
              <LoadingSheet />
            ) : employees.length === 0 ? (
              <EmptyNote title="No employees yet." />
            ) : (
              <ul>
                {employees.map((emp) => {
                  const er = r.filter((x) => x.employee_id === emp.id);
                  const q = er.filter((x) => statusOf(x) === 'qualified').length;
                  const late = er.filter(isOverdue).length;
                  const v = pct(q, er.length);
                  return (
                    <li key={emp.id} data-reveal>
                      <a href={href(`employees/${emp.id}`)} className="group grid grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-4 border-b border-dashed border-ink-dash py-4 md:grid-cols-[40px_minmax(0,1.1fr)_minmax(0,1.4fr)_132px]">
                        <Stamp name={emp.full_name} size={40} dim={!emp.job_title} />
                        <span className="min-w-0">
                          <span className="block truncate text-[18px] font-medium tracking-tightish md:text-[20px]">{emp.full_name}</span>
                          <span className="mono block truncate text-[12px] text-ink-2">{emp.job_title ? `${emp.job_title} · ${emp.location.split(',')[0]}` : 'Needs setup'}</span>
                        </span>
                        <span className="col-span-3 row-start-2 md:col-span-1 md:row-start-auto">
                          <Ruler value={v} tone={v === 100 ? '#5a7d4a' : '#283f7d'} height={10} ticks={false} />
                          <span className="mono mt-1.5 flex justify-between text-[11px] text-ink-2">
                            <span>
                              {q}/{er.length} qualified
                            </span>
                            {late > 0 && (
                              <span className="tag !h-[22px] !text-[11px] text-[#a52d25]">
                                  <span className="tag-dot bg-[#c8382f] !h-[12px] !w-[12px]" />
                                  {late} overdue
                                </span>
                            )}
                          </span>
                        </span>
                        <span className="flex items-center justify-end gap-3">
                          <span className="display tabular hidden text-[34px] md:inline">
                            {v}
                            <span className="mono align-top text-[14px] text-ink-2">%</span>
                          </span>
                          <span className="flex h-10 w-10 items-center justify-center border border-ink-rule/30 bg-sheet text-navy-3 transition-transform duration-500 ease-joe-out group-hover:-rotate-90" style={{ borderRadius: 2 }}>
                            <Chevron size={12} />
                          </span>
                        </span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            )}
          </Folder>

          <div className="mt-10 flex flex-wrap gap-x-6 gap-y-2" data-reveal>
            {Object.values(STATUS).map((m) => (
              <span key={m.label} className="mono flex items-center gap-2 text-[11px] uppercase tracking-[0.05em] text-ink-2">
                <span className="h-2.5 w-2.5" style={{ background: m.color }} /> {m.label}
              </span>
            ))}
          </div>
        </div>
      </Container>
    </div>
  );
}

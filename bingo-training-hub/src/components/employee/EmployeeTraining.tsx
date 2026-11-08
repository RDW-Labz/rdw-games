import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { href } from '@/lib/router';
import { useEnter, useScrollReveal } from '@/lib/motion';
import type { EmployeeTrainingRow } from '@/lib/types';
import { STATUS, statusOf, isOverdue, pct, type TrainingStatus } from '@/lib/status';
import { DueTag, EmptyNote, LinkButton, LoadingSheet, Ruler, Stat, StatusTag } from '@/components/ui/kit';
import { Container, Folder, PageHero } from '@/components/ui/layout';
import { Chevron, Hand as HandGlyph } from '@/components/ui/Glyph';
import { Aisle } from '@/components/art/Aisle';
import { IsoArt, kindForCategory } from '@/components/art/IsoArt';

const ORDER: TrainingStatus[] = ['retrain', 'failed', 'acknowledge', 'not_started', 'signoff', 'qualified'];

export function EmployeeTraining() {
  const { profile } = useAuth();
  const [rows, setRows] = useState<EmployeeTrainingRow[] | null>(null);
  const [descs, setDescs] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<'all' | 'todo' | 'signoff' | 'done'>('all');
  const ref = useEnter<HTMLDivElement>([rows === null]);
  const listRef = useScrollReveal<HTMLDivElement>([rows, filter]);

  useEffect(() => {
    if (profile) api.training(profile.id).then(setRows).catch(() => setRows([]));
    api.categories().then((c) => setDescs(Object.fromEntries(c.map((x) => [x.name, x.description])))).catch(() => {});
  }, [profile]);

  const stats = useMemo(() => {
    const r = rows ?? [];
    const by = (s: TrainingStatus[]) => r.filter((x) => s.includes(statusOf(x))).length;
    return { total: r.length, done: by(['qualified']), signoff: by(['signoff']), todo: by(['not_started', 'failed', 'acknowledge', 'retrain']) };
  }, [rows]);

  const next = useMemo(() => {
    const r = [...(rows ?? [])].filter((x) => statusOf(x) !== 'qualified' && statusOf(x) !== 'signoff');
    r.sort((a, b) => Number(isOverdue(b)) - Number(isOverdue(a)) || ORDER.indexOf(statusOf(a)) - ORDER.indexOf(statusOf(b)) || (a.due_date ?? '9').localeCompare(b.due_date ?? '9'));
    return r[0];
  }, [rows]);

  const visible = (rows ?? []).filter((r) => {
    const s = statusOf(r);
    if (filter === 'todo') return !['qualified', 'signoff'].includes(s);
    if (filter === 'signoff') return s === 'signoff';
    if (filter === 'done') return s === 'qualified';
    return true;
  });
  const groups = visible.reduce<Record<string, EmployeeTrainingRow[]>>((acc, r) => ((acc[r.category_name] ??= []).push(r), acc), {});
  const done = pct(stats.done, stats.total);
  const first = profile?.full_name.split(' ')[0] ?? '';

  if (profile && !profile.job_title) {
    return (
      <div ref={ref}>
        <PageHero title={`Hi, ${first}`} left="Welcome aboard" right="almost set up" />
        <Container className="max-w-[760px]">
          <EmptyNote title="A manager still needs to set your job and location." note="Your lessons show up here once they do.">
            <p className="lede text-[15px]">Let your lead know you signed up. It only takes them a minute.</p>
          </EmptyNote>
        </Container>
      </div>
    );
  }

  return (
    <div ref={ref}>
      <PageHero title="My training" left={profile?.job_title} right={profile?.location} />

      <Container>
        {/* Illustration board with the progress card + next lesson pinned to it */}
        <div className="relative">
          <div data-dark className="relative h-[300px] overflow-hidden border border-ink-rule md:h-[560px]" data-wipe>
            <Aisle label={profile?.location?.toUpperCase().startsWith('SPRING') ? 'SPRINGDALE' : 'AISLE 04'} />
          </div>
          <div className="relative z-[2] -mt-6 px-3 md:absolute md:left-6 md:top-6 md:mt-0 md:w-[360px] md:px-0" data-pop data-rot="-1.5">
            <div className="sheet relative p-5" style={{ transform: 'rotate(-1.5deg)' }}>
              <div className="flex items-start justify-between">
                <span className="label">Qualified</span>
                <span className="hand text-[14px]">{first}&rsquo;s card</span>
              </div>
              <div className="mt-2 flex items-end gap-3">
                <span className="display tabular text-[64px] leading-[0.8] md:text-[72px]">
                  {rows ? done : '–'}
                  <span className="mono ml-0.5 align-top text-[20px] text-ink-2">%</span>
                </span>
                <span className="mono mb-1 ml-auto text-[13px] text-ink-2">
                  {stats.done}/{stats.total} lessons
                </span>
              </div>
              <div className="mt-4">
                <Ruler value={done} tone={done === 100 ? '#5a7d4a' : '#283f7d'} />
              </div>
            </div>
          </div>
          {next && (
            <div className="relative z-[2] mt-4 md:absolute md:bottom-6 md:left-6 md:mt-0 md:max-w-[460px]" data-rise>
              <div className="flex flex-col gap-4 p-5 text-white md:p-6" style={{ background: '#20386c', borderRadius: 2, boxShadow: '7px 5px 0 rgba(0,0,0,.18)' }}>
                <div>
                  <div className="mono text-[12px] uppercase tracking-[0.06em] text-white/70">{isOverdue(next) ? 'Overdue — do this first' : 'Up next'}</div>
                  <div className="title mt-1.5 text-[28px] text-white md:text-[34px]">{next.lesson_title}</div>
                  <div className="mt-1 text-[15px] text-white/80">{STATUS[statusOf(next)].next}</div>
                </div>
                <LinkButton href={href(`lesson/${next.lesson_id}`)} variant="cream" tile="#ec633d" className="self-start">
                  {statusOf(next) === 'not_started' ? 'Start lesson' : 'Continue'}
                </LinkButton>
              </div>
            </div>
          )}
          {rows && !next && stats.total > 0 && (
            <div className="relative z-[2] mt-4 md:absolute md:bottom-6 md:left-6 md:mt-0 md:max-w-[460px]">
              <div className="p-5 text-white md:p-6" style={{ background: '#20386c', borderRadius: 2, boxShadow: '7px 5px 0 rgba(0,0,0,.18)' }}>
                <div className="title text-[28px] text-white">{stats.signoff ? 'Waiting on sign-off' : 'All caught up'}</div>
                <div className="mt-1 text-[15px] text-white/80">{stats.signoff ? 'Ask a manager to watch your hands-on tasks.' : 'Nice work. Nothing left to do.'}</div>
              </div>
            </div>
          )}
        </div>

        {/* Stat plates double as filters */}
        <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat value={stats.total} label="Assigned" onClick={() => setFilter('all')} active={filter === 'all'} />
          <Stat value={stats.todo} label="To do" tone="#ec633d" onClick={() => setFilter('todo')} active={filter === 'todo'} />
          <Stat value={stats.signoff} label="Sign-off" tone="#20386c" onClick={() => setFilter('signoff')} active={filter === 'signoff'} note={stats.signoff ? 'ask a lead' : undefined} />
          <Stat value={stats.done} label="Qualified" tone="#5a7d4a" onClick={() => setFilter('done')} active={filter === 'done'} />
        </div>

        <div ref={listRef}>
          {rows === null ? (
            <div className="mt-12">
              <LoadingSheet />
            </div>
          ) : rows.length === 0 ? (
            <div className="mt-12">
              <EmptyNote title="No training assigned yet." note="check back after your manager assigns some" />
            </div>
          ) : visible.length === 0 ? (
            <div className="mt-12">
              <EmptyNote title="Nothing in this pile." note="tap Assigned to see everything" />
            </div>
          ) : (
            Object.entries(groups).map(([cat, list], gi) => (
              <Folder key={cat} tab={`Section ${String(gi + 1).padStart(2, '0')}`} tone={gi % 2 ? 'deep' : 'manila'} className="mt-20" tight={list.length < 3}>
                <div className="mb-6 grid grid-cols-[1fr_auto] items-start gap-4 sm:items-end">
                  <div>
                    <h2 className="title text-[34px] md:text-[52px]">{cat}</h2>
                    {descs[cat] && <p className="lede mt-2 text-[16px] md:text-[18px]">{descs[cat]}</p>}
                    <span className="hand mt-3 inline-block text-[17px]" style={{ transform: 'rotate(-3deg)' }}>
                      {list.filter((r) => statusOf(r) === 'qualified').length} of {list.length} done
                    </span>
                  </div>
                  <IsoArt kind={kindForCategory(cat)} size={150} className="-mb-2 -mt-6 hidden sm:block" />
                  <IsoArt kind={kindForCategory(cat)} size={52} className="sm:hidden" float={false} />
                </div>
                <ul>
                  {list.map((r) => (
                    <LessonRow key={r.assignment_id} row={r} />
                  ))}
                </ul>
              </Folder>
            ))
          )}
        </div>
      </Container>
    </div>
  );
}

function LessonRow({ row }: { row: EmployeeTrainingRow }) {
  const s = statusOf(row);
  return (
    <li data-reveal>
      <a href={href(`lesson/${row.lesson_id}`)} className="group -mx-3 grid min-h-[64px] grid-cols-[1fr_auto] items-center gap-x-4 gap-y-2 border-b border-dashed border-ink-dash px-3 py-4 transition-colors duration-300 hover:bg-[#20386c]/[0.04] md:grid-cols-[1fr_auto_auto] md:py-5">
        <span className="min-w-0">
          <span className="block text-[19px] font-medium leading-tight tracking-tightish text-ink transition-transform duration-500 ease-joe-out group-hover:translate-x-1 md:text-[24px]">{row.lesson_title}</span>
          <span className="mt-2 flex flex-wrap items-center gap-1.5 md:hidden">
            <StatusTag status={s} compact />
            <DueTag due={s === 'qualified' ? null : row.due_date} />
            {row.requires_practical && (
              <span className="tag">
                <span className="tag-dot text-ink-2">
                  <HandGlyph size={12} />
                </span>
                Hands-on
              </span>
            )}
          </span>
        </span>
        <span className="hidden items-center gap-2 md:flex">
          <StatusTag status={s} />
          <DueTag due={s === 'qualified' ? null : row.due_date} />
          {row.requires_practical && (
            <span className="tag" title="Needs a hands-on sign-off">
              <span className="tag-dot text-ink-2">
                <HandGlyph size={12} />
              </span>
              Hands-on
            </span>
          )}
        </span>
        <span className="flex h-11 w-11 items-center justify-center border border-ink-rule/30 bg-sheet text-navy-3 transition-transform duration-500 ease-joe-out group-hover:-rotate-90 md:h-10 md:w-10" style={{ borderRadius: 2 }}>
          <Chevron size={12} />
        </span>
      </a>
    </li>
  );
}

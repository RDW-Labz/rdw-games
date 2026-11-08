import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { href } from '@/lib/router';
import { gsap, useEnter, reducedMotion } from '@/lib/motion';
import { useToast } from '@/lib/toast';
import type { Category, Lesson, LessonProgress } from '@/lib/types';
import { Button, Display, Hand, LinkButton, Skeleton, Tape } from '@/components/ui/kit';
import { Container, Folder } from '@/components/ui/layout';
import { ArrowDown, ArrowLeft, Check, Cross, Eye, Hand as HandGlyph, Image as ImageGlyph, Loop, Play } from '@/components/ui/Glyph';
import { Warehouse } from '@/components/art/Warehouse';
import { Dock } from '@/components/art/Dock';

export function LessonDetail({ lessonId, preview = false }: { lessonId: string; preview?: boolean }) {
  const { profile } = useAuth();
  const toast = useToast();
  const [lesson, setLesson] = useState<Lesson | null | undefined>(undefined);
  const [category, setCategory] = useState<Category | null>(null);
  const [progress, setProgress] = useState<LessonProgress | null>(null);
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [retaking, setRetaking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const ref = useEnter<HTMLDivElement>([lesson === undefined]);

  useEffect(() => {
    Promise.all([api.lesson(lessonId), profile && !preview ? api.progress(lessonId, profile.id) : Promise.resolve(null), api.categories()]).then(([l, p, cats]) => {
      setLesson(l);
      setProgress(p);
      setCategory(cats.find((c) => c.id === l?.category_id) ?? null);
    });
  }, [lessonId, profile, preview]);

  const quiz = lesson?.quiz_questions ?? [];
  const isRetrain = !!(progress && lesson && progress.completed_version > 0 && lesson.version > progress.completed_version);
  const quizOpen = preview || !progress?.quiz_passed || isRetrain || retaking;
  const showResult = !preview && !!progress && progress.quiz_total > 0 && !quizOpen;
  const lastFailed = !!progress && progress.quiz_total > 0 && !progress.quiz_passed;

  const step = useMemo(() => {
    if (!progress || !progress.quiz_passed || isRetrain) return 1;
    if (!progress.acknowledged) return 2;
    if (lesson?.requires_practical && !progress.practical_signed_off) return 3;
    return 4;
  }, [progress, lesson, isRetrain]);

  async function submitQuiz() {
    if (!profile || !lesson) return;
    setBusy(true);
    const score = quiz.reduce((a, q, i) => a + (answers[i] === q.answer_index ? 1 : 0), 0);
    try {
      const p = await api.submitQuiz({ employeeId: profile.id, lesson, score, existing: progress, resetAck: isRetrain || retaking });
      setProgress(p);
      setRetaking(false);
      if (p.quiz_passed) toast.push(`Quiz passed — ${p.quiz_score}/${p.quiz_total}`);
      else toast.push(`Not yet — ${p.quiz_score}/${p.quiz_total}. Review and try again.`, 'error');
    } catch {
      toast.push('Could not save your quiz. Try again.', 'error');
    }
    setBusy(false);
  }

  async function acknowledge() {
    if (!progress) return;
    setBusy(true);
    try {
      setProgress(await api.acknowledge(progress.id));
      toast.push('Signed. Thanks!');
    } catch {
      toast.push('Could not save your signature. Try again.', 'error');
    }
    setBusy(false);
  }

  if (lesson === undefined) {
    return (
      <Container className="max-w-[980px] pt-[130px]">
        <Skeleton className="mb-6 h-4 w-40" />
        <Skeleton className="mb-4 h-24 w-3/4" />
        <Skeleton className="h-6 w-1/2" />
      </Container>
    );
  }
  if (!lesson) {
    return (
      <Container className="max-w-[760px] pt-[140px] text-center">
        <Display text="Not found" className="text-[clamp(56px,9vw,120px)]" />
        <p className="lede mt-4 text-[18px]">That lesson was removed or the link is wrong.</p>
        <div className="mt-8 flex justify-center">
          <LinkButton href={href('')} variant="cream">
            Back to my training
          </LinkButton>
        </div>
      </Container>
    );
  }

  const steps = ['Learn + quiz', 'Sign', ...(lesson.requires_practical ? ['Hands-on'] : []), 'Qualified'];
  const stepIndex = lesson.requires_practical ? step : step === 4 ? 3 : step;

  return (
    <div ref={ref}>
      <Container className="max-w-[1060px] pt-[96px] md:pt-[120px]">
        <a href={href(preview ? 'lessons' : '')} className="mono group inline-flex items-center gap-2 text-[13px] text-ink-2 hover:text-ink" data-rise>
          <ArrowLeft size={14} className="transition-transform duration-500 ease-joe-out group-hover:-translate-x-1" />
          {preview ? 'Lesson library' : 'My training'}
        </a>

        <header className="relative mt-8">
          <div className="label flex flex-wrap items-center gap-x-3 gap-y-1" data-rise>
            <span>{category?.name ?? 'Lesson'}</span>
            <span className="text-ink-3">/</span>
            <span>Version {lesson.version}</span>
            <span className="text-ink-3">/</span>
            <span>{quiz.length} questions</span>
            {preview && <span className="tag ml-1 text-navy">Manager preview</span>}
            {lesson.requires_practical && (
              <span className="ml-2 hidden normal-case tracking-normal sm:inline">
                <Hand rot={-4} size={17} underline>
                  + hands-on sign-off
                </Hand>
              </span>
            )}
          </div>
          <Display text={lesson.title} className="mt-4 text-[clamp(44px,7.4vw,104px)]" />
          <p className="lede mt-6 max-w-[760px] text-[20px] md:text-[24px]" style={{ textWrap: 'balance' }} data-rise>
            {lesson.summary}
          </p>
        </header>

        {/* Step ruler */}
        {!preview && (
          <ol className="mt-10 grid gap-2" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0,1fr))` }} data-rise>
            {steps.map((s, i) => {
              const n = i + 1;
              const state = n < stepIndex ? 'done' : n === stepIndex ? 'now' : 'next';
              return (
                <li key={s} className="min-w-0">
                  <div className="h-[6px] w-full origin-left" data-line style={{ background: state === 'next' ? 'rgba(55,55,55,.15)' : state === 'now' ? '#ec633d' : '#283f7d' }} />
                  <div className="mt-2.5 flex items-center gap-2">
                    <span className={`mono flex h-6 w-6 flex-none items-center justify-center text-[11px] ${state === 'done' ? 'bg-navy text-white' : state === 'now' ? 'bg-signal-orange text-white' : 'border border-ink-rule/40 text-ink-2'}`} style={{ borderRadius: 2 }}>
                      {state === 'done' ? <Check size={11} /> : n}
                    </span>
                    <span className={`hidden truncate text-[15px] font-medium tracking-tightish sm:inline ${state === 'next' ? 'text-ink-3' : 'text-ink'}`}>{s}</span>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        {!preview && (
          <p className="mono mt-3 text-[12px] uppercase tracking-[0.05em] text-ink-2 sm:hidden">
            Step {stepIndex} of {steps.length} · <span className="text-ink">{steps[stepIndex - 1]}</span>
          </p>
        )}

        {isRetrain && !retaking && (
          <div className="relative mt-10" data-pop data-rot="-0.6">
            <div className="relative flex flex-col gap-2 bg-signal-orange px-6 py-5 text-white md:flex-row md:items-center md:gap-8" style={{ transform: 'rotate(-0.6deg)', boxShadow: 'var(--shadow-sheet)', borderRadius: 2 }}>
              <Tape className="-top-2 left-8" />
              <div className="mono flex-none text-[12px] uppercase tracking-[0.06em] text-white/85">Procedure updated · v{progress?.completed_version} → v{lesson.version}</div>
              <p className="max-w-[64ch] flex-1 text-[19px] font-medium leading-snug tracking-tightish" style={{ textWrap: 'balance' }}>This lesson changed. Read it again, retake the quiz and sign to stay qualified.</p>
              <button onClick={() => document.getElementById('quiz')?.scrollIntoView({ behavior: 'smooth', block: 'start' })} className="group/btn btn btn-cream flex-none self-start md:self-auto">
                <span className="btn-icon text-white" style={{ background: '#283f7d' }}>
                  <ArrowDown size={15} />
                </span>
                Start the update
              </button>
            </div>
          </div>
        )}
      </Container>

      <Container className="max-w-[1060px]">
        <div className="mt-12 grid items-start gap-6 md:grid-cols-12">
          <div className="space-y-6 md:col-span-7">
            {lesson.video_url && <VideoFrame url={lesson.video_url} title={lesson.title} />}
            {(lesson.video_url ? lesson.screenshot_urls.slice(1) : lesson.screenshot_urls.slice(0, 1)).map((u, i) => (
              <Diagram key={u.slice(-40) + i} url={u} n={lesson.video_url ? i + 2 : 1} rot={-0.8} onOpen={setLightbox} />
            ))}
            {!lesson.video_url && lesson.screenshot_urls.length === 0 && (
              <div className="relative aspect-video overflow-hidden border border-ink-rule" data-dark data-wipe>
                {/pickup|checkout/i.test(category?.name ?? '') ? <Dock variant="pickup" label="PICKUP" /> : <Warehouse label={(category?.name ?? 'LESSON').toUpperCase().slice(0, 12)} />}
              </div>
            )}
          </div>
          <div className="space-y-6 md:col-span-5">
            <FactsCard lesson={lesson} progress={preview ? null : progress} step={preview ? 0 : stepIndex} steps={steps} retrain={isRetrain} />
            {(lesson.video_url ? lesson.screenshot_urls.slice(0, 1) : lesson.screenshot_urls.slice(1)).map((u, i) => (
              <Diagram key={u.slice(-40) + 'b' + i} url={u} n={lesson.video_url ? 1 : i + 2} rot={1.1} onOpen={setLightbox} />
            ))}
          </div>
        </div>

        {lesson.instructions && (
          <Folder tab="How to" tone="cream" className="mt-20">
            <div className="grid gap-8 md:grid-cols-[220px_1fr]">
              <div>
                <h2 className="title text-[32px] md:text-[40px]">Step by step</h2>
                <Hand rot={-3} size={16} className="mt-3 block">
                  read it, then do it
                </Hand>
              </div>
              <ol>
                {lesson.instructions
                  .split('\n')
                  .filter((l) => l.trim())
                  .map((line, i) => (
                    <li key={i} className="flex gap-4 border-b border-dashed border-ink-dash py-4 last:border-b-0">
                      <span className="mono mt-0.5 flex h-7 w-7 flex-none items-center justify-center border border-ink-rule text-[12px]" style={{ borderRadius: 2 }}>
                        {i + 1}
                      </span>
                      <span className="text-[17px] leading-[1.45] tracking-tightish text-ink md:text-[19px]">{line}</span>
                    </li>
                  ))}
              </ol>
            </div>
          </Folder>
        )}

        {lesson.requires_practical && (
          <section id="handson" data-dark className="relative mb-8 mt-16 scroll-mt-24 overflow-hidden px-5 py-12 md:px-12 md:py-16" style={{ background: '#20386c' }} data-rise>
            <div className="grain-local" style={{ opacity: 0.25 }} />
            <div className="relative grid items-center gap-8 md:grid-cols-[1fr_1.1fr]">
              <div className="text-white">
                <div className="mono text-[12px] uppercase tracking-[0.06em] text-white/60">Hands-on sign-off</div>
                <h2 className="title mt-2 text-[34px] text-white md:text-[44px]">A manager watches you do it.</h2>
                <p className="mt-3 text-[16px] leading-relaxed text-white/75">After you pass the quiz and sign, a manager checks the real task on the floor and signs you off.</p>
              </div>
              <div className="relative bg-[#ebe4da] p-6 text-ink md:p-8" style={{ transform: 'rotate(1.5deg)', boxShadow: '9px 6px 0 rgba(0,0,0,.18)' }} data-pop data-rot="1.5">
                <div className="label mb-2">What the manager checks</div>
                <p className="text-[18px] font-medium leading-snug tracking-tightish">{lesson.practical_notes || 'They watch you complete the task safely, start to finish.'}</p>
                <div className="mt-5 flex items-center gap-3 border-t border-dashed border-ink-dash/60 pt-4">
                  {progress?.practical_signed_off ? (
                    <>
                      <span className="flex h-8 w-8 items-center justify-center bg-[#5a7d4a] text-white" style={{ borderRadius: 2 }}>
                        <Check size={14} />
                      </span>
                      <span className="text-[15px] font-medium">Signed off{progress.signed_off_at ? ` on ${new Date(progress.signed_off_at).toLocaleDateString()}` : ''}</span>
                    </>
                  ) : (
                    <>
                      <span className="flex h-8 w-8 items-center justify-center bg-navy-3 text-white" style={{ borderRadius: 2 }}>
                        <Eye size={14} />
                      </span>
                      <span className="text-[15px] text-ink-2">{step >= 3 ? 'Ready — ask a manager to watch\u00a0you.' : 'Unlocks after the quiz and your\u00a0signature.'}</span>
                    </>
                  )}
                </div>
              </div>
            </div>
          </section>
        )}

        {/* Quiz */}
        <Folder tab="Quiz" className={`${lesson.requires_practical ? 'mt-24' : 'mt-16'} scroll-mt-28`} id="quiz">
          <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="title text-[32px] md:text-[44px]">Quick quiz</h2>
              <p className="lede mt-2 text-[16px]">
                {quiz.length} questions · {lesson.passing_score} correct to pass
              </p>
            </div>
            {lastFailed && quizOpen && !preview && (
              <Hand rot={-3} size={17} color="#b2352c">
                last attempt · {progress!.quiz_score} of {progress!.quiz_total} — you&rsquo;ve got this
              </Hand>
            )}
          </div>

          {showResult ? (
            <QuizResult progress={progress!} onRetake={() => { setAnswers({}); setRetaking(true); }} />
          ) : (
            <>
              <ol className="space-y-8">
                {quiz.map((q, qi) => (
                  <li key={qi}>
                    <p className="mb-3 flex gap-3 text-[18px] font-medium leading-snug tracking-tightish text-ink md:text-[21px]">
                      <span className="mono mt-0.5 flex h-7 w-7 flex-none items-center justify-center bg-ink text-[12px] text-white" style={{ borderRadius: 2 }}>
                        {qi + 1}
                      </span>
                      {q.question}
                    </p>
                    <div className="grid gap-2 md:grid-cols-2">
                      {q.options.map((opt, oi) => {
                        const sel = answers[qi] === oi;
                        const correct = preview && oi === q.answer_index;
                        return (
                          <button key={oi} type="button" className="choice" data-state={correct ? 'correct' : sel ? 'selected' : undefined} onClick={() => !preview && setAnswers((a) => ({ ...a, [qi]: oi }))} aria-pressed={sel}>
                            <span className="choice-box" style={sel || correct ? { background: correct ? '#5a7d4a' : '#3b60c5', color: '#fff', borderStyle: 'solid', borderColor: 'transparent' } : undefined}>
                              {sel || correct ? <Check size={14} /> : String.fromCharCode(65 + oi)}
                            </span>
                            <span>{opt}</span>
                          </button>
                        );
                      })}
                    </div>
                  </li>
                ))}
              </ol>
              {!preview && (
                <div className="mt-10 flex flex-wrap items-center gap-4 border-t border-dashed border-ink-dash pt-6">
                  <Button onClick={submitQuiz} disabled={busy || Object.keys(answers).length < quiz.length}>
                    {busy ? 'Checking…' : 'Submit quiz'}
                  </Button>
                  <span className="mono text-[13px] text-ink-2">
                    {Object.keys(answers).length}/{quiz.length} answered
                  </span>
                </div>
              )}
            </>
          )}
        </Folder>

        {/* Signature */}
        {!preview && progress?.quiz_passed && !isRetrain && !retaking && (
          <Folder tab="Signature" tone="deep" className="mt-20 scroll-mt-28" id="sign">
            <SignBlock name={profile?.full_name ?? ''} signed={progress.acknowledged} at={progress.acknowledged_at} busy={busy} onSign={acknowledge} />
          </Folder>
        )}
      </Container>

      {!preview && <StickyCta cta={stepCta(lesson, progress, stepIndex, steps, isRetrain)} />}

      {lightbox && (
        <div onClick={() => setLightbox(null)} className="fixed inset-0 z-[90] flex items-center justify-center bg-[#373737]/60 p-4 backdrop-blur-[3px]" role="dialog" aria-label="Diagram">
          <img src={lightbox} alt="Diagram enlarged" className="max-h-[86vh] max-w-full bg-sheet p-2" style={{ boxShadow: 'var(--shadow-lift)', transform: 'rotate(-0.6deg)', animation: 'lb .6s cubic-bezier(.2,0,.1,1) both' }} />
          <style>{`@keyframes lb { from { opacity: 0; transform: translateY(30px) rotate(-5deg); } }`}</style>
        </div>
      )}
    </div>
  );
}

/* Phones: the next action stays reachable in a bar at the bottom until the
   lesson sheet's own button scrolls into view. */
function StickyCta({ cta }: { cta: ReturnType<typeof stepCta> }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const target = document.getElementById('sheet-cta');
    if (!target) return;
    const io = new IntersectionObserver(([e]) => setShow(!e.isIntersecting && e.boundingClientRect.top > 0), { threshold: 0 });
    io.observe(target);
    return () => io.disconnect();
  }, [cta.to]);
  const go = (e: React.MouseEvent) => {
    if (!cta.to) return;
    e.preventDefault();
    document.getElementById(cta.to)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  return (
    <div className={`fixed inset-x-0 bottom-0 z-[60] border-t border-ink-strong/80 px-3 pb-[max(12px,env(safe-area-inset-bottom))] pt-3 transition-transform duration-500 ease-joe-out sm:hidden ${show ? 'translate-y-0' : 'translate-y-full'}`} style={{ background: '#fffaf0', boxShadow: '0 -3px 0 rgba(0,0,0,.08)' }}>
      <a href={cta.to ? `#${cta.to}` : href('')} onClick={go} className="group/btn btn btn-primary w-full justify-start">
        <span className="btn-icon text-white" style={{ background: '#ec633d' }}>
          {cta.icon}
        </span>
        {cta.text}
      </a>
    </div>
  );
}

function Diagram({ url, n, rot, onOpen }: { url: string; n: number; rot: number; onOpen: (u: string) => void }) {
  return (
    <button onClick={() => onOpen(url)} className="group relative block w-full bg-sheet p-2 text-left transition-transform duration-500 ease-joe-out hover:-translate-y-1" style={{ boxShadow: 'var(--shadow-sheet)', transform: `rotate(${rot}deg)`, borderRadius: 2 }} data-pop data-rot={rot}>
      <img src={url} alt={`Diagram ${n}`} className="block aspect-[14/9] w-full border border-ink-rule/20 object-cover" />
      <span className="mono mt-2 flex items-center gap-2 px-1 pb-1 text-[12px] text-ink-2">
        <ImageGlyph size={13} /> Diagram {n} · tap to enlarge
      </span>
    </button>
  );
}

/* The one thing to do next, for the learner's current step. */
function stepCta(lesson: Lesson, progress: LessonProgress | null, step: number, steps: string[], retrain: boolean) {
  const label = steps[step - 1];
  void lesson;
  return step === 0 || step === 1
      ? { text: retrain || (progress && progress.quiz_total > 0 && !progress.quiz_passed) ? 'Retake the quiz' : 'Jump to the quiz', to: 'quiz', icon: retrain || (progress && progress.quiz_total > 0) ? <Loop size={15} /> : <ArrowDown size={15} /> }
      : label === 'Sign'
        ? { text: 'Sign to confirm', to: 'sign', icon: <HandGlyph size={15} /> }
        : label === 'Hands-on'
          ? { text: 'Ask a manager to watch you', to: 'handson', icon: <Eye size={15} /> }
          : { text: 'Back to my training', to: '', icon: <ArrowLeft size={15} /> };
}

/* The lesson "spec sheet": what it takes, and where you stand. */
function FactsCard({ lesson, progress, step, steps, retrain }: { lesson: Lesson; progress: LessonProgress | null; step: number; steps: string[]; retrain: boolean }) {
  const rows: [string, string][] = [
    ['Steps', String(lesson.instructions.split('\n').filter((l) => l.trim()).length)],
    ['Quiz', `${lesson.quiz_questions.length} questions · pass ${lesson.passing_score}`],
    ['Hands-on', lesson.requires_practical ? 'Manager sign-off' : 'Not needed'],
    ['Version', `v${lesson.version}`],
  ];
  if (progress && progress.quiz_total > 0)
    rows.push(retrain ? [`v${progress.completed_version} best`, `${progress.quiz_score}/${progress.quiz_total} — retake needed`] : ['Best try', `${progress.quiz_score}/${progress.quiz_total}${progress.quiz_passed ? ' · passed' : ''}`]);
  const cta = stepCta(lesson, progress, step, steps, retrain);
  const go = (e: React.MouseEvent) => {
    if (!cta.to) return;
    e.preventDefault();
    document.getElementById(cta.to)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  return (
    <div className="relative bg-sheet p-6" style={{ boxShadow: 'var(--shadow-sheet)', border: '1px solid rgba(66,66,66,.25)', borderRadius: 2 }} data-pop data-rot="0">
      <div className="flex items-start justify-between gap-3">
        <span className="label">Lesson sheet</span>
        {step > 0 && <span className="hand text-[15px]">step {step} of {steps.length}</span>}
      </div>
      <dl className="mt-4">
        {rows.map(([k, v]) => (
          <div key={k} className="grid grid-cols-[110px_1fr] gap-3 border-b border-dashed border-ink-dash/50 py-2.5 last:border-b-0">
            <dt className="mono text-[12px] uppercase tracking-[0.05em] text-ink-2">{k}</dt>
            <dd className="text-[15px] tracking-tightish text-ink">{v}</dd>
          </div>
        ))}
      </dl>
      <a id="sheet-cta" href={cta.to ? `#${cta.to}` : href('')} onClick={go} className="group/btn btn btn-primary mt-5 w-full justify-start">
        <span className="btn-icon text-white" style={{ background: '#ec633d' }}>
          {cta.icon}
        </span>
        {cta.text}
      </a>
      {cta.to === 'quiz' && <p className="mono mt-2 text-[11px] text-ink-2">Need {lesson.passing_score} of {lesson.quiz_questions.length} to pass</p>}
      {step > 1 && cta.to !== 'quiz' && (
        <button onClick={() => document.getElementById('quiz')?.scrollIntoView({ behavior: 'smooth', block: 'start' })} className="mono mt-3 text-[12px] text-ink-2 underline decoration-dotted underline-offset-4 hover:text-ink">
          Review the quiz
        </button>
      )}
    </div>
  );
}

function QuizResult({ progress, onRetake }: { progress: LessonProgress; onRetake: () => void }) {
  const stamp = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!stamp.current || reducedMotion()) return;
    gsap.fromTo(stamp.current, { scale: 1.6, opacity: 0, rotate: -18 }, { scale: 1, opacity: 1, rotate: -8, duration: 0.6, ease: 'joe.out', delay: 0.1 });
  }, []);
  const passed = progress.quiz_passed;
  const c = passed ? '#5a7d4a' : '#d2463a';
  return (
    <div className="flex flex-col items-start gap-8 md:flex-row md:items-center md:gap-14">
      <div ref={stamp} className="inline-flex flex-col items-center px-6 py-3" style={{ border: `3px solid ${c}`, color: c, transform: 'rotate(-8deg)', borderRadius: 4, boxShadow: `inset 0 0 0 2px #dfcfb2, inset 0 0 0 4px ${c}` }}>
        <span className="mono text-[28px] font-medium uppercase tracking-[0.12em]">{passed ? 'Passed' : 'Not yet'}</span>
        <span className="mono text-[14px]">
          {progress.quiz_score}/{progress.quiz_total} correct
        </span>
      </div>
      <div className="max-w-[420px]">
        <p className="text-[17px] leading-snug tracking-tightish text-ink">{passed ? 'Nice. Your score is saved — you can retake it any time to practice.' : 'Review the steps above, then try again.'}</p>
        <div className="mt-4">
          <Button variant="cream" onClick={onRetake} icon={<Loop size={15} />}>
            Retake quiz
          </Button>
        </div>
      </div>
    </div>
  );
}

function SignBlock({ name, signed, at, busy, onSign }: { name: string; signed: boolean; at: string | null; busy: boolean; onSign: () => void }) {
  const sig = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!signed || !sig.current || reducedMotion()) return;
    gsap.fromTo(sig.current, { clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0% 0 0)', duration: 1.4, ease: 'joe.inOut' });
  }, [signed]);
  return (
    <div className="grid items-end gap-8 md:grid-cols-[1fr_1fr]">
      <div>
        <h2 className="title text-[32px] md:text-[44px]">Sign to confirm</h2>
        <p className="lede mt-2 max-w-[420px] text-[16px]">I read this lesson, I understand it, and I&rsquo;ll follow it on the floor.</p>
      </div>
      <div>
        <div className="relative h-[72px] border-b-2 border-ink">
          <span className="mono absolute -top-1 left-0 text-[18px] text-ink-3">×</span>
          {signed ? (
            <span ref={sig} className="absolute bottom-1 left-8 font-hand text-[34px] leading-none text-navy" style={{ transform: 'rotate(-3deg)' }}>
              {name}
            </span>
          ) : (
            <span className="hand absolute bottom-3 left-8 text-[18px] text-ink-3">sign here</span>
          )}
        </div>
        <div className="mt-4 flex items-center justify-between gap-4">
          <span className="mono text-[12px] text-ink-2">{signed && at ? `Signed ${new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : name}</span>
          {!signed && (
            <Button onClick={onSign} disabled={busy} variant="primary" icon={<HandGlyph size={15} />}>
              {busy ? 'Saving…' : 'I understand — sign'}
            </Button>
          )}
          {signed && (
            <span className="tag text-[#3f5a35]">
              <span className="tag-dot bg-[#5a7d4a] text-white">
                <Check size={10} />
              </span>
              Signed
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function VideoFrame({ url, title }: { url: string; title: string }) {
  const [playing, setPlaying] = useState(false);
  const yt = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]+)/)?.[1];
  const isDemoClip = url.startsWith('demo://');
  return (
    <div data-dark className="relative aspect-video overflow-hidden border border-ink-rule bg-cobalt-deep" data-rise>
      {playing && !isDemoClip ? (
        yt ? (
          <iframe src={`https://www.youtube.com/embed/${yt}?autoplay=1`} title={title} className="h-full w-full" allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen />
        ) : (
          <video src={url} controls autoPlay className="h-full w-full" />
        )
      ) : (
        <button onClick={() => setPlaying(true)} className="group absolute inset-0 text-left">
          <div className="absolute inset-0">
            <Warehouse view="610 404 400 225" label="DEMO" />
          </div>
          <span className="mono absolute bottom-3 left-3 flex items-center gap-2 bg-sheet py-1 pl-1 pr-3 text-[13px] text-ink-strong" style={{ borderRadius: 2, boxShadow: 'var(--shadow-plate)' }}>
            <span className="flex h-7 w-7 items-center justify-center bg-signal-orange text-white" style={{ borderRadius: 2 }}>
              <Play size={11} />
            </span>
            Watch the demo
          </span>
        </button>
      )}
      {playing && isDemoClip && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-cobalt-deep p-6 text-center text-white">
          <span className="mono text-[12px] uppercase tracking-[0.06em] text-white/70">Demo mode</span>
          <p className="title text-[22px] text-white">The lesson video plays here in the live app.</p>
          <button onClick={() => setPlaying(false)} className="mono mt-2 inline-flex items-center gap-2 text-[13px] text-white/80 hover:text-white">
            <Cross size={11} /> Close
          </button>
        </div>
      )}
    </div>
  );
}

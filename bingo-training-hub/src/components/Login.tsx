import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { isDemo } from '@/lib/api';
import { demo, DEMO_PEOPLE } from '@/lib/demo';
import { useEnter } from '@/lib/motion';
import type { Profile } from '@/lib/types';
import { Button, Display, Field, Hand, Hole, Segmented, Stamp } from '@/components/ui/kit';
import { Dock } from '@/components/art/Dock';
import { LogoMark, Wordmark } from '@/components/shell/Logo';
import { ArrowBlock } from '@/components/ui/Glyph';
import { Coords } from '@/components/shell/Shell';

export function Login() {
  const { signIn, signUp, demoSignIn } = useAuth();
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [people, setPeople] = useState<Profile[]>([]);
  const ref = useEnter<HTMLDivElement>();

  useEffect(() => {
    if (isDemo) Promise.all(DEMO_PEOPLE.map((id) => demo.profileById(id))).then((p) => setPeople(p.filter(Boolean) as Profile[]));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = mode === 'signin' ? await signIn(email, password) : await signUp(email, password, fullName);
    setBusy(false);
    if (r.error) setError(r.error);
  }

  return (
    <div ref={ref} className="bg-grid relative min-h-screen overflow-hidden">
      <div className="grain" />
      <Coords dark={false} />
      <div className="fixed inset-x-3 top-3 z-[70] flex justify-center">
        <div className="plate flex h-[52px] items-center gap-3 px-2 pr-5">
          <LogoMark />
          <Wordmark />
        </div>
      </div>
      <div className="hand absolute right-6 top-[26px] z-[60] hidden text-[15px] lg:block">BinGo Auctions · Harrison, AR</div>

      <div className="relative mx-auto max-w-[1280px] px-4 pb-16 pt-[100px] md:px-8 md:pt-[124px]">
        <div className="relative text-center">
          <div className="relative inline-block max-w-full">
            <span className="absolute -top-9 left-2 hidden lg:block">
              <Hand rot={-4} size={22}>Employee training</Hand>
            </span>
            <span className="mb-2 block lg:hidden">
              <Hand rot={-2} size={14} underline>
                Employee training
              </Hand>
            </span>
            <Display text="Learn the floor" className="text-[clamp(48px,8vw,112px)]" />
            <span className="mt-2 block xl:hidden">
              <Hand rot={-3} size={15}>then do it right</Hand>
            </span>
            <span className="absolute left-full top-[30%] ml-4 hidden w-[190px] text-left xl:block">
              <Hand rot={-5} size={19} arrow="left">
                then do it right
              </Hand>
            </span>
          </div>
        </div>

        <div className="relative mt-8 grid grid-cols-1 items-start gap-6 lg:mt-12 lg:grid-cols-[minmax(0,1fr)_520px] lg:gap-0">
          <div data-dark className="relative h-[230px] min-w-0 overflow-hidden border border-ink-rule md:h-[460px] lg:h-[560px]" data-wipe>
            <Dock />
            <div className="absolute bottom-4 left-4 hidden items-center gap-3 bg-navy-deep/95 py-2 pl-2 pr-4 text-left md:flex" style={{ borderRadius: 2, boxShadow: '4px 4px 0 rgba(0,0,0,.2)' }}>
              <span className="flex h-8 w-8 flex-none items-center justify-center bg-signal-orange text-white" style={{ borderRadius: 2 }}>
                <ArrowBlock size={13} />
              </span>
              <p className="max-w-[300px] text-[14px] font-medium leading-tight tracking-tightish text-white">Lessons, quizzes and hands-on sign-offs for every job on the floor.</p>
            </div>
          </div>

          <div className="relative min-w-0 lg:-ml-16 lg:mt-16" data-pop data-rot="0">
            <div className="relative px-5 pb-8 pt-10 md:rotate-1 md:px-12 md:pb-12 md:pt-14" style={{ background: 'var(--sheet-modal)', border: '1px solid rgba(66,66,66,.3)', boxShadow: 'var(--shadow-sheet)', borderRadius: 2 }}>
              <div className="grain-local" style={{ opacity: 0.16 }} />
              <Hole className="left-4 top-4" />
              <Hole className="bottom-4 left-4" />
              <div className="relative">
                <div className="label mb-3">{isDemo ? 'Preview the app' : mode === 'signin' ? 'Welcome back' : 'New here'}</div>
                <h2 className="title text-[34px] md:text-[40px]">{isDemo ? 'Pick a person' : mode === 'signin' ? 'Sign in' : 'Create your account'}</h2>

                {isDemo ? (
                  <>
                    <p className="lede mt-3 text-[16px]">This is demo data. Choose who to preview as — a manager or someone on the floor.</p>
                    <div className="mt-6 space-y-2.5">
                      {people.map((p, i) => (
                        <button key={p.id} onClick={() => demoSignIn(p.id)} className="choice group" style={{ animation: `rise .8s ${0.4 + i * 0.06}s cubic-bezier(.2,0,.1,1) both` }}>
                          <Stamp name={p.full_name} size={38} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[16px] font-medium tracking-tightish text-ink-strong">{p.full_name}</span>
                            <span className="mono block text-[12px] leading-snug text-ink-2">{p.role === 'manager' ? 'Manager' : p.job_title}</span>
                            <span className="mono block text-[11px] leading-snug text-ink-3">{p.location}</span>
                          </span>
                          <span className="flex h-9 w-9 items-center justify-center text-white transition-transform duration-500 ease-joe-out group-hover:translate-x-1" style={{ background: '#283f7d', borderRadius: 2 }}>
                            <ArrowBlock size={14} />
                          </span>
                        </button>
                      ))}
                    </div>
                    <style>{`@keyframes rise { from { opacity: 0; transform: translateY(14px); } }`}</style>
                  </>
                ) : (
                  <form onSubmit={submit} className="mt-6 space-y-4">
                    <Segmented
                      value={mode}
                      onChange={(v) => {
                        setMode(v);
                        setError(null);
                      }}
                      options={[
                        { value: 'signin', label: 'Sign in' },
                        { value: 'signup', label: 'Create account' },
                      ]}
                    />
                    {mode === 'signup' && (
                      <Field label="Full name">
                        <input className="field" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="First and last name" required autoComplete="name" />
                      </Field>
                    )}
                    <Field label="Email">
                      <input className="field" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@bingoauctions.com" required autoComplete="email" />
                    </Field>
                    <Field label="Password">
                      <input className="field" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} />
                    </Field>
                    {error && (
                      <p className="mono border border-dashed border-signal-red/60 bg-[#fbeae4] px-3 py-2.5 text-[13px] text-[#b2352c]" role="alert">
                        {error}
                      </p>
                    )}
                    <Button type="submit" full disabled={busy}>
                      {busy ? (mode === 'signin' ? 'Signing in…' : 'Creating…') : mode === 'signin' ? 'Sign in' : 'Create account'}
                    </Button>
                    {mode === 'signup' && <Hand rot={-2} size={15} className="block pt-1">A manager sets your job + location after you sign up.</Hand>}
                  </form>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

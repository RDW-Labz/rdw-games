import { useEffect, useRef } from 'react';
import { AuthProvider, useAuth } from '@/lib/auth';
import { ToastProvider } from '@/lib/toast';
import { useRoute } from '@/lib/router';
import { gsap, reducedMotion } from '@/lib/motion';
import { Login } from '@/components/Login';
import { EmployeeTraining } from '@/components/employee/EmployeeTraining';
import { LessonDetail } from '@/components/employee/LessonDetail';
import { Overview } from '@/components/manager/Overview';
import { Employees } from '@/components/manager/Employees';
import { Lessons } from '@/components/manager/Lessons';
import { Assign } from '@/components/manager/Assign';
import { Shell, type NavItem } from '@/components/shell/Shell';
import { LogoMark } from '@/components/shell/Logo';

function Loader() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current || reducedMotion()) return;
    const cells = ref.current.querySelectorAll('svg > *');
    gsap.fromTo(cells, { opacity: 0, scale: 0.6, transformOrigin: 'center' }, { opacity: 1, scale: 1, stagger: 0.04, duration: 0.6, repeat: -1, yoyo: true, repeatDelay: 0.3, ease: 'joe.inOut' });
  }, []);
  return (
    <div className="bg-grid flex min-h-screen flex-col items-center justify-center gap-4">
      <div className="grain" />
      <div ref={ref} className="plate p-4" style={{ filter: 'drop-shadow(0 0 1px #3f3f3f)' }}>
        <LogoMark size={44} />
      </div>
      <span className="hand text-[16px]">loading the floor…</span>
    </div>
  );
}

const EMPLOYEE_NAV: NavItem[] = [{ path: '', label: 'My training', match: (r) => !r[0] || r[0] === 'lesson' }];
const MANAGER_NAV: NavItem[] = [
  { path: '', label: 'Overview', match: (r) => !r[0] },
  { path: 'employees', label: 'Roster', match: (r) => r[0] === 'employees' },
  { path: 'lessons', label: 'Lessons', match: (r) => r[0] === 'lessons' },
  { path: 'assign', label: 'Assign', match: (r) => r[0] === 'assign' },
];

function AppShell() {
  const { profile, loading } = useAuth();
  const route = useRoute();
  if (loading) return <Loader />;
  if (!profile) return <Login />;

  if (profile.role === 'manager') {
    const page = route[0] === 'employees' ? <Employees route={route} /> : route[0] === 'lessons' ? <Lessons route={route} /> : route[0] === 'assign' ? <Assign /> : route[0] === 'lesson' && route[1] ? <LessonDetail lessonId={route[1]} preview /> : <Overview />;
    return (
      <Shell items={MANAGER_NAV} route={route} cta={{ label: 'New lesson', path: 'lessons/new' }}>
        <div key={route.join('/')}>{page}</div>
      </Shell>
    );
  }
  const page = route[0] === 'lesson' && route[1] ? <LessonDetail lessonId={route[1]} /> : <EmployeeTraining />;
  return (
    <Shell items={EMPLOYEE_NAV} route={route} cta={route[0] === 'lesson' ? { label: 'All lessons', path: '' } : undefined}>
      <div key={route.join('/')}>{page}</div>
    </Shell>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <AppShell />
      </ToastProvider>
    </AuthProvider>
  );
}

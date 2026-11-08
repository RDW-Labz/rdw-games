import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { go } from './router';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { isDemo } from './api';
import { demo } from './demo';
import type { Profile } from './types';

interface AuthState {
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signUp: (email: string, password: string, fullName: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  demoSignIn: (profileId: string) => Promise<void>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);
const DEMO_KEY = 'bth-demo-user';

function readDemoUser() {
  try {
    return localStorage.getItem(DEMO_KEY);
  } catch {
    return null;
  }
}
function writeDemoUser(id: string | null) {
  try {
    if (id) localStorage.setItem(DEMO_KEY, id);
    else localStorage.removeItem(DEMO_KEY);
  } catch {
    /* storage unavailable — demo still works for this tab */
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  async function loadProfile(uid: string) {
    const { data, error } = await supabase.from('profiles').select('*').eq('id', uid).maybeSingle();
    if (error) {
      console.error('profile load failed', error);
      return null;
    }
    return (data as Profile) ?? null;
  }

  useEffect(() => {
    if (isDemo) {
      const id = readDemoUser();
      (id ? demo.profileById(id) : Promise.resolve(null)).then((p) => {
        setProfile(p);
        setTimeout(() => setLoading(false), 650);
      });
      return;
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (data.session) {
        loadProfile(data.session.user.id).then((p) => {
          setProfile(p);
          setLoading(false);
        });
      } else setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, newSession) => {
      (async () => {
        setSession(newSession);
        if (newSession && (event === 'SIGNED_IN' || event === 'USER_UPDATED' || event === 'TOKEN_REFRESHED')) setProfile(await loadProfile(newSession.user.id));
        else if (!newSession) setProfile(null);
      })();
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  async function signIn(email: string, password: string) {
    if (isDemo) return { error: 'Demo mode — pick a person below to preview.' };
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { error: 'Could not sign in. Check your email and password.' };
    return { error: null };
  }

  async function signUp(email: string, password: string, fullName: string) {
    if (isDemo) return { error: 'Demo mode — pick a person below to preview.' };
    const { error } = await supabase.auth.signUp({ email, password, options: { data: { full_name: fullName } } });
    if (error) return { error: 'Could not create your account. That email may already be in use.' };
    return { error: null };
  }

  async function signOut() {
    if (!isDemo) await supabase.auth.signOut();
    writeDemoUser(null);
    setProfile(null);
    setSession(null);
    go('');
  }

  async function demoSignIn(profileId: string) {
    writeDemoUser(profileId);
    setProfile(await demo.profileById(profileId));
    go('');
  }

  return <AuthContext.Provider value={{ session, profile, loading, signIn, signUp, signOut, demoSignIn }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

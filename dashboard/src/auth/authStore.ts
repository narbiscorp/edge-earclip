// Auth state, kept in its own Zustand slice (separate from the main
// dashboard store) so the rest of the app doesn't get re-rendered when
// only the auth state changes.
//
// The store subscribes to `supabase.auth.onAuthStateChange` once on
// module load — there's no `init()` to forget to call.

import { create } from 'zustand';
import type { Session, User } from '@supabase/supabase-js';
import { supabase, SUPABASE_CONFIGURED } from '../lib/supabase';

export type AuthStatus = 'loading' | 'signed_in' | 'signed_out';

interface AuthState {
  status: AuthStatus;
  user: User | null;
  session: Session | null;

  /** Whether the login modal is open. */
  showLogin: boolean;
  setShowLogin: (v: boolean) => void;

  signOut: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  status: SUPABASE_CONFIGURED ? 'loading' : 'signed_out',
  user: null,
  session: null,
  showLogin: false,
  setShowLogin: (v) => set({ showLogin: v }),
  signOut: async () => {
    try { await supabase.auth.signOut(); }
    catch (err) { console.warn('[auth] signOut failed', err); }
  },
}));

// Bootstrap: pull initial session, then subscribe to changes.
if (SUPABASE_CONFIGURED) {
  void supabase.auth.getSession().then(({ data }) => {
    const session = data.session ?? null;
    useAuthStore.setState({
      status: session ? 'signed_in' : 'signed_out',
      user: session?.user ?? null,
      session,
    });
  }).catch((err) => {
    console.warn('[auth] getSession failed', err);
    useAuthStore.setState({ status: 'signed_out' });
  });

  supabase.auth.onAuthStateChange((_event, session) => {
    useAuthStore.setState({
      status: session ? 'signed_in' : 'signed_out',
      user: session?.user ?? null,
      session,
      // Close the login modal on successful sign-in.
      showLogin: session ? false : useAuthStore.getState().showLogin,
    });
  });
}

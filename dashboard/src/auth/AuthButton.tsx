// Header auth pill. Shows:
//   • signed out  → "Sign in to save"     (opens LoginModal)
//   • signed in   → "<email> · Sign out"  (signs out)
//   • loading     → "…"                   (waiting for getSession)
//
// Hidden entirely when Supabase isn't configured so contributors without
// env vars don't see a broken-looking control.

import { SUPABASE_CONFIGURED } from '../lib/supabase';
import { useAuthStore } from './authStore';

export default function AuthButton() {
  const status   = useAuthStore((s) => s.status);
  const user     = useAuthStore((s) => s.user);
  const setShow  = useAuthStore((s) => s.setShowLogin);
  const signOut  = useAuthStore((s) => s.signOut);

  if (!SUPABASE_CONFIGURED) return null;

  if (status === 'loading') {
    return (
      <div className="px-3 py-1 text-xs text-slate-500 shrink-0">…</div>
    );
  }

  if (status === 'signed_out') {
    return (
      <button
        onClick={() => setShow(true)}
        className="px-3 py-1 rounded-lg border border-indigo-700/50 bg-indigo-900/30 hover:bg-indigo-800/50 text-xs font-medium text-indigo-200 shrink-0 transition"
        title="Sign in to save and view session history"
      >
        Sign in to save
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2 shrink-0">
      <span className="text-xs text-slate-400 max-w-[180px] truncate" title={user?.email ?? ''}>
        {user?.email ?? 'Signed in'}
      </span>
      <button
        onClick={() => { void signOut(); }}
        className="px-2 py-1 rounded text-xs text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition"
        title="Sign out"
      >
        Sign out
      </button>
    </div>
  );
}

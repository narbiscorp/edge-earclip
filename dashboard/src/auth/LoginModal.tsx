// Sign-in modal — magic-link email + Google OAuth.
//
// On successful sign-in the authStore subscription closes this modal
// automatically (see authStore.ts).

import { useState } from 'react';
import { supabase, SUPABASE_CONFIGURED } from '../lib/supabase';
import { useAuthStore } from './authStore';

function redirectUrl(): string {
  // Land back on the same page after the magic-link round-trip.
  if (typeof window === 'undefined') return '';
  return window.location.origin + window.location.pathname;
}

export default function LoginModal() {
  const setShowLogin = useAuthStore((s) => s.setShowLogin);

  const [email, setEmail]       = useState('');
  const [sending, setSending]   = useState(false);
  const [magicSent, setSent]    = useState(false);
  const [error, setError]       = useState<string | null>(null);

  const close = () => setShowLogin(false);

  async function sendMagicLink(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setError(null);
    setSending(true);
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: { emailRedirectTo: redirectUrl() },
      });
      if (error) setError(error.message);
      else setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  async function signInWithGoogle() {
    setError(null);
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: redirectUrl() },
      });
      if (error) setError(error.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/90 backdrop-blur-sm"
      onClick={close}
    >
      <div
        className="relative bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-sm mx-4 p-6 space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-100">Sign in</h2>
          <button
            onClick={close}
            className="text-slate-500 hover:text-slate-300 text-xl leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {!SUPABASE_CONFIGURED ? (
          <div className="rounded border border-amber-700/40 bg-amber-900/20 p-3 text-xs text-amber-200">
            Cloud save is not configured for this deployment.
            <br />
            Tuning works without an account.
          </div>
        ) : magicSent ? (
          <div className="rounded border border-emerald-700/40 bg-emerald-900/20 p-3 text-sm text-emerald-200">
            Check <strong>{email}</strong> for a sign-in link.
            <div className="text-xs text-emerald-400/80 mt-1">
              You can close this dialog.
            </div>
          </div>
        ) : (
          <>
            <form onSubmit={sendMagicLink} className="space-y-3">
              <label className="block">
                <span className="text-xs uppercase tracking-wide text-slate-400">Email</span>
                <input
                  type="email"
                  required
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="mt-1 w-full rounded bg-slate-800 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500"
                  placeholder="you@example.com"
                />
              </label>
              <button
                type="submit"
                disabled={sending || !email.trim()}
                className="w-full px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium text-white transition"
              >
                {sending ? 'Sending…' : 'Email me a sign-in link'}
              </button>
            </form>

            <div className="flex items-center gap-2 text-xs text-slate-500">
              <div className="flex-1 h-px bg-slate-700" />
              <span>or</span>
              <div className="flex-1 h-px bg-slate-700" />
            </div>

            <button
              onClick={signInWithGoogle}
              className="w-full px-4 py-2 rounded-lg border border-slate-700 hover:border-slate-600 bg-slate-800 hover:bg-slate-700 text-sm font-medium text-slate-100 transition"
            >
              Continue with Google
            </button>

            <div className="text-[11px] text-slate-500 leading-relaxed">
              Sessions you save are private to your account. You can sign in
              from any device with the same email to see your history.
            </div>
          </>
        )}

        {error && (
          <div className="rounded border border-rose-700/40 bg-rose-900/20 p-2 text-xs text-rose-200">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

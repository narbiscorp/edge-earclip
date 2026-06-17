// Active-client state — which client the next saved session is attributed to.
//
// Kept in its own Zustand slice (like authStore) so selecting a client doesn't
// re-render the whole dashboard. Persisted to localStorage *per signed-in user*
// (key `narbis.activeClient.<userId>`) so a shared machine doesn't leak the
// previous clinician's selection to the next one.
//
// This is a pointer, not the source of truth for attribution: a session's
// client_id is bound at save/confirm time (see SessionSummaryModal), never
// continuously — switching the active client mid-session is harmless.

import { create } from 'zustand';
import { useAuthStore } from '../auth/authStore';

const KEY_PREFIX = 'narbis.activeClient.';

interface PersistedActive { id: string; name: string }

// The user whose selection is currently loaded. setActiveClient writes under
// this key; null means signed-out (nothing is persisted).
let _currentUserId: string | null = null;

function load(userId: string): PersistedActive | null {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + userId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedActive>;
    if (typeof parsed.id === 'string' && typeof parsed.name === 'string') {
      return { id: parsed.id, name: parsed.name };
    }
    return null;
  } catch {
    return null;
  }
}

function save(userId: string, active: PersistedActive | null): void {
  try {
    if (active) localStorage.setItem(KEY_PREFIX + userId, JSON.stringify(active));
    else localStorage.removeItem(KEY_PREFIX + userId);
  } catch { /* quota / private mode */ }
}

interface ClientStoreState {
  activeClientId: string | null;     // null = "Unassigned"
  activeClientName: string | null;   // cached for display without a fetch

  /** Set (or clear, with null) the active client and persist it for this user. */
  setActiveClient: (c: { id: string; name: string } | null) => void;
  /** Clear the in-memory selection (e.g. on sign-out) without touching storage. */
  clearActiveClient: () => void;
  /** Re-read the persisted selection for a (possibly new) signed-in user. */
  hydrateForUser: (userId: string | null) => void;
}

export const useClientStore = create<ClientStoreState>((set) => ({
  activeClientId: null,
  activeClientName: null,

  setActiveClient: (c) => {
    if (_currentUserId) save(_currentUserId, c ? { id: c.id, name: c.name } : null);
    set({ activeClientId: c?.id ?? null, activeClientName: c?.name ?? null });
  },

  clearActiveClient: () => set({ activeClientId: null, activeClientName: null }),

  hydrateForUser: (userId) => {
    _currentUserId = userId;
    if (!userId) {
      set({ activeClientId: null, activeClientName: null });
      return;
    }
    const active = load(userId);
    set({
      activeClientId: active?.id ?? null,
      activeClientName: active?.name ?? null,
    });
  },
}));

// Bootstrap + react to auth changes. Mirrors sessions/pendingSyncQueue.ts.
// Hydrate from the current auth state immediately (covers the case where the
// session was already restored before this module subscribed), then keep in
// sync as the user signs in/out or switches accounts.
useClientStore.getState().hydrateForUser(useAuthStore.getState().user?.id ?? null);

useAuthStore.subscribe((state, prev) => {
  const nextId = state.user?.id ?? null;
  const prevId = prev.user?.id ?? null;
  if (nextId !== prevId) {
    useClientStore.getState().hydrateForUser(nextId);
  }
});

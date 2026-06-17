import { useEffect, useRef, useState } from 'react';
import { useDashboardStore } from '../state/store';
import { useAuthStore } from '../auth/authStore';
import { useClientStore } from '../clients/clientStore';
import ClientPicker from '../clients/ClientPicker';
import { SUPABASE_CONFIGURED } from '../lib/supabase';
import { getPairedDeviceName } from '../ble/narbisDevice';
import { forgetEdgePairedDevice, getEdgePairedDeviceName } from '../ble/edgeDevice';
import type { NarbisStatus } from '../ble/narbisDevice';
import type { PolarStatus } from '../ble/polarH10';
import type { EdgeStatus } from '../ble/edgeDevice';

/* ──────────────────────────────────────────────────────────────
   SlimHeader — Basic/Mobile-mode replacement for the wall-of-chrome
   App header. Brand on the left, three device pills (Earclip / Glasses
   / Polar) in the middle, ⚙ and ⋮ trays on the right.
     - Each device pill is a button that opens a popover with the
       same Connect / Forget / Disconnect actions the Expert header
       has, talking through the same store setters.
     - The ⚙ cog tray holds the Basic/Mobile/Expert toggle + the auth
       buttons (sign in / sign out / email display).
     - The ⋮ kebab menu holds End Session + History.
   Expert mode keeps the existing header verbatim — this component
   is only mounted for uiMode === 'basic' | 'mobile'.
   ────────────────────────────────────────────────────────────── */

const STATE_DOT: Record<NarbisStatus | PolarStatus | EdgeStatus, string> = {
  disconnected: 'bg-slate-600',
  connecting: 'bg-amber-400 animate-pulse',
  reconnecting: 'bg-amber-400 animate-pulse',
  connected: 'bg-emerald-400',
};

interface SlimHeaderProps {
  onShowHistory: () => void;
  onOpenClinicianPortal: () => void;
}

export default function SlimHeader({ onShowHistory, onOpenClinicianPortal }: SlimHeaderProps) {
  const narbis = useDashboardStore((s) => s.connection.narbis);
  const edge = useDashboardStore((s) => s.connection.edge);
  const polar = useDashboardStore((s) => s.connection.polar);
  const uiMode = useDashboardStore((s) => s.uiMode);
  const setUiMode = useDashboardStore((s) => s.setUiMode);
  const endSessionAndSave = useDashboardStore((s) => s.endSessionAndSave);

  /* Earclip pill — the relay case is folded in: when the dashboard
   * isn't directly paired but the glasses' BLE-central is relaying
   * frames through, treat the earclip as effectively "connected" for
   * pill color, and label it "via Glasses" instead of showing battery. */
  const earclipRelayed =
    narbis.state === 'disconnected' &&
    edge.state === 'connected' &&
    edge.earclipRelay === true;
  const earclipDotState: NarbisStatus =
    earclipRelayed ? 'connected' : narbis.state;
  const earclipSocPct = narbis.battery?.soc_pct ?? null;
  const earclipSubLabel = earclipRelayed
    ? 'via Glasses'
    : earclipSocPct != null
      ? `${earclipSocPct}%`
      : null;

  /* Glasses + Polar don't expose a battery service in the store today —
   * the only `battery` field is on `narbis.battery` (populated either by
   * direct earclip pairing or by the relayed-battery event on the glasses).
   * If/when those services arrive, swap these nulls for the real values. */
  const glassesSocPct: number | null = null;
  const polarSocPct: number | null = null;

  return (
    <header className="flex items-center gap-2 px-3 py-2 border-b border-slate-800/70 bg-slate-950/80 backdrop-blur-sm shrink-0">
      <div className="text-[12px] tracking-wide text-slate-300 truncate min-w-0">
        <span className="text-slate-100">narbis</span>{' '}
        <span className="text-slate-500 hidden sm:inline">HRV Glasses Dashboard</span>
      </div>

      <RecordingForChip />


      <div className="flex items-center gap-1.5 ml-auto flex-wrap justify-end">
        <DevicePill
          name="Earclip"
          state={earclipDotState}
          sub={earclipSubLabel}
          popover={<EarclipPopover />}
        />
        <DevicePill
          name="Glasses"
          state={edge.state}
          sub={glassesSocPct != null ? `${glassesSocPct}%` : null}
          popover={<GlassesPopover />}
        />
        <DevicePill
          name="Polar"
          state={polar.state}
          sub={polarSocPct != null ? `${polarSocPct}%` : null}
          popover={<PolarPopover />}
        />
        <CogTray
          uiMode={uiMode}
          setUiMode={setUiMode}
          onOpenClinicianPortal={onOpenClinicianPortal}
        />
        <KebabMenu
          onEndSession={endSessionAndSave}
          onShowHistory={onShowHistory}
        />
      </div>
    </header>
  );
}

/* ──────────────────────────────────────────────────────────────
   Device status pill. Clicking opens a small popover anchored
   under the pill with the connect/disconnect/forget actions for
   that specific device. The popover content is supplied by the
   parent so we can share dropdown chrome without coupling to any
   one device's setters.
   ────────────────────────────────────────────────────────────── */
function DevicePill({
  name, state, sub, popover,
}: {
  name: string;
  state: NarbisStatus | PolarStatus | EdgeStatus;
  sub: string | null;
  popover: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useDismissOnOutsideClick(rootRef, open, () => setOpen(false));

  const isConnected = state === 'connected';
  const dotCls = STATE_DOT[state];
  const labelCls = isConnected ? 'text-slate-200' : 'text-slate-400';

  return (
    <div className="relative" ref={rootRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={
          'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] transition ' +
          (isConnected
            ? 'border-slate-700 bg-slate-800/60 hover:border-slate-500'
            : 'border-slate-700/60 bg-slate-800/30 hover:border-slate-500')
        }
        title={`${name} · ${state}${sub ? ` · ${sub}` : ''}`}
      >
        <span
          className={'h-1.5 w-1.5 rounded-full ' + dotCls}
          style={isConnected ? { boxShadow: '0 0 6px #34d399' } : undefined}
        />
        <span className={labelCls}>{name}</span>
        {sub && <span className="tabular-nums text-slate-500">{sub}</span>}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1.5 z-30 min-w-[200px] rounded-lg border border-slate-700 bg-slate-900 shadow-xl p-2 space-y-1">
          {popover}
        </div>
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   Per-device popovers. Each one reads the live state directly so
   the popover updates while open (e.g., button label flips from
   "Connect" to "Disconnect" as the device pairs).
   ────────────────────────────────────────────────────────────── */
function EarclipPopover() {
  const narbis = useDashboardStore((s) => s.connection.narbis);
  const pairedName = getPairedDeviceName();
  const connect = () => {
    void useDashboardStore.getState().connectNarbis().catch(console.error);
  };
  const disconnect = () => {
    void useDashboardStore.getState().disconnectNarbis().catch(console.error);
  };
  const forget = () => {
    void useDashboardStore.getState().forgetNarbis().catch(console.error);
  };
  return (
    <>
      <PopoverHeader
        title={narbis.deviceName ?? pairedName ?? 'Earclip'}
        state={narbis.state}
      />
      {narbis.state === 'disconnected' ? (
        <>
          <PopoverButton variant="connect" onClick={connect}>Connect</PopoverButton>
          {pairedName && (
            <PopoverButton onClick={forget} title="Clear saved earclip — next connect will prompt">
              Forget
            </PopoverButton>
          )}
        </>
      ) : (
        <PopoverButton
          onClick={disconnect}
          disabled={narbis.state === 'connecting'}
        >
          Disconnect
        </PopoverButton>
      )}
    </>
  );
}

function GlassesPopover() {
  const edge = useDashboardStore((s) => s.connection.edge);
  const edgePairedName = getEdgePairedDeviceName();
  const connect = () => {
    void useDashboardStore.getState().connectEdge().catch(console.error);
  };
  const disconnect = () => {
    void useDashboardStore.getState().disconnectEdge().catch(console.error);
  };
  const forget = () => {
    void useDashboardStore.getState().disconnectEdge().catch(() => { /* ignore */ });
    forgetEdgePairedDevice();
  };
  const repairEarclip = () => {
    if (!confirm(
      'This tells the connected glasses to forget their current earclip and ' +
      'rescan for a new one. The closest powered-on Narbis Earclip will be ' +
      'picked. Continue?'
    )) return;
    void useDashboardStore.getState().edgeForgetEarclip().catch(console.error);
  };
  return (
    <>
      <PopoverHeader
        title={edge.deviceName ?? edgePairedName ?? 'Glasses'}
        state={edge.state}
      />
      {edge.state === 'disconnected' ? (
        <>
          <PopoverButton variant="connect" onClick={connect}>Connect</PopoverButton>
          {edgePairedName && (
            <PopoverButton onClick={forget} title="Clear saved glasses — next connect will prompt">
              Forget
            </PopoverButton>
          )}
        </>
      ) : (
        <>
          <PopoverButton
            onClick={disconnect}
            disabled={edge.state === 'connecting'}
          >
            Disconnect
          </PopoverButton>
          <PopoverButton
            onClick={repairEarclip}
            disabled={edge.state !== 'connected'}
            title="Tell the glasses to drop their current earclip and rescan"
          >
            Re-pair earclip
          </PopoverButton>
        </>
      )}
    </>
  );
}

function PolarPopover() {
  const polar = useDashboardStore((s) => s.connection.polar);
  const connect = () => {
    void useDashboardStore.getState().connectPolar().catch(console.error);
  };
  const disconnect = () => {
    void useDashboardStore.getState().disconnectPolar().catch(console.error);
  };
  return (
    <>
      <PopoverHeader title={polar.deviceName ?? 'Polar H10'} state={polar.state} />
      {polar.state === 'disconnected' ? (
        <PopoverButton variant="connect" onClick={connect}>Connect</PopoverButton>
      ) : (
        <PopoverButton
          onClick={disconnect}
          disabled={polar.state === 'connecting'}
        >
          Disconnect
        </PopoverButton>
      )}
    </>
  );
}

function PopoverHeader({
  title, state,
}: { title: string; state: NarbisStatus | PolarStatus | EdgeStatus }) {
  return (
    <div className="px-2 py-1.5 mb-1 border-b border-slate-800">
      <div className="text-xs font-medium text-slate-200 truncate">{title}</div>
      <div className="text-[10px] text-slate-500 capitalize">{state}</div>
    </div>
  );
}

function PopoverButton({
  children, onClick, variant, disabled, title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  variant?: 'connect';
  disabled?: boolean;
  title?: string;
}) {
  const base = 'w-full text-left rounded px-2 py-1.5 text-xs transition disabled:opacity-50 disabled:cursor-not-allowed';
  const cls = variant === 'connect'
    ? `${base} bg-emerald-600 hover:bg-emerald-500 text-white font-medium`
    : `${base} bg-slate-800 hover:bg-slate-700 text-slate-200`;
  return (
    <button className={cls} onClick={onClick} disabled={disabled} title={title}>
      {children}
    </button>
  );
}

/* ──────────────────────────────────────────────────────────────
   Cog tray — mode toggle (Basic / Mobile / Expert) + auth section.
   Auth section is hidden when Supabase isn't configured (matches
   the existing AuthButton behavior).
   ────────────────────────────────────────────────────────────── */
function CogTray({
  uiMode, setUiMode, onOpenClinicianPortal,
}: {
  uiMode: 'basic' | 'expert' | 'mobile';
  setUiMode: (m: 'basic' | 'expert' | 'mobile') => void;
  onOpenClinicianPortal: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useDismissOnOutsideClick(rootRef, open, () => setOpen(false));

  const authStatus = useAuthStore((s) => s.status);
  const authUser = useAuthStore((s) => s.user);
  const setShowLogin = useAuthStore((s) => s.setShowLogin);
  const signOut = useAuthStore((s) => s.signOut);

  return (
    <div className="relative" ref={rootRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center justify-center h-7 w-7 rounded-full border border-slate-700 bg-slate-800/60 text-slate-300 hover:border-slate-500 hover:text-slate-100 transition"
        title="Settings"
        aria-label="Settings"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1.5 z-30 min-w-[220px] rounded-lg border border-slate-700 bg-slate-900 shadow-xl p-2">
          <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500 px-2 py-1">View</div>
          <div className="grid grid-cols-3 gap-1 mb-2">
            {(['basic', 'mobile', 'expert'] as const).map((m) => (
              <button
                key={m}
                onClick={() => { setUiMode(m); setOpen(false); }}
                className={
                  'rounded px-2 py-1 text-xs transition capitalize ' +
                  (uiMode === m
                    ? 'bg-cyan-500/20 text-cyan-100 border border-cyan-400/60'
                    : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border border-transparent')
                }
              >
                {m}
              </button>
            ))}
          </div>
          {SUPABASE_CONFIGURED && (
            <>
              <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500 px-2 py-1">Account</div>
              {authStatus === 'loading' && (
                <div className="px-2 py-1.5 text-xs text-slate-500">loading…</div>
              )}
              {authStatus === 'signed_out' && (
                <PopoverButton
                  variant="connect"
                  onClick={() => { setShowLogin(true); setOpen(false); }}
                >
                  Sign in
                </PopoverButton>
              )}
              {authStatus === 'signed_in' && (
                <>
                  <div className="px-2 py-1 text-xs text-slate-400 truncate" title={authUser?.email ?? ''}>
                    {authUser?.email ?? 'Signed in'}
                  </div>
                  {/* Active training-client picker — renders nothing until the
                      clinician has created at least one client. Sits directly
                      below the email per the clinician-portal flow. */}
                  <ClientPicker />
                  <PopoverButton onClick={() => { onOpenClinicianPortal(); setOpen(false); }}>
                    Clinician portal
                  </PopoverButton>
                  <PopoverButton onClick={() => { void signOut(); setOpen(false); }}>
                    Sign out
                  </PopoverButton>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   Kebab menu — End Session + History. Both items mirror the
   matching buttons in the expert header. History only shows when
   Supabase is wired up.
   ────────────────────────────────────────────────────────────── */
function KebabMenu({
  onEndSession, onShowHistory,
}: {
  onEndSession: () => void;
  onShowHistory: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useDismissOnOutsideClick(rootRef, open, () => setOpen(false));

  return (
    <div className="relative" ref={rootRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center justify-center h-7 w-7 rounded-full border border-slate-700 bg-slate-800/60 text-slate-300 hover:border-slate-500 hover:text-slate-100 transition"
        title="More"
        aria-label="More"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="12" cy="5" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="12" cy="19" r="1.6" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1.5 z-30 min-w-[180px] rounded-lg border border-slate-700 bg-slate-900 shadow-xl p-2 space-y-1">
          <PopoverButton onClick={() => { onEndSession(); setOpen(false); }}>
            End session
          </PopoverButton>
          {SUPABASE_CONFIGURED && (
            <PopoverButton onClick={() => { onShowHistory(); setOpen(false); }}>
              History
            </PopoverButton>
          )}
        </div>
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   "Recording for" chip — shows the active training client in the
   brand area so a clinician sees who the live session will be
   attributed to *before* the end-of-session confirm. Hidden when no
   client is selected (personal use), keeping the header clean.
   ────────────────────────────────────────────────────────────── */
function RecordingForChip() {
  const activeClientName = useClientStore((s) => s.activeClientName);
  if (!activeClientName) return null;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-cyan-500/40 bg-cyan-500/10 px-2 py-0.5 text-[11px] text-cyan-200 truncate max-w-[40vw] shrink min-w-0"
      title={`New sessions will be saved to ${activeClientName}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-cyan-400 shrink-0" style={{ boxShadow: '0 0 6px #22d3ee' }} />
      <span className="text-cyan-400/70">rec</span>
      <span className="truncate">{activeClientName}</span>
    </span>
  );
}

/* Tiny utility — closes a popover when the user clicks outside the
 * root ref or hits Escape. Used by every dropdown in this header. */
function useDismissOnOutsideClick(
  rootRef: React.RefObject<HTMLElement | null>,
  open: boolean,
  onDismiss: () => void,
) {
  useEffect(() => {
    if (!open) return;
    const onClick = (ev: MouseEvent) => {
      const root = rootRef.current;
      if (root && ev.target instanceof Node && !root.contains(ev.target)) {
        onDismiss();
      }
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onDismiss();
    };
    /* Schedule the listener for the next tick so the same click that
     * opened the menu doesn't immediately close it. */
    const id = window.setTimeout(() => {
      window.addEventListener('mousedown', onClick);
      window.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener('mousedown', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onDismiss, rootRef]);
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { useDashboardStore } from '../state/store';
import { narbisDevice } from '../ble/narbisDevice';
import {
  BUILT_IN_PRESETS,
  deleteUserPreset,
  exportPresetJson,
  findUserPresetByName,
  importPresetJson,
  listUserPresets,
  saveUserPreset,
  type SavedPreset,
} from './config/presetStore';

type Status = { kind: 'idle' } | { kind: 'busy'; msg: string } | { kind: 'ok'; msg: string } | { kind: 'err'; msg: string };

export default function PresetBar() {
  const config = useDashboardStore((s) => s.config);
  const narbisState = useDashboardStore((s) => s.connection.narbis.state);
  const isConnected = narbisState === 'connected';

  const [userPresets, setUserPresets] = useState<SavedPreset[]>([]);
  const [selectedId, setSelectedId] = useState<string>('builtin-default');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [saveName, setSaveName] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refreshUserPresets = useCallback(async () => {
    try {
      const list = await listUserPresets();
      setUserPresets(list);
    } catch (err) {
      setStatus({ kind: 'err', msg: `load presets: ${errMsg(err)}` });
    }
  }, []);

  useEffect(() => {
    void refreshUserPresets();
  }, [refreshUserPresets]);

  useEffect(() => {
    if (status.kind === 'ok' || status.kind === 'err') {
      const t = setTimeout(() => setStatus({ kind: 'idle' }), 3000);
      return () => clearTimeout(t);
    }
  }, [status]);

  const selected: SavedPreset | undefined =
    BUILT_IN_PRESETS.find((p) => p.id === selectedId) ??
    userPresets.find((p) => p.id === selectedId);

  const onApply = async () => {
    if (!selected) return;
    setStatus({ kind: 'busy', msg: `applying ${selected.name}…` });
    try {
      await narbisDevice.writeConfig(selected.config);
      setStatus({ kind: 'ok', msg: `applied ${selected.name}` });
    } catch (err) {
      setStatus({ kind: 'err', msg: `apply: ${errMsg(err)}` });
    }
  };

  const onSave = async () => {
    if (!config) return;
    const trimmed = saveName.trim();
    if (!trimmed) {
      setStatus({ kind: 'err', msg: 'preset name required' });
      return;
    }
    setStatus({ kind: 'busy', msg: 'saving…' });
    try {
      const existing = await findUserPresetByName(trimmed);
      if (existing && !window.confirm(`Overwrite preset "${trimmed}"?`)) {
        setStatus({ kind: 'idle' });
        return;
      }
      const saved = await saveUserPreset({
        id: existing?.id,
        name: trimmed,
        config,
      });
      setShowSaveModal(false);
      setSaveName('');
      await refreshUserPresets();
      setSelectedId(saved.id);
      setStatus({ kind: 'ok', msg: `saved ${saved.name}` });
    } catch (err) {
      setStatus({ kind: 'err', msg: `save: ${errMsg(err)}` });
    }
  };

  const onDelete = async () => {
    if (!selected || selected.builtIn) return;
    if (!window.confirm(`Delete preset "${selected.name}"?`)) return;
    try {
      await deleteUserPreset(selected.id);
      await refreshUserPresets();
      setSelectedId('builtin-default');
      setStatus({ kind: 'ok', msg: 'preset deleted' });
    } catch (err) {
      setStatus({ kind: 'err', msg: `delete: ${errMsg(err)}` });
    }
  };

  const onExport = () => {
    if (!selected) return;
    try {
      const json = exportPresetJson(selected);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const safe = selected.name.replace(/[^a-zA-Z0-9._-]+/g, '_');
      a.download = `${safe}.narbispreset.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setStatus({ kind: 'ok', msg: 'preset exported' });
    } catch (err) {
      setStatus({ kind: 'err', msg: `export: ${errMsg(err)}` });
    }
  };

  const onImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setStatus({ kind: 'busy', msg: `importing ${file.name}…` });
    try {
      const text = await file.text();
      const saved = await importPresetJson(text);
      await refreshUserPresets();
      setSelectedId(saved.id);
      setStatus({ kind: 'ok', msg: `imported ${saved.name}` });
    } catch (err) {
      setStatus({ kind: 'err', msg: `import: ${errMsg(err)}` });
    }
  };

  const busy = status.kind === 'busy';
  const canApply = isConnected && !!selected && !busy;
  const canSave = !!config && !busy;
  const canDelete = !!selected && !selected.builtIn && !busy;

  return (
    <div className="rounded border border-slate-800 bg-slate-900/50 p-3 flex flex-col gap-2 text-[11px]">
      <div className="text-[12px] font-medium text-slate-200">Presets</div>
      <select
        value={selectedId}
        onChange={(e) => setSelectedId(e.target.value)}
        className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-100"
      >
        <optgroup label="Built-in">
          {BUILT_IN_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </optgroup>
        {userPresets.length > 0 ? (
          <optgroup label="Saved">
            {userPresets.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </optgroup>
        ) : null}
      </select>
      {selected?.description ? (
        <div className="text-[10px] text-slate-500">{selected.description}</div>
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={onApply}
          disabled={!canApply}
          className="rounded bg-emerald-600 hover:bg-emerald-500 px-2 py-1 text-[11px] font-medium disabled:opacity-40 disabled:hover:bg-emerald-600"
        >
          Apply
        </button>
        <button
          type="button"
          onClick={() => { setSaveName(''); setShowSaveModal(true); }}
          disabled={!canSave}
          className="rounded bg-slate-700 hover:bg-slate-600 px-2 py-1 text-[11px] disabled:opacity-40"
        >
          Save as…
        </button>
        <button
          type="button"
          onClick={() => void onDelete()}
          disabled={!canDelete}
          className="rounded bg-slate-800 hover:bg-rose-700 px-2 py-1 text-[11px] disabled:opacity-40"
        >
          Delete
        </button>
        <button
          type="button"
          onClick={onExport}
          disabled={!selected || busy}
          className="rounded bg-slate-800 hover:bg-slate-700 px-2 py-1 text-[11px] disabled:opacity-40"
        >
          Export
        </button>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
          className="rounded bg-slate-800 hover:bg-slate-700 px-2 py-1 text-[11px] disabled:opacity-40"
        >
          Import
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => { void onImport(e); }}
        />
      </div>
      {!isConnected ? (
        <div className="text-[10px] text-amber-300/80">Connect to apply or import a preset.</div>
      ) : null}
      {status.kind !== 'idle' ? (
        <div
          className={`text-[10px] ${
            status.kind === 'err'
              ? 'text-rose-400'
              : status.kind === 'ok'
                ? 'text-emerald-400'
                : 'text-slate-300'
          }`}
        >
          {status.msg}
        </div>
      ) : null}

      {showSaveModal ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70"
          onClick={() => setShowSaveModal(false)}
        >
          <div
            className="w-80 rounded border border-slate-700 bg-slate-900 p-4 flex flex-col gap-2"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-[12px] font-medium text-slate-100">Save preset</div>
            <input
              autoFocus
              type="text"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void onSave();
                else if (e.key === 'Escape') setShowSaveModal(false);
              }}
              placeholder="Preset name"
              className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-slate-100"
            />
            <div className="text-[10px] text-slate-500">
              Saves the current config snapshot. Existing names will be overwritten with confirmation.
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setShowSaveModal(false)}
                className="rounded bg-slate-800 hover:bg-slate-700 px-2 py-1 text-[11px]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void onSave()}
                disabled={!saveName.trim() || busy}
                className="rounded bg-emerald-600 hover:bg-emerald-500 px-2 py-1 text-[11px] font-medium disabled:opacity-40"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

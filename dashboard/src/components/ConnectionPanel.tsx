export default function ConnectionPanel() {
  return (
    <div className="flex items-center gap-3 text-sm text-slate-400">
      <span className="px-2 py-1 rounded bg-slate-800">Narbis: disconnected</span>
      <span className="px-2 py-1 rounded bg-slate-800">Polar H10: disconnected</span>
      <span className="px-2 py-1 rounded bg-slate-800">Recording: idle</span>
    </div>
  );
}

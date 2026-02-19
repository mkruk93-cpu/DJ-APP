"use client";

import { useRadioStore } from "@/lib/radioStore";
import { MODE_LABELS } from "@/lib/types";

const MODE_COLORS: Record<string, string> = {
  dj: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  radio: "bg-violet-500/20 text-violet-400 border-violet-500/30",
  democracy: "bg-green-500/20 text-green-400 border-green-500/30",
  jukebox: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  party: "bg-pink-500/20 text-pink-400 border-pink-500/30",
};

export default function ModeIndicator() {
  const mode = useRadioStore((s) => s.mode);
  const connected = useRadioStore((s) => s.connected);

  if (!connected) return null;

  const color = MODE_COLORS[mode] ?? MODE_COLORS.radio;
  const label = MODE_LABELS[mode] ?? mode;

  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold ${color}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}

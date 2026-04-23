"use client";

import { useState } from "react";
import { useRadioStore } from "@/lib/radioStore";
import { setMode as apiSetMode } from "@/lib/radioApi";
import { getSupabase } from "@/lib/supabaseClient";
import type { Mode } from "@/lib/types";
import { MODE_LABELS } from "@/lib/types";

const MODE_CONFIG: { mode: Mode; icon: string; description: string }[] = [
  { mode: "dj", icon: "DJ", description: "Alleen admin beheert alles" },
  { mode: "radio", icon: "FM", description: "Automatische playlist, admin-beheerd" },
  { mode: "democracy", icon: "DM", description: "Iedereen kan toevoegen en stemmen" },
  { mode: "jukebox", icon: "JB", description: "Iedereen voegt toe, admin skipt" },
  { mode: "party", icon: "PT", description: "Iedereen mag alles" },
  { mode: "solo", icon: "SO", description: "Alleen de geplande solist kan toevoegen en soundboarden" },
];

export default function ModeSelector() {
  const currentMode = useRadioStore((s) => s.mode);
  const connected = useRadioStore((s) => s.connected);
  const serverUrl = useRadioStore((s) => s.serverUrl);
  const [status, setStatus] = useState<string | null>(null);

  async function ensureFreshServerUrl(): Promise<boolean> {
    try {
      const { data } = await getSupabase()
        .from("settings")
        .select("radio_server_url")
        .eq("id", 1)
        .single();
      const freshUrl = (data?.radio_server_url ?? "").trim().replace(/\/+$/, "");
      if (freshUrl) {
        useRadioStore.getState().setServerUrl(freshUrl);
        return true;
      }
    } catch {}
    return !!(useRadioStore.getState().serverUrl ?? process.env.NEXT_PUBLIC_CONTROL_SERVER_URL);
  }

  async function selectMode(mode: Mode) {
    setStatus(`Wijzigen naar ${MODE_LABELS[mode]}...`);
    try {
      const hasUrl = await ensureFreshServerUrl();
      if (!hasUrl) {
        setStatus("Fout: geen radio server URL gevonden");
        setTimeout(() => setStatus(null), 4000);
        return;
      }
      await apiSetMode(mode);
      setStatus(`${MODE_LABELS[mode]} actief`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus(`Fout: ${msg}`);
    }
    setTimeout(() => setStatus(null), 4000);
  }

  return (
    <div className="space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500">
        Modus {!connected && <span className="text-yellow-500">(socket offline)</span>}
      </h3>
      {status && (
        <p className={`text-xs ${status.startsWith("Fout:") ? "text-red-400" : "text-green-400"}`}>
          {status}
        </p>
      )}
      {!serverUrl && !process.env.NEXT_PUBLIC_CONTROL_SERVER_URL && (
        <p className="text-xs text-red-400">Geen server URL geconfigureerd</p>
      )}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {MODE_CONFIG.map(({ mode, icon, description }) => {
          const active = mode === currentMode;
          return (
            <button
              key={mode}
              onClick={() => selectMode(mode)}
              className={`flex flex-col items-center gap-1.5 rounded-xl border p-3 text-center transition sm:p-4 ${
                active
                  ? "border-violet-500 bg-violet-500/10 shadow-sm shadow-violet-500/20"
                  : "border-gray-700 bg-gray-800/50 hover:border-gray-600"
              }`}
            >
              <span className="rounded-full border border-current/20 px-2 py-1 text-xs font-bold">{icon}</span>
              <span className={`text-sm font-semibold ${active ? "text-violet-400" : "text-gray-300"}`}>
                {MODE_LABELS[mode]}
              </span>
              <span className="text-xs leading-tight text-gray-500">{description}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

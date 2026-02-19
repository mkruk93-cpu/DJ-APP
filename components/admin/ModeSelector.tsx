"use client";

import { useState, useEffect } from "react";
import { useRadioStore } from "@/lib/radioStore";
import { getSocket } from "@/lib/socket";
import { getRadioToken } from "@/lib/auth";
import type { Mode } from "@/lib/types";
import { MODE_LABELS } from "@/lib/types";

const MODE_CONFIG: { mode: Mode; icon: string; description: string }[] = [
  { mode: "dj", icon: "🎧", description: "Alleen admin beheert alles" },
  { mode: "radio", icon: "📻", description: "Automatische playlist, admin-beheerd" },
  { mode: "democracy", icon: "🗳️", description: "Iedereen kan toevoegen en stemmen" },
  { mode: "jukebox", icon: "🎵", description: "Iedereen voegt toe, admin skipt" },
  { mode: "party", icon: "🎉", description: "Iedereen mag alles" },
];

export default function ModeSelector() {
  const currentMode = useRadioStore((s) => s.mode);
  const connected = useRadioStore((s) => s.connected);
  const [debugMsg, setDebugMsg] = useState("");
  const [lastEvent, setLastEvent] = useState("");

  useEffect(() => {
    const s = getSocket();
    function onMode(data: { mode: string }) {
      setLastEvent(`Received mode:${data.mode} at ${new Date().toLocaleTimeString()}`);
    }
    s.on("mode:change", onMode);
    return () => { s.off("mode:change", onMode); };
  }, []);

  function selectMode(mode: Mode) {
    const token = getRadioToken();
    const s = getSocket();
    const info = `store:${currentMode} sock:${s.connected} id:${s.id ?? "none"}`;

    if (!token || !connected) { setDebugMsg(`BLOCKED | ${info}`); return; }

    s.emit("mode:set", { mode, token });
    setDebugMsg(`Sent ${mode} | ${info}`);
  }

  return (
    <div className="space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500">
        Modus
      </h3>
      {debugMsg && <p className="text-xs text-yellow-400 bg-yellow-500/10 rounded p-2 break-all">{debugMsg}</p>}
      {lastEvent && <p className="text-xs text-green-400 bg-green-500/10 rounded p-2 break-all">{lastEvent}</p>}
      <p className="text-xs text-gray-500">Store mode: {currentMode}</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
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
              <span className="text-2xl">{icon}</span>
              <span className={`text-sm font-semibold ${active ? "text-violet-400" : "text-gray-300"}`}>
                {MODE_LABELS[mode]}
              </span>
              <span className="text-xs text-gray-500 leading-tight">{description}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

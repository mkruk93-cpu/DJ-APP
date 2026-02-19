"use client";

import { useRef } from "react";
import { useRadioStore } from "@/lib/radioStore";
import { updateSetting as apiUpdateSetting } from "@/lib/radioApi";

export default function ModeSettings() {
  const mode = useRadioStore((s) => s.mode);
  const settings = useRadioStore((s) => s.modeSettings);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleUpdate(key: string, value: number) {
    // Optimistic local update
    useRadioStore.getState().setModeSettings({ ...settings, [key]: value });

    // Debounce the HTTP call so dragging a slider doesn't spam requests
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      apiUpdateSetting(key, value).catch((err) =>
        console.warn("[ModeSettings]", err)
      );
    }, 300);
  }

  if (mode === "dj" || mode === "radio") {
    return (
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
        <p className="text-sm text-gray-500">
          Geen extra instellingen voor deze modus.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-xl border border-gray-800 bg-gray-900 p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500">
        Modus instellingen
      </h3>

      {mode === "democracy" && (
        <>
          <div>
            <label className="mb-1.5 flex items-center justify-between text-sm text-gray-300">
              <span>Skip-drempel</span>
              <span className="font-semibold text-violet-400">{settings.democracy_threshold}%</span>
            </label>
            <input
              type="range"
              min={1}
              max={100}
              value={settings.democracy_threshold}
              onChange={(e) => handleUpdate("democracy_threshold", Number(e.target.value))}
              className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-gray-700 accent-violet-500"
            />
          </div>
          <div>
            <label className="mb-1.5 flex items-center justify-between text-sm text-gray-300">
              <span>Stemtimer</span>
              <span className="font-semibold text-violet-400">{settings.democracy_timer}s</span>
            </label>
            <input
              type="range"
              min={5}
              max={60}
              value={settings.democracy_timer}
              onChange={(e) => handleUpdate("democracy_timer", Number(e.target.value))}
              className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-gray-700 accent-violet-500"
            />
          </div>
        </>
      )}

      {mode === "jukebox" && (
        <div>
          <label className="mb-1.5 flex items-center justify-between text-sm text-gray-300">
            <span>Max nummers per gebruiker</span>
            <span className="font-semibold text-violet-400">{settings.jukebox_max_per_user}</span>
          </label>
          <input
            type="range"
            min={1}
            max={20}
            value={settings.jukebox_max_per_user}
            onChange={(e) => handleUpdate("jukebox_max_per_user", Number(e.target.value))}
            className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-gray-700 accent-violet-500"
          />
        </div>
      )}

      {mode === "party" && (
        <div>
          <label className="mb-1.5 flex items-center justify-between text-sm text-gray-300">
            <span>Skip cooldown</span>
            <span className="font-semibold text-violet-400">{settings.party_skip_cooldown}s</span>
          </label>
          <input
            type="range"
            min={0}
            max={60}
            value={settings.party_skip_cooldown}
            onChange={(e) => handleUpdate("party_skip_cooldown", Number(e.target.value))}
            className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-gray-700 accent-violet-500"
          />
        </div>
      )}
    </div>
  );
}

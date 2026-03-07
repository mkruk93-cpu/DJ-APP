"use client";

import { useRef } from "react";
import { useRadioStore } from "@/lib/radioStore";
import { updateSetting as apiUpdateSetting } from "@/lib/radioApi";
import type { Mode, ModeSettings } from "@/lib/types";

const MODE_ORDER: Mode[] = ["dj", "radio", "democracy", "jukebox", "party"];
const MODE_LABEL: Record<Mode, string> = {
  dj: "DJ",
  radio: "Radio",
  democracy: "Democratie",
  jukebox: "Jukebox",
  party: "Party",
};

function getQueueSettingKeys(mode: Mode): {
  base: keyof ModeSettings;
  min: keyof ModeSettings;
  step: keyof ModeSettings;
} {
  if (mode === "dj") {
    return {
      base: "dj_queue_base_per_user",
      min: "dj_queue_min_per_user",
      step: "dj_queue_listener_step",
    };
  }
  if (mode === "radio") {
    return {
      base: "radio_queue_base_per_user",
      min: "radio_queue_min_per_user",
      step: "radio_queue_listener_step",
    };
  }
  if (mode === "democracy") {
    return {
      base: "democracy_queue_base_per_user",
      min: "democracy_queue_min_per_user",
      step: "democracy_queue_listener_step",
    };
  }
  if (mode === "party") {
    return {
      base: "party_queue_base_per_user",
      min: "party_queue_min_per_user",
      step: "party_queue_listener_step",
    };
  }
  return {
    base: "jukebox_queue_base_per_user",
    min: "jukebox_queue_min_per_user",
    step: "jukebox_queue_listener_step",
  };
}

function getDynamicLimitPreview(settings: ModeSettings, mode: Mode, listeners: number): number {
  const keys = getQueueSettingKeys(mode);
  const min = Math.max(1, Math.round(Number(settings[keys.min] ?? 1)));
  const base = Math.max(min, Math.round(Number(settings[keys.base] ?? min)));
  const step = Math.max(1, Math.round(Number(settings[keys.step] ?? 1)));
  const normalizedListeners = Math.max(1, Math.round(Number(listeners || 1)));
  const reduction = Math.floor(Math.max(0, normalizedListeners - 1) / step);
  return Math.max(min, base - reduction);
}

export default function ModeSettings() {
  const mode = useRadioStore((s) => s.mode);
  const settings = useRadioStore((s) => s.modeSettings);
  const listenerCount = useRadioStore((s) => s.listenerCount);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleUpdate(key: keyof ModeSettings, value: number) {
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

  return (
    <div className="space-y-4 rounded-xl border border-gray-800 bg-gray-900 p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500">
        Modus instellingen
      </h3>

      <div className="space-y-3 rounded-lg border border-gray-800 bg-gray-950/60 p-3">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold text-gray-200">Wachtrij limiet per modus</h4>
          <span className="text-xs text-gray-400">
            Online: <span className="font-semibold text-violet-300">{listenerCount}</span>
          </span>
        </div>
        <p className="text-xs text-gray-500">
          Minder luisteraars = hogere limiet. Meer luisteraars = lagere limiet.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          {MODE_ORDER.map((modeKey) => {
            const keys = getQueueSettingKeys(modeKey);
            const previewLimit = getDynamicLimitPreview(settings, modeKey, listenerCount);
            return (
              <div key={modeKey} className="space-y-2 rounded-lg border border-gray-800 bg-gray-900/70 p-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-gray-200">{MODE_LABEL[modeKey]}</p>
                  <p className="text-xs text-violet-300">Nu: {previewLimit} p.p.</p>
                </div>
                <div>
                  <label className="mb-1.5 flex items-center justify-between text-xs text-gray-300">
                    <span>Basis max p.p.</span>
                    <span className="font-semibold text-violet-400">{settings[keys.base]}</span>
                  </label>
                  <input
                    type="range"
                    min={1}
                    max={20}
                    value={settings[keys.base]}
                    onChange={(e) => handleUpdate(keys.base, Number(e.target.value))}
                    className="violet-slider h-1.5 w-full cursor-pointer appearance-none rounded-full bg-gray-700 accent-violet-500"
                  />
                </div>
                <div>
                  <label className="mb-1.5 flex items-center justify-between text-xs text-gray-300">
                    <span>Min p.p.</span>
                    <span className="font-semibold text-violet-400">{settings[keys.min]}</span>
                  </label>
                  <input
                    type="range"
                    min={1}
                    max={20}
                    value={settings[keys.min]}
                    onChange={(e) => handleUpdate(keys.min, Number(e.target.value))}
                    className="violet-slider h-1.5 w-full cursor-pointer appearance-none rounded-full bg-gray-700 accent-violet-500"
                  />
                </div>
                <div>
                  <label className="mb-1.5 flex items-center justify-between text-xs text-gray-300">
                    <span>Verlaag 1 bij elke X luisteraars</span>
                    <span className="font-semibold text-violet-400">{settings[keys.step]}</span>
                  </label>
                  <input
                    type="range"
                    min={1}
                    max={20}
                    value={settings[keys.step]}
                    onChange={(e) => handleUpdate(keys.step, Number(e.target.value))}
                    className="violet-slider h-1.5 w-full cursor-pointer appearance-none rounded-full bg-gray-700 accent-violet-500"
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

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
              className="violet-slider h-1.5 w-full cursor-pointer appearance-none rounded-full bg-gray-700 accent-violet-500"
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
              className="violet-slider h-1.5 w-full cursor-pointer appearance-none rounded-full bg-gray-700 accent-violet-500"
            />
          </div>
        </>
      )}

      {mode === "jukebox" && (
        <div>
          <label className="mb-1.5 flex items-center justify-between text-sm text-gray-300">
            <span>Legacy max (oude Jukebox limiet)</span>
            <span className="font-semibold text-violet-400">{settings.jukebox_max_per_user}</span>
          </label>
          <input
            type="range"
            min={1}
            max={20}
            value={settings.jukebox_max_per_user}
            onChange={(e) => handleUpdate("jukebox_max_per_user", Number(e.target.value))}
            className="violet-slider h-1.5 w-full cursor-pointer appearance-none rounded-full bg-gray-700 accent-violet-500"
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
            className="violet-slider h-1.5 w-full cursor-pointer appearance-none rounded-full bg-gray-700 accent-violet-500"
          />
        </div>
      )}
    </div>
  );
}

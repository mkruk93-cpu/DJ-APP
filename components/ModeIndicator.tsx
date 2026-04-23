"use client";

import { useEffect, useRef, useState } from "react";
import { useRadioStore } from "@/lib/radioStore";
import { MODE_LABELS } from "@/lib/types";

const MODE_COLORS: Record<string, string> = {
  dj: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  radio: "bg-violet-500/20 text-violet-400 border-violet-500/30",
  democracy: "bg-green-500/20 text-green-400 border-green-500/30",
  jukebox: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  party: "bg-pink-500/20 text-pink-400 border-pink-500/30",
  solo: "bg-amber-500/20 text-amber-300 border-amber-500/30",
};

const MODE_DESCRIPTIONS: Record<string, { badge: string; lines: string[] }> = {
  dj: {
    badge: "DJ",
    lines: [
      "De DJ heeft volledige controle",
      "Alleen de admin kan nummers toevoegen en skippen",
    ],
  },
  radio: {
    badge: "FM",
    lines: [
      "Automatische playlist",
      "De admin beheert de wachtrij",
    ],
  },
  democracy: {
    badge: "DM",
    lines: [
      "Iedereen kan nummers toevoegen",
      "Stemmen bepaalt welk nummer geskipt wordt",
    ],
  },
  jukebox: {
    badge: "JB",
    lines: [
      "Iedereen kan nummers toevoegen",
      "Alleen de admin kan skippen",
    ],
  },
  party: {
    badge: "PT",
    lines: [
      "Iedereen mag nummers toevoegen",
      "Iedereen mag skippen",
    ],
  },
  solo: {
    badge: "SO",
    lines: [
      "De ingeplande solist mag nummers toevoegen",
      "Alleen de solist en admin zien het soundboard en aanvragen",
    ],
  },
};

export default function ModeIndicator() {
  const mode = useRadioStore((s) => s.mode);
  const connected = useRadioStore((s) => s.connected);
  const activeSoloNickname = useRadioStore((s) => s.activeSoloNickname);
  const [open, setOpen] = useState(false);
  const [positionAbove, setPositionAbove] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const checkPosition = () => {
      if (!buttonRef.current) return;
      const buttonRect = buttonRef.current.getBoundingClientRect();
      setPositionAbove(buttonRect.bottom > window.innerHeight / 2);
    };
    checkPosition();
    window.addEventListener("resize", checkPosition);
    return () => window.removeEventListener("resize", checkPosition);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  if (!connected) {
    return (
      <div className="inline-flex items-center gap-1 rounded-full border border-gray-600/50 bg-gray-500/10 px-2.5 py-1 text-xs font-semibold text-gray-500">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-gray-500" />
        Verbinden...
      </div>
    );
  }

  const color = MODE_COLORS[mode] ?? MODE_COLORS.radio;
  const baseLabel = MODE_LABELS[mode] ?? mode;
  const label = mode === "solo" && activeSoloNickname ? `Solo · ${activeSoloNickname}` : baseLabel;
  const info = MODE_DESCRIPTIONS[mode];

  return (
    <div ref={popoverRef} className="relative">
      <button
        ref={buttonRef}
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-semibold transition hover:brightness-125 sm:px-2.5 sm:text-xs ${color}`}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-current" />
        <span>{label}</span>
      </button>

      {open && info && (
        <div
          className={`absolute z-50 w-64 max-w-[calc(100vw-2rem)] rounded-xl border border-gray-700 bg-gray-900 p-4 shadow-2xl shadow-black/50 ${
            positionAbove ? "bottom-full left-0 mb-2" : "top-full left-0 mt-2"
          }`}
        >
          <div className="mb-2 flex items-center gap-2">
            <span className="rounded-full border border-current/20 px-2 py-1 text-xs font-bold text-white">{info.badge}</span>
            <span className={`text-sm font-bold ${color.split(" ")[1]}`}>{baseLabel}</span>
          </div>
          {mode === "solo" && activeSoloNickname && (
            <p className="mb-2 text-xs text-amber-200">Actieve solist: {activeSoloNickname}</p>
          )}
          <ul className="space-y-1.5">
            {info.lines.map((line, i) => (
              <li key={i} className="flex items-start gap-2 text-xs text-gray-300">
                <span className="mt-0.5 h-1 w-1 shrink-0 rounded-full bg-gray-500" />
                {line}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

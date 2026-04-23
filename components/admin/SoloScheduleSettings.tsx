"use client";

import { useEffect, useMemo, useState } from "react";
import { updateSetting as apiUpdateSetting } from "@/lib/radioApi";
import { useRadioStore } from "@/lib/radioStore";
import type { SoloScheduleSlot } from "@/lib/types";

function toIso(value: string): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function formatSlot(slot: SoloScheduleSlot): string {
  const start = new Date(slot.startTime);
  const end = new Date(slot.endTime);
  return `${start.toLocaleDateString("nl-NL", { weekday: "long", day: "2-digit", month: "long" })} ${start.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" })} - ${end.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" })}`;
}

export default function SoloScheduleSettings() {
  const slotDurationMinutes = useRadioStore((s) => s.soloSlotDurationMinutes);
  const openSlots = useRadioStore((s) => s.soloOpenSlots);
  const bookings = useRadioStore((s) => s.soloBookings);
  const [duration, setDuration] = useState(slotDurationMinutes);
  const [newStart, setNewStart] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDuration(slotDurationMinutes);
  }, [slotDurationMinutes]);

  const bookingByKey = useMemo(
    () => new Map(bookings.map((booking) => [`${booking.startTime}_${booking.endTime}`, booking.nickname])),
    [bookings],
  );

  async function saveDuration(next: number) {
    const normalized = Math.max(15, Math.min(360, Math.round(next || 60)));
    setDuration(normalized);
    useRadioStore.getState().setSoloSchedule({
      slotDurationMinutes: normalized,
      openSlots,
      bookings,
      activeNickname: useRadioStore.getState().activeSoloNickname,
      activeSlot: useRadioStore.getState().activeSoloSlot,
    });
    await apiUpdateSetting("solo_slot_duration_minutes", normalized);
  }

  async function saveSlots(nextSlots: SoloScheduleSlot[]) {
    useRadioStore.getState().setSoloSchedule({
      slotDurationMinutes: duration,
      openSlots: nextSlots,
      bookings,
      activeNickname: useRadioStore.getState().activeSoloNickname,
      activeSlot: useRadioStore.getState().activeSoloSlot,
    });
    await apiUpdateSetting("solo_open_slots", nextSlots);
  }

  async function addSlot() {
    const startTime = toIso(newStart);
    if (!startTime) return;
    const endTime = new Date(new Date(startTime).getTime() + duration * 60_000).toISOString();
    const nextSlots = [...openSlots, { id: `${startTime}_${endTime}`, startTime, endTime }]
      .sort((left, right) => new Date(left.startTime).getTime() - new Date(right.startTime).getTime());
    setSaving(true);
    try {
      await saveSlots(nextSlots);
      setNewStart("");
    } finally {
      setSaving(false);
    }
  }

  async function removeSlot(slot: SoloScheduleSlot) {
    setSaving(true);
    try {
      await saveSlots(openSlots.filter((entry) => entry.id !== slot.id));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4 rounded-xl border border-gray-800 bg-gray-900 p-4">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500">Solo planning</h3>
        <p className="mt-1 text-xs text-gray-400">
          Bepaal welke solo-slots openstaan. De gebruiker met het actieve slot krijgt in `Solo` de add-to-queue rechten en het soundboard.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-[180px_minmax(0,1fr)_auto]">
        <label className="space-y-1">
          <span className="text-xs text-gray-300">Standaard duur (minuten)</span>
          <input
            type="number"
            min={15}
            max={360}
            value={duration}
            onChange={(e) => setDuration(Number(e.target.value))}
            onBlur={() => { void saveDuration(duration); }}
            className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-white outline-none transition focus:border-violet-500"
          />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-gray-300">Nieuw open slot</span>
          <input
            type="datetime-local"
            value={newStart}
            onChange={(e) => setNewStart(e.target.value)}
            className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-white outline-none transition focus:border-violet-500"
          />
        </label>
        <button
          type="button"
          disabled={saving || !newStart}
          onClick={() => { void addSlot(); }}
          className="self-end rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Slot toevoegen
        </button>
      </div>

      <div className="space-y-2">
        {openSlots.length === 0 && (
          <p className="rounded-lg border border-dashed border-gray-700 px-3 py-3 text-sm text-gray-400">
            Er staan nog geen open solo-slots klaar.
          </p>
        )}
        {openSlots.map((slot) => {
          const bookedBy = bookingByKey.get(`${slot.startTime}_${slot.endTime}`) ?? null;
          return (
            <div key={slot.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-800 bg-gray-950/70 px-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-white">{formatSlot(slot)}</p>
                <p className="text-xs text-gray-400">
                  {bookedBy ? `Geclaimd door ${bookedBy}` : "Nog vrij om te claimen"}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className={`rounded-full px-2 py-1 text-[11px] font-semibold ${
                  bookedBy ? "bg-amber-500/15 text-amber-300" : "bg-emerald-500/15 text-emerald-300"
                }`}>
                  {bookedBy ? "Bezet" : "Open"}
                </span>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => { void removeSlot(slot); }}
                  className="rounded-lg border border-red-500/30 px-3 py-1.5 text-xs font-semibold text-red-300 transition hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Verwijderen
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {openSlots.length > 0 && (
        <div className="rounded-lg border border-gray-800 bg-gray-950/60 px-3 py-3 text-xs text-gray-400">
          Tip: bestaande boekingen blijven in `dj_schedule` staan. Als je een open slot verwijdert, kan niemand dat slot opnieuw claimen.
        </div>
      )}
    </div>
  );
}

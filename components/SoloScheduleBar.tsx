"use client";

import { useEffect, useMemo, useState } from "react";
import type { SoloScheduleBooking, SoloScheduleSlot } from "@/lib/types";

interface SoloScheduleBarProps {
  slots: SoloScheduleSlot[];
  bookings: SoloScheduleBooking[];
  activeNickname: string | null;
  currentUsername: string | null;
  durationMinutes: number;
  isAdmin: boolean;
  onClaim: (slot: SoloScheduleSlot) => void;
  onSchedule: (slot: SoloScheduleSlot) => void;
  onUpdateOwnSlot: (bookingId: string, slot: SoloScheduleSlot) => void;
  onCancelOwnSlot: (bookingId: string) => void;
  canEndActiveSolo?: boolean;
  onEndActiveSolo?: () => void;
  endingActiveSolo?: boolean;
  expanded?: boolean;
  onClose?: () => void;
}

function formatSlotLabel(startTime: string, endTime: string): string {
  const start = new Date(startTime);
  const end = new Date(endTime);
  return `${start.toLocaleDateString("nl-NL", { weekday: "short", day: "2-digit", month: "2-digit" })} ${start.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" })}-${end.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" })}`;
}

export default function SoloScheduleBar({
  slots,
  bookings,
  activeNickname,
  currentUsername,
  durationMinutes,
  isAdmin,
  onClaim,
  onSchedule,
  onUpdateOwnSlot,
  onCancelOwnSlot,
  canEndActiveSolo = false,
  onEndActiveSolo,
  endingActiveSolo = false,
  expanded = false,
  onClose,
}: SoloScheduleBarProps) {
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [newStart, setNewStart] = useState("");
  const [customDuration, setCustomDuration] = useState(durationMinutes);
  const [scheduling, setScheduling] = useState(false);
  const [editingBookingId, setEditingBookingId] = useState<string | null>(null);
  const [busyBookingId, setBusyBookingId] = useState<string | null>(null);
  const normalizedCurrentUsername = (currentUsername ?? "").trim().toLowerCase();

  useEffect(() => {
    setCustomDuration(durationMinutes);
  }, [durationMinutes]);

  const slotItems = useMemo(() => {
    const bookingByKey = new Map(bookings.map((booking) => [`${booking.startTime}_${booking.endTime}`, booking]));
    const openSlotKeys = new Set(slots.map((slot) => `${slot.startTime}_${slot.endTime}`));
    const openSlotItems = slots
      .map((slot) => {
        const booking = bookingByKey.get(`${slot.startTime}_${slot.endTime}`) ?? null;
        const startMs = new Date(slot.startTime).getTime();
        const endMs = new Date(slot.endTime).getTime();
        const now = Date.now();
        const isPast = endMs <= now;
        const isActive = startMs <= now && endMs > now;
        const isMine = !!booking && booking.nickname.trim().toLowerCase() === normalizedCurrentUsername;
        return { slot, booking, isPast, isActive, isMine };
      })
      .filter((item) => !item.isPast || item.isActive);
    const customBookingItems = bookings
      .filter((booking) => !openSlotKeys.has(`${booking.startTime}_${booking.endTime}`))
      .map((booking) => {
        const startMs = new Date(booking.startTime).getTime();
        const endMs = new Date(booking.endTime).getTime();
        const now = Date.now();
        const isPast = endMs <= now;
        const isActive = startMs <= now && endMs > now;
        const isMine = booking.nickname.trim().toLowerCase() === normalizedCurrentUsername;
        return {
          slot: { id: booking.id, startTime: booking.startTime, endTime: booking.endTime },
          booking,
          isPast,
          isActive,
          isMine,
        };
      })
      .filter((item) => !item.isPast || item.isActive);

    return [...openSlotItems, ...customBookingItems]
      .sort((left, right) => new Date(left.slot.startTime).getTime() - new Date(right.slot.startTime).getTime())
      .slice(0, 8);
  }, [bookings, normalizedCurrentUsername, slots]);

  function handleSchedule() {
    const parsed = new Date(newStart);
    if (!newStart || Number.isNaN(parsed.getTime())) return;
    const normalizedDuration = Math.max(15, Math.min(60, Math.round(customDuration || durationMinutes || 60)));
    const startTime = parsed.toISOString();
    const endTime = new Date(parsed.getTime() + normalizedDuration * 60_000).toISOString();
    setScheduling(true);
    if (editingBookingId) {
      onUpdateOwnSlot(editingBookingId, { id: `${startTime}_${endTime}`, startTime, endTime });
    } else {
      onSchedule({ id: `${startTime}_${endTime}`, startTime, endTime });
    }
    window.setTimeout(() => setScheduling(false), 1200);
    setEditingBookingId(null);
    setNewStart("");
  }

  if (!expanded) return null;

  return (
    <div className="pointer-events-auto rounded-xl border border-amber-500/20 bg-gray-950/95 px-2 py-2 shadow-2xl shadow-black/45 backdrop-blur sm:px-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-amber-300">Solo inschrijven</p>
        <p className="text-xs text-gray-300">
          Plan zelf je solo in. Je kiest zelf een starttijd en een duur van 15 tot 60 minuten.
        </p>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-600/60 bg-gray-900/70 px-3 py-1 text-xs font-semibold text-gray-200 transition hover:border-gray-500 hover:bg-gray-800"
          >
            Sluiten
          </button>
        )}
        {activeNickname && (
          <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[11px] font-medium text-amber-200">
            Nu live: {activeNickname}
          </span>
        )}
        {canEndActiveSolo && onEndActiveSolo && (
          <button
            type="button"
            onClick={onEndActiveSolo}
            disabled={endingActiveSolo}
            className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-1 text-xs font-semibold text-red-200 transition hover:border-red-400/70 hover:bg-red-500/15 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {endingActiveSolo ? "Solo stoppen..." : "Solo afbreken"}
          </button>
        )}
      </div>
      <div className="mb-3 grid gap-2 rounded-xl border border-amber-500/15 bg-gray-950/45 p-3 sm:grid-cols-[minmax(0,1fr)_120px_auto]">
        <label className="space-y-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-amber-200/80">Starttijd</span>
          <input
            type="datetime-local"
            value={newStart}
            onChange={(event) => setNewStart(event.target.value)}
            className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-white outline-none transition focus:border-amber-400"
          />
        </label>
        <label className="space-y-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-amber-200/80">Minuten</span>
          <input
            type="number"
            min={15}
            max={60}
            step={15}
            value={customDuration}
            onChange={(event) => setCustomDuration(Number(event.target.value))}
            className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-white outline-none transition focus:border-amber-400"
          />
        </label>
        <button
          type="button"
          disabled={scheduling || !newStart}
          onClick={handleSchedule}
          className="self-end rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-gray-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {scheduling ? "Bezig..." : editingBookingId ? "Wijzig solo" : "Plan solo"}
        </button>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {slotItems.length === 0 && (
          <div className="min-w-[16rem] rounded-xl border border-dashed border-amber-500/30 bg-gray-900/55 px-4 py-3 text-sm text-gray-300">
            Er staan nog geen solo’s gepland. Kies hierboven je gewenste tijd om de eerste in te plannen.
          </div>
        )}
        {slotItems.map(({ slot, booking, isActive, isMine }) => {
          const disabled = !!booking || claimingId === slot.id;
          const canClaim = !disabled && !isAdmin;
          const isFutureOwnBooking = !!booking && isMine && new Date(slot.startTime).getTime() > Date.now();
          return (
            <div
              key={slot.id}
              className={`min-w-[13rem] rounded-xl border px-3 py-2 text-left transition ${
                isActive
                  ? "border-amber-400/60 bg-amber-400/15"
                  : booking
                    ? "border-gray-700 bg-gray-800/70"
                    : "border-amber-500/30 bg-gray-900/70 hover:border-amber-400/60 hover:bg-amber-400/10"
              }`}
            >
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-white">{formatSlotLabel(slot.startTime, slot.endTime)}</span>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                  isActive
                    ? "bg-amber-400/15 text-amber-200"
                    : booking
                      ? "bg-gray-700 text-gray-200"
                      : "bg-emerald-500/15 text-emerald-300"
                }`}>
                  {isActive ? "Live" : booking ? "Bezet" : "Open"}
                </span>
              </div>
              <p className="text-xs text-gray-300">
                {booking
                  ? (isMine ? "Jouw solo-slot" : `Geclaimd door ${booking.nickname}`)
                  : "Klik om dit solo-slot te claimen"}
              </p>
              {!booking && (
                <button
                  type="button"
                  disabled={!canClaim}
                  onClick={() => {
                    setClaimingId(slot.id);
                    onClaim(slot);
                    window.setTimeout(() => setClaimingId((current) => current === slot.id ? null : current), 1200);
                  }}
                  className={`mt-2 w-full rounded-lg border border-amber-500/40 px-3 py-2 text-xs font-semibold text-amber-200 transition hover:border-amber-400/70 hover:bg-amber-500/10 ${!canClaim ? "cursor-default opacity-60" : ""}`}
                >
                  Claim dit slot
                </button>
              )}
              {isFutureOwnBooking && booking && (
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    disabled={busyBookingId === booking.id}
                    onClick={() => {
                      const start = new Date(booking.startTime);
                      const local = new Date(start.getTime() - start.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
                      setEditingBookingId(booking.id);
                      setNewStart(local);
                      setCustomDuration(Math.max(15, Math.min(60, Math.round((new Date(booking.endTime).getTime() - new Date(booking.startTime).getTime()) / 60000))));
                    }}
                    className="flex-1 rounded-lg border border-blue-500/40 px-3 py-2 text-xs font-semibold text-blue-200 transition hover:bg-blue-500/10 disabled:opacity-60"
                  >
                    Wijzigen
                  </button>
                  <button
                    type="button"
                    disabled={busyBookingId === booking.id}
                    onClick={() => {
                      const confirmed = typeof window === "undefined" ? true : window.confirm("Weet je zeker dat je jouw geplande solo wilt annuleren?");
                      if (!confirmed) return;
                      setBusyBookingId(booking.id);
                      onCancelOwnSlot(booking.id);
                      window.setTimeout(() => setBusyBookingId((current) => current === booking.id ? null : current), 1200);
                    }}
                    className="flex-1 rounded-lg border border-red-500/40 px-3 py-2 text-xs font-semibold text-red-200 transition hover:bg-red-500/10 disabled:opacity-60"
                  >
                    Annuleren
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

"use client";

import { useState, useEffect, useCallback } from "react";
import { useRadioStore } from "@/lib/radioStore";
import { getSocket } from "@/lib/socket";

const DISMISSED_KEY = "push_notification_dismissed";

export default function PushNotification() {
  const pushMessage = useRadioStore((s) => s.pushMessage);
  const pushMessageExpiry = useRadioStore((s) => s.pushMessageExpiry);
  const setPushMessage = useRadioStore((s) => s.setPushMessage);
  const setPushMessageExpiry = useRadioStore((s) => s.setPushMessageExpiry);
  const [visible, setVisible] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const handleDismiss = useCallback(() => {
    setDismissed(true);
    setVisible(false);
    if (typeof window !== "undefined") {
      sessionStorage.setItem(DISMISSED_KEY, pushMessage || "");
    }
  }, [pushMessage]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const savedDismissed = sessionStorage.getItem(DISMISSED_KEY);
    if (pushMessage && savedDismissed !== pushMessage) {
      setDismissed(false);
      setVisible(true);
    } else if (!pushMessage) {
      setDismissed(false);
      setVisible(false);
      sessionStorage.removeItem(DISMISSED_KEY);
    }
  }, [pushMessage]);

  useEffect(() => {
    if (pushMessageExpiry > 0 && Date.now() > pushMessageExpiry) {
      setPushMessage(null);
      setPushMessageExpiry(0);
      setVisible(false);
    }
  }, [pushMessageExpiry, setPushMessage, setPushMessageExpiry]);

  useEffect(() => {
    const socket = getSocket();
    function onPushMessage(data: { message: string | null; expiry: number }) {
      setPushMessage(data.message);
      setPushMessageExpiry(data.expiry);
      if (!data.message) {
        setDismissed(false);
        setVisible(false);
      }
    }
    socket.on("push:message", onPushMessage);
    return () => {
      socket.off("push:message", onPushMessage);
    };
  }, [setPushMessage, setPushMessageExpiry]);

  if (!visible || dismissed || !pushMessage) return null;

  return (
    <div className="fixed inset-x-4 bottom-20 z-[100] mx-auto max-w-lg animate-in fade-in slide-in-from-bottom-4 duration-300 sm:bottom-24">
      <div className="relative overflow-hidden rounded-2xl border border-amber-500/30 bg-gradient-to-r from-amber-950/95 via-orange-950/95 to-amber-950/95 p-4 shadow-2xl shadow-black/60 backdrop-blur-sm">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-amber-500/10 via-transparent to-transparent" />
        <div className="absolute -left-8 -top-8 h-24 w-24 rounded-full bg-amber-500/20 blur-2xl" />
        <div className="absolute -right-8 -bottom-8 h-24 w-24 rounded-full bg-orange-500/20 blur-2xl" />
        
        <div className="relative flex items-start gap-3">
          <div className="shrink-0 rounded-full bg-amber-500/20 p-2">
            <svg className="h-5 w-5 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
            </svg>
          </div>
          
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-amber-100">
              Bericht van KrukkeX
            </p>
            <p className="mt-1 text-sm text-amber-200/90 leading-relaxed">
              {pushMessage}
            </p>
          </div>
          
          <button
            onClick={handleDismiss}
            className="shrink-0 rounded-lg bg-amber-500/20 p-1.5 text-amber-400 transition hover:bg-amber-500/30 hover:text-amber-300"
            aria-label="Bericht sluiten"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

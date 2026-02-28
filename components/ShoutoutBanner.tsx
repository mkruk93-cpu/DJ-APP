"use client";

import { useEffect, useState } from "react";

type Shoutout = {
  id: string;
  nickname: string;
  message: string;
};

export default function ShoutoutBanner() {
  const [shoutout, setShoutout] = useState<Shoutout | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const res = await fetch("/api/shoutouts", { cache: "no-store" });
        const data = await res.json();
        if (!active) return;
        setShoutout(data?.shoutout ?? null);
      } catch {
        if (!active) return;
        setShoutout(null);
      }
    };
    void load();
    const t = window.setInterval(() => void load(), 2500);
    return () => {
      active = false;
      window.clearInterval(t);
    };
  }, []);

  if (!shoutout) return null;

  return (
    <div className="mb-3 rounded-xl border border-amber-400/40 bg-amber-500/10 px-4 py-2 text-sm text-amber-100 shadow-[0_0_24px_rgba(251,191,36,0.2)]">
      <span className="mr-2 font-semibold">Shoutout:</span>
      <span className="font-medium">{shoutout.nickname}</span>
      <span className="mx-2 text-amber-200/70">-</span>
      <span>{shoutout.message}</span>
    </div>
  );
}

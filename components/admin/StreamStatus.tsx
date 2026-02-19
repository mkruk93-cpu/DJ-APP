"use client";

import { useRadioStore } from "@/lib/radioStore";
import { useEffect, useState } from "react";

export default function StreamStatus() {
  const connected = useRadioStore((s) => s.connected);
  const streamOnline = useRadioStore((s) => s.streamOnline);
  const [icecastOk, setIcecastOk] = useState<boolean | null>(null);
  const [uptime, setUptime] = useState<number | null>(null);

  useEffect(() => {
    async function checkHealth() {
      const serverUrl = process.env.NEXT_PUBLIC_CONTROL_SERVER_URL ?? "http://localhost:3001";
      try {
        const res = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(5000) });
        if (res.ok) {
          const data = await res.json();
          setUptime(data.uptime ?? null);
          setIcecastOk(true);
        } else {
          setIcecastOk(false);
        }
      } catch {
        setIcecastOk(false);
        setUptime(null);
      }
    }

    checkHealth();
    const interval = setInterval(checkHealth, 15_000);
    return () => clearInterval(interval);
  }, []);

  function formatUptime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0) return `${h}u ${m}m`;
    return `${m}m`;
  }

  const indicators = [
    { label: "Control server", ok: connected },
    { label: "Stream actief", ok: streamOnline },
    { label: "Icecast bereikbaar", ok: icecastOk },
  ];

  return (
    <div className="space-y-3 rounded-xl border border-gray-800 bg-gray-900 p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500">
        Stream status
      </h3>

      <div className="space-y-2">
        {indicators.map(({ label, ok }) => (
          <div key={label} className="flex items-center gap-2">
            <span
              className={`h-2 w-2 rounded-full ${
                ok === null ? "bg-gray-600" : ok ? "bg-green-500" : "bg-red-500"
              }`}
            />
            <span className={`text-sm ${ok ? "text-gray-300" : "text-gray-500"}`}>
              {label}
            </span>
          </div>
        ))}
      </div>

      {uptime !== null && (
        <p className="text-xs text-gray-500">
          Server uptime: {formatUptime(uptime)}
        </p>
      )}
    </div>
  );
}

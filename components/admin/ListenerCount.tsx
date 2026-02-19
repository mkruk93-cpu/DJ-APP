"use client";

import { useRadioStore } from "@/lib/radioStore";

export default function ListenerCount() {
  const listenerCount = useRadioStore((s) => s.listenerCount);

  return (
    <div className="flex items-center gap-2 rounded-xl border border-gray-800 bg-gray-900 p-4">
      <span className="h-2.5 w-2.5 rounded-full bg-green-500" />
      <span className="text-sm text-gray-300">
        <span className="font-semibold text-white">{listenerCount}</span>
        {" "}luisteraar{listenerCount !== 1 ? "s" : ""} verbonden
      </span>
    </div>
  );
}

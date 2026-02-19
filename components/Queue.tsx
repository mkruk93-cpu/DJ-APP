"use client";

import { useRadioStore } from "@/lib/radioStore";

export default function Queue() {
  const queue = useRadioStore((s) => s.queue);

  return (
    <div className="flex h-full flex-col rounded-xl border border-gray-800 bg-gray-900 shadow-lg shadow-violet-500/5">
      <div className="border-b border-gray-800 px-3 py-2 sm:px-4 sm:py-3">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-violet-400 sm:text-sm">
            Wachtrij
          </h2>
          <span className="text-xs text-gray-500">
            {queue.length} {queue.length === 1 ? "nummer" : "nummers"}
          </span>
        </div>
      </div>

      <div className="chat-scroll min-h-0 flex-1 space-y-1 overflow-y-auto px-3 py-2 sm:px-4 sm:py-3">
        {queue.length === 0 && (
          <p className="py-8 text-center text-sm text-gray-500">
            Wachtrij is leeg
          </p>
        )}
        {queue.map((item, index) => (
          <div
            key={item.id}
            className="flex items-center gap-2.5 rounded-lg border border-gray-800 bg-gray-800/50 p-2 transition hover:border-gray-700 sm:gap-3 sm:p-2.5"
          >
            <span className="w-5 shrink-0 text-center text-xs font-medium text-gray-500">
              {index + 1}
            </span>

            {item.thumbnail && (
              <img
                src={item.thumbnail}
                alt=""
                className="h-10 w-14 shrink-0 rounded object-cover sm:h-11 sm:w-16"
              />
            )}

            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-white">
                {item.title ?? "Laden..."}
              </p>
              <p className="truncate text-xs text-gray-400">
                {item.added_by}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export type MenuAction = {
  key: string;
  label: string;
  onSelect: () => void | Promise<void>;
  tone?: "default" | "accent" | "success" | "warning" | "danger";
};

type ShareConfig = {
  loadUsers: () => Promise<string[]>;
  onSelectUser: (username: string) => void | Promise<void>;
};

interface PlaylistOptionsButtonProps {
  actions: MenuAction[];
  shareConfig?: ShareConfig;
  buttonLabel?: string;
}

function toneClasses(tone: MenuAction["tone"]): string {
  switch (tone) {
    case "accent":
      return "text-violet-200 hover:bg-violet-500/15";
    case "success":
      return "text-emerald-200 hover:bg-emerald-500/15";
    case "warning":
      return "text-amber-200 hover:bg-amber-500/15";
    case "danger":
      return "text-red-200 hover:bg-red-500/15";
    default:
      return "text-gray-200 hover:bg-gray-800";
  }
}

export default function PlaylistOptionsButton({
  actions,
  shareConfig,
  buttonLabel = "⋯",
}: PlaylistOptionsButtonProps) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"menu" | "share">("menu");
  const [users, setUsers] = useState<string[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [filter, setFilter] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node;
      if (rootRef.current && !rootRef.current.contains(target)) {
        setOpen(false);
        setMode("menu");
        setFilter("");
      }
    }
    if (!open) return;
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  const filteredUsers = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return users;
    return users.filter((user) => user.toLowerCase().includes(needle));
  }, [filter, users]);

  async function openSharePicker() {
    if (!shareConfig) return;
    setMode("share");
    if (users.length > 0) return;
    setLoadingUsers(true);
    try {
      const nextUsers = await shareConfig.loadUsers();
      setUsers(nextUsers);
    } finally {
      setLoadingUsers(false);
    }
  }

  return (
    <div
      ref={rootRef}
      className="relative shrink-0"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={() => {
          setOpen((prev) => !prev);
          setMode("menu");
          setFilter("");
        }}
        className="flex h-6 w-6 flex-col items-center justify-center rounded text-[8px] leading-none text-gray-400 transition hover:text-white gap-0.5"
        title="Playlist opties"
        aria-label="Playlist opties"
      >
        <span className="h-0.5 w-0.5 rounded-full bg-current"></span>
        <span className="h-0.5 w-0.5 rounded-full bg-current"></span>
        <span className="h-0.5 w-0.5 rounded-full bg-current"></span>
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-56 overflow-hidden rounded-lg border border-gray-700 bg-gray-950 shadow-2xl">
          {mode === "menu" ? (
            <div className="py-1">
              {actions.map((action) => (
                <button
                  key={action.key}
                  type="button"
                  onClick={() => {
                    void action.onSelect();
                    setOpen(false);
                    setMode("menu");
                    setFilter("");
                  }}
                  className={`w-full px-3 py-2 text-left text-xs transition ${toneClasses(action.tone)}`}
                >
                  {action.label}
                </button>
              ))}
              {shareConfig && (
                <button
                  type="button"
                  onClick={() => { void openSharePicker(); }}
                  className="w-full px-3 py-2 text-left text-xs text-sky-200 transition hover:bg-sky-500/15"
                >
                  Deel met gebruiker
                </button>
              )}
            </div>
          ) : (
            <div className="p-2">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Deel playlist</span>
                <button
                  type="button"
                  onClick={() => {
                    setMode("menu");
                    setFilter("");
                  }}
                  className="text-[10px] text-gray-400 transition hover:text-white"
                >
                  Terug
                </button>
              </div>
              <input
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Zoek gebruiker..."
                className="mb-2 w-full rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-white outline-none focus:border-sky-500"
              />
              <div className="max-h-56 overflow-y-auto rounded border border-gray-800 bg-gray-900/70">
                {loadingUsers ? (
                  <p className="px-3 py-2 text-xs text-gray-400">Gebruikers laden...</p>
                ) : filteredUsers.length === 0 ? (
                  <p className="px-3 py-2 text-xs text-gray-500">Geen gebruikers gevonden</p>
                ) : (
                  filteredUsers.map((user) => (
                    <button
                      key={user}
                      type="button"
                      onClick={() => {
                        if (!shareConfig) return;
                        void shareConfig.onSelectUser(user);
                        setOpen(false);
                        setMode("menu");
                        setFilter("");
                      }}
                      className="w-full px-3 py-2 text-left text-xs text-gray-200 transition hover:bg-sky-500/15 hover:text-sky-100"
                    >
                      {user}
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

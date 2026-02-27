import type { OverlaySettings, PanelLayout } from "../types";

const SETTINGS_KEY = "dj_overlay_settings_v1";
const CHAT_LAYOUT_KEY = "dj_overlay_layout_chat_v1";
const REQUEST_LAYOUT_KEY = "dj_overlay_layout_requests_v1";

const DEFAULT_SETTINGS: OverlaySettings = {
  apiBaseUrl: "/",
  adminToken: "",
  supabaseUrl: "",
  supabaseAnonKey: "",
  showTopBar: true,
  lockLayout: false,
  clickThrough: false,
  showChat: true,
  showRequests: true,
};

const DEFAULT_CHAT_LAYOUT: PanelLayout = { x: 24, y: 24, width: 420, height: 420 };
const DEFAULT_REQUEST_LAYOUT: PanelLayout = { x: 480, y: 24, width: 460, height: 560 };

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function loadSettings(): OverlaySettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  const saved = parseJson<OverlaySettings>(localStorage.getItem(SETTINGS_KEY));
  return { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
}

export function saveSettings(next: OverlaySettings): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
}

export function loadChatLayout(): PanelLayout {
  if (typeof window === "undefined") return DEFAULT_CHAT_LAYOUT;
  const saved = parseJson<PanelLayout>(localStorage.getItem(CHAT_LAYOUT_KEY));
  return { ...DEFAULT_CHAT_LAYOUT, ...(saved ?? {}) };
}

export function loadRequestLayout(): PanelLayout {
  if (typeof window === "undefined") return DEFAULT_REQUEST_LAYOUT;
  const saved = parseJson<PanelLayout>(localStorage.getItem(REQUEST_LAYOUT_KEY));
  return { ...DEFAULT_REQUEST_LAYOUT, ...(saved ?? {}) };
}

export function saveChatLayout(next: PanelLayout): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(CHAT_LAYOUT_KEY, JSON.stringify(next));
}

export function saveRequestLayout(next: PanelLayout): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(REQUEST_LAYOUT_KEY, JSON.stringify(next));
}

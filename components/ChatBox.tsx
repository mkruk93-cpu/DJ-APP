"use client";

import { useEffect, useRef, useState, useCallback, useId } from "react";
import { getSupabase } from "@/lib/supabaseClient";
import { getRadioToken } from "@/lib/auth";
import EmojiPicker, { Theme, type EmojiClickData } from "emoji-picker-react";
import { NoAutofillInput } from "@/components/NoAutofillInput";

interface ChatMessage {
  id: string;
  nickname: string;
  content: string;
  created_at: string;
}

interface ChatBoxProps {
  username?: string;
  onNewMessage?: () => void;
  onUserClick?: (username: string) => void;
}

interface MediaSearchItem {
  id: string;
  title: string | null;
  previewUrl: string;
  mediaUrl: string;
}

const MAX_MESSAGES = 200;
const MAX_LENGTH = 300;
const COOLDOWN_MS = 2000;
const DUPLICATE_WINDOW_MS = 5000;
const DELETE_LONG_PRESS_MS = 550;
const STICKER_TOKEN_PREFIX = "[[sticker:";
const STICKER_TOKEN_SUFFIX = "]]";

type PickerTab = "emoji" | "sticker" | "gif";
type MediaType = "sticker" | "gif";

function decodeLegacyEntities(text: string): string {
  // Older chat rows were stored as HTML entities (e.g. &#39;). React already
  // escapes output safely, so decode these for correct visual rendering.
  return text
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function normalizeApostrophes(text: string): string {
  // Normalize common apostrophe/quote variants so every client sees plain ASCII apostrophes.
  return text
    .replace(/[’‘‚‛`´ʻʼʹ′＇]/g, "'")
    .replace(/[“”„‟]/g, '"');
}

function parseMediaToken(raw: string): { type: MediaType; url: string } | null {
  const match = raw.trim().match(/^\[\[media:(gif|sticker):(.+)\]\]$/i);
  if (!match) return null;
  const [, typeRaw, urlRaw] = match;
  const type = typeRaw.toLowerCase() === "sticker" ? "sticker" : "gif";
  const url = urlRaw.trim();
  if (!/^https?:\/\//i.test(url)) return null;
  return { type, url };
}

function timeStr(iso: string) {
  return new Date(iso).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" });
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

export default function ChatBox({ onNewMessage, username, onUserClick }: ChatBoxProps = {}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [cooldown, setCooldown] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerTab, setPickerTab] = useState<PickerTab>("emoji");
  const [mediaQuery, setMediaQuery] = useState("");
  const [mediaItems, setMediaItems] = useState<MediaSearchItem[]>([]);
  const [mediaNextPos, setMediaNextPos] = useState<string | null>(null);
  const [mediaLoading, setMediaLoading] = useState(false);
  const [mediaLoadingMore, setMediaLoadingMore] = useState(false);
  const [mediaError, setMediaError] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [deletingMessageId, setDeletingMessageId] = useState<string | null>(null);
  const [deleteMenuMessageId, setDeleteMenuMessageId] = useState<string | null>(null);
  const [adminToken, setAdminToken] = useState<string>("");
  const [userColors, setUserColors] = useState<Record<string, string>>({});
  const lastMsgRef = useRef<{ text: string; time: number }>({ text: "", time: 0 });
  const messagesRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const mediaAbortRef = useRef<AbortController | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const channelId = useId();
  const nickname = username || (typeof window !== "undefined" ? localStorage.getItem("nickname") ?? "Gast" : "Gast");
  const activeMediaType: MediaType | null = pickerTab === "gif" || pickerTab === "sticker" ? pickerTab : null;
  const isAdmin = !!adminToken;

  // Fetch user colors when messages change
  useEffect(() => {
    const uniqueNicknames = [...new Set(messages.map(m => m.nickname))];
    if (uniqueNicknames.length === 0) return;
    
    fetch(`/api/profile/colors?usernames=${encodeURIComponent(uniqueNicknames.join(","))}`)
      .then(res => res.json())
      .then(data => {
        if (data.colors) {
          setUserColors(data.colors);
        }
      })
      .catch(() => {});
  }, [messages]);

  const scrollToBottom = useCallback((smooth = false) => {
    const host = messagesRef.current;
    if (!host) return;
    host.scrollTo({ top: host.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  function parseSticker(raw: string): string | null {
    const trimmed = raw.trim();
    if (!trimmed.startsWith(STICKER_TOKEN_PREFIX) || !trimmed.endsWith(STICKER_TOKEN_SUFFIX)) {
      return null;
    }
    return trimmed.slice(STICKER_TOKEN_PREFIX.length, -STICKER_TOKEN_SUFFIX.length).trim() || null;
  }

  function renderContent(raw: string) {
    const media = parseMediaToken(raw);
    if (media) {
      return (
        <img
          src={media.url}
          alt={media.type === "gif" ? "GIF" : "Sticker"}
          loading="lazy"
          className="mt-1 max-h-28 w-auto max-w-[10rem] rounded-xl object-contain shadow-md shadow-black/30 sm:max-h-40 sm:max-w-[14rem]"
        />
      );
    }
    const stickerUrl = parseSticker(raw);
    if (stickerUrl) {
      return (
        <img
          src={stickerUrl}
          alt="Sticker"
          className="mt-1 h-14 w-14 rounded-xl object-cover shadow-md shadow-black/30 sm:h-20 sm:w-20"
        />
      );
    }
    return <span>{normalizeApostrophes(decodeLegacyEntities(raw))}</span>;
  }

  const fetchMedia = useCallback(async (
    type: MediaType,
    query: string,
    options?: { append?: boolean; pos?: string | null },
  ) => {
    const append = !!options?.append;
    const pos = options?.pos ?? null;
    if (!append) {
      setMediaLoading(true);
      setMediaError("");
      setMediaNextPos(null);
    } else {
      if (!pos) return;
      setMediaLoadingMore(true);
      setMediaError("");
    }

    mediaAbortRef.current?.abort();
    const controller = new AbortController();
    mediaAbortRef.current = controller;

    const params = new URLSearchParams({
      type,
      q: query.trim(),
      limit: "24",
    });
    if (append && pos) params.set("pos", pos);

    try {
      const res = await fetch(`/api/chat-media/search?${params.toString()}`, {
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
      });
      const payload = (await res.json().catch(() => ({}))) as {
        items?: MediaSearchItem[];
        nextPos?: string | null;
        error?: string;
      };
      if (!res.ok) {
        setMediaError(payload.error ?? "Media laden mislukt");
        return;
      }

      const items = Array.isArray(payload.items) ? payload.items : [];
      setMediaItems((prev) => {
        if (!append) return items;
        const merged = [...prev, ...items];
        return Array.from(new Map(merged.map((item) => [item.id, item])).values());
      });
      setMediaNextPos(payload.nextPos ?? null);
    } catch (err) {
      if (controller.signal.aborted) return;
      const msg = err instanceof Error ? err.message : "Media laden mislukt";
      setMediaError(msg);
    } finally {
      if (!append) setMediaLoading(false);
      else setMediaLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    const sb = getSupabase();

    sb.from("chat_messages")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(10)
      .then(({ data }) => {
        if (data) setMessages(data.reverse());
      });

    const channel = sb
      .channel(`chat-${channelId}`)
      .on<ChatMessage>(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "chat_messages" },
        (payload) => {
          setMessages((prev) => {
            const next = [...prev, payload.new];
            return next.length > MAX_MESSAGES ? next.slice(-MAX_MESSAGES) : next;
          });
          onNewMessage?.();
        }
      )
      .on<{ old: { id: string } }>(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "chat_messages" },
        (payload) => {
          const removedId = (payload as { old?: { id?: string } }).old?.id;
          if (!removedId) return;
          setMessages((prev) => prev.filter((m) => m.id !== removedId));
        },
      )
      .subscribe();

    return () => {
      sb.removeChannel(channel);
    };
  }, []);

  useEffect(() => {
    return () => mediaAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    setAdminToken(getRadioToken() ?? "");
  }, []);

  useEffect(() => {
    // Always show latest message on load and follow new messages.
    scrollToBottom(messages.length > 1);
  }, [messages, scrollToBottom]);

  useEffect(() => {
    const host = messagesRef.current;
    if (!host) return;
    const observer = new MutationObserver(() => {
      scrollToBottom(false);
    });
    observer.observe(host, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [scrollToBottom]);

  useEffect(() => {
    function handleOutsideClick(e: MouseEvent) {
      if (!pickerOpen) return;
      const target = e.target as Node;
      const clickedInForm = formRef.current?.contains(target);
      const clickedInPicker = pickerRef.current?.contains(target);
      
      if (!clickedInForm && !clickedInPicker) {
        setPickerOpen(false);
      }
    }
    document.addEventListener("click", handleOutsideClick);
    return () => document.removeEventListener("click", handleOutsideClick);
  }, [pickerOpen]);

  const sendMessage = useCallback(async (content?: string) => {
    const normalizedInput = normalizeApostrophes(content ?? input);
    const text = normalizedInput.trim();
    if (!text || text.length > MAX_LENGTH || cooldown) return;

    const now = Date.now();
    if (text === lastMsgRef.current.text && now - lastMsgRef.current.time < DUPLICATE_WINDOW_MS) return;

    setCooldown(true);
    setTimeout(() => setCooldown(false), COOLDOWN_MS);
    lastMsgRef.current = { text, time: now };

    if (!content) setInput("");
    await getSupabase().from("chat_messages").insert({ nickname, content: text });
  }, [input, cooldown, nickname]);

  function addEmoji(emojiData: EmojiClickData) {
    setInput((prev) => `${prev}${emojiData.emoji}`);
  }

  function sendMedia(type: MediaType, url: string) {
    const payload = `[[media:${type}:${url}]]`;
    void sendMessage(payload);
    setPickerOpen(false);
  }

  function clearLongPressTimer() {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }

  function startLongPress(messageId: string, canDelete: boolean) {
    clearLongPressTimer();
    if (!canDelete) return;
    longPressTimerRef.current = window.setTimeout(() => {
      setDeleteMenuMessageId(messageId);
    }, DELETE_LONG_PRESS_MS);
  }

  function cancelLongPress() {
    clearLongPressTimer();
  }

  function canDeleteMessage(message: ChatMessage): boolean {
    return isAdmin || normalizeName(message.nickname) === normalizeName(nickname);
  }

  async function deleteMessage(messageId: string) {
    if (!messageId || deletingMessageId) return;
    setDeleteError("");
    setDeletingMessageId(messageId);
    try {
      const token = getRadioToken() ?? "";
      const res = await fetch(`/api/chat-messages/${messageId}`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "x-admin-token": token } : {}),
        },
        body: JSON.stringify({ nickname, token: token || undefined }),
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setDeleteError(payload.error ?? "Bericht verwijderen mislukt");
        return;
      }
      setDeleteMenuMessageId(null);
      setMessages((prev) => prev.filter((m) => m.id !== messageId));
    } catch {
      setDeleteError("Bericht verwijderen mislukt");
    } finally {
      setDeletingMessageId(null);
    }
  }

  useEffect(() => {
    if (!pickerOpen || !activeMediaType) return;
    const timer = window.setTimeout(() => {
      void fetchMedia(activeMediaType, mediaQuery, { append: false });
    }, 280);
    return () => window.clearTimeout(timer);
  }, [pickerOpen, activeMediaType, mediaQuery, fetchMedia]);

  useEffect(() => {
    return () => {
      clearLongPressTimer();
    };
  }, []);

  function switchTab(tab: PickerTab) {
    setPickerTab(tab);
    setMediaError("");
    if (tab === "emoji") return;
    // Don't clear search query when switching between sticker/gif tabs
    if (mediaQuery.trim() && (tab === "sticker" || tab === "gif")) {
      // Keep existing search and just fetch new media type
      setMediaItems([]);
      setMediaNextPos(null);
    } else {
      setMediaQuery("");
      setMediaItems([]);
      setMediaNextPos(null);
    }
  }

  return (
    <div className="flex h-full w-full min-w-0 flex-1 flex-col rounded-xl border border-gray-800 bg-gray-900 shadow-lg shadow-violet-500/5">
      <div className="border-b border-gray-800 px-3 py-2 sm:px-4 sm:py-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-violet-400 sm:text-sm">Chat</h2>
      </div>

      <div
        ref={messagesRef}
        onClick={() => setDeleteMenuMessageId(null)}
        className="chat-scroll min-h-0 flex-1 space-y-0.5 overflow-y-auto px-3 py-2 sm:space-y-1 sm:px-4 sm:py-3"
      >
        {messages.map((m) => (
          <div
            key={m.id}
            className="group text-sm leading-relaxed"
            onPointerDown={() => startLongPress(m.id, canDeleteMessage(m))}
            onPointerUp={cancelLongPress}
            onPointerLeave={cancelLongPress}
            onPointerCancel={cancelLongPress}
            onPointerMove={cancelLongPress}
            onContextMenu={(e) => {
              if (!canDeleteMessage(m)) return;
              e.preventDefault();
              setDeleteMenuMessageId(m.id);
            }}
          >
            <div className="flex items-start gap-1.5">
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  onClick={() => onUserClick?.(m.nickname)}
                  className="font-semibold hover:underline"
                  style={{ color: userColors[m.nickname.toLowerCase()] || "#a78bfa" }}
                >
                  {m.nickname}
                </button>
                <span className="mx-1 text-gray-600 sm:mx-1.5">{timeStr(m.created_at)}</span>
                <span className="text-gray-300">{renderContent(m.content)}</span>
              </div>
            </div>
            {deleteMenuMessageId === m.id && canDeleteMessage(m) && (
              <div
                className="mt-1.5 flex gap-2"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  onClick={() => { void deleteMessage(m.id); }}
                  disabled={deletingMessageId === m.id}
                  className="rounded border border-red-500/60 bg-red-500/10 px-2 py-0.5 text-[11px] font-semibold text-red-300 transition hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {deletingMessageId === m.id ? "Verwijderen..." : "Verwijderen"}
                </button>
                <button
                  type="button"
                  onClick={() => setDeleteMenuMessageId(null)}
                  className="rounded border border-gray-700 bg-gray-800 px-2 py-0.5 text-[11px] text-gray-300 transition hover:bg-gray-700"
                >
                  Annuleren
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
      {deleteError && (
        <p className="border-t border-red-900/50 px-3 py-1.5 text-[11px] text-red-300 sm:px-4">
          {deleteError}
        </p>
      )}

      <form
        ref={formRef}
        onSubmit={(e) => { e.preventDefault(); sendMessage(); }}
        className="relative flex shrink-0 gap-2 border-t border-gray-800 px-3 py-2 sm:px-4 sm:py-3"
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setPickerOpen((prev) => !prev);
            setPickerTab("emoji");
          }}
          className="shrink-0 rounded-lg border border-gray-700 bg-gray-800 px-2.5 py-2 text-sm text-gray-200 transition hover:border-violet-500 hover:text-white"
          aria-label="Open emoji and sticker picker"
        >
          🙂
        </button>
        <NoAutofillInput
          type="search"
          id="chat-message-input"
          name={`chat-message-${Math.random().toString(36).substring(7)}`}
          autoComplete="off"
          spellCheck={false}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          maxLength={MAX_LENGTH}
          placeholder="Bericht..."
          className="min-w-0 flex-1 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 outline-none transition focus:border-violet-500"
        />
        <button
          type="submit"
          disabled={cooldown || !input.trim()}
          className="shrink-0 rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-violet-500 disabled:opacity-40"
        >
          Stuur
        </button>

      </form>

      {/* Emoji/Media Picker - Moved outside form for better positioning on mobile */}
      {pickerOpen && (
        <div 
          ref={pickerRef}
          className="fixed inset-x-2 bottom-20 z-[250] mx-auto w-auto max-w-[calc(100vw-1rem)] rounded-xl border border-gray-700 bg-gray-900 p-2 shadow-2xl shadow-black/40 sm:bottom-[calc(100%+8px)] sm:left-4 sm:inset-x-auto sm:mx-0 sm:w-80 sm:max-w-none"
        >
          <div className="mb-2 flex gap-1 rounded-lg bg-gray-800 p-1">
            {(['emoji', 'sticker', 'gif'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => switchTab(tab)}
                className={`flex-1 rounded-md px-2 py-1 text-xs font-semibold transition ${
                  pickerTab === tab ? "bg-violet-600 text-white" : "text-gray-300 hover:text-white"
                }`}
              >
                {tab === "emoji" ? "Emoji" : tab === "sticker" ? "Stickers" : "GIF"}
              </button>
            ))}
          </div>

          {pickerTab === "emoji" ? (
            <div className="overflow-hidden rounded-lg border border-gray-700">
              <EmojiPicker
                width="100%"
                height={360}
                lazyLoadEmojis
                searchDisabled={false}
                skinTonesDisabled
                autoFocusSearch={false}
                theme={Theme.DARK}
                previewConfig={{ showPreview: false }}
                searchPlaceHolder="Zoek emoji..."
                onEmojiClick={addEmoji}
              />
            </div>
          ) : (
            <div>
              <NoAutofillInput
                type="search"
                id="media-search-input"
                name={`media-search-${Math.random().toString(36).substring(7)}`}
                autoComplete="off"
                spellCheck={false}
                value={mediaQuery}
                onChange={(e) => setMediaQuery(e.target.value)}
                placeholder={pickerTab === "gif" ? "Zoek GIF's..." : "Zoek stickers..."}
                className="mb-2 w-full rounded-lg border border-gray-700 bg-gray-800 px-2.5 py-1.5 text-xs text-white placeholder-gray-500 outline-none transition focus:border-violet-500"
              />
              {mediaError && <p className="mb-2 text-[11px] text-red-300">{mediaError}</p>}
              <div className="chat-scroll grid min-h-64 max-h-64 grid-cols-3 gap-1.5 overflow-y-auto pr-1 sm:gap-2">
                {mediaLoading && mediaItems.length === 0 ? (
                  <p className="col-span-3 text-[11px] text-gray-400">Media laden...</p>
                ) : mediaItems.length === 0 ? (
                  <p className="col-span-3 text-[11px] text-gray-400">Geen resultaten gevonden.</p>
                ) : (
                  mediaItems.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => sendMedia(activeMediaType ?? "gif", item.mediaUrl)}
                      className="rounded-lg bg-gray-800 p-1.5 transition hover:bg-gray-700"
                      title={item.title ?? "Media"}
                    >
                      <img src={item.previewUrl} alt={item.title ?? "Media"} className="h-12 w-full rounded-md object-cover sm:h-14" loading="lazy" />
                    </button>
                  ))
                )}
                {mediaLoading && mediaItems.length > 0 && (
                  <div className="col-span-3 py-2 text-center">
                    <div className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-violet-500 border-t-transparent" />
                  </div>
                )}
              </div>
              {mediaNextPos && (
                <button
                  type="button"
                  onClick={() => {
                    if (!activeMediaType || mediaLoadingMore) return;
                    void fetchMedia(activeMediaType, mediaQuery, { append: true, pos: mediaNextPos });
                  }}
                  className="mt-2 w-full rounded-lg border border-gray-700 bg-gray-800/80 px-2 py-1.5 text-xs text-gray-200 transition hover:bg-gray-700 disabled:opacity-50"
                  disabled={mediaLoadingMore}
                >
                  {mediaLoadingMore ? "Laden..." : "Meer laden"}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

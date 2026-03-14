"use client";

import { useEffect, useRef, useState, useCallback, useId } from "react";
import { getSupabase } from "@/lib/supabaseClient";
import EmojiPicker, { Theme, type EmojiClickData } from "emoji-picker-react";

interface ChatMessage {
  id: string;
  nickname: string;
  content: string;
  created_at: string;
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

export default function ChatBox({ onNewMessage }: { onNewMessage?: () => void } = {}) {
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
  const lastMsgRef = useRef<{ text: string; time: number }>({ text: "", time: 0 });
  const bottomRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const mediaAbortRef = useRef<AbortController | null>(null);
  const channelId = useId();
  const nickname = typeof window !== "undefined" ? localStorage.getItem("nickname") ?? "anon" : "anon";
  const activeMediaType: MediaType | null = pickerTab === "gif" || pickerTab === "sticker" ? pickerTab : null;

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
          className="mt-1 max-h-44 w-auto max-w-[14rem] rounded-xl object-contain shadow-md shadow-black/30 sm:max-h-56 sm:max-w-[18rem]"
        />
      );
    }
    const stickerUrl = parseSticker(raw);
    if (stickerUrl) {
      return (
        <img
          src={stickerUrl}
          alt="Sticker"
          className="mt-1 h-20 w-20 rounded-xl object-cover shadow-md shadow-black/30 sm:h-24 sm:w-24"
        />
      );
    }
    return <span>{normalizeApostrophes(decodeLegacyEntities(raw))}</span>;
  }

  const fetchMedia = useCallback(async (type: MediaType, query: string, options?: { append?: boolean }) => {
    const append = !!options?.append;
    if (!append) {
      setMediaLoading(true);
      setMediaError("");
      setMediaNextPos(null);
    } else {
      if (!mediaNextPos) return;
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
    if (append && mediaNextPos) params.set("pos", mediaNextPos);

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
  }, [mediaNextPos]);

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
      .subscribe();

    return () => {
      sb.removeChannel(channel);
    };
  }, []);

  useEffect(() => {
    return () => mediaAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    function handleOutsideClick(e: MouseEvent) {
      if (!pickerOpen) return;
      if (formRef.current && !formRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    }
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
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

  useEffect(() => {
    if (!pickerOpen || !activeMediaType) return;
    const timer = window.setTimeout(() => {
      void fetchMedia(activeMediaType, mediaQuery, { append: false });
    }, 280);
    return () => window.clearTimeout(timer);
  }, [pickerOpen, activeMediaType, mediaQuery, fetchMedia]);

  function switchTab(tab: PickerTab) {
    setPickerTab(tab);
    setMediaError("");
    if (tab === "emoji") return;
    setMediaQuery("");
    setMediaItems([]);
    setMediaNextPos(null);
  }

  return (
    <div className="flex h-full flex-col rounded-xl border border-gray-800 bg-gray-900 shadow-lg shadow-violet-500/5">
      <div className="border-b border-gray-800 px-3 py-2 sm:px-4 sm:py-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-violet-400 sm:text-sm">Chat</h2>
      </div>

      <div className="chat-scroll min-h-0 flex-1 space-y-0.5 overflow-y-auto px-3 py-2 sm:space-y-1 sm:px-4 sm:py-3">
        {messages.map((m) => (
          <div key={m.id} className="text-sm leading-relaxed">
            <span className="font-semibold text-violet-400">{m.nickname}</span>
            <span className="mx-1 text-gray-600 sm:mx-1.5">{timeStr(m.created_at)}</span>
            <span className="text-gray-300">{renderContent(m.content)}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <form
        ref={formRef}
        onSubmit={(e) => { e.preventDefault(); sendMessage(); }}
        className="relative flex shrink-0 gap-2 border-t border-gray-800 px-3 py-2 sm:px-4 sm:py-3"
      >
        <button
          type="button"
          onClick={() => {
            setPickerOpen((prev) => !prev);
            setPickerTab("emoji");
          }}
          className="shrink-0 rounded-lg border border-gray-700 bg-gray-800 px-2.5 py-2 text-sm text-gray-200 transition hover:border-violet-500 hover:text-white"
          aria-label="Open emoji and sticker picker"
        >
          🙂
        </button>
        <input
          type="text"
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

        {pickerOpen && (
          <div className="absolute bottom-[calc(100%+8px)] left-3 z-20 w-72 rounded-xl border border-gray-700 bg-gray-900 p-2 shadow-2xl shadow-black/40 sm:left-4">
            <div className="mb-2 flex gap-1 rounded-lg bg-gray-800 p-1">
              <button
                type="button"
                onClick={() => switchTab("emoji")}
                className={`flex-1 rounded-md px-2 py-1 text-xs font-semibold transition ${
                  pickerTab === "emoji" ? "bg-violet-600 text-white" : "text-gray-300 hover:text-white"
                }`}
              >
                Emoji
              </button>
              <button
                type="button"
                onClick={() => switchTab("sticker")}
                className={`flex-1 rounded-md px-2 py-1 text-xs font-semibold transition ${
                  pickerTab === "sticker" ? "bg-violet-600 text-white" : "text-gray-300 hover:text-white"
                }`}
              >
                Stickers
              </button>
              <button
                type="button"
                onClick={() => switchTab("gif")}
                className={`flex-1 rounded-md px-2 py-1 text-xs font-semibold transition ${
                  pickerTab === "gif" ? "bg-violet-600 text-white" : "text-gray-300 hover:text-white"
                }`}
              >
                GIF
              </button>
            </div>

            {pickerTab === "emoji" ? (
              <div className="overflow-hidden rounded-lg border border-gray-700">
                <EmojiPicker
                  width="100%"
                  height={300}
                  lazyLoadEmojis
                  searchDisabled={false}
                  skinTonesDisabled
                  autoFocusSearch={false}
                  theme={Theme.DARK}
                  onEmojiClick={addEmoji}
                />
              </div>
            ) : (
              <div>
                <input
                  type="text"
                  value={mediaQuery}
                  onChange={(e) => setMediaQuery(e.target.value)}
                  placeholder={pickerTab === "gif" ? "Zoek GIF's..." : "Zoek stickers..."}
                  className="mb-2 w-full rounded-lg border border-gray-700 bg-gray-800 px-2.5 py-1.5 text-xs text-white placeholder-gray-500 outline-none transition focus:border-violet-500"
                />
                {mediaError && <p className="mb-2 text-[11px] text-red-300">{mediaError}</p>}
                <div className="chat-scroll grid max-h-64 grid-cols-3 gap-2 overflow-y-auto pr-1">
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
                        <img src={item.previewUrl} alt={item.title ?? "Media"} className="h-16 w-full rounded-md object-cover" loading="lazy" />
                      </button>
                    ))
                  )}
                </div>
                {mediaNextPos && (
                  <button
                    type="button"
                    onClick={() => {
                      if (!activeMediaType || mediaLoadingMore) return;
                      void fetchMedia(activeMediaType, mediaQuery, { append: true });
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
      </form>
    </div>
  );
}

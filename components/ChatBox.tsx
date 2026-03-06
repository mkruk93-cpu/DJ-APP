"use client";

import { useEffect, useRef, useState, useCallback, useId } from "react";
import { getSupabase } from "@/lib/supabaseClient";

interface ChatMessage {
  id: string;
  nickname: string;
  content: string;
  created_at: string;
}

const MAX_MESSAGES = 200;
const MAX_LENGTH = 300;
const COOLDOWN_MS = 2000;
const DUPLICATE_WINDOW_MS = 5000;
const STICKER_TOKEN_PREFIX = "[[sticker:";
const STICKER_TOKEN_SUFFIX = "]]";

const EMOJIS = [
  "🔥", "🎉", "💜", "😂", "😮", "😍",
  "🤯", "🥳", "🙌", "⚡", "🎧", "🫶",
];

const STICKERS = [
  { label: "Party", url: "https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f389.png" },
  { label: "Fire", url: "https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f525.png" },
  { label: "Hype", url: "https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f973.png" },
  { label: "Love", url: "https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f60d.png" },
  { label: "Mindblown", url: "https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f92f.png" },
  { label: "Headphones", url: "https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f3a7.png" },
];

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

function timeStr(iso: string) {
  return new Date(iso).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" });
}

export default function ChatBox({ onNewMessage }: { onNewMessage?: () => void } = {}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [cooldown, setCooldown] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerTab, setPickerTab] = useState<"emoji" | "sticker">("emoji");
  const lastMsgRef = useRef<{ text: string; time: number }>({ text: "", time: 0 });
  const bottomRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const channelId = useId();
  const nickname = typeof window !== "undefined" ? localStorage.getItem("nickname") ?? "anon" : "anon";

  function parseSticker(raw: string): string | null {
    const trimmed = raw.trim();
    if (!trimmed.startsWith(STICKER_TOKEN_PREFIX) || !trimmed.endsWith(STICKER_TOKEN_SUFFIX)) {
      return null;
    }
    return trimmed.slice(STICKER_TOKEN_PREFIX.length, -STICKER_TOKEN_SUFFIX.length).trim() || null;
  }

  function renderContent(raw: string) {
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
    return <span>{decodeLegacyEntities(raw)}</span>;
  }

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
    const text = (content ?? input).trim();
    if (!text || text.length > MAX_LENGTH || cooldown) return;

    const now = Date.now();
    if (text === lastMsgRef.current.text && now - lastMsgRef.current.time < DUPLICATE_WINDOW_MS) return;

    setCooldown(true);
    setTimeout(() => setCooldown(false), COOLDOWN_MS);
    lastMsgRef.current = { text, time: now };

    if (!content) setInput("");
    await getSupabase().from("chat_messages").insert({ nickname, content: text });
  }, [input, cooldown, nickname]);

  function addEmoji(emoji: string) {
    setInput((prev) => `${prev}${emoji}`);
    setPickerOpen(false);
  }

  function sendSticker(url: string) {
    const stickerPayload = `${STICKER_TOKEN_PREFIX}${url}${STICKER_TOKEN_SUFFIX}`;
    void sendMessage(stickerPayload);
    setPickerOpen(false);
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
                onClick={() => setPickerTab("emoji")}
                className={`flex-1 rounded-md px-2 py-1 text-xs font-semibold transition ${
                  pickerTab === "emoji" ? "bg-violet-600 text-white" : "text-gray-300 hover:text-white"
                }`}
              >
                Emoji
              </button>
              <button
                type="button"
                onClick={() => setPickerTab("sticker")}
                className={`flex-1 rounded-md px-2 py-1 text-xs font-semibold transition ${
                  pickerTab === "sticker" ? "bg-violet-600 text-white" : "text-gray-300 hover:text-white"
                }`}
              >
                Stickers
              </button>
            </div>

            {pickerTab === "emoji" ? (
              <div className="grid grid-cols-6 gap-1">
                {EMOJIS.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => addEmoji(emoji)}
                    className="rounded-lg bg-gray-800 py-1.5 text-xl transition hover:bg-gray-700"
                    title={`Voeg ${emoji} toe`}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-2">
                {STICKERS.map((sticker) => (
                  <button
                    key={sticker.url}
                    type="button"
                    onClick={() => sendSticker(sticker.url)}
                    className="rounded-lg bg-gray-800 p-1.5 transition hover:bg-gray-700"
                    title={`Sticker: ${sticker.label}`}
                  >
                    <img src={sticker.url} alt={sticker.label} className="h-16 w-full rounded-md object-cover" />
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </form>
    </div>
  );
}

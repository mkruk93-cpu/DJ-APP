"use client";

import { useEffect, useRef, useState, useCallback } from "react";
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

function sanitize(html: string): string {
  return html.replace(/[<>&"']/g, (c) => {
    const map: Record<string, string> = { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" };
    return map[c] ?? c;
  });
}

function timeStr(iso: string) {
  return new Date(iso).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" });
}

export default function ChatBox() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [cooldown, setCooldown] = useState(false);
  const lastMsgRef = useRef<{ text: string; time: number }>({ text: "", time: 0 });
  const bottomRef = useRef<HTMLDivElement>(null);
  const nickname = typeof window !== "undefined" ? localStorage.getItem("nickname") ?? "anon" : "anon";

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
      .channel("chat")
      .on<ChatMessage>(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "chat_messages" },
        (payload) => {
          setMessages((prev) => {
            const next = [...prev, payload.new];
            return next.length > MAX_MESSAGES ? next.slice(-MAX_MESSAGES) : next;
          });
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

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || text.length > MAX_LENGTH || cooldown) return;

    const now = Date.now();
    if (text === lastMsgRef.current.text && now - lastMsgRef.current.time < DUPLICATE_WINDOW_MS) return;

    setCooldown(true);
    setTimeout(() => setCooldown(false), COOLDOWN_MS);
    lastMsgRef.current = { text, time: now };

    setInput("");
    await getSupabase().from("chat_messages").insert({ nickname, content: sanitize(text) });
  }, [input, cooldown, nickname]);

  return (
    <div className="flex h-full flex-col rounded-xl border border-gray-800 bg-gray-900 shadow-lg shadow-violet-500/5">
      <div className="border-b border-gray-800 px-4 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-violet-400">Chat</h2>
      </div>

      <div className="chat-scroll flex-1 space-y-1 overflow-y-auto px-4 py-3">
        {messages.map((m) => (
          <div key={m.id} className="text-sm leading-relaxed">
            <span className="font-semibold text-violet-400">{m.nickname}</span>
            <span className="mx-1.5 text-gray-600">{timeStr(m.created_at)}</span>
            <span className="text-gray-300">{m.content}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <form
        onSubmit={(e) => { e.preventDefault(); sendMessage(); }}
        className="flex gap-2 border-t border-gray-800 px-4 py-3"
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          maxLength={MAX_LENGTH}
          placeholder="Typ een bericht..."
          className="flex-1 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 outline-none transition focus:border-violet-500"
        />
        <button
          type="submit"
          disabled={cooldown || !input.trim()}
          className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-violet-500 disabled:opacity-40"
        >
          Stuur
        </button>
      </form>
    </div>
  );
}

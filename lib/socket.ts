import { io, Socket } from 'socket.io-client';

let socket: Socket | null = null;
let currentUrl: string | null = null;
let fallback: Socket | null = null;

/** Returns the active socket, or a safe disconnected fallback if not yet connected. */
export function getSocket(): Socket {
  if (socket) return socket;
  if (!fallback) fallback = io('http://0.0.0.0', { autoConnect: false });
  return fallback;
}

export function connectSocket(url?: string): Socket {
  const targetUrl = url ?? process.env.NEXT_PUBLIC_CONTROL_SERVER_URL ?? null;
  if (!targetUrl) throw new Error('No radio server URL');

  if (socket && currentUrl !== targetUrl) {
    socket.disconnect();
    socket = null;
  }

  if (!socket) {
    currentUrl = targetUrl;
    socket = io(targetUrl, {
      autoConnect: false,
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: Infinity,
      transports: ['websocket', 'polling'],
    });
  }

  if (!socket.connected) socket.connect();
  return socket;
}

export function disconnectSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
    currentUrl = null;
  }
}

export function isSocketReady(): boolean {
  return socket !== null && socket.connected;
}

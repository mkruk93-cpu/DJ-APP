import { io, Socket } from 'socket.io-client';

let socket: Socket | null = null;
let currentUrl: string | null = null;

export function getSocket(): Socket {
  if (!socket) throw new Error('Socket not initialized — call connectSocket(url) first');
  return socket;
}

export function connectSocket(url?: string): Socket {
  const targetUrl = url ?? process.env.NEXT_PUBLIC_CONTROL_SERVER_URL ?? null;
  if (!targetUrl) throw new Error('No radio server URL');

  // If URL changed, disconnect old socket
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

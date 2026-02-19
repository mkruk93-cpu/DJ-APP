import { io, Socket } from 'socket.io-client';

let socket: Socket | null = null;

const CONTROL_SERVER_URL = process.env.NEXT_PUBLIC_CONTROL_SERVER_URL ?? 'http://localhost:3001';

export function getSocket(): Socket {
  if (socket) return socket;

  socket = io(CONTROL_SERVER_URL, {
    autoConnect: false,
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionAttempts: Infinity,
    transports: ['websocket', 'polling'],
  });

  return socket;
}

export function connectSocket(): Socket {
  const s = getSocket();
  if (!s.connected) s.connect();
  return s;
}

export function disconnectSocket(): void {
  if (socket?.connected) {
    socket.disconnect();
  }
}

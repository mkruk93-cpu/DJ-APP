export interface ChatMessage {
  id: string;
  nickname: string;
  content: string;
  created_at: string;
}

export type RequestStatus = "pending" | "approved" | "downloaded" | "rejected" | "error";

export interface RequestItem {
  id: string;
  nickname: string;
  url: string;
  title: string | null;
  artist: string | null;
  thumbnail: string | null;
  source?: string | null;
  genre?: string | null;
  genre_confidence?: "explicit" | "artist_based" | "unknown" | null;
  status: RequestStatus;
  created_at: string;
}

export interface NowPlaying {
  title: string | null;
  artist: string | null;
  artwork_url: string | null;
  updated_at?: string;
}

export interface OverlaySettings {
  apiBaseUrl: string;
  controlServerUrl: string;
  adminToken: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  showTopBar: boolean;
  lockLayout: boolean;
  clickThrough: boolean;
  showChat: boolean;
  showRequests: boolean;
}

export interface PanelLayout {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PollPreset {
  id: string;
  name: string;
  question: string;
  options: string[];
  created_at: string;
}

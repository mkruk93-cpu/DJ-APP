export type Mode = 'dj' | 'radio' | 'democracy' | 'jukebox' | 'party';

export type Action = 'skip' | 'add_to_queue' | 'reorder_queue' | 'remove_from_queue' | 'vote_skip';

export interface QueueItem {
  id: string;
  youtube_url: string;
  youtube_id: string;
  title: string | null;
  thumbnail: string | null;
  added_by: string;
  position: number;
  created_at: string;
}

export interface Track {
  id: string;
  youtube_id: string;
  title: string | null;
  thumbnail: string | null;
  duration: number | null;
  started_at: number;
}

export interface ModeSettings {
  democracy_threshold: number;
  democracy_timer: number;
  jukebox_max_per_user: number;
  party_skip_cooldown: number;
}

export interface VoteState {
  votes: number;
  required: number;
  timer: number;
}

export interface DurationVote {
  id: string;
  youtube_url: string;
  title: string | null;
  thumbnail: string | null;
  duration: number;
  added_by: string;
  yes: number;
  no: number;
  voters: string[];
  expires_at: number;
}

export interface ServerState {
  currentTrack: Track | null;
  queue: QueueItem[];
  mode: Mode;
  modeSettings: ModeSettings;
  listenerCount: number;
  streamOnline: boolean;
  voteState: VoteState | null;
  durationVote: DurationVote | null;
}

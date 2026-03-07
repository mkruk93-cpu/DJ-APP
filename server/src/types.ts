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
  added_by: string | null;
  started_at: number;
}

export interface UpcomingTrack {
  youtube_id: string;
  title: string | null;
  thumbnail: string | null;
  duration: number | null;
  added_by: string | null;
  isFallback: boolean;
}

export interface FallbackGenre {
  id: string;
  label: string;
  trackCount: number;
  genre_group?: string | null;
  subgenre?: string | null;
  related_parent_playlist_id?: string | null;
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

export interface QueuePushVote {
  id: string;
  item_id: string;
  title: string | null;
  thumbnail: string | null;
  added_by: string;
  proposed_by: string;
  required: number;
  yes: number;
  no: number;
  voters: string[];
  expires_at: number;
}

export interface ServerState {
  currentTrack: Track | null;
  upcomingTrack: UpcomingTrack | null;
  queue: QueueItem[];
  mode: Mode;
  modeSettings: ModeSettings;
  fallbackGenres: FallbackGenre[];
  activeFallbackGenre: string | null;
  activeFallbackGenreBy: string | null;
  activeFallbackSharedMode: 'random' | 'ordered';
  listenerCount: number;
  streamOnline: boolean;
  voteState: VoteState | null;
  durationVote: DurationVote | null;
  queuePushVote: Omit<QueuePushVote, 'voters'> | null;
  queuePushLocked: boolean;
  skipLocked: boolean;
}

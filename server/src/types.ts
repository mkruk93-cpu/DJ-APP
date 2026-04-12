export type Mode = 'dj' | 'radio' | 'democracy' | 'jukebox' | 'party';

export type Action = 'skip' | 'add_to_queue' | 'reorder_queue' | 'remove_from_queue' | 'vote_skip';

export interface QueueItem {
  id: string;
  youtube_url: string;
  youtube_id: string;
  title: string | null;
  artist?: string | null;
  thumbnail: string | null;
  added_by: string;
  position: number;
  created_at: string;
  selection_label?: string | null;
  selection_playlist?: string | null;
  selection_tab?: 'queue' | 'local' | 'online' | 'playlists' | 'mixed' | null;
  selection_key?: string | null;
}

export interface Track {
  id: string;
  youtube_id: string;
  title: string | null;
  artist?: string | null;
  thumbnail: string | null;
  duration: number | null;
  added_by: string | null;
  started_at: number;
  selection_label?: string | null;
  selection_playlist?: string | null;
  selection_tab?: 'queue' | 'local' | 'online' | 'playlists' | 'mixed' | null;
  selection_key?: string | null;
}

export interface UpcomingTrack {
  youtube_id: string;
  title: string | null;
  artist?: string | null;
  thumbnail: string | null;
  duration: number | null;
  added_by: string | null;
  isFallback: boolean;
  selection_label?: string | null;
  selection_playlist?: string | null;
  selection_tab?: 'queue' | 'local' | 'online' | 'playlists' | 'mixed' | null;
  selection_key?: string | null;
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
  dj_queue_base_per_user: number;
  dj_queue_min_per_user: number;
  dj_queue_listener_step: number;
  radio_queue_base_per_user: number;
  radio_queue_min_per_user: number;
  radio_queue_listener_step: number;
  democracy_queue_base_per_user: number;
  democracy_queue_min_per_user: number;
  democracy_queue_listener_step: number;
  jukebox_queue_base_per_user: number;
  jukebox_queue_min_per_user: number;
  jukebox_queue_listener_step: number;
  party_queue_base_per_user: number;
  party_queue_min_per_user: number;
  party_queue_listener_step: number;
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
  artist: string | null;
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
  jingleEnabled: boolean;
  jingleEveryTracks: number;
  jingleSelectedKeys: string[];
  mode: Mode;
  modeSettings: ModeSettings;
  fallbackGenres: FallbackGenre[];
  activeFallbackGenre: string | null;
  activeFallbackGenres: string[];
  activeFallbackGenreBy: string | null;
  activeFallbackSharedMode: 'random' | 'ordered';
  listenerCount: number;
  streamOnline: boolean;
  pausedForIdle: boolean;
  voteState: VoteState | null;
  durationVote: DurationVote | null;
  queuePushVote: Omit<QueuePushVote, 'voters'> | null;
  queuePushLocked: boolean;
  skipLocked: boolean;
  /** When true, only admin token may change autoplay fallback / shared mode / presets apply */
  lockAutoplayFallback: boolean;
  /** When true, hide local genre catalog in fallback UI and omit local slices in search APIs */
  hideLocalDiscovery: boolean;
  /** Push notification message for all users */
  pushMessage: string | null;
  /** Unix timestamp when push message expires (0 = no expiry) */
  pushMessageExpiry: number;
}

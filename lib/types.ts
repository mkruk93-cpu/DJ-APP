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
  thumbnail: string | null;
  duration: number;
  added_by: string;
  yes: number;
  no: number;
  expires_at: number;
  voted: boolean;
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
  expires_at: number;
  voted: boolean;
}

export interface RadioState {
  connected: boolean;
  currentTrack: Track | null;
  upcomingTrack: UpcomingTrack | null;
  queue: QueueItem[];
  fallbackGenres: FallbackGenre[];
  activeFallbackGenre: string | null;
  activeFallbackGenres: string[];
  activeFallbackGenreBy: string | null;
  activeFallbackSharedMode: 'random' | 'ordered';
  mode: Mode;
  modeSettings: ModeSettings;
  listenerCount: number;
  streamOnline: boolean;
  pausedForIdle: boolean;
  voteState: VoteState | null;
  durationVote: DurationVote | null;
  queuePushVote: QueuePushVote | null;
  queuePushLocked: boolean;
  skipLocked: boolean;
  serverUrl: string | null;
}

export const MODE_LABELS: Record<Mode, string> = {
  dj: 'DJ',
  radio: 'Radio',
  democracy: 'Democratie',
  jukebox: 'Jukebox',
  party: 'Party',
};

export function canPerformAction(mode: Mode, action: Action, isAdmin: boolean): boolean {
  const rules: Record<Mode, Record<Action, 'admin' | 'all' | 'none'>> = {
    dj: { skip: 'admin', add_to_queue: 'admin', reorder_queue: 'admin', remove_from_queue: 'admin', vote_skip: 'none' },
    radio: { skip: 'admin', add_to_queue: 'admin', reorder_queue: 'admin', remove_from_queue: 'admin', vote_skip: 'none' },
    democracy: { skip: 'admin', add_to_queue: 'all', reorder_queue: 'admin', remove_from_queue: 'admin', vote_skip: 'all' },
    jukebox: { skip: 'admin', add_to_queue: 'all', reorder_queue: 'admin', remove_from_queue: 'admin', vote_skip: 'none' },
    party: { skip: 'all', add_to_queue: 'all', reorder_queue: 'admin', remove_from_queue: 'all', vote_skip: 'none' },
  };

  const rule = rules[mode]?.[action];
  if (!rule || rule === 'none') return false;
  if (rule === 'all') return true;
  return isAdmin;
}

import { create } from 'zustand';
import type { RadioState, Track, QueueItem, Mode, ModeSettings, VoteState, DurationVote, QueuePushVote, FallbackGenre } from './types';

interface RadioStore extends RadioState {
  setConnected: (connected: boolean) => void;
  setCurrentTrack: (track: Track | null) => void;
  setUpcomingTrack: (track: RadioState["upcomingTrack"]) => void;
  setQueue: (items: QueueItem[]) => void;
  setFallbackGenres: (genres: FallbackGenre[]) => void;
  setActiveFallbackGenre: (genreId: string | null) => void;
  setActiveFallbackGenres: (genreIds: string[]) => void;
  setActiveFallbackGenreBy: (nickname: string | null) => void;
  setActiveFallbackSharedMode: (mode: "random" | "ordered") => void;
  setActiveFallbackPresetName: (presetName: string | null) => void;
  setMode: (mode: Mode, settings: ModeSettings) => void;
  setModeSettings: (settings: ModeSettings) => void;
  setListenerCount: (count: number) => void;
  setStreamOnline: (online: boolean) => void;
  setPausedForIdle: (pausedForIdle: boolean) => void;
  setVoteState: (vote: VoteState | null) => void;
  setDurationVote: (vote: DurationVote | null) => void;
  setQueuePushVote: (vote: QueuePushVote | null) => void;
  setQueuePushLocked: (locked: boolean) => void;
  setLockAutoplayFallback: (locked: boolean) => void;
  setHideLocalDiscovery: (hide: boolean) => void;
  setServerUrl: (url: string | null) => void;
  skipLocked: boolean;
  setSkipLocked: (locked: boolean) => void;
  playerPlaying: boolean;
  setPlayerPlaying: (playing: boolean) => void;
  onlineUserCount: number;
  setOnlineUserCount: (count: number) => void;
  pushMessage: string | null;
  setPushMessage: (message: string | null) => void;
  pushMessageExpiry: number;
  setPushMessageExpiry: (expiry: number) => void;
  resetAll: () => void;
  initFromServer: (state: Partial<RadioState>) => void;
}

export const useRadioStore = create<RadioStore>((set) => ({
  connected: false,
  currentTrack: null,
  upcomingTrack: null,
  queue: [],
  fallbackGenres: [],
  activeFallbackGenre: null,
  activeFallbackGenres: [],
  activeFallbackGenreBy: null,
  activeFallbackSharedMode: "random",
  activeFallbackPresetName: null,
  mode: 'radio',
  modeSettings: {
    democracy_threshold: 51,
    democracy_timer: 15,
    jukebox_max_per_user: 5,
    party_skip_cooldown: 10,
    dj_queue_base_per_user: 3,
    dj_queue_min_per_user: 1,
    dj_queue_listener_step: 3,
    radio_queue_base_per_user: 3,
    radio_queue_min_per_user: 1,
    radio_queue_listener_step: 3,
    democracy_queue_base_per_user: 2,
    democracy_queue_min_per_user: 1,
    democracy_queue_listener_step: 3,
    jukebox_queue_base_per_user: 5,
    jukebox_queue_min_per_user: 1,
    jukebox_queue_listener_step: 2,
    party_queue_base_per_user: 6,
    party_queue_min_per_user: 1,
    party_queue_listener_step: 2,
  },
  listenerCount: 0,
  onlineUserCount: 0,
  streamOnline: false,
  pausedForIdle: false,
  voteState: null,
  durationVote: null,
  queuePushVote: null,
  queuePushLocked: false,
  serverUrl: null,
  skipLocked: false,
  lockAutoplayFallback: false,
  hideLocalDiscovery: false,
  playerPlaying: false,
  pushMessage: null,
  pushMessageExpiry: 0,

  setConnected: (connected) => set({ connected }),
  setCurrentTrack: (currentTrack) => set({ currentTrack }),
  setUpcomingTrack: (upcomingTrack) => set({ upcomingTrack }),
  setQueue: (queue) => set({ queue }),
  setFallbackGenres: (fallbackGenres) => set({ fallbackGenres }),
  setActiveFallbackGenre: (activeFallbackGenre) => set({ activeFallbackGenre }),
  setActiveFallbackGenres: (activeFallbackGenres) => set({ activeFallbackGenres }),
  setActiveFallbackGenreBy: (activeFallbackGenreBy) => set({ activeFallbackGenreBy }),
  setActiveFallbackSharedMode: (activeFallbackSharedMode) => set({ activeFallbackSharedMode }),
  setActiveFallbackPresetName: (activeFallbackPresetName) => set({ activeFallbackPresetName }),
  setMode: (mode, modeSettings) => set({ mode, modeSettings }),
  setModeSettings: (modeSettings) => set({ modeSettings }),
  setListenerCount: (listenerCount) => set({ listenerCount }),
  setOnlineUserCount: (onlineUserCount) => set({ onlineUserCount }),
  setStreamOnline: (streamOnline) => set({ streamOnline }),
  setPausedForIdle: (pausedForIdle) => set({ pausedForIdle }),
  setVoteState: (voteState) => set({ voteState }),
  setDurationVote: (durationVote) => set({ durationVote }),
  setQueuePushVote: (queuePushVote) => set({ queuePushVote }),
  setQueuePushLocked: (queuePushLocked) => set({ queuePushLocked }),
  setLockAutoplayFallback: (lockAutoplayFallback) => set({ lockAutoplayFallback }),
  setHideLocalDiscovery: (hideLocalDiscovery) => set({ hideLocalDiscovery }),
  setServerUrl: (serverUrl) => set({ serverUrl }),
  setSkipLocked: (skipLocked) => set({ skipLocked }),
  setPlayerPlaying: (playerPlaying) => set({ playerPlaying }),
  setPushMessage: (pushMessage) => set({ pushMessage }),
  setPushMessageExpiry: (pushMessageExpiry) => set({ pushMessageExpiry }),
  resetAll: () => set({
    connected: false,
    currentTrack: null,
    upcomingTrack: null,
    queue: [],
    fallbackGenres: [],
    activeFallbackGenre: null,
    activeFallbackGenres: [],
    activeFallbackGenreBy: null,
    activeFallbackSharedMode: "random",
    listenerCount: 0,
    onlineUserCount: 0,
    streamOnline: false,
    pausedForIdle: false,
    voteState: null,
    durationVote: null,
    queuePushVote: null,
    queuePushLocked: false,
    skipLocked: false,
    lockAutoplayFallback: false,
    hideLocalDiscovery: false,
    playerPlaying: false,
    pushMessage: null,
    pushMessageExpiry: 0,
  }),
  initFromServer: (state) => set(state),
}));

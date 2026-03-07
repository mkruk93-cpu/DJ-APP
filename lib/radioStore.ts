import { create } from 'zustand';
import type { RadioState, Track, QueueItem, Mode, ModeSettings, VoteState, DurationVote, QueuePushVote, FallbackGenre } from './types';

interface RadioStore extends RadioState {
  setConnected: (connected: boolean) => void;
  setCurrentTrack: (track: Track | null) => void;
  setUpcomingTrack: (track: RadioState["upcomingTrack"]) => void;
  setQueue: (items: QueueItem[]) => void;
  setFallbackGenres: (genres: FallbackGenre[]) => void;
  setActiveFallbackGenre: (genreId: string | null) => void;
  setActiveFallbackGenreBy: (nickname: string | null) => void;
  setActiveFallbackSharedMode: (mode: "random" | "ordered") => void;
  setMode: (mode: Mode, settings: ModeSettings) => void;
  setModeSettings: (settings: ModeSettings) => void;
  setListenerCount: (count: number) => void;
  setStreamOnline: (online: boolean) => void;
  setVoteState: (vote: VoteState | null) => void;
  setDurationVote: (vote: DurationVote | null) => void;
  setQueuePushVote: (vote: QueuePushVote | null) => void;
  setQueuePushLocked: (locked: boolean) => void;
  setServerUrl: (url: string | null) => void;
  skipLocked: boolean;
  setSkipLocked: (locked: boolean) => void;
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
  activeFallbackGenreBy: null,
  activeFallbackSharedMode: "random",
  mode: 'radio',
  modeSettings: {
    democracy_threshold: 51,
    democracy_timer: 15,
    jukebox_max_per_user: 5,
    party_skip_cooldown: 10,
  },
  listenerCount: 0,
  streamOnline: false,
  voteState: null,
  durationVote: null,
  queuePushVote: null,
  queuePushLocked: false,
  serverUrl: null,
  skipLocked: false,

  setConnected: (connected) => set({ connected }),
  setCurrentTrack: (currentTrack) => set({ currentTrack }),
  setUpcomingTrack: (upcomingTrack) => set({ upcomingTrack }),
  setQueue: (queue) => set({ queue }),
  setFallbackGenres: (fallbackGenres) => set({ fallbackGenres }),
  setActiveFallbackGenre: (activeFallbackGenre) => set({ activeFallbackGenre }),
  setActiveFallbackGenreBy: (activeFallbackGenreBy) => set({ activeFallbackGenreBy }),
  setActiveFallbackSharedMode: (activeFallbackSharedMode) => set({ activeFallbackSharedMode }),
  setMode: (mode, modeSettings) => set({ mode, modeSettings }),
  setModeSettings: (modeSettings) => set({ modeSettings }),
  setListenerCount: (listenerCount) => set({ listenerCount }),
  setStreamOnline: (streamOnline) => set({ streamOnline }),
  setVoteState: (voteState) => set({ voteState }),
  setDurationVote: (durationVote) => set({ durationVote }),
  setQueuePushVote: (queuePushVote) => set({ queuePushVote }),
  setQueuePushLocked: (queuePushLocked) => set({ queuePushLocked }),
  setServerUrl: (serverUrl) => set({ serverUrl }),
  setSkipLocked: (skipLocked) => set({ skipLocked }),
  resetAll: () => set({
    connected: false,
    currentTrack: null,
    upcomingTrack: null,
    queue: [],
    fallbackGenres: [],
    activeFallbackGenre: null,
    activeFallbackGenreBy: null,
    activeFallbackSharedMode: "random",
    listenerCount: 0,
    streamOnline: false,
    voteState: null,
    durationVote: null,
    queuePushVote: null,
    queuePushLocked: false,
    skipLocked: false,
  }),
  initFromServer: (state) => set(state),
}));

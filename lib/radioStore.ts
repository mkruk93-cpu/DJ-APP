import { create } from 'zustand';
import type { RadioState, Track, QueueItem, Mode, ModeSettings, VoteState, DurationVote } from './types';

interface RadioStore extends RadioState {
  setConnected: (connected: boolean) => void;
  setCurrentTrack: (track: Track | null) => void;
  setQueue: (items: QueueItem[]) => void;
  setMode: (mode: Mode, settings: ModeSettings) => void;
  setModeSettings: (settings: ModeSettings) => void;
  setListenerCount: (count: number) => void;
  setStreamOnline: (online: boolean) => void;
  setVoteState: (vote: VoteState | null) => void;
  setDurationVote: (vote: DurationVote | null) => void;
  resetAll: () => void;
  initFromServer: (state: Partial<RadioState>) => void;
}

export const useRadioStore = create<RadioStore>((set) => ({
  connected: false,
  currentTrack: null,
  queue: [],
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

  setConnected: (connected) => set({ connected }),
  setCurrentTrack: (currentTrack) => set({ currentTrack }),
  setQueue: (queue) => set({ queue }),
  setMode: (mode, modeSettings) => set({ mode, modeSettings }),
  setModeSettings: (modeSettings) => set({ modeSettings }),
  setListenerCount: (listenerCount) => set({ listenerCount }),
  setStreamOnline: (streamOnline) => set({ streamOnline }),
  setVoteState: (voteState) => set({ voteState }),
  setDurationVote: (durationVote) => set({ durationVote }),
  resetAll: () => set({
    connected: false,
    currentTrack: null,
    queue: [],
    listenerCount: 0,
    streamOnline: false,
    voteState: null,
    durationVote: null,
  }),
  initFromServer: (state) => set(state),
}));

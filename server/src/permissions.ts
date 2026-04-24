import type { Mode, Action } from './types.js';

const RULES: Record<Mode, Record<Action, 'admin' | 'all' | 'none' | 'solo'>> = {
  dj: {
    skip: 'admin',
    add_to_queue: 'admin',
    reorder_queue: 'admin',
    remove_from_queue: 'admin',
    vote_skip: 'none',
  },
  radio: {
    skip: 'admin',
    add_to_queue: 'admin',
    reorder_queue: 'admin',
    remove_from_queue: 'admin',
    vote_skip: 'none',
  },
  democracy: {
    skip: 'admin',
    add_to_queue: 'all',
    reorder_queue: 'admin',
    remove_from_queue: 'admin',
    vote_skip: 'all',
  },
  jukebox: {
    skip: 'admin',
    add_to_queue: 'all',
    reorder_queue: 'admin',
    remove_from_queue: 'admin',
    vote_skip: 'none',
  },
  party: {
    skip: 'all',
    add_to_queue: 'all',
    reorder_queue: 'admin',
    remove_from_queue: 'all',
    vote_skip: 'none',
  },
  solo: {
    skip: 'solo',
    add_to_queue: 'solo',
    reorder_queue: 'admin',
    remove_from_queue: 'admin',
    vote_skip: 'none',
  },
};

export function canPerformAction(mode: Mode, action: Action, isAdmin: boolean, hasSoloControl = false): boolean {
  const rule = RULES[mode]?.[action];
  if (!rule || rule === 'none') return false;
  if (rule === 'all') return true;
  if (rule === 'solo') return isAdmin || hasSoloControl;
  return isAdmin;
}

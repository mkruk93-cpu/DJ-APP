export interface UserIdentity {
  nickname: string;
  deviceId: string;
}

const DEVICE_ID_KEY = 'radio_device_id';

function makeDeviceId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const randomPart = Math.random().toString(36).slice(2, 12);
  const timePart = Date.now().toString(36);
  return `dev_${timePart}_${randomPart}`;
}

export function getDeviceId(): string {
  if (typeof window === 'undefined') return '';
  const existing = localStorage.getItem(DEVICE_ID_KEY)?.trim();
  if (existing) return existing;
  const generated = makeDeviceId();
  localStorage.setItem(DEVICE_ID_KEY, generated);
  return generated;
}

export function getNickname(): string {
  if (typeof window === 'undefined') return '';
  const stored = (localStorage.getItem('nickname') ?? '').trim();
  const authUser = localStorage.getItem('supabase.auth.token');
  if (authUser) {
    try {
      const parsed = JSON.parse(authUser);
      const authNickname = String(
        parsed?.user?.user_metadata?.username
        || parsed?.user?.email?.split('@')[0]
        || '',
      ).trim();
      if (authNickname) {
        if (stored !== authNickname) {
          localStorage.setItem('nickname', authNickname);
        }
        return authNickname;
      }
    } catch {
      // Ignore parse errors and fall back to stored nickname.
    }
  }
  return stored;
}

export function getUserIdentity(requireNickname = true): UserIdentity {
  const nickname = getNickname();
  if (requireNickname && !nickname) {
    // Fallback: gebruik auth username uit localStorage of 'anonymous'
    if (typeof window !== 'undefined') {
      const authUser = localStorage.getItem('supabase.auth.token');
      if (authUser) {
        try {
          const parsed = JSON.parse(authUser);
          const username = parsed?.user?.user_metadata?.username || parsed?.user?.email?.split('@')[0];
          if (username) {
            return {
              nickname: username,
              deviceId: getDeviceId(),
            };
          }
        } catch {
          // Ignore parse errors
        }
      }
    }
    // Laatste fallback: gebruik anonymous
    return {
      nickname: 'anonymous',
      deviceId: getDeviceId(),
    };
  }
  return {
    nickname: nickname || 'anonymous',
    deviceId: getDeviceId(),
  };
}

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
  return (localStorage.getItem('nickname') ?? '').trim();
}

export function getUserIdentity(requireNickname = true): UserIdentity {
  const nickname = getNickname();
  if (requireNickname && !nickname) {
    // Fallback: gebruik auth username of anonymous als geen nickname in localStorage
    if (typeof window !== 'undefined') {
      const authUsername = window.location.search.includes('auth=true') ? null : null;
      if (authUsername) {
        return {
          nickname: authUsername,
          deviceId: getDeviceId(),
        };
      }
    }
    throw new Error('Nickname ontbreekt');
  }
  return {
    nickname: nickname || 'anonymous',
    deviceId: getDeviceId(),
  };
}

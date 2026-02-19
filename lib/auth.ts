const RADIO_TOKEN_KEY = 'radio_admin_token';

export function getRadioToken(): string | null {
  if (typeof window === 'undefined') return null;
  return sessionStorage.getItem(RADIO_TOKEN_KEY);
}

export function setRadioToken(token: string): void {
  if (typeof window === 'undefined') return;
  sessionStorage.setItem(RADIO_TOKEN_KEY, token);
}

export function clearRadioToken(): void {
  if (typeof window === 'undefined') return;
  sessionStorage.removeItem(RADIO_TOKEN_KEY);
}

export function isRadioAdmin(): boolean {
  return getRadioToken() !== null;
}

const RADIO_TOKEN_KEY = 'radio_admin_token';
const ADMIN_SESSION_KEY = 'admin_auth';

export function getRadioToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(RADIO_TOKEN_KEY);
}

export function setRadioToken(token: string): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(RADIO_TOKEN_KEY, token);
}

export function clearRadioToken(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(RADIO_TOKEN_KEY);
}

export function isRadioAdmin(): boolean {
  const token = getRadioToken();
  const expectedToken = process.env.NEXT_PUBLIC_ADMIN_PASSWORD?.trim();

  if (!token || !expectedToken) return false;

  return token.trim() === expectedToken;
}

export function clearAdminSessionArtifacts(): void {
  if (typeof window === 'undefined') return;
  sessionStorage.removeItem(ADMIN_SESSION_KEY);
  clearRadioToken();
}

import { getRadioToken } from './auth';
import { useRadioStore } from './radioStore';

function getServerUrl(): string | null {
  return useRadioStore.getState().serverUrl ?? process.env.NEXT_PUBLIC_CONTROL_SERVER_URL ?? null;
}

async function post(path: string, body: Record<string, unknown> = {}): Promise<{ ok: boolean; [k: string]: unknown }> {
  const url = getServerUrl();
  if (!url) throw new Error('No server URL');

  const token = getRadioToken();
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, token }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }

  return res.json();
}

export async function setMode(mode: string): Promise<void> {
  await post('/api/mode', { mode });
}

export async function updateSetting(key: string, value: unknown): Promise<void> {
  await post('/api/settings', { key, value });
}

export async function skipTrack(): Promise<void> {
  await post('/api/skip');
}

export async function setKeepFiles(keep: boolean): Promise<void> {
  await post('/api/keep-files', { keep });
}

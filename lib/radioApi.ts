import { getRadioToken } from './auth';
import { useRadioStore } from './radioStore';

function getServerUrl(): string | null {
  return useRadioStore.getState().serverUrl ?? process.env.NEXT_PUBLIC_CONTROL_SERVER_URL ?? null;
}

async function post(path: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const url = getServerUrl();
  if (!url) throw new Error('No server URL configured');

  const token = getRadioToken();
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, token }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as Record<string, string>).error ?? `HTTP ${res.status}`);
  }

  return res.json();
}

export async function setMode(mode: string): Promise<void> {
  await post('/api/mode', { mode });
  // Optimistic: re-fetch full state so store is always in sync
  refreshState();
}

export async function updateSetting(key: string, value: unknown): Promise<void> {
  await post('/api/settings', { key, value });
  refreshState();
}

export async function skipTrack(): Promise<void> {
  await post('/api/skip');
}

export async function setKeepFiles(keep: boolean): Promise<void> {
  await post('/api/keep-files', { keep });
}

function refreshState(): void {
  const url = getServerUrl();
  if (!url) return;

  fetch(`${url}/state`)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then((state) => {
      const store = useRadioStore.getState();
      store.initFromServer({
        currentTrack: state.currentTrack ?? null,
        queue: state.queue ?? [],
        mode: state.mode ?? 'radio',
        modeSettings: state.modeSettings ?? store.modeSettings,
        listenerCount: state.listenerCount ?? 0,
        streamOnline: state.streamOnline ?? false,
      });
    })
    .catch(() => {});
}

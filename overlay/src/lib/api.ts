import type { RequestItem, RequestStatus } from "../types";

function toUrl(base: string, path: string): string {
  const trimmed = (base ?? "").trim();
  if (!trimmed || trimmed === "/") return path;
  return `${trimmed.replace(/\/+$/, "")}${path}`;
}

export async function fetchRequests(
  baseUrl: string,
  status?: string,
): Promise<RequestItem[]> {
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  const res = await fetch(toUrl(baseUrl, `/api/requests${query}`));
  if (!res.ok) throw new Error(`requests fetch failed (${res.status})`);
  const payload = (await res.json()) as { items?: RequestItem[] };
  return payload.items ?? [];
}

export async function updateRequestStatus(
  baseUrl: string,
  token: string,
  id: string,
  status: RequestStatus,
): Promise<void> {
  const path = `/api/requests/${id}`;
  const primary = toUrl(baseUrl, path);
  const candidates = [primary, `http://localhost:3000${path}`];
  let lastError: unknown = null;

  for (const url of candidates) {
    try {
      const res = await fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-admin-token": token },
        body: JSON.stringify({ status }),
      });
      if (res.ok) return;
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      lastError = new Error(payload.error ?? `status update failed (${res.status})`);
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("status update failed");
}

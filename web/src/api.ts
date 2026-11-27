import { STORAGE_KEY } from "./session";

export type ApiResult<T> = { ok: boolean; error?: string; data?: T };

export async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  try {
    const response = await fetch(`/api${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${localStorage.getItem(STORAGE_KEY) ?? ""}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await response.json().catch(() => ({}))) as T & { error?: string };
    return response.ok ? { ok: true, data: json } : { ok: false, error: json.error };
  } catch {
    return { ok: false };
  }
}

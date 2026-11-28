export type PageUser = { name: string; language: string };

export const STORAGE_KEY = "taskbuddy.session";

async function post(path: string, body: unknown): Promise<PageUser | undefined> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) return undefined;
  const result = (await response.json()) as { token: string; user: PageUser };
  localStorage.setItem(STORAGE_KEY, result.token);
  return result.user;
}

export function forgetSession(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // storage unavailable
  }
}

export async function signIn(): Promise<PageUser | undefined> {
  const url = new URL(location.href);
  const linkToken = url.searchParams.get("login");
  if (linkToken) {
    url.searchParams.delete("login");
    history.replaceState(null, "", url);
    return post("/api/auth/link", { token: linkToken });
  }

  const token = localStorage.getItem(STORAGE_KEY);
  if (!token) return undefined;
  const response = await fetch("/api/me", { headers: { Authorization: `Bearer ${token}` } });
  if (response.status === 401) localStorage.removeItem(STORAGE_KEY);
  if (!response.ok) return undefined;
  return ((await response.json()) as { user: PageUser }).user;
}

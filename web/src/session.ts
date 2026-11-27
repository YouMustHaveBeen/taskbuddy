import { retrieveRawInitData } from "@telegram-apps/sdk";

export type PageUser = { name: string; language: string };

const STORAGE_KEY = "taskbuddy.session";

function telegramInitData(): string | undefined {
  try {
    return retrieveRawInitData();
  } catch {
    return undefined;
  }
}

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

export async function signIn(): Promise<PageUser | undefined> {
  const initData = telegramInitData();
  if (initData) return post("/api/auth/telegram", { initData });

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
  if (!response.ok) {
    localStorage.removeItem(STORAGE_KEY);
    return undefined;
  }
  return ((await response.json()) as { user: PageUser }).user;
}

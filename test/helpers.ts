import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { vi } from "vitest";
import app from "../src/index";
import { signInByTelegramId } from "../src/core/auth";
import { toHex } from "../src/core/crypto";
import { createDb } from "../src/db/client";

export const ORIGIN = "https://taskbuddy.example";

export async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await app.fetch(new Request(`${ORIGIN}${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

export async function resetDb(): Promise<void> {
  await env.DB.batch(
    [
      "day_plan",
      "insight_spheres",
      "insights",
      "zones",
      "practices",
      "routines",
      "tasks",
      "item_spheres",
      "items",
      "rewards",
      "category_compat",
      "categories",
      "action_kinds",
      "spheres",
      "tg_updates",
      "sessions",
      "settings",
      "users",
      "households",
    ].map((table) =>
      env.DB.prepare(`DELETE FROM ${table}`),
    ),
  );
}

export type TelegramCall = { method: string; payload: Record<string, unknown> };

export function mockTelegram(): TelegramCall[] {
  const calls: TelegramCall[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const method = String(input instanceof Request ? input.url : input).split("/").pop() ?? "";
    const payload = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ method, payload });
    const result =
      method === "getMe"
        ? { id: 1, is_bot: true, first_name: "TaskBuddy", username: "test_bot" }
        : method === "sendMessage"
          ? { message_id: 1, date: 0, chat: { id: payload.chat_id, type: "private" } }
          : true;
    return Response.json({ ok: true, result });
  });
  return calls;
}

let updateId = 1;

export function sendUpdate(text: string, from = { id: 1001, first_name: "Ann", language_code: "ru" }) {
  return call("/tg/webhook", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": env.WEBHOOK_SECRET },
    body: JSON.stringify({
      update_id: updateId++,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: from.id, type: "private", first_name: from.first_name },
        from: { ...from, is_bot: false },
        text,
        entities: text.startsWith("/")
          ? [{ type: "bot_command", offset: 0, length: text.split(" ")[0].length }]
          : undefined,
      },
    }),
  });
}

async function hmac(key: BufferSource, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
}

export async function signInitData(fields: Record<string, string>, token = env.TELEGRAM_BOT_TOKEN) {
  const checkString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join("\n");
  const secret = await hmac(new TextEncoder().encode("WebAppData"), token);
  const hash = toHex(await hmac(secret, checkString));
  return new URLSearchParams({ ...fields, hash }).toString();
}

export async function createUser(telegramId: number, name: string): Promise<{ id: string; token: string }> {
  const now = Date.now();
  const householdId = crypto.randomUUID();
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO households (id, created_at) VALUES (?, ?)").bind(householdId, now),
    env.DB
      .prepare(
        "INSERT INTO users (id, household_id, telegram_id, name, language, timezone, created_at) VALUES (?, ?, ?, ?, 'ru', 'Europe/Dublin', ?)",
      )
      .bind(id, householdId, telegramId, name, now),
  ]);
  const signedIn = await signInByTelegramId(createDb(env.DB), telegramId, now);
  return { id, token: signedIn!.token };
}

export function api(token: string, method: string, path: string, body?: unknown): Promise<Response> {
  return call(`/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

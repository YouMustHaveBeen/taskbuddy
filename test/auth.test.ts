import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLoginLink, registerByInvite, signInByLink, userBySession } from "../src/core/auth";
import { defaults } from "../src/core/settings";
import { createDb } from "../src/db/client";
import { call, mockTelegram, resetDb, sendUpdate } from "./helpers";

const db = createDb(env.DB);
const ann = { telegramId: 1001, name: "Ann", languageCode: "ru" };
const bob = { telegramId: 2002, name: "Bob", languageCode: "en" };
const MINUTE = 60_000;

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

describe("регистрация по коду приглашения", () => {
  it("без верного кода пользователь не создается", async () => {
    expect(await registerByInvite(db, ann, "", env.OWNER_INVITE_CODE, 0)).toBeUndefined();
    expect(await registerByInvite(db, ann, "wrong", env.OWNER_INVITE_CODE, 0)).toBeUndefined();
    const { results } = await env.DB.prepare("SELECT id FROM users").all();
    expect(results).toHaveLength(0);
  });

  it("с верным кодом создается пользователь со своей семьей, языком и поясом по умолчанию", async () => {
    const user = await registerByInvite(db, ann, env.OWNER_INVITE_CODE, env.OWNER_INVITE_CODE, 0);
    expect(user).toMatchObject({ telegramId: 1001, language: "ru", timezone: defaults.timezone });
    const household = await env.DB.prepare("SELECT id FROM households").first<{ id: string }>();
    expect(household?.id).toBe(user?.householdId);
  });

  it("на этапе одного пользователя второй по тому же коду не регистрируется", async () => {
    await registerByInvite(db, ann, env.OWNER_INVITE_CODE, env.OWNER_INVITE_CODE, 0);
    expect(await registerByInvite(db, bob, env.OWNER_INVITE_CODE, env.OWNER_INVITE_CODE, 0)).toBeUndefined();
    const { results } = await env.DB.prepare("SELECT id FROM households").all();
    expect(results).toHaveLength(1);
  });
});

describe("одноразовая ссылка входа", () => {
  it("дает сессию один раз", async () => {
    const user = await registerByInvite(db, ann, env.OWNER_INVITE_CODE, env.OWNER_INVITE_CODE, 0);
    const link = await createLoginLink(db, user!.id, 0);
    const first = await signInByLink(db, link, MINUTE);
    expect(first?.user.id).toBe(user!.id);
    expect(await signInByLink(db, link, MINUTE)).toBeUndefined();
    expect((await userBySession(db, first!.token, MINUTE))?.id).toBe(user!.id);
  });

  it("не работает после срока действия", async () => {
    const user = await registerByInvite(db, ann, env.OWNER_INVITE_CODE, env.OWNER_INVITE_CODE, 0);
    const link = await createLoginLink(db, user!.id, 0);
    expect(await signInByLink(db, link, defaults.loginLinkTtlMinutes * MINUTE + 1)).toBeUndefined();
  });

  it("сама ссылка не является токеном сессии", async () => {
    const user = await registerByInvite(db, ann, env.OWNER_INVITE_CODE, env.OWNER_INVITE_CODE, 0);
    const link = await createLoginLink(db, user!.id, 0);
    expect(await userBySession(db, link, MINUTE)).toBeUndefined();
  });

  it("сессия истекает по настройке", async () => {
    const user = await registerByInvite(db, ann, env.OWNER_INVITE_CODE, env.OWNER_INVITE_CODE, 0);
    const signedIn = await signInByLink(db, await createLoginLink(db, user!.id, 0), 0);
    const ttl = defaults.sessionTtlHours * 60 * MINUTE;
    expect(await userBySession(db, signedIn!.token, ttl - 1)).toBeDefined();
    expect(await userBySession(db, signedIn!.token, ttl + 1)).toBeUndefined();
  });

  it("токены в базе хранятся только хешем", async () => {
    const user = await registerByInvite(db, ann, env.OWNER_INVITE_CODE, env.OWNER_INVITE_CODE, 0);
    const link = await createLoginLink(db, user!.id, 0);
    const signedIn = await signInByLink(db, link, 0);
    const { results } = await env.DB.prepare("SELECT id FROM sessions").all<{ id: string }>();
    const ids = results.map((row) => row.id);
    expect(ids).not.toContain(link);
    expect(ids).not.toContain(signedIn!.token);
  });
});

describe("вебхук Telegram", () => {
  it("без секретного токена отвечает 401 и ничего не делает", async () => {
    const calls = mockTelegram();
    const response = await call("/tg/webhook", { method: "POST", body: "{}" });
    expect(response.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("/start с кодом регистрирует владелицу и здоровается", async () => {
    const calls = mockTelegram();
    expect((await sendUpdate(`/start ${env.OWNER_INVITE_CODE}`)).status).toBe(200);
    const reply = calls.find((c) => c.method === "sendMessage");
    expect(reply?.payload.text).toBe("Привет! TaskBuddy подключен.");
  });

  it("/start без кода отвечает, что бот закрытый", async () => {
    const calls = mockTelegram();
    await sendUpdate("/start", { id: 3003, first_name: "Eve", language_code: "en" });
    const reply = calls.find((c) => c.method === "sendMessage");
    expect(reply?.payload.text).toBe("This is a private bot. An invite code is required.");
  });

  it("повтор того же update_id не обрабатывается второй раз", async () => {
    const calls = mockTelegram();
    const body = JSON.stringify({
      update_id: 999_999,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: 1001, type: "private", first_name: "Ann" },
        from: { id: 1001, is_bot: false, first_name: "Ann" },
        text: "/start",
        entities: [{ type: "bot_command", offset: 0, length: 6 }],
      },
    });
    const init = {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": env.WEBHOOK_SECRET },
      body,
    };
    await call("/tg/webhook", init);
    await call("/tg/webhook", init);
    expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(1);
  });

  it("/web присылает ссылку, по которой страница входит один раз", async () => {
    const calls = mockTelegram();
    await sendUpdate(`/start ${env.OWNER_INVITE_CODE}`);
    await sendUpdate("/web");
    const message = calls.filter((c) => c.method === "sendMessage")[1]?.payload;
    expect(message?.parse_mode).toBe("HTML");
    const link = /^<a href="([^"]+)">TaskBuddy<\/a>$/.exec(String(message?.text));
    const url = new URL(link![1].replaceAll("&amp;", "&"));
    expect(url.searchParams.has("pick")).toBe(false);
    const token = url.searchParams.get("login");

    const first = await call("/api/auth/link", { method: "POST", body: JSON.stringify({ token }) });
    expect(first.status).toBe(200);
    const { token: session } = await first.json<{ token: string }>();
    const me = await call("/api/me", { headers: { Authorization: `Bearer ${session}` } });
    expect(await me.json()).toEqual({ user: { name: "Ann", language: "ru" } });

    const second = await call("/api/auth/link", { method: "POST", body: JSON.stringify({ token }) });
    expect(second.status).toBe(401);
  });

  it("/web от незнакомого пользователя ссылку не дает", async () => {
    const calls = mockTelegram();
    await sendUpdate("/web", { id: 3003, first_name: "Eve", language_code: "ru" });
    const reply = calls.find((c) => c.method === "sendMessage");
    expect(reply?.payload.text).toBe("Это закрытый бот. Нужен код приглашения.");
  });
});

describe("страница без сессии", () => {
  it("тело null или не JSON при входе отклоняется с 401", async () => {
    expect((await call("/api/auth/link", { method: "POST", body: "null" })).status).toBe(401);
    expect((await call("/api/auth/link", { method: "POST", body: "not json" })).status).toBe(401);
  });

  it("/api/me без токена и с чужим токеном отвечает 401", async () => {
    expect((await call("/api/me")).status).toBe(401);
    const forged = { headers: { Authorization: "Bearer forged" } };
    expect((await call("/api/me", forged)).status).toBe(401);
  });
});

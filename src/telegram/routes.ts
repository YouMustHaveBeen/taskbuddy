import { Hono } from "hono";
import type { Update } from "grammy/types";
import { t } from "../../i18n";
import { safeEqual } from "../core/crypto";
import { defaults } from "../core/settings";
import { createDb } from "../db/client";
import { claimUpdate } from "../db/tgUpdates";
import type { Env } from "../env";
import { createBot } from "./bot";

export const telegramRoutes = new Hono<{ Bindings: Env }>();

telegramRoutes.post("/webhook", async (c) => {
  const secret = c.req.header("X-Telegram-Bot-Api-Secret-Token") ?? "";
  if (!(await safeEqual(secret, c.env.WEBHOOK_SECRET))) return c.body(null, 401);
  const update = await c.req.json<Update>();
  const origin = new URL(c.req.url).origin;
  c.executionCtx.waitUntil(processUpdate(c.env, origin, update));
  return c.body(null, 200);
});

telegramRoutes.post("/setup", async (c) => {
  const secret = c.req.header("X-Setup-Secret") ?? "";
  if (!(await safeEqual(secret, c.env.WEBHOOK_SECRET))) return c.body(null, 401);
  const origin = new URL(c.req.url).origin;
  const bot = await createBot(c.env, createDb(c.env.DB), origin);
  await bot.api.setWebhook(`${origin}/tg/webhook`, {
    secret_token: c.env.WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query"],
  });
  await bot.api.setChatMenuButton({
    menu_button: { type: "web_app", text: t("en", "bot.menuButton"), web_app: { url: `${origin}/` } },
  });
  return c.text("ok");
});

async function processUpdate(env: Env, origin: string, update: Update): Promise<void> {
  try {
    const db = createDb(env.DB);
    const now = Date.now();
    const retention = defaults.tgUpdateRetentionHours * 3_600_000;
    if (!(await claimUpdate(db, update.update_id, now, now - retention))) return;
    const bot = await createBot(env, db, origin);
    await bot.handleUpdate(update);
  } catch (error) {
    console.error("telegram update failed", error instanceof Error ? error.name : "unknown");
  }
}

import { Bot } from "grammy/web";
import { pickLanguage, t, type Language } from "../../i18n";
import { createLoginLink, registerByInvite } from "../core/auth";
import { items } from "../core/items";
import { defaults } from "../core/settings";
import type { Db } from "../db/client";
import { findUserByTelegramId } from "../db/users";
import type { Env } from "../env";
import { onCallback, onReply } from "./day";

let botInfo: Bot["botInfo"] | undefined;

export async function createBot(env: Env, db: Db, origin: string): Promise<Bot> {
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN, { botInfo });
  if (!botInfo) {
    await bot.init();
    botInfo = bot.botInfo;
  }
  const chat = bot.chatType("private");

  chat.command("start", async (ctx) => {
    const user =
      (await findUserByTelegramId(db, ctx.from.id)) ??
      (await registerByInvite(
        db,
        { telegramId: ctx.from.id, name: ctx.from.first_name, languageCode: ctx.from.language_code },
        ctx.match.trim(),
        env.OWNER_INVITE_CODE,
        Date.now(),
      ));
    await ctx.reply(
      user
        ? t(user.language as Language, "bot.start.welcome")
        : t(pickLanguage(ctx.from.language_code), "bot.start.private"),
    );
  });

  chat.command("web", async (ctx) => {
    const user = await findUserByTelegramId(db, ctx.from.id);
    if (!user) {
      await ctx.reply(t(pickLanguage(ctx.from.language_code), "bot.start.private"));
      return;
    }
    const token = await createLoginLink(db, user.id, Date.now());
    const text = t(user.language as Language, "bot.web.link", {
      count: defaults.loginLinkTtlMinutes,
    });
    await ctx.reply(`${text}\n${origin}/?login=${encodeURIComponent(token)}`);
  });

  chat.on("callback_query:data", async (ctx) => {
    // не менять порядок: «часики» на кнопке снимаются до чтений из базы
    await ctx.answerCallbackQuery().catch(() => undefined);
    const message = ctx.callbackQuery.message;
    const user = await findUserByTelegramId(db, ctx.from.id);
    if (!user || !message) return;
    const text = "text" in message && typeof message.text === "string" ? message.text : "";
    await onCallback({ api: ctx.api, db, user, url: origin }, message.message_id, text, ctx.callbackQuery.data);
  });

  chat.on("message:text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) return;
    const user = await findUserByTelegramId(db, ctx.from.id);
    if (!user) {
      await ctx.reply(t(pickLanguage(ctx.from.language_code), "bot.start.private"));
      return;
    }
    const replyTo = ctx.message.reply_to_message;
    if (replyTo?.from?.id === ctx.me.id) {
      const text = ctx.message.text.trim();
      if (await onReply({ api: ctx.api, db, user, url: origin }, replyTo.message_id, text)) {
        await ctx.react("👍");
        return;
      }
    }
    const { outcome } = await items.addInbox(db, user.id, ctx.message.text, "bot");
    if (outcome === "ok") await ctx.react("👍");
  });

  return bot;
}

import { Bot } from "grammy/web";
import { pickLanguage, t, type Language } from "../../i18n";
import { createLoginLink, registerByInvite } from "../core/auth";
import { items } from "../core/items";
import { defaults } from "../core/settings";
import type { Db } from "../db/client";
import { findUserByTelegramId } from "../db/users";
import type { Env } from "../env";

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

  chat.on("message:text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) return;
    const user = await findUserByTelegramId(db, ctx.from.id);
    if (!user) {
      await ctx.reply(t(pickLanguage(ctx.from.language_code), "bot.start.private"));
      return;
    }
    const { outcome } = await items.addInbox(db, user.id, ctx.message.text, "bot");
    if (outcome === "ok") await ctx.react("👍");
  });

  return bot;
}

import { InlineKeyboard, type Api } from "grammy/web";
import { t, type Language, type TextKey } from "../../i18n";
import type { TodayView } from "../core/day";
import { dropPrompts, savePrompt, setListMessage, type BotPrompt } from "../db/botPrompts";
import type { Db } from "../db/client";
import type { User } from "../db/users";

/**
 * Бот для одного пользователя: API Telegram, база, пользователь, адрес страницы (для ссылки входа)
 * и будильник таймера (окончание таймера `userId` в `at`).
 */
export type Tg = { api: Api; db: Db; user: User; url: string; alarm: (userId: string, at: number) => Promise<void> };

export const say = (user: User, key: TextKey, vars?: Record<string, string | number>) => t(user.language as Language, key, vars);
export const data = (...parts: (string | number)[]) => parts.join("|");

/** Вопрос, ответом на который считается ответ на это сообщение. */
export async function ask(tg: Tg, cardMessageId: number, prompt: Omit<BotPrompt, "userId" | "messageId" | "cardMessageId">, question: TextKey) {
  const sent = await tg.api.sendMessage(tg.user.telegramId, `${say(tg.user, question)}\n${say(tg.user, "bot.replyHint")}`, {
    reply_markup: { force_reply: true },
  });
  try {
    await savePrompt(tg.db, { ...prompt, userId: tg.user.id, messageId: sent.message_id, cardMessageId }, Date.now());
  } catch (error) {
    // вопрос не записан: он удаляется из чата
    await tg.api.deleteMessage(tg.user.telegramId, sent.message_id).catch(() => undefined);
    throw error;
  }
}

/** Убирает вопросы к карточке: по ним уже ответили кнопкой или пропустили. */
export async function clearPrompts(tg: Tg, cardMessageId: number) {
  for (const messageId of await dropPrompts(tg.db, tg.user.id, cardMessageId)) {
    await tg.api.deleteMessage(tg.user.telegramId, messageId).catch(() => undefined);
  }
}

/** Список на сегодня: старое сообщение удаляется, новое присылается последним в чате. */
export async function sendList(tg: Tg, view: TodayView): Promise<void> {
  const lines = [say(tg.user, "bot.list.title"), ""];
  if (view.list.length === 0) lines.push(say(tg.user, "bot.list.empty"));
  for (const task of view.list) lines.push(`${task.state === "done" ? "✓" : "•"} ${task.title}`);
  // «Сделано: название» и «Таймер» под списком — для каждой принятой несделанной задачи
  const keyboard = new InlineKeyboard();
  for (const task of view.list.filter((row) => row.state === "accepted")) {
    keyboard
      .text(say(tg.user, "bot.list.done", { title: task.title }), data("l", view.date, task.slot, task.position))
      .text(say(tg.user, "action.timer"), data("tm", view.date, task.slot, task.position))
      .row();
  }
  if (tg.user.listMessageId !== null) {
    await tg.api.deleteMessage(tg.user.telegramId, tg.user.listMessageId).catch(() => undefined);
  }
  const sent = await tg.api.sendMessage(tg.user.telegramId, lines.join("\n"), {
    reply_markup: keyboard.inline_keyboard.length > 0 ? keyboard : undefined,
  });
  await setListMessage(tg.db, tg.user.id, sent.message_id);
  tg.user.listMessageId = sent.message_id;
}

/** Сообщение без кнопок с отметкой выбранного ответа. */
export async function markAnswered(tg: Tg, messageId: number, text: string, label: TextKey) {
  await tg.api.editMessageText(tg.user.telegramId, messageId, `${text}\n\n✓ ${say(tg.user, label)}`, {
    reply_markup: { inline_keyboard: [] },
  }).catch(() => undefined);
}

/** Кнопка устарела (задачу удалили или изменили): кнопки снимаются, на сообщении «Это уже изменилось». */
export async function markStale(tg: Tg, messageId: number, text: string) {
  await tg.api.editMessageText(tg.user.telegramId, messageId, `${text}\n\n${say(tg.user, "bot.stale")}`, {
    reply_markup: { inline_keyboard: [] },
  }).catch(() => undefined);
}

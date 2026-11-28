import type { Db } from "./client";

/** Вопрос бота, ответом на который считается ответ на сообщение `messageId`; контекст — строка плана и карточка. */
export type BotPrompt = {
  userId: string;
  messageId: number;
  cardMessageId: number;
  kind: "reason" | "blocks" | "survey" | "return" | "park";
  date: string;
  slot: string;
  position: number;
  action: string | null;
};

export async function savePrompt(db: Db, prompt: BotPrompt, now: number): Promise<void> {
  await db.$client
    .prepare(
      `INSERT OR REPLACE INTO bot_prompts (user_id, message_id, card_message_id, kind, date, slot, position, action, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(prompt.userId, prompt.messageId, prompt.cardMessageId, prompt.kind, prompt.date, prompt.slot, prompt.position, prompt.action, now)
    .run();
}

/** Забирает вопрос, на сообщение которого ответили (первичный ключ), и удаляет его. */
export async function takePrompt(db: Db, userId: string, messageId: number): Promise<BotPrompt | undefined> {
  const row = await db.$client
    .prepare(
      `DELETE FROM bot_prompts WHERE user_id = ? AND message_id = ?
      RETURNING message_id, card_message_id, kind, date, slot, position, action`,
    )
    .bind(userId, messageId)
    .first<{ message_id: number; card_message_id: number; kind: BotPrompt["kind"]; date: string; slot: string; position: number; action: string | null }>();
  return row
    ? {
        userId,
        messageId: row.message_id,
        cardMessageId: row.card_message_id,
        kind: row.kind,
        date: row.date,
        slot: row.slot,
        position: row.position,
        action: row.action,
      }
    : undefined;
}

/** Удаляет вопросы к карточке `cardMessageId` (по ним пропустили или ответили кнопкой); возвращает их сообщения. */
export async function dropPrompts(db: Db, userId: string, cardMessageId: number): Promise<number[]> {
  const { results } = await db.$client
    .prepare("DELETE FROM bot_prompts WHERE user_id = ? AND card_message_id = ? RETURNING message_id")
    .bind(userId, cardMessageId)
    .all<{ message_id: number }>();
  return results.map((row) => row.message_id);
}

/** Сообщение со списком на сегодня, последнее в чате; первичный ключ users. */
export async function setListMessage(db: Db, userId: string, messageId: number): Promise<void> {
  await db.$client.prepare("UPDATE users SET list_message_id = ? WHERE id = ?").bind(messageId, userId).run();
}

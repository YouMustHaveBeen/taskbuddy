import type { Db } from "./client";

export type TimerKind = "task" | "zone" | "reward";
export type TimerPlace = "bot" | "web";

export type TimerRow = {
  kind: TimerKind;
  itemId: string;
  title: string;
  minutes: number;
  startedAt: number;
  pausedAt: number | null;
  remainingSec: number | null;
  endsAt: number | null;
  startedIn: TimerPlace;
  botMessageId: number | null;
};

type TimerRaw = {
  kind: TimerKind;
  item_id: string;
  title: string;
  minutes: number;
  started_at: number;
  paused_at: number | null;
  remaining_sec: number | null;
  ends_at: number | null;
  started_in: TimerPlace;
  bot_message_id: number | null;
};

/**
 * Таймер пользователя с названием задачи или награды; у задачи в архиве и удаленной награды таймера нет.
 * Первичные ключи timers, items и rewards.
 */
const timerSql = `SELECT t.kind, t.item_id, COALESCE(i.title, r.title) AS title, t.minutes, t.started_at, t.paused_at,
    t.remaining_sec, t.ends_at, t.started_in, t.bot_message_id
  FROM timers t
  LEFT JOIN items i ON t.kind = 'task' AND i.id = t.item_id AND i.owner_id = t.user_id AND i.archived_at IS NULL
  LEFT JOIN rewards r ON t.kind = 'reward' AND r.id = t.item_id AND r.user_id = t.user_id
  WHERE t.user_id = ? AND (i.id IS NOT NULL OR r.id IS NOT NULL)`;

function fromRaw(row: TimerRaw | undefined | null): TimerRow | undefined {
  if (!row) return undefined;
  return {
    kind: row.kind,
    itemId: row.item_id,
    title: row.title,
    minutes: row.minutes,
    startedAt: row.started_at,
    pausedAt: row.paused_at,
    remainingSec: row.remaining_sec,
    endsAt: row.ends_at,
    startedIn: row.started_in,
    botMessageId: row.bot_message_id,
  };
}

export async function loadTimer(db: Db, userId: string): Promise<TimerRow | undefined> {
  return fromRaw(await db.$client.prepare(timerSql).bind(userId).first<TimerRaw>());
}

export type TimerWrite = { changed: number; timer?: TimerRow };

/** Запись и чтение таймера одним batch; `changed` — сколько строк изменила запись. */
async function write(db: Db, userId: string, statement: D1PreparedStatement): Promise<TimerWrite> {
  const d1 = db.$client;
  const [written, read] = await d1.batch([statement, d1.prepare(timerSql).bind(userId)]);
  return { changed: written.meta.changes, timer: fromRaw((read.results as TimerRaw[])[0]) };
}

/**
 * Таймер не идет и не на паузе (остановлен, время вышло, даже если будильник еще не сработал), его задача уже
 * в архиве или награда удалена; ?5 — сейчас.
 */
const idle = `(timers.ends_at IS NULL AND timers.paused_at IS NULL) OR timers.ends_at <= ?5
  OR (timers.kind = 'task' AND NOT EXISTS (SELECT 1 FROM items WHERE items.id = timers.item_id AND items.archived_at IS NULL))
  OR (timers.kind = 'reward' AND NOT EXISTS (SELECT 1 FROM rewards WHERE rewards.id = timers.item_id))`;

/** Откуда берется запись таймера: задача своей владелицы не в архиве или награда пользователя. */
const sources: Record<"task" | "reward", string> = {
  task: "FROM items WHERE id = ?3 AND owner_id = ?1 AND archived_at IS NULL",
  reward: "FROM rewards WHERE id = ?3 AND user_id = ?1",
};

/** Запускает таймер задачи или награды `itemId` пользователя; идущий или стоящий на паузе таймер не заменяется. */
export function startTimer(
  db: Db,
  start: { userId: string; kind: "task" | "reward"; itemId: string; minutes: number; startedIn: TimerPlace; botMessageId: number | null },
  now: number,
): Promise<TimerWrite> {
  const { userId, kind, itemId, minutes, startedIn, botMessageId } = start;
  return write(
    db,
    userId,
    db.$client
      .prepare(
        `INSERT INTO timers (user_id, kind, item_id, minutes, started_at, paused_at, remaining_sec, ends_at, started_in, bot_message_id)
        SELECT ?1, ?2, ?3, ?4, ?5, NULL, NULL, ?6, ?7, ?8 ${sources[kind]}
        ON CONFLICT (user_id) DO UPDATE SET kind = excluded.kind, item_id = excluded.item_id, minutes = excluded.minutes,
          started_at = excluded.started_at, paused_at = NULL, remaining_sec = NULL, ends_at = excluded.ends_at,
          started_in = excluded.started_in, bot_message_id = excluded.bot_message_id
        WHERE ${idle}`,
      )
      .bind(userId, kind, itemId, minutes, now, now + minutes * 60_000, startedIn, botMessageId),
  );
}

/** «Пауза»: пока время не вышло, остаток в секундах (с округлением вверх) запоминается, время останавливается. */
export function pauseTimer(db: Db, userId: string, now: number): Promise<TimerWrite> {
  return write(
    db,
    userId,
    db.$client
      .prepare(
        `UPDATE timers SET paused_at = ?1, remaining_sec = MAX(0, CAST((ends_at - ?1 + 999) / 1000 AS INTEGER)), ends_at = NULL
        WHERE user_id = ?2 AND ends_at > ?1`,
      )
      .bind(now, userId),
  );
}

/** «Продолжить» после паузы: время идет дальше с того же остатка. */
export function resumeTimer(db: Db, userId: string, now: number): Promise<TimerWrite> {
  return write(
    db,
    userId,
    db.$client
      .prepare(
        `UPDATE timers SET ends_at = ?1 + remaining_sec * 1000, paused_at = NULL, remaining_sec = NULL
        WHERE user_id = ?2 AND paused_at IS NOT NULL`,
      )
      .bind(now, userId),
  );
}

/** «Стоп»: идущий или стоящий на паузе таймер останавливается. */
export function stopTimer(db: Db, userId: string): Promise<TimerWrite> {
  return write(
    db,
    userId,
    db.$client
      .prepare(
        `UPDATE timers SET ends_at = NULL, paused_at = NULL, remaining_sec = NULL
        WHERE user_id = ? AND (ends_at IS NOT NULL OR paused_at IS NOT NULL)`,
      )
      .bind(userId),
  );
}

/** Будильник: таймер с окончанием `endsAt` останавливается, его сообщение в боте — `messageId`; возвращает число изменений. */
export async function expireTimer(db: Db, userId: string, endsAt: number, messageId: number | null): Promise<number> {
  const result = await db.$client
    .prepare("UPDATE timers SET ends_at = NULL, bot_message_id = COALESCE(?, bot_message_id) WHERE user_id = ? AND ends_at = ?")
    .bind(messageId, userId, endsAt)
    .run();
  return result.meta.changes;
}

/** Сообщение бота, в котором показывается таймер записи `itemId`. */
export async function setTimerMessage(db: Db, userId: string, itemId: string, messageId: number | null): Promise<void> {
  await db.$client
    .prepare("UPDATE timers SET bot_message_id = ? WHERE user_id = ? AND item_id = ?")
    .bind(messageId, userId, itemId)
    .run();
}

/** Снимает таймер записи `itemId` (например, «Продолжить позже»). */
export async function dropTimer(db: Db, userId: string, itemId: string): Promise<number> {
  const result = await db.$client.prepare("DELETE FROM timers WHERE user_id = ? AND item_id = ?").bind(userId, itemId).run();
  return result.meta.changes;
}

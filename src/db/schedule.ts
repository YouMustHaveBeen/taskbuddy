import type { Db } from "./client";
import type { User } from "./users";

/** Отметки расписания в users: дата (по поясу пользователя), когда событие дня уже выполнено. */
export type MarkColumn = "survey_on" | "morning_on" | "reprompt_on" | "deadline_on" | "night_on";
const markColumns: readonly MarkColumn[] = ["survey_on", "morning_on", "reprompt_on", "deadline_on", "night_on"];

type UserRaw = {
  id: string;
  household_id: string;
  telegram_id: number;
  name: string;
  language: string;
  timezone: string;
  created_at: number;
  survey_on: string | null;
  morning_on: string | null;
  reprompt_on: string | null;
  deadline_on: string | null;
  night_on: string | null;
  list_message_id: number | null;
};

export type DueReminder = { id: string; remindAt: number; title: string; ownerId: string; send: boolean };

/**
 * Состояние для запуска расписания одним batch: все пользователи (таблица маленькая, полный просмотр) и напоминания,
 * время которых наступило (индекс tasks_remind_at по диапазону). Напоминания архивных записей и записей
 * не в задачах тоже читаются, чтобы их снять, но не отправляются.
 */
export async function loadScheduleState(db: Db, now: number): Promise<{ users: User[]; reminders: DueReminder[] }> {
  const d1 = db.$client;
  const [users, reminders] = await d1.batch([
    d1.prepare("SELECT * FROM users"),
    d1.prepare(
      `SELECT t.id, t.remind_at, i.title, i.owner_id, i.kind, i.archived_at
      FROM tasks t JOIN items i ON i.id = t.id
      WHERE t.remind_at <= ?`,
    ).bind(now),
  ]);
  return {
    users: (users.results as UserRaw[]).map((row) => ({
      id: row.id,
      householdId: row.household_id,
      telegramId: row.telegram_id,
      name: row.name,
      language: row.language,
      timezone: row.timezone,
      createdAt: row.created_at,
      surveyOn: row.survey_on,
      morningOn: row.morning_on,
      repromptOn: row.reprompt_on,
      deadlineOn: row.deadline_on,
      nightOn: row.night_on,
      listMessageId: row.list_message_id,
    })),
    reminders: (
      reminders.results as { id: string; remind_at: number; title: string; owner_id: string; kind: string; archived_at: number | null }[]
    ).map((row) => ({
      id: row.id,
      remindAt: row.remind_at,
      title: row.title,
      ownerId: row.owner_id,
      send: row.kind === "task" && row.archived_at === null,
    })),
  };
}

/**
 * Отмечает события дня выполненными одним batch. Отметка ставится, только если ее еще не было за эту дату,
 * поэтому событие берет ровно один запуск расписания или одно действие пользователя. Возвращает взятые отметки.
 */
export async function claimMarks(
  db: Db,
  claims: { userId: string; column: MarkColumn; date: string }[],
): Promise<{ userId: string; column: MarkColumn }[]> {
  if (claims.length === 0) return [];
  const d1 = db.$client;
  // QUERY BUDGET EXCEPTION: по одной отметке на событие — один batch
  const results = await d1.batch(
    claims.map((claim) => {
      if (!markColumns.includes(claim.column)) throw new Error("unknown mark column");
      return d1
        .prepare(`UPDATE users SET ${claim.column} = ? WHERE id = ? AND (${claim.column} IS NULL OR ${claim.column} < ?) RETURNING id`)
        .bind(claim.date, claim.userId, claim.date);
    }),
  );
  return claims.filter((_, index) => results[index].results.length > 0).map(({ userId, column }) => ({ userId, column }));
}

/** Снимает наступившие напоминания; возвращает id тех, что снял этот запуск. Задачи по первичному ключу. */
export async function claimReminders(db: Db, ids: string[], now: number): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const { results } = await db.$client
    .prepare(`UPDATE tasks SET remind_at = NULL WHERE remind_at <= ? AND id IN (${ids.map(() => "?").join(", ")}) RETURNING id`)
    .bind(now, ...ids)
    .all<{ id: string }>();
  return new Set(results.map((row) => row.id));
}

/** «Напомнить снова завтра»: новое время напоминания задачи владелицы. */
export async function setReminder(db: Db, userId: string, itemId: string, remindAt: number): Promise<boolean> {
  const result = await db.$client
    .prepare(
      `UPDATE tasks SET remind_at = ?
      WHERE id = (SELECT id FROM items WHERE id = ? AND owner_id = ? AND kind = 'task' AND archived_at IS NULL)`,
    )
    .bind(remindAt, itemId, userId)
    .run();
  return result.meta.changes > 0;
}

/** Названия задач владелицы с дедлайном в [from, to): индекс tasks_deadline по диапазону, задача по первичному ключу. */
export async function deadlinesBetween(db: Db, userId: string, from: number, to: number): Promise<string[]> {
  const { results } = await db.$client
    .prepare(
      `SELECT i.title FROM tasks t JOIN items i ON i.id = t.id
      WHERE t.deadline >= ? AND t.deadline < ? AND i.owner_id = ? AND i.kind = 'task' AND i.archived_at IS NULL
      ORDER BY t.deadline`,
    )
    .bind(from, to, userId)
    .all<{ title: string }>();
  return results.map((row) => row.title);
}

/**
 * Ночная очистка одним batch: планы дня раньше `planBefore` (первичный ключ day_plan по диапазону дат),
 * истекшие «отложено до» задач владелицы (индекс items_owner_kind) и вопросы бота старше `promptsBefore`.
 */
export async function nightCleanup(db: Db, userId: string, planBefore: string, promptsBefore: number, now: number): Promise<void> {
  const d1 = db.$client;
  // QUERY BUDGET EXCEPTION: три очистки — один batch раз в сутки
  await d1.batch([
    d1.prepare("DELETE FROM day_plan WHERE user_id = ? AND date < ?").bind(userId, planBefore),
    d1
      .prepare(
        `UPDATE tasks SET deferred = 0, deferred_until = NULL
        WHERE deferred = 1 AND deferred_until IS NOT NULL AND deferred_until <= ?
          AND id IN (SELECT id FROM items WHERE owner_id = ? AND kind = 'task' AND archived_at IS NULL)`,
      )
      .bind(now, userId),
    d1.prepare("DELETE FROM bot_prompts WHERE user_id = ? AND created_at < ?").bind(userId, promptsBefore),
  ]);
}

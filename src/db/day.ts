import type { Candidate, PlanPick, PlanSlot, TaskFlags } from "../core/day";
import type { Db } from "./client";

type Flags = { deferred: number; deferred_until: number | null; queued: number; waiting_for: string | null };

type CandidateRaw = Flags & {
  id: string;
  important: number | null;
  urgent: number | null;
  impactful: number | null;
  easy: number | null;
  flavor: "dopamine" | "frog" | null;
  deadline: number | null;
  last_shown_at: number | null;
};

const flag = (value: number | null): boolean | null => (value === null ? null : value !== 0);
const flags = (row: Flags): TaskFlags => ({
  deferred: row.deferred !== 0,
  deferredUntil: row.deferred_until,
  queued: row.queued !== 0,
  waitingFor: row.waiting_for,
});

/**
 * Задачи владелицы для плана дня: не проекты, не шаги проекта в фокусе или отложенного проекта; задачи на паузе
 * тоже (они идут только в блок дедлайнов). Индекс items_owner_kind (owner_id, kind, archived_at), задача и проект
 * по первичному ключу tasks.
 */
export async function planCandidates(db: Db, userId: string, now: number): Promise<(Omit<Candidate, "pause"> & TaskFlags)[]> {
  const { results } = await db.$client
    .prepare(
      `SELECT i.id, t.important, t.urgent, t.impactful, t.easy, t.flavor, t.deadline, t.last_shown_at,
        t.deferred, t.deferred_until, t.queued, t.waiting_for
      FROM items i
      JOIN tasks t ON t.id = i.id
      LEFT JOIN tasks p ON p.id = t.project_id
      WHERE i.owner_id = ?2 AND i.kind = 'task' AND i.archived_at IS NULL AND i.assign_state IN ('none', 'accepted')
        AND t.is_project = 0
        AND (p.id IS NULL OR (p.in_focus = 0 AND NOT (p.deferred = 1 AND (p.deferred_until IS NULL OR p.deferred_until > ?1))))`,
    )
    .bind(now, userId)
    .all<CandidateRaw>();
  return results.map((row) => ({
    id: row.id,
    important: flag(row.important),
    urgent: flag(row.urgent),
    impactful: flag(row.impactful),
    easy: flag(row.easy),
    flavor: row.flavor,
    deadline: row.deadline,
    lastShownAt: row.last_shown_at,
    ...flags(row),
  }));
}

export type PlanState = "offered" | "accepted" | "refused" | "done" | "returned" | "closed" | "tomorrow" | "dropped";

export type PlanRow = TaskFlags & {
  date: string;
  slot: PlanSlot;
  position: number;
  itemId: string;
  state: PlanState;
  hidden: boolean;
  replacements: number;
  title: string;
  important: boolean | null;
  urgent: boolean | null;
  impactful: boolean | null;
  easy: boolean | null;
  why: string | null;
  flavor: "dopamine" | "frog" | null;
  firstStepText: string | null;
  /** У задачи есть голосовой первый шаг (записан в боте). */
  hasVoice: boolean;
  deadline: number | null;
  /** Дата последней неудачи задачи (отказ, «На завтра», «В хранилище»). */
  lastFailOn: string | null;
  /** Задача уже в архиве (например, отмечена выполненной на вкладке «Задачи»). */
  archived: boolean;
};

type PlanRaw = Flags & {
  date: string;
  slot: PlanSlot;
  position: number;
  item_id: string;
  state: PlanState;
  hidden: number;
  replacements: number;
  title: string;
  important: number | null;
  urgent: number | null;
  impactful: number | null;
  easy: number | null;
  why: string | null;
  flavor: "dopamine" | "frog" | null;
  first_step_text: string | null;
  has_voice: number | null;
  deadline: number | null;
  last_fail_on: string | null;
  archived_at: number | null;
};

/**
 * План дня с названиями и метками задач и принятые несделанные задачи прошлых дней (вечерний опрос по ним не пройден).
 * Первичный ключ day_plan (user_id, date, …) по диапазону дат; задача по первичному ключу.
 */
const planSql = `SELECT d.date, d.slot, d.position, d.item_id, d.state, d.hidden, d.replacements, i.title,
    t.important, t.urgent, t.impactful, t.easy, t.why, t.flavor, t.first_step_text, t.first_step_voice_id IS NOT NULL AS has_voice, t.deadline,
    t.deferred, t.deferred_until, t.queued, t.waiting_for, t.last_fail_on, i.archived_at
  FROM day_plan d
  JOIN items i ON i.id = d.item_id
  LEFT JOIN tasks t ON t.id = d.item_id
  WHERE d.user_id = ?1 AND d.date <= ?2 AND (d.date = ?2 OR (d.state = 'accepted' AND i.archived_at IS NULL))
  ORDER BY d.date, d.slot, d.position`;

function planFromRaw(rows: PlanRaw[]): PlanRow[] {
  return rows.map((row) => ({
    date: row.date,
    slot: row.slot,
    position: row.position,
    itemId: row.item_id,
    state: row.state,
    hidden: row.hidden !== 0,
    replacements: row.replacements,
    title: row.title,
    important: flag(row.important),
    urgent: flag(row.urgent),
    impactful: flag(row.impactful),
    easy: flag(row.easy),
    why: row.why,
    flavor: row.flavor,
    firstStepText: row.first_step_text,
    hasVoice: row.has_voice === 1,
    deadline: row.deadline,
    lastFailOn: row.last_fail_on,
    archived: row.archived_at !== null,
    ...flags(row),
  }));
}

/** Награда пользователя из «Справочников»; `position` — место в списке на сегодня, на которое она выбрана (или null). */
export type DayReward = { id: string; title: string; minutes: number; position: number | null };

/**
 * Награды пользователя (индекс rewards_user) и места в списке на дату, на которые они выбраны (первичный ключ
 * day_rewards по user_id и date). Награда, выбранная на несколько мест, приходит несколько раз.
 */
const rewardsSql = `SELECT r.id, r.title, r.minutes, d.position
  FROM rewards r
  LEFT JOIN day_rewards d ON d.user_id = r.user_id AND d.date = ?2 AND d.reward_id = r.id
  WHERE r.user_id = ?1`;

/** План дня (см. planSql) и награды пользователя с местами в списке на сегодня. */
export type DayData = { plan: PlanRow[]; rewards: DayReward[] };

const read = (d1: D1Database, userId: string, date: string) => [
  d1.prepare(planSql).bind(userId, date),
  d1.prepare(rewardsSql).bind(userId, date),
];

function fromResults(results: D1Result[]): DayData {
  const [plan, rewards] = results.slice(-2);
  return { plan: planFromRaw(plan.results as PlanRaw[]), rewards: rewards.results as DayReward[] };
}

export async function loadPlan(db: Db, userId: string, date: string): Promise<DayData> {
  return fromResults(await db.$client.batch(read(db.$client, userId, date)));
}

/** Выбирает награду `rewardId` своей владелицы на место `position` списка на сегодня, если место еще свободно; читает награды заново. */
export async function saveDayReward(db: Db, userId: string, date: string, position: number, rewardId: string, now: number): Promise<DayReward[]> {
  const d1 = db.$client;
  const [, rewards] = await d1.batch([
    d1
      .prepare(
        `INSERT OR IGNORE INTO day_rewards (user_id, date, position, reward_id, created_at)
        SELECT ?1, ?2, ?3, id, ?5 FROM rewards WHERE id = ?4 AND user_id = ?1`,
      )
      .bind(userId, date, position, rewardId, now),
    d1.prepare(rewardsSql).bind(userId, date),
  ]);
  return rewards.results as DayReward[];
}

/** Голосовой первый шаг задачи своей владелицы (file_id Telegram); первичные ключи tasks и items. */
export async function firstStepVoice(db: Db, userId: string, itemId: string): Promise<string | undefined> {
  const row = await db.$client
    .prepare("SELECT t.first_step_voice_id FROM tasks t JOIN items i ON i.id = t.id WHERE t.id = ? AND i.owner_id = ?")
    .bind(itemId, userId)
    .first<{ first_step_voice_id: string | null }>();
  return row?.first_step_voice_id ?? undefined;
}

/** Записывает (или заменяет) голосовой первый шаг задачи своей владелицы; возвращает, записан ли он. */
export async function setFirstStepVoice(db: Db, userId: string, itemId: string, fileId: string): Promise<boolean> {
  const result = await db.$client
    .prepare(
      `UPDATE tasks SET first_step_voice_id = ?
      WHERE id = ? AND id IN (SELECT id FROM items WHERE id = ? AND owner_id = ? AND archived_at IS NULL)`,
    )
    .bind(fileId, itemId, itemId, userId)
    .run();
  return result.meta.changes > 0;
}

const buttonSlotNames = ["important", "urgent", "impactful", "easy"];

/**
 * Записывает план дня и читает его в том же batch. Если план на эту дату уже записан другим запросом,
 * INSERT OR IGNORE оставляет первый, и читается он. Строки кнопок скрыты, пока пользователь не нажал кнопку.
 */
export async function savePlan(db: Db, userId: string, date: string, picks: PlanPick[], now: number): Promise<DayData> {
  const d1 = db.$client;
  // QUERY BUDGET EXCEPTION: по одной вставке на строку плана (дедлайны и четыре кнопки), чтение плана и наград — один batch
  const results = await d1.batch([
    ...picks.map((pick) =>
      d1
        .prepare(
          "INSERT OR IGNORE INTO day_plan (user_id, date, slot, position, item_id, hidden, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(userId, date, pick.slot, pick.position, pick.itemId, buttonSlotNames.includes(pick.slot) ? 1 : 0, now),
    ),
    ...read(d1, userId, date),
  ]);
  return fromResults(results);
}

/** Строка плана: user_id, date, slot, position. */
export type PlanKey = { userId: string; date: string; slot: PlanSlot; position: number };
const keyWhere = "user_id = ? AND date = ? AND slot = ? AND position = ?";
const keyArgs = (key: PlanKey) => [key.userId, key.date, key.slot, key.position];

export type PlanWrite = DayData & { changed: number };

/**
 * Выполняет записи одним batch и читает план. `changed` — число строк, измененных записью-проверкой с номером
 * `guard` (по умолчанию первой): она проверяет, что строка плана была в ожидаемом состоянии. Записи после нее
 * цепляются за нее через changes(), записи до нее проверяют то же состояние сами; если проверка ничего
 * не изменила (повторное нажатие, параллельный запрос), не выполняется ничего.
 */
async function write(
  db: Db,
  key: Pick<PlanKey, "userId" | "date">,
  statements: D1PreparedStatement[],
  guard = 0,
  timerOf?: PlanKey,
): Promise<PlanWrite> {
  // QUERY BUDGET EXCEPTION: записи действия, чтение плана и наград — один batch
  const d1 = db.$client;
  const drop = timerOf ? [dropTimerStatement(db, timerOf)] : [];
  const results = await d1.batch([...statements, ...drop, ...read(d1, key.userId, key.date)]);
  return { changed: results[guard].meta.changes, ...fromResults(results) };
}

/** Снимает таймер задачи строки плана, если строка больше не ждет работы (выполнена, возвращена, закрыта, ответ опроса). */
function dropTimerStatement(db: Db, key: PlanKey): D1PreparedStatement {
  return db.$client
    .prepare(
      `DELETE FROM timers WHERE user_id = ? AND kind = 'task'
        AND item_id IN (SELECT item_id FROM day_plan WHERE ${keyWhere} AND state NOT IN ('offered', 'accepted'))`,
    )
    .bind(key.userId, ...keyArgs(key));
}

const states = (list: PlanState[]) => `(${list.map((state) => `'${state}'`).join(", ")})`;
const itemOfRow = `(SELECT item_id FROM day_plan WHERE ${keyWhere})`;

/** Показывает задачу за кнопкой: снимает «скрыто» и записывает время показа. */
export function revealRow(db: Db, key: PlanKey, now: number): Promise<PlanWrite> {
  const d1 = db.$client;
  return write(db, key, [
    d1.prepare(`UPDATE day_plan SET hidden = 0 WHERE ${keyWhere} AND hidden = 1`).bind(...keyArgs(key)),
    d1.prepare(`UPDATE tasks SET last_shown_at = ? WHERE changes() > 0 AND id = ${itemOfRow}`).bind(now, ...keyArgs(key)),
  ]);
}

export function setRowState(db: Db, key: PlanKey, from: PlanState[], to: PlanState): Promise<PlanWrite> {
  return write(
    db,
    key,
    [db.$client.prepare(`UPDATE day_plan SET state = ? WHERE ${keyWhere} AND state IN ${states(from)}`).bind(to, ...keyArgs(key))],
    0,
    key,
  );
}

/** «Сделано»: строка плана в «выполнено» и задача в архив как выполненная. */
export function completeRow(db: Db, key: PlanKey, from: PlanState[], now: number): Promise<PlanWrite> {
  const d1 = db.$client;
  return write(db, key, [
    d1.prepare(`UPDATE day_plan SET state = 'done' WHERE ${keyWhere} AND state IN ${states(from)}`).bind(...keyArgs(key)),
    d1
      .prepare(
        `UPDATE items SET archived_at = ?, archive_reason = 'done', updated_at = ?
        WHERE changes() > 0 AND owner_id = ? AND archived_at IS NULL AND id = ${itemOfRow}`,
      )
      .bind(now, now, key.userId, ...keyArgs(key)),
  ], 0, key);
}

/** Причина отказа записывается в карточку задачи, от которой отказались. */
export function saveRefusalNote(db: Db, key: PlanKey, note: string): Promise<PlanWrite> {
  return write(db, key, [
    db.$client
      .prepare(`UPDATE tasks SET refusal_note = ? WHERE id = (SELECT item_id FROM day_plan WHERE ${keyWhere} AND state = 'refused')`)
      .bind(note, ...keyArgs(key)),
  ]);
}

/** Следующая строка слота (позиция + 1) с задачей `itemId`; создается, только если прежняя строка в одном из `from`. */
function nextRowStatements(db: Db, key: PlanKey, itemId: string, from: PlanState[], bump: number, now: number) {
  const d1 = db.$client;
  return [
    d1
      .prepare(
        `INSERT OR IGNORE INTO day_plan (user_id, date, slot, position, item_id, state, replacements, hidden, created_at)
        SELECT user_id, date, slot, position + 1, ?, 'offered', replacements + ?, 0, ?
        FROM day_plan WHERE ${keyWhere} AND state IN ${states(from)}`,
      )
      .bind(itemId, bump, now, ...keyArgs(key)),
    d1.prepare("UPDATE tasks SET last_shown_at = ? WHERE changes() > 0 AND id = ?").bind(now, itemId),
  ];
}

/** «Обновить» и «Дофамин»: новая строка слота после выполненной (или закрытой дофаминовой). */
export function addNextRow(db: Db, key: PlanKey, itemId: string, now: number): Promise<PlanWrite> {
  return write(db, key, nextRowStatements(db, key, itemId, ["done", "closed"], 0, now));
}

/** Задача «Подумай, почему откладываешь», которая добавляется, когда задача становится лягушкой. */
export type ThinkTask = { id: string; title: string; date: string };

/**
 * Неудача задачи (отказ, «На завтра», «В хранилище»): счетчик неудач растет на 1, но не чаще раза в день `date`.
 * Если счетчик дошел до порога, задача без отметки становится лягушкой, и в план дня `think.date` добавляется
 * новая задача `think`. Все записи выполняются, только если верно условие `pending` (строка плана еще ждет ответа).
 */
function failStatements(
  db: Db,
  userId: string,
  itemId: string,
  date: string,
  pending: { sql: string; args: unknown[] },
  frogAt: number,
  think: ThinkTask,
  now: number,
): D1PreparedStatement[] {
  const d1 = db.$client;
  return [
    d1
      .prepare(
        `UPDATE tasks SET skip_count = skip_count + 1, last_fail_on = ?
        WHERE id = ? AND (last_fail_on IS NULL OR last_fail_on <> ?) AND ${pending.sql}`,
      )
      .bind(date, itemId, date, ...pending.args),
    // не менять порядок: каждая следующая запись выполняется, только если предыдущая что-то изменила
    d1
      .prepare("UPDATE tasks SET flavor = 'frog', frog_auto = 1 WHERE changes() > 0 AND id = ? AND flavor IS NULL AND skip_count >= ?")
      .bind(itemId, frogAt),
    d1
      .prepare(
        `INSERT INTO items (id, kind, title, owner_id, creator_id, household_id, source, created_at, updated_at)
        SELECT ?, 'task', ?, owner_id, owner_id, household_id, 'bot', ?, ? FROM items WHERE changes() > 0 AND id = ?`,
      )
      .bind(think.id, think.title, now, now, itemId),
    d1.prepare("INSERT INTO tasks (id) SELECT ? WHERE changes() > 0").bind(think.id),
    d1
      .prepare(
        `INSERT OR IGNORE INTO day_plan (user_id, date, slot, position, item_id, state, hidden, created_at)
        SELECT ?1, ?2, 'think',
          (SELECT COALESCE(MAX(position) + 1, 0) FROM day_plan WHERE user_id = ?1 AND date = ?2 AND slot = 'think'),
          ?3, 'accepted', 0, ?4
        WHERE changes() > 0`,
      )
      .bind(userId, think.date, think.id, now),
  ];
}

function insightStatement(db: Db, userId: string, insight: { id: string; text: string }, pending: { sql: string; args: unknown[] }) {
  return db.$client
    .prepare(`INSERT INTO insights (id, user_id, text) SELECT ?, ?, ? WHERE ${pending.sql}`)
    .bind(insight.id, userId, insight.text, ...pending.args);
}

/**
 * Завершает отказ: неудача задачи (см. failStatements), ответ «Что мешает?» (если есть) идет в инсайты, а слот
 * получает замену `replacement` или закрывается, если замены нет. Отказ ждет завершения, пока строка в «отказе»
 * и следующей строки слота еще нет.
 */
export function finishRefusal(
  db: Db,
  key: PlanKey,
  itemId: string,
  replacement: string | undefined,
  insight: { id: string; text: string } | undefined,
  frog: { at: number; think: ThinkTask },
  now: number,
): Promise<PlanWrite> {
  const d1 = db.$client;
  const pending = {
    sql: `EXISTS (SELECT 1 FROM day_plan r WHERE r.user_id = ? AND r.date = ? AND r.slot = ? AND r.position = ? AND r.state = 'refused'
      AND NOT EXISTS (SELECT 1 FROM day_plan n WHERE n.user_id = r.user_id AND n.date = r.date AND n.slot = r.slot AND n.position = r.position + 1))`,
    args: keyArgs(key),
  };
  const statements = failStatements(db, key.userId, itemId, key.date, pending, frog.at, frog.think, now);
  if (insight) statements.push(insightStatement(db, key.userId, insight, pending));
  const guard = statements.length;
  if (replacement) statements.push(...nextRowStatements(db, key, replacement, ["refused"], 1, now));
  else statements.push(d1.prepare(`UPDATE day_plan SET state = 'closed' WHERE ${keyWhere} AND state = 'refused'`).bind(...keyArgs(key)));
  return write(db, key, statements, guard);
}

export type SurveyAnswer = "tomorrow" | "back" | "drop";
const surveyStates: Record<SurveyAnswer, PlanState> = { tomorrow: "tomorrow", back: "returned", drop: "dropped" };

/**
 * Ответ вечернего опроса по принятой несделанной строке плана `key` (любого дня до `today` включительно).
 * «На завтра»: задача принятой ставится в план дня `target`, если ее там еще нет, и это неудача. «В хранилище»:
 * неудача. «Удалить»: задача в архив как неактуальная. Строка плана получает состояние ответа; план читается на `today`.
 */
export function answerSurvey(
  db: Db,
  key: PlanKey,
  itemId: string,
  answer: SurveyAnswer,
  today: string,
  target: string,
  insight: { id: string; text: string } | undefined,
  frog: { at: number; think: ThinkTask },
  now: number,
): Promise<PlanWrite> {
  const d1 = db.$client;
  const pending = {
    sql: `EXISTS (SELECT 1 FROM day_plan d JOIN items i ON i.id = d.item_id
      WHERE d.user_id = ? AND d.date = ? AND d.slot = ? AND d.position = ? AND d.state = 'accepted' AND i.archived_at IS NULL)`,
    args: keyArgs(key),
  };
  const statements: D1PreparedStatement[] = [];
  if (answer === "drop") {
    statements.push(
      d1
        .prepare(
          `UPDATE items SET archived_at = ?, archive_reason = 'irrelevant', updated_at = ?
          WHERE id = ? AND owner_id = ? AND archived_at IS NULL AND ${pending.sql}`,
        )
        .bind(now, now, itemId, key.userId, ...pending.args),
    );
  } else {
    if (answer === "tomorrow") {
      statements.push(
        d1
        .prepare(
          `INSERT OR IGNORE INTO day_plan (user_id, date, slot, position, item_id, state, hidden, created_at)
          SELECT ?, ?, 'picked',
            (SELECT COALESCE(MAX(p.position) + 1, 0) FROM day_plan p WHERE p.user_id = ? AND p.date = ? AND p.slot = 'picked'),
            ?, 'accepted', 0, ?
          WHERE NOT EXISTS (SELECT 1 FROM day_plan e WHERE e.user_id = ? AND e.date = ? AND e.item_id = ?) AND ${pending.sql}`,
        )
        .bind(key.userId, target, key.userId, target, itemId, now, key.userId, target, itemId, ...pending.args),
      );
    }
    statements.push(...failStatements(db, key.userId, itemId, key.date, pending, frog.at, frog.think, now));
    if (insight) statements.push(insightStatement(db, key.userId, insight, pending));
  }
  const guard = statements.length;
  statements.push(
    d1
      .prepare(`UPDATE day_plan SET state = ? WHERE ${keyWhere} AND state = 'accepted'`)
      .bind(surveyStates[answer], ...keyArgs(key)),
  );
  return write(db, { userId: key.userId, date: today }, statements, guard, key);
}

/**
 * «Вернуть» после таймера: задача из строки плана уходит в хранилище, и это неудача (см. failStatements);
 * ответ «Что мешает?» (если есть) идет в инсайты, а слот кнопки получает замену `replacement`. Строка ждет
 * ответа, пока она в одном из `from`.
 */
export function returnRow(
  db: Db,
  key: PlanKey,
  itemId: string,
  from: PlanState[],
  replacement: string | undefined,
  insight: { id: string; text: string } | undefined,
  frog: { at: number; think: ThinkTask },
  now: number,
): Promise<PlanWrite> {
  const d1 = db.$client;
  const pending = {
    sql: `EXISTS (SELECT 1 FROM day_plan r WHERE r.user_id = ? AND r.date = ? AND r.slot = ? AND r.position = ? AND r.state IN ${states(from)})`,
    args: keyArgs(key),
  };
  const statements = failStatements(db, key.userId, itemId, key.date, pending, frog.at, frog.think, now);
  if (insight) statements.push(insightStatement(db, key.userId, insight, pending));
  const guard = statements.length;
  statements.push(d1.prepare(`UPDATE day_plan SET state = 'returned' WHERE ${keyWhere} AND state IN ${states(from)}`).bind(...keyArgs(key)));
  if (replacement) statements.push(...nextRowStatements(db, key, replacement, ["returned"], 1, now));
  return write(db, key, statements, guard, key);
}

/** «Выбрать»: выбранная вручную задача сразу принята; задача, которая сегодня уже в плане (в любом состоянии), не вставляется (индекс day_plan_item). */
export function addPickedRow(db: Db, userId: string, date: string, itemId: string, now: number): Promise<PlanWrite> {
  const d1 = db.$client;
  return write(db, { userId, date }, [
    d1
      .prepare(
        `INSERT OR IGNORE INTO day_plan (user_id, date, slot, position, item_id, state, hidden, created_at)
        SELECT ?1, ?2, 'picked',
          (SELECT COALESCE(MAX(position) + 1, 0) FROM day_plan WHERE user_id = ?1 AND date = ?2 AND slot = 'picked'),
          i.id, 'accepted', 0, ?3
        FROM items i JOIN tasks t ON t.id = i.id
        WHERE i.id = ?4 AND i.owner_id = ?1 AND i.kind = 'task' AND i.archived_at IS NULL AND t.is_project = 0
          AND NOT EXISTS (SELECT 1 FROM day_plan WHERE item_id = ?4 AND user_id = ?1 AND date = ?2)`,
      )
      .bind(userId, date, now, itemId),
    d1.prepare("UPDATE tasks SET last_shown_at = ? WHERE changes() > 0 AND id = ?").bind(now, itemId),
  ]);
}

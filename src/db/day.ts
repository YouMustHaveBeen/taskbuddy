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

export type PlanState = "offered" | "accepted" | "refused" | "done" | "returned" | "closed";

export type PlanRow = TaskFlags & {
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
  deadline: number | null;
};

type PlanRaw = Flags & {
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
  deadline: number | null;
};

/** План дня с названиями и метками задач; первичный ключ day_plan (user_id, date, …), задача по первичному ключу. */
const planSql = `SELECT d.slot, d.position, d.item_id, d.state, d.hidden, d.replacements, i.title,
    t.important, t.urgent, t.impactful, t.easy, t.why, t.flavor, t.first_step_text, t.deadline,
    t.deferred, t.deferred_until, t.queued, t.waiting_for
  FROM day_plan d
  JOIN items i ON i.id = d.item_id
  LEFT JOIN tasks t ON t.id = d.item_id
  WHERE d.user_id = ? AND d.date = ?
  ORDER BY d.slot, d.position`;

function planFromRaw(rows: PlanRaw[]): PlanRow[] {
  return rows.map((row) => ({
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
    deadline: row.deadline,
    ...flags(row),
  }));
}

export async function loadPlan(db: Db, userId: string, date: string): Promise<PlanRow[]> {
  const { results } = await db.$client.prepare(planSql).bind(userId, date).all<PlanRaw>();
  return planFromRaw(results);
}

const buttonSlotNames = ["important", "urgent", "impactful", "easy"];

/**
 * Записывает план дня и читает его в том же batch. Если план на эту дату уже записан другим запросом,
 * INSERT OR IGNORE оставляет первый, и читается он. Строки кнопок скрыты, пока пользователь не нажал кнопку.
 */
export async function savePlan(db: Db, userId: string, date: string, picks: PlanPick[], now: number): Promise<PlanRow[]> {
  const d1 = db.$client;
  // QUERY BUDGET EXCEPTION: по одной вставке на строку плана (дедлайны и четыре кнопки) и чтение плана — один batch
  const results = await d1.batch([
    ...picks.map((pick) =>
      d1
        .prepare(
          "INSERT OR IGNORE INTO day_plan (user_id, date, slot, position, item_id, hidden, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(userId, date, pick.slot, pick.position, pick.itemId, buttonSlotNames.includes(pick.slot) ? 1 : 0, now),
    ),
    d1.prepare(planSql).bind(userId, date),
  ]);
  return planFromRaw(results[results.length - 1].results as PlanRaw[]);
}

/** Строка плана: user_id, date, slot, position. */
export type PlanKey = { userId: string; date: string; slot: PlanSlot; position: number };
const keyWhere = "user_id = ? AND date = ? AND slot = ? AND position = ?";
const keyArgs = (key: PlanKey) => [key.userId, key.date, key.slot, key.position];

export type PlanWrite = { changed: number; plan: PlanRow[] };

/**
 * Выполняет записи одним batch и читает план. `changed` — число строк, измененных первой записью: она
 * проверяет, что строка плана была в ожидаемом состоянии; остальные записи цепляются за нее через changes()
 * и не выполняются, если первая ничего не изменила (повторное нажатие, параллельный запрос).
 */
async function write(db: Db, key: Pick<PlanKey, "userId" | "date">, statements: D1PreparedStatement[]): Promise<PlanWrite> {
  // QUERY BUDGET EXCEPTION: записи действия и чтение плана — один batch
  const d1 = db.$client;
  const results = await d1.batch([...statements, d1.prepare(planSql).bind(key.userId, key.date)]);
  return {
    changed: results[0].meta.changes,
    plan: planFromRaw(results[results.length - 1].results as PlanRaw[]),
  };
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
  return write(db, key, [
    db.$client.prepare(`UPDATE day_plan SET state = ? WHERE ${keyWhere} AND state IN ${states(from)}`).bind(to, ...keyArgs(key)),
  ]);
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
  ]);
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

/**
 * Завершает отказ: счетчик отказов задачи растет на 1, ответ «Что мешает?» (если есть) идет в инсайты, а слот
 * получает замену `itemId` или закрывается, если замены нет.
 */
export function finishRefusal(
  db: Db,
  key: PlanKey,
  replacement: string | undefined,
  insight: { id: string; text: string } | undefined,
  now: number,
): Promise<PlanWrite> {
  const d1 = db.$client;
  const statements = replacement
    ? nextRowStatements(db, key, replacement, ["refused"], 1, now)
    : [d1.prepare(`UPDATE day_plan SET state = 'closed' WHERE ${keyWhere} AND state = 'refused'`).bind(...keyArgs(key))];
  // changes() после предыдущей записи: 1, только если отказ действительно завершен этим запросом
  statements.push(
    d1.prepare(`UPDATE tasks SET skip_count = skip_count + 1 WHERE changes() > 0 AND id = ${itemOfRow}`).bind(...keyArgs(key)),
  );
  if (insight) {
    statements.push(
      d1.prepare("INSERT INTO insights (id, user_id, text) SELECT ?, ?, ? WHERE changes() > 0").bind(insight.id, key.userId, insight.text),
    );
  }
  return write(db, key, statements);
}

/** «Выбрать»: выбранная вручную задача сразу принята; одна и та же задача два раза за день в плане не бывает. */
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
        WHERE i.id = ?4 AND i.owner_id = ?1 AND i.kind = 'task' AND i.archived_at IS NULL AND t.is_project = 0`,
      )
      .bind(userId, date, now, itemId),
    d1.prepare("UPDATE tasks SET last_shown_at = ? WHERE changes() > 0 AND id = ?").bind(now, itemId),
  ]);
}

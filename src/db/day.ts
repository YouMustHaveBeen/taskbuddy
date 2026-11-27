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

export type PlanRow = TaskFlags & {
  slot: PlanSlot;
  position: number;
  itemId: string;
  state: "offered" | "accepted" | "refused" | "done" | "returned";
  replacements: number;
  title: string;
  important: boolean | null;
  urgent: boolean | null;
  impactful: boolean | null;
  easy: boolean | null;
  deadline: number | null;
};

type PlanRaw = Flags & {
  slot: PlanSlot;
  position: number;
  item_id: string;
  state: PlanRow["state"];
  replacements: number;
  title: string;
  important: number | null;
  urgent: number | null;
  impactful: number | null;
  easy: number | null;
  deadline: number | null;
};

/** План дня с названиями и метками задач; первичный ключ day_plan (user_id, date, …), задача по первичному ключу. */
const planSql = `SELECT d.slot, d.position, d.item_id, d.state, d.replacements, i.title,
    t.important, t.urgent, t.impactful, t.easy, t.deadline, t.deferred, t.deferred_until, t.queued, t.waiting_for
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
    replacements: row.replacements,
    title: row.title,
    important: flag(row.important),
    urgent: flag(row.urgent),
    impactful: flag(row.impactful),
    easy: flag(row.easy),
    deadline: row.deadline,
    ...flags(row),
  }));
}

export async function loadPlan(db: Db, userId: string, date: string): Promise<PlanRow[]> {
  const { results } = await db.$client.prepare(planSql).bind(userId, date).all<PlanRaw>();
  return planFromRaw(results);
}

/**
 * Записывает план дня и читает его в том же batch. Если план на эту дату уже записан другим запросом,
 * INSERT OR IGNORE оставляет первый, и читается он.
 */
export async function savePlan(db: Db, userId: string, date: string, picks: PlanPick[], now: number): Promise<PlanRow[]> {
  const d1 = db.$client;
  // QUERY BUDGET EXCEPTION: по одной вставке на строку плана (дедлайны и четыре кнопки) и чтение плана — один batch
  const results = await d1.batch([
    ...picks.map((pick) =>
      d1
        .prepare(
          "INSERT OR IGNORE INTO day_plan (user_id, date, slot, position, item_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(userId, date, pick.slot, pick.position, pick.itemId, now),
    ),
    d1.prepare(planSql).bind(userId, date),
  ]);
  return planFromRaw(results[results.length - 1].results as PlanRaw[]);
}

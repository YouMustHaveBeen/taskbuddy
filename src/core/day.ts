import { formatInTimeZone } from "date-fns-tz";
import type { Db } from "../db/client";
import { loadPlan, planCandidates, savePlan, type PlanRow } from "../db/day";
import { defaults } from "./settings";

export type Marks = { important: boolean | null; urgent: boolean | null; impactful: boolean | null; easy: boolean | null };
export type PriorityLevel = "top" | "high" | "medium" | "low" | "none";

/** Сумма баллов четырех меток; пустая метка считается «нет». */
export function priority(marks: Marks): number {
  const w = defaults.priorityWeights;
  return (
    (marks.important ? w.important : 0) +
    (marks.impactful ? w.impactful : 0) +
    (marks.urgent ? w.urgent : 0) +
    (marks.easy ? w.easy : 0)
  );
}

export function priorityLevel(points: number): PriorityLevel {
  const l = defaults.priorityLevels;
  if (points >= l.top) return "top";
  if (points >= l.high) return "high";
  if (points >= l.medium) return "medium";
  if (points >= l.low) return "low";
  return "none";
}

/** Дата «ГГГГ-ММ-ДД» в часовом поясе пользователя. */
export function localDate(ms: number, timezone: string): string {
  return formatInTimeZone(ms, timezone, "yyyy-MM-dd");
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export type TaskFlags = {
  deferred: boolean;
  deferredUntil: number | null;
  queued: boolean;
  waitingFor: string | null;
};

export type Pause = "deferred" | "queued" | "waiting";

/** Причина паузы: отложено (без даты или дата еще не наступила), в очереди, жду; null — можно делать сейчас. */
export function pauseReason(task: TaskFlags, now: number): Pause | null {
  if (task.deferred && (task.deferredUntil === null || task.deferredUntil > now)) return "deferred";
  if (task.queued) return "queued";
  if (task.waitingFor !== null) return "waiting";
  return null;
}

/** Статус задачи: можно делать сейчас или пауза (отложено, очередь, жду). */
export function taskStatus(task: TaskFlags, now: number): "now" | "paused" {
  return pauseReason(task, now) === null ? "now" : "paused";
}

export type Candidate = Marks & {
  id: string;
  /** Причина паузы на момент составления плана; за кнопки идут только задачи без паузы. */
  pause: Pause | null;
  flavor: "dopamine" | "frog" | null;
  deadline: number | null;
  lastShownAt: number | null;
};

/** Порядок по приоритету: больше баллов; при равенстве сначала с важностью или эффектом, затем дольше не показанная. */
export function byPriority(a: Candidate, b: Candidate): number {
  const diff = priority(b) - priority(a);
  if (diff !== 0) return diff;
  const strong = (c: Candidate) => (c.important || c.impactful ? 1 : 0);
  if (strong(a) !== strong(b)) return strong(b) - strong(a);
  return (a.lastShownAt ?? -1) - (b.lastShownAt ?? -1);
}

export const buttonSlots = ["important", "urgent", "impactful", "easy"] as const;
export type ButtonSlot = (typeof buttonSlots)[number];
export type PlanSlot = "deadline" | ButtonSlot;
export type PlanPick = { slot: PlanSlot; position: number; itemId: string };

const DAY = 86_400_000;

function weight(task: Candidate, now: number): number {
  const cap = defaults.pickStaleDaysCap;
  const days = task.lastShownAt === null ? cap : Math.min(cap, Math.max(0, Math.floor((now - task.lastShownAt) / DAY)));
  return (1 + priority(task)) * (1 + days) * (task.flavor === "frog" ? defaults.pickFrogBoost : 1);
}

function weightedPick(pool: Candidate[], now: number, random: () => number): Candidate {
  const weights = pool.map((task) => weight(task, now));
  let point = random() * weights.reduce((sum, w) => sum + w, 0);
  for (let i = 0; i < pool.length; i++) {
    point -= weights[i];
    if (point < 0) return pool[i];
  }
  return pool[pool.length - 1];
}

/**
 * План дня: блок дедлайнов (просроченные и в пределах горизонта, в том числе задачи на паузе) и по одной задаче
 * «можно сейчас» за каждой из четырех кнопок. Задача в плане встречается один раз; «дофамин» за кнопки не попадает.
 */
export function composePlan(
  candidates: Candidate[],
  today: string,
  timezone: string,
  now: number,
  random: () => number,
): PlanPick[] {
  const horizon = addDays(today, defaults.deadlineHorizonDays);
  const deadlines = candidates
    .filter((task) => task.deadline !== null && localDate(task.deadline, timezone) <= horizon)
    .sort((a, b) => a.deadline! - b.deadline! || byPriority(a, b));
  const picks: PlanPick[] = deadlines.map((task, position) => ({ slot: "deadline", position, itemId: task.id }));
  const used = new Set(picks.map((pick) => pick.itemId));
  for (const slot of buttonSlots) {
    const free = candidates.filter((task) => !used.has(task.id) && task.pause === null && task.flavor !== "dopamine");
    if (free.length === 0) break;
    const marked = free.filter((task) => task[slot] === true);
    const task = marked.length > 0 ? weightedPick(marked, now, random) : [...free].sort(byPriority)[0];
    picks.push({ slot, position: 0, itemId: task.id });
    used.add(task.id);
  }
  return picks;
}

export type PlanTask = Omit<PlanRow, "important" | "urgent" | "impactful" | "easy" | keyof TaskFlags> & {
  priority: number;
  level: PriorityLevel;
  /** Причина паузы сейчас (для пометки в блоке дедлайнов). */
  pause: Pause | null;
};
export type TodayView = { date: string; deadlines: PlanTask[]; buttons: Partial<Record<ButtonSlot, PlanTask>> };

function view(date: string, plan: PlanRow[], now: number): TodayView {
  const result: TodayView = { date, deadlines: [], buttons: {} };
  for (const row of plan) {
    const { important, urgent, impactful, easy, deferred, deferredUntil, queued, waitingFor, ...rest } = row;
    const points = priority({ important, urgent, impactful, easy });
    const pause = pauseReason({ deferred, deferredUntil, queued, waitingFor }, now);
    const task: PlanTask = { ...rest, priority: points, level: priorityLevel(points), pause };
    if (row.slot === "deadline") result.deadlines.push(task);
    else if ((buttonSlots as readonly string[]).includes(row.slot)) result.buttons[row.slot as ButtonSlot] = task;
  }
  result.deadlines.sort((a, b) => a.position - b.position);
  return result;
}

export const day = {
  /** План дня пользователя: читается, а если его еще нет, составляется и записывается; за день не пересчитывается. */
  async today(db: Db, user: { id: string; timezone: string }, now: number, random: () => number = Math.random): Promise<TodayView> {
    const date = localDate(now, user.timezone);
    const existing = await loadPlan(db, user.id, date);
    if (existing.length > 0) return view(date, existing, now);
    const candidates = (await planCandidates(db, user.id, now)).map((task) => ({ ...task, pause: pauseReason(task, now) }));
    const picks = composePlan(candidates, date, user.timezone, now, random);
    return view(date, picks.length > 0 ? await savePlan(db, user.id, date, picks, now) : [], now);
  },
};

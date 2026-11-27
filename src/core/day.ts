import { formatInTimeZone } from "date-fns-tz";
import type { Db } from "../db/client";
import {
  addNextRow,
  addPickedRow,
  completeRow,
  finishRefusal,
  loadPlan,
  planCandidates,
  revealRow,
  saveRefusalNote,
  savePlan,
  setRowState,
  type PlanRow,
  type PlanState,
} from "../db/day";
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
export type PlanSlot = "deadline" | "picked" | ButtonSlot;
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
 * Задача за кнопкой слота или дофаминовая задача: только «можно сейчас», не из `used`; за кнопку «дофамин» не идет.
 * Из задач с отметкой слота выбирается случайная с весом, а если таких нет, берется задача с наибольшим приоритетом.
 */
export function pickForSlot(
  candidates: Candidate[],
  slot: ButtonSlot | "dopamine",
  used: Set<string>,
  now: number,
  random: () => number,
): Candidate | undefined {
  const free = candidates.filter((task) => !used.has(task.id) && task.pause === null);
  if (slot === "dopamine") {
    const pool = free.filter((task) => task.flavor === "dopamine");
    return pool.length > 0 ? weightedPick(pool, now, random) : undefined;
  }
  const regular = free.filter((task) => task.flavor !== "dopamine");
  if (regular.length === 0) return undefined;
  const marked = regular.filter((task) => task[slot] === true);
  return marked.length > 0 ? weightedPick(marked, now, random) : [...regular].sort(byPriority)[0];
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
    const task = pickForSlot(candidates, slot, used, now, random);
    if (!task) break;
    picks.push({ slot, position: 0, itemId: task.id });
    used.add(task.id);
  }
  return picks;
}

export type PlanTask = Omit<
  PlanRow,
  "important" | "urgent" | "impactful" | "easy" | "why" | "firstStepText" | keyof TaskFlags
> & {
  priority: number;
  level: PriorityLevel;
  /** Причина паузы сейчас (для пометки в блоке дедлайнов). */
  pause: Pause | null;
  firstStep: string | null;
  /** «Зачем» задачи с отметкой «Важно» или «Эффект»: показывается при отказе; null — показывать нечего. */
  reasonPrompt: string | null;
  /** Спрашивать ли «Что мешает?» при этом отказе: не чаще раза на задачу в день. */
  askBlocks: boolean;
};
export type TodayView = {
  date: string;
  deadlines: PlanTask[];
  /** Текущая строка каждой кнопки: последняя по позиции (замены и «Обновить» добавляют новые строки). */
  buttons: Partial<Record<ButtonSlot, PlanTask>>;
  /** Задачи, взятые через «Выбрать». */
  picked: PlanTask[];
  /** Сколько задач из блока «Пять задач» выполнено сегодня, и сколько их заполняет кольцо. */
  done: number;
  ringTasks: number;
};

/** «Что мешает?» спрашивается при отказе от задачи не чаще раза в день: если от нее уже отказывались, не спрашивается. */
function asksBlocks(plan: PlanRow[], row: PlanRow): boolean {
  return row.state === "refused" && !plan.some((other) => other !== row && other.itemId === row.itemId && other.state === "refused");
}

function view(date: string, plan: PlanRow[], now: number): TodayView {
  const result: TodayView = { date, deadlines: [], buttons: {}, picked: [], done: 0, ringTasks: defaults.dayRingTasks };
  for (const row of plan) {
    const { important, urgent, impactful, easy, why, firstStepText, deferred, deferredUntil, queued, waitingFor, ...rest } = row;
    const points = priority({ important, urgent, impactful, easy });
    const task: PlanTask = {
      ...rest,
      priority: points,
      level: priorityLevel(points),
      pause: pauseReason({ deferred, deferredUntil, queued, waitingFor }, now),
      firstStep: firstStepText,
      reasonPrompt: (important || impactful) && why ? why : null,
      askBlocks: asksBlocks(plan, row),
    };
    if (row.slot === "deadline") result.deadlines.push(task);
    else if (row.slot === "picked") result.picked.push(task);
    else if ((buttonSlots as readonly string[]).includes(row.slot)) result.buttons[row.slot as ButtonSlot] = task;
    if (row.state === "done" && row.slot !== "deadline") result.done += 1;
  }
  result.deadlines.sort((a, b) => a.position - b.position);
  result.picked.sort((a, b) => a.position - b.position);
  return result;
}

export type DayOutcome = "ok" | "invalid" | "not_found" | "none";
export type DayResult = { outcome: DayOutcome; today?: TodayView };
export type DayAction = "reveal" | "accept" | "refuse" | "reason" | "next" | "done" | "refresh" | "dopamine" | "release";
type DayUser = { id: string; timezone: string };

const actions: readonly string[] = ["reveal", "accept", "refuse", "reason", "next", "done", "refresh", "dopamine", "release"];
const planSlots: readonly string[] = ["deadline", "picked", ...buttonSlots];

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed !== "" && trimmed.length <= defaults.itemTextMaxLength ? trimmed : undefined;
}

async function usable(db: Db, userId: string, now: number, used: Set<string>, pick: (candidates: Candidate[]) => Candidate | undefined) {
  const candidates = (await planCandidates(db, userId, now)).map((task) => ({ ...task, pause: pauseReason(task, now) }));
  return pick(candidates.filter((task) => !used.has(task.id)));
}

export const day = {
  /** План дня пользователя: читается, а если его еще нет, составляется и записывается; за день не пересчитывается. */
  async today(db: Db, user: DayUser, now: number, random: () => number = Math.random): Promise<TodayView> {
    const date = localDate(now, user.timezone);
    const existing = await loadPlan(db, user.id, date);
    if (existing.length > 0) return view(date, existing, now);
    const candidates = (await planCandidates(db, user.id, now)).map((task) => ({ ...task, pause: pauseReason(task, now) }));
    const picks = composePlan(candidates, date, user.timezone, now, random);
    return view(date, picks.length > 0 ? await savePlan(db, user.id, date, picks, now) : [], now);
  },

  /**
   * Действие над строкой плана дня (слот и позиция из `GET /today`). Правила переходов:
   * reveal — показать задачу за кнопкой; accept — принять (после отказа — «Все же взять»); refuse — отказаться;
   * reason — записать причину отказа в карточку; next — завершить отказ (счетчик отказов, «Что мешает?», замена);
   * done — выполнено, задача в архив; refresh и dopamine — новая задача на месте выполненной;
   * release — «Пропустить» или «Закрыть» у дофаминовой задачи.
   */
  async act(
    db: Db,
    user: DayUser,
    now: number,
    target: { slot: string; position: number; action: string },
    body: unknown,
    random: () => number = Math.random,
  ): Promise<DayResult> {
    const { slot, position, action } = target;
    if (!planSlots.includes(slot) || !actions.includes(action) || !Number.isInteger(position) || position < 0) {
      return { outcome: "invalid" };
    }
    const date = localDate(now, user.timezone);
    const plan = await loadPlan(db, user.id, date);
    const row = plan.find((candidate) => candidate.slot === slot && candidate.position === position);
    if (!row) return { outcome: "not_found" };
    const key = { userId: user.id, date, slot: slot as PlanSlot, position };
    const isButton = (buttonSlots as readonly string[]).includes(slot);
    const current = plan.filter((other) => other.slot === slot).every((other) => other.position <= position);
    if (isButton && !current) return { outcome: "invalid" };
    const dopamine = row.flavor === "dopamine";
    const fields = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const finish = (written: { changed: number; plan: PlanRow[] }): DayResult =>
      written.changed > 0 ? { outcome: "ok", today: view(date, written.plan, now) } : { outcome: "invalid" };

    switch (action as DayAction) {
      case "reveal":
        return isButton && row.hidden ? finish(await revealRow(db, key, now)) : { outcome: "invalid" };
      case "accept":
        if (!isButton || row.hidden) return { outcome: "invalid" };
        return finish(await setRowState(db, key, ["offered", "refused"], "accepted"));
      case "refuse":
        if (!isButton || row.hidden || dopamine) return { outcome: "invalid" };
        return finish(await setRowState(db, key, ["offered"], "refused"));
      case "reason": {
        const note = text(fields.text);
        return row.state === "refused" && note ? finish(await saveRefusalNote(db, key, note)) : { outcome: "invalid" };
      }
      case "next": {
        if (row.state !== "refused") return { outcome: "invalid" };
        const raw = fields.blocks;
        const blocks = raw === undefined || raw === null || raw === "" ? undefined : text(raw);
        if (raw !== undefined && raw !== null && raw !== "" && !blocks) return { outcome: "invalid" };
        const used = new Set(plan.map((other) => other.itemId));
        const replacement =
          row.replacements < defaults.refusalReplacements
            ? await usable(db, user.id, now, used, (candidates) =>
                pickForSlot(candidates, slot as ButtonSlot, used, now, random),
              )
            : undefined;
        const insight = blocks && asksBlocks(plan, row) ? { id: crypto.randomUUID(), text: blocks } : undefined;
        return finish(await finishRefusal(db, key, replacement?.id, insight, now));
      }
      case "done": {
        if (row.hidden) return { outcome: "invalid" };
        const from: PlanState[] = slot === "deadline" ? ["offered", "accepted"] : ["accepted"];
        return finish(await completeRow(db, key, from, now));
      }
      case "refresh":
      case "dopamine": {
        const closedDopamine = row.state === "closed" && dopamine;
        if (!isButton || !(row.state === "done" || closedDopamine)) return { outcome: "invalid" };
        const used = new Set(plan.map((other) => other.itemId));
        const next = await usable(db, user.id, now, used, (candidates) =>
          pickForSlot(candidates, action === "dopamine" ? "dopamine" : (slot as ButtonSlot), used, now, random),
        );
        return next ? finish(await addNextRow(db, key, next.id, now)) : { outcome: "none" };
      }
      case "release":
        if (!isButton || !dopamine || row.hidden) return { outcome: "invalid" };
        return finish(await setRowState(db, key, ["offered", "accepted"], "closed"));
    }
  },

  /** «Выбрать»: задача, выбранная пользователем вручную, попадает в план принятой. */
  async pick(db: Db, user: DayUser, now: number, itemId: unknown): Promise<DayResult> {
    if (typeof itemId !== "string" || itemId === "") return { outcome: "invalid" };
    const date = localDate(now, user.timezone);
    const plan = await loadPlan(db, user.id, date);
    if (plan.length === 0) return { outcome: "not_found" };
    const inPlay = plan.some((row) => row.itemId === itemId && ["offered", "accepted", "done"].includes(row.state));
    if (inPlay) return { outcome: "invalid" };
    const written = await addPickedRow(db, user.id, date, itemId, now);
    return written.changed > 0 ? { outcome: "ok", today: view(date, written.plan, now) } : { outcome: "not_found" };
  },
};

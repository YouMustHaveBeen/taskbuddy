import { formatInTimeZone } from "date-fns-tz";
import { t, type Language } from "../../i18n";
import type { Db } from "../db/client";
import {
  addNextRow,
  addPickedRow,
  answerSurvey,
  completeRow,
  firstStepVoice,
  setFirstStepVoice,
  finishRefusal,
  returnRow,
  loadPlan,
  planCandidates,
  revealRow,
  saveDayReward,
  saveRefusalNote,
  savePlan,
  setRowState,
  type DayData,
  type DayReward,
  type PlanRow,
  type PlanState,
  type SurveyAnswer,
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

/** Время «ЧЧ:ММ» в часовом поясе пользователя. */
export function localTime(ms: number, timezone: string): string {
  return formatInTimeZone(ms, timezone, "HH:mm");
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
/** think — задача «Подумай, почему откладываешь», добавленная, когда задача стала лягушкой. */
export type PlanSlot = "deadline" | "picked" | "think" | ButtonSlot;
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
  "important" | "urgent" | "impactful" | "easy" | "why" | "firstStepText" | "lastFailOn" | "archived" | keyof TaskFlags
> & {
  priority: number;
  level: PriorityLevel;
  /** Причина паузы сейчас (для пометки в блоке дедлайнов). */
  pause: Pause | null;
  firstStep: string | null;
  /** «Зачем» задачи с отметкой «Важно» или «Эффект»: показывается при отказе; null — показывать нечего. */
  reasonPrompt: string | null;
  /** Спрашивать ли «Что мешает?» при неудаче (отказ, «На завтра», «В хранилище»): не чаще раза на задачу в день. */
  askBlocks: boolean;
};
/**
 * Награда списка на сегодня на месте `position` (0 — перед первой задачей, N — после последней). Открыта награда
 * сразу после сделанных задач; у прошедших (`past`) и открытой есть название, у следующих нет (скрыты).
 * Прошедшее место без награды (наград тогда не было или награду удалили) не показывается.
 */
export type ListReward = {
  position: number;
  open: boolean;
  past: boolean;
  rewardId: string | null;
  title: string | null;
  minutes: number | null;
};
export type TodayView = {
  date: string;
  deadlines: PlanTask[];
  /** Текущая строка каждой кнопки: последняя по позиции (замены и «Обновить» добавляют новые строки). */
  buttons: Partial<Record<ButtonSlot, PlanTask>>;
  /** Задачи, взятые через «Выбрать», перенесенные опросом «На завтра» и задачи «Подумай, почему откладываешь». */
  picked: PlanTask[];
  /** Список на сегодня: выполненные, затем принятые задачи дня (кроме блока дедлайнов). */
  list: PlanTask[];
  /** Награды списка: на N задач N + 1 награда, перед каждой задачей и после последней; пусто, если задач или наград нет. */
  rewards: ListReward[];
  /** Вечерний опрос: принятые несделанные задачи прошлых дней, а с времени опроса и сегодняшние. */
  survey: PlanTask[];
  /** Опрос прошлого дня не пройден: новых задач на сегодня нет, план не составляется. */
  locked: boolean;
  /** Сколько задач из блока «Пять задач» выполнено сегодня, и сколько их заполняет кольцо. */
  done: number;
  ringTasks: number;
};

/** «Что мешает?» спрашивается не чаще раза на задачу в день: только если в день строки плана неудачи еще не было. */
function asksBlocks(row: PlanRow): boolean {
  return row.lastFailOn !== row.date;
}

/** Опрос прошлого дня не пройден: в плане есть принятая несделанная задача дня раньше `date`. */
function isLocked(plan: PlanRow[], date: string): boolean {
  return plan.some((row) => row.date < date);
}

/** Награды списка из `list` и наград пользователя; у открытой награды без названия награда еще не выбрана. */
function listRewards(list: PlanTask[], rewards: DayReward[]): ListReward[] {
  if (list.length === 0 || rewards.length === 0) return [];
  const open = list.filter((task) => task.state === "done").length;
  const chosen = new Map(rewards.filter((reward) => reward.position !== null).map((reward) => [reward.position, reward]));
  const lines: ListReward[] = [];
  for (let position = 0; position <= list.length; position++) {
    const reward = position <= open ? chosen.get(position) : undefined;
    lines.push({
      position,
      open: position === open,
      past: position < open,
      rewardId: reward?.id ?? null,
      title: reward?.title ?? null,
      minutes: reward?.minutes ?? null,
    });
  }
  return lines;
}

function view(date: string, data: DayData, now: number, timezone: string): TodayView {
  const plan = data.plan;
  const locked = isLocked(plan, date);
  const result: TodayView = {
    date,
    deadlines: [],
    buttons: {},
    picked: [],
    list: [],
    rewards: [],
    survey: [],
    locked,
    done: 0,
    ringTasks: defaults.dayRingTasks,
  };
  const surveyToday = localTime(now, timezone) >= defaults.surveyAt;
  for (const row of plan) {
    const { important, urgent, impactful, easy, why, firstStepText, lastFailOn, archived, deferred, deferredUntil, queued, waitingFor, ...rest } = row;
    const points = priority({ important, urgent, impactful, easy });
    const task: PlanTask = {
      ...rest,
      priority: points,
      level: priorityLevel(points),
      pause: pauseReason({ deferred, deferredUntil, queued, waitingFor }, now),
      firstStep: firstStepText,
      reasonPrompt: (important || impactful) && why ? why : null,
      askBlocks: asksBlocks(row),
    };
    if (row.state === "accepted" && !archived && row.slot !== "deadline" && (row.date < date || surveyToday)) {
      result.survey.push(task);
    }
    if (row.date !== date || locked) continue;
    // вернутый в хранилище дедлайн в сегодняшнем плане не показывается
    if (row.slot === "deadline") {
      if (row.state !== "returned") result.deadlines.push(task);
    }
    else if (row.slot === "picked" || row.slot === "think") {
      // перенесенная опросом, возвращенная в хранилище или удаленная задача в сегодняшнем плане не показывается
      if (row.state === "accepted" || row.state === "done") result.picked.push(task);
    }
    else if ((buttonSlots as readonly string[]).includes(row.slot)) result.buttons[row.slot as ButtonSlot] = task;
    if (row.slot !== "deadline" && (row.state === "accepted" || row.state === "done")) result.list.push(task);
    if (row.state === "done" && row.slot !== "deadline") result.done += 1;
  }
  const order = (task: PlanTask) => (task.slot === "think" ? 1 : 0);
  result.deadlines.sort((a, b) => a.position - b.position);
  result.picked.sort((a, b) => order(a) - order(b) || a.position - b.position);
  // сделанные задачи идут первыми, порядок внутри сохраняется
  result.list.sort((a, b) => (a.state === "done" ? 0 : 1) - (b.state === "done" ? 0 : 1));
  result.rewards = listRewards(result.list, data.rewards);
  return result;
}

/**
 * План дня для показа: если открытой награде списка еще не выбрана награда, она выбирается случайно из наград
 * пользователя и записывается (до N + 1 раз за день). QUERY BUDGET EXCEPTION: запись награды с чтением наград — batch.
 */
async function present(db: Db, user: DayUser, date: string, data: DayData, now: number, random: () => number): Promise<TodayView> {
  const result = view(date, data, now, user.timezone);
  const open = result.rewards.find((reward) => reward.open);
  if (!open || open.title !== null) return result;
  const pool = [...new Map(data.rewards.map((reward) => [reward.id, reward])).values()];
  const reward = pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
  const rewards = await saveDayReward(db, user.id, date, open.position, reward.id, now);
  return view(date, { plan: data.plan, rewards }, now, user.timezone);
}

export type DayOutcome = "ok" | "invalid" | "not_found" | "none";
export type DayResult = { outcome: DayOutcome; today?: TodayView };
export type DayAction =
  | "reveal"
  | "accept"
  | "refuse"
  | "reason"
  | "next"
  | "done"
  | "refresh"
  | "dopamine"
  | "release"
  | "return";
export type DayUser = { id: string; timezone: string; language: string };

const actions: readonly string[] = ["reveal", "accept", "refuse", "reason", "next", "done", "refresh", "dopamine", "release", "return"];
const planSlots: readonly string[] = ["deadline", "picked", "think", ...buttonSlots];
const surveyAnswers: readonly string[] = ["tomorrow", "back", "drop"];
/** Слоты, которые заполняет составление плана; план с одними перенесенными задачами еще не составлен. */
const composedSlots: readonly string[] = ["deadline", ...buttonSlots];

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed !== "" && trimmed.length <= defaults.itemTextMaxLength ? trimmed : undefined;
}

async function usable(db: Db, userId: string, now: number, used: Set<string>, pick: (candidates: Candidate[]) => Candidate | undefined) {
  const candidates = (await planCandidates(db, userId, now)).map((task) => ({ ...task, pause: pauseReason(task, now) }));
  return pick(candidates.filter((task) => !used.has(task.id)));
}

/**
 * План дня на дату: читается, а если его еще нет (или в нем только перенесенные задачи), составляется
 * и дописывается без задач, которые уже в плане, и без `exclude`. Пока опрос прошлого дня не пройден,
 * план не составляется. Пустой план не записывается.
 */
async function planOfDay(
  db: Db,
  user: DayUser,
  date: string,
  now: number,
  random: () => number,
  exclude?: string,
): Promise<DayData> {
  const loaded = await loadPlan(db, user.id, date);
  const todays = loaded.plan.filter((row) => row.date === date);
  if (isLocked(loaded.plan, date) || todays.some((row) => composedSlots.includes(row.slot))) return loaded;
  const inPlan = new Set(todays.map((row) => row.itemId));
  if (exclude) inPlan.add(exclude);
  const candidates = (await planCandidates(db, user.id, now))
    .filter((task) => !inPlan.has(task.id))
    .map((task) => ({ ...task, pause: pauseReason(task, now) }));
  const picks = composePlan(candidates, date, user.timezone, now, random);
  return picks.length > 0 ? savePlan(db, user.id, date, picks, now) : loaded;
}

/** Задача «Подумай, почему откладываешь» на случай, если неудача сделает задачу лягушкой. */
function frogFor(user: DayUser, title: string, date: string) {
  const think = { id: crypto.randomUUID(), title: t(user.language as Language, "think.title", { title }), date };
  return { at: defaults.frogThreshold, think };
}

/** Текст ответа «Что мешает?»: нет ответа — undefined, неверный ответ — null. */
function blocksText(raw: unknown): string | undefined | null {
  if (raw === undefined || raw === null || raw === "") return undefined;
  return text(raw) ?? null;
}

export const day = {
  /** Голосовой первый шаг задачи (file_id Telegram), если он есть. */
  voice(db: Db, userId: string, itemId: string): Promise<string | undefined> {
    return firstStepVoice(db, userId, itemId);
  },

  /** Записывает (или заменяет) голосовой первый шаг задачи; false — задачи нет или она в архиве. */
  saveVoice(db: Db, userId: string, itemId: string, fileId: string): Promise<boolean> {
    return setFirstStepVoice(db, userId, itemId, fileId);
  },

  /** План дня пользователя: читается, а если его еще нет, составляется и записывается; за день не пересчитывается. */
  async today(db: Db, user: DayUser, now: number, random: () => number = Math.random): Promise<TodayView> {
    const date = localDate(now, user.timezone);
    return present(db, user, date, await planOfDay(db, user, date, now, random), now, random);
  },

  /**
   * Действие над строкой плана дня (слот и позиция из `GET /today`). Правила переходов:
   * reveal — показать задачу за кнопкой; accept — принять (после отказа — «Все же взять»); refuse — отказаться;
   * reason — записать причину отказа в карточку; next — завершить отказ (счетчик отказов, «Что мешает?», замена);
   * done — выполнено, задача в архив; refresh и dopamine — новая задача на месте выполненной;
   * release — «Пропустить» или «Закрыть» у дофаминовой задачи; return — «Вернуть» после таймера: задача
   * в хранилище (неудача, «Что мешает?» в `blocks`, замена за кнопкой), у дофаминовой — как «Закрыть».
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
    const loaded = await loadPlan(db, user.id, date);
    const plan = loaded.plan.filter((other) => other.date === date);
    const row = plan.find((candidate) => candidate.slot === slot && candidate.position === position);
    if (!row) return { outcome: "not_found" };
    const key = { userId: user.id, date, slot: slot as PlanSlot, position };
    const isButton = (buttonSlots as readonly string[]).includes(slot);
    const current = plan.filter((other) => other.slot === slot).every((other) => other.position <= position);
    if (isButton && !current) return { outcome: "invalid" };
    const dopamine = row.flavor === "dopamine";
    const fields = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const finish = async (written: { changed: number } & DayData): Promise<DayResult> =>
      written.changed > 0 ? { outcome: "ok", today: await present(db, user, date, written, now, random) } : { outcome: "invalid" };

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
        const blocks = blocksText(fields.blocks);
        if (blocks === null) return { outcome: "invalid" };
        const used = new Set(plan.map((other) => other.itemId));
        const replacement =
          row.replacements < defaults.refusalReplacements
            ? await usable(db, user.id, now, used, (candidates) =>
                pickForSlot(candidates, slot as ButtonSlot, used, now, random),
              )
            : undefined;
        const insight = blocks && asksBlocks(row) ? { id: crypto.randomUUID(), text: blocks } : undefined;
        const frog = frogFor(user, row.title, addDays(date, 1));
        return finish(await finishRefusal(db, key, row.itemId, replacement?.id, insight, frog, now));
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
      case "return": {
        const from: PlanState[] = slot === "deadline" ? ["offered", "accepted"] : ["accepted"];
        if (row.hidden || row.archived || !from.includes(row.state)) return { outcome: "invalid" };
        if (dopamine) return finish(await setRowState(db, key, from, "closed"));
        const blocks = blocksText(fields.blocks);
        if (blocks === null) return { outcome: "invalid" };
        const used = new Set(plan.map((other) => other.itemId));
        const replacement =
          isButton && row.replacements < defaults.refusalReplacements
            ? await usable(db, user.id, now, used, (candidates) =>
                pickForSlot(candidates, slot as ButtonSlot, used, now, random),
              )
            : undefined;
        const insight = blocks && asksBlocks(row) ? { id: crypto.randomUUID(), text: blocks } : undefined;
        const frog = frogFor(user, row.title, addDays(date, 1));
        return finish(await returnRow(db, key, row.itemId, from, replacement?.id, insight, frog, now));
      }
    }
  },

  /** «Выбрать»: задача, выбранная пользователем вручную, попадает в план принятой. QUERY BUDGET EXCEPTION: при пустом плане он сначала составляется (до 4 запросов). */
  async pick(db: Db, user: DayUser, now: number, itemId: unknown): Promise<DayResult> {
    if (typeof itemId !== "string" || itemId === "") return { outcome: "invalid" };
    const date = localDate(now, user.timezone);
    // пустой план составляется без выбранной задачи
    const plan = await planOfDay(db, user, date, now, Math.random, itemId);
    // пока опрос прошлого дня не пройден, новые задачи в план не добавляются: в ответе — день с опросом
    if (isLocked(plan.plan, date)) return { outcome: "invalid", today: view(date, plan, now, user.timezone) };
    const inToday = (rows: PlanRow[]) => rows.some((row) => row.date === date && row.itemId === itemId);
    if (inToday(plan.plan)) return { outcome: "invalid" };
    const written = await addPickedRow(db, user.id, date, itemId, now);
    if (written.changed > 0) return { outcome: "ok", today: await present(db, user, date, written, now, Math.random) };
    return { outcome: inToday(written.plan) ? "invalid" : "not_found" };
  },

  /**
   * Ответ вечернего опроса по строке плана из `survey`: tomorrow — «На завтра» (задача принятой в плане следующего
   * дня, но не раньше сегодняшнего), back — «В хранилище», drop — «Удалить» (в архив как неактуальная).
   * «На завтра» и «В хранилище» — неудача задачи; ответ «Что мешает?» (`blocks`) записывается в инсайты.
   * QUERY BUDGET EXCEPTION: последний ответ опроса прошлого дня составляет план дня (еще до 3 запросов, раз в день).
   */
  async survey(
    db: Db,
    user: DayUser,
    now: number,
    target: { date: string; slot: string; position: number; answer: string },
    body: unknown,
  ): Promise<DayResult> {
    const { date, slot, position, answer } = target;
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !planSlots.includes(slot) ||
      !surveyAnswers.includes(answer) ||
      !Number.isInteger(position) ||
      position < 0
    ) {
      return { outcome: "invalid" };
    }
    const today = localDate(now, user.timezone);
    const fields = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const blocks = answer === "drop" ? undefined : blocksText(fields.blocks);
    if (blocks === null) return { outcome: "invalid" };
    const plan = await loadPlan(db, user.id, today);
    const row = view(today, plan, now, user.timezone).survey.find(
      (task) => task.date === date && task.slot === slot && task.position === position,
    );
    if (!row) return { outcome: "not_found" };
    const key = { userId: user.id, date, slot: slot as PlanSlot, position };
    const next = addDays(date, 1) > today ? addDays(date, 1) : today;
    const insight = blocks && row.askBlocks ? { id: crypto.randomUUID(), text: blocks } : undefined;
    const written = await answerSurvey(
      db,
      key,
      row.itemId,
      answer as SurveyAnswer,
      today,
      next,
      insight,
      frogFor(user, row.title, next),
      now,
    );
    if (written.changed === 0) return { outcome: "invalid" };
    // опрос пройден: план дня составляется сразу (как при открытии страницы)
    const composed = written.plan.some((other) => other.date === today && composedSlots.includes(other.slot));
    const rows = isLocked(written.plan, today) || composed ? written : await planOfDay(db, user, today, now, Math.random);
    return { outcome: "ok", today: await present(db, user, today, rows, now, Math.random) };
  },
};

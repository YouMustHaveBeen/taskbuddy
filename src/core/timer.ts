import type { Db } from "../db/client";
import {
  dropTimer,
  expireTimer,
  loadTimer,
  pauseTimer,
  resumeTimer,
  setTimerMessage,
  startTimer,
  stopTimer,
  type TimerPlace,
  type TimerRow,
} from "../db/timers";
import { day, type DayUser, type PlanTask, type TodayView } from "./day";
import { defaults } from "./settings";

export type TimerState = "running" | "paused" | "ended";
export type TimerView = Omit<TimerRow, "pausedAt"> & { state: TimerState };
export type TimerOutcome = "ok" | "invalid" | "not_found" | "busy";
/** `previous` — таймер до «Продолжить» (у `again`). */
export type TimerResult = { outcome: TimerOutcome; timer?: TimerView; today?: TodayView; previous?: TimerView };

/** Идет (время окончания впереди), на паузе или остановлен (время вышло, даже если будильник еще не сработал, или нажали «Стоп»). */
function view(row: TimerRow | undefined, now: number): TimerView | undefined {
  if (!row) return undefined;
  const { pausedAt, ...rest } = row;
  const state: TimerState = row.endsAt !== null && row.endsAt > now ? "running" : pausedAt !== null ? "paused" : "ended";
  return { ...rest, state };
}

/** Строки плана, у задачи которых может идти таймер: принятые несделанные и блок дедлайнов. */
function workRows(today: TodayView): PlanTask[] {
  const rows = [...today.deadlines, ...today.picked, ...Object.values(today.buttons)];
  return rows.filter((row) => row.state === "accepted" || (row.slot === "deadline" && row.state === "offered"));
}

function validMinutes(minutes: number): boolean {
  return (defaults.timerMinutes as readonly number[]).includes(minutes);
}

async function startFor(
  db: Db,
  user: DayUser,
  now: number,
  row: PlanTask,
  minutes: number,
  place: TimerPlace,
  botMessageId: number | null,
): Promise<TimerResult> {
  const written = await startTimer(
    db,
    { userId: user.id, kind: "task", itemId: row.itemId, minutes, startedIn: place, botMessageId },
    now,
  );
  return { outcome: written.changed > 0 ? "ok" : written.timer ? "busy" : "not_found", timer: view(written.timer, now) };
}

const changedOr = (written: { changed: number; timer?: TimerRow }, now: number): TimerResult =>
  written.changed > 0
    ? { outcome: "ok", timer: view(written.timer, now) }
    : { outcome: written.timer ? "invalid" : "not_found", timer: view(written.timer, now) };

export const timer = {
  async current(db: Db, userId: string, now: number): Promise<TimerView | undefined> {
    return view(await loadTimer(db, userId), now);
  },

  /**
   * «Таймер» у задачи строки плана (слот и позиция из `GET /today`): длина — одна из `timerMinutes`.
   * Если другой таймер идет или стоит на паузе, новый не запускается (busy), в ответе — текущий.
   * QUERY BUDGET EXCEPTION: план дня (1–3 запроса) и запись таймера с чтением (batch).
   */
  async start(
    db: Db,
    user: DayUser,
    now: number,
    target: { slot: string; position: number; minutes: number },
    place: TimerPlace,
    botMessageId: number | null = null,
  ): Promise<TimerResult> {
    if (!validMinutes(target.minutes) || !Number.isInteger(target.position)) return { outcome: "invalid" };
    const today = await day.today(db, user, now);
    const row = workRows(today).find((task) => task.slot === target.slot && task.position === target.position);
    if (!row) return { outcome: "not_found", today };
    return startFor(db, user, now, row, target.minutes, place, botMessageId);
  },

  /** «Продолжить» после «Стоп» или окончания: таймер той же задачи снова, с новой длиной. QUERY BUDGET EXCEPTION: таймер, план дня, запись. */
  async again(db: Db, user: DayUser, now: number, minutes: number, place: TimerPlace, botMessageId: number | null = null): Promise<TimerResult> {
    if (!validMinutes(minutes)) return { outcome: "invalid" };
    const current = view(await loadTimer(db, user.id), now);
    if (!current) return { outcome: "not_found" };
    if (current.state !== "ended" || current.kind !== "task") return { outcome: "invalid", timer: current };
    const today = await day.today(db, user, now);
    const row = workRows(today).find((task) => task.itemId === current.itemId);
    if (!row) return { outcome: "not_found", timer: current, today };
    return { ...(await startFor(db, user, now, row, minutes, place, botMessageId)), previous: current };
  },

  async pause(db: Db, userId: string, now: number): Promise<TimerResult> {
    return changedOr(await pauseTimer(db, userId, now), now);
  },

  async resume(db: Db, userId: string, now: number): Promise<TimerResult> {
    return changedOr(await resumeTimer(db, userId, now), now);
  },

  async stop(db: Db, userId: string, now: number): Promise<TimerResult> {
    return changedOr(await stopTimer(db, userId), now);
  },

  /**
   * Будильник: таймер, время которого вышло (`endsAt` — окончание, которое видел будильник), останавливается;
   * `messageId` — новое сообщение «Время вышло» в боте. Если таймер с тех пор изменили, ничего не меняется (false).
   */
  async expire(db: Db, userId: string, endsAt: number, messageId: number | null): Promise<boolean> {
    return (await expireTimer(db, userId, endsAt, messageId)) > 0;
  },

  /** Таймер в базе идет, и его время вышло: будильнику пора сработать. */
  due(current: TimerView | undefined, now: number): current is TimerView & { endsAt: number } {
    return current !== undefined && current.endsAt !== null && current.endsAt <= now;
  },

  async setMessage(db: Db, userId: string, itemId: string, messageId: number | null): Promise<void> {
    await setTimerMessage(db, userId, itemId, messageId);
  },

  /**
   * Кнопки после таймера задачи: finish — «Завершить» (как «Сделано»), later — «Продолжить позже» (таймер снимается,
   * задача остается в списке на сегодня), back — «Вернуть» (задача в хранилище, `body.blocks` — ответ «Что мешает?»).
   * В ответе — таймер до нажатия и план дня. QUERY BUDGET EXCEPTION: таймер, план дня и действие над строкой плана.
   */
  async close(db: Db, user: DayUser, now: number, action: "finish" | "later" | "back", body?: unknown): Promise<TimerResult> {
    const current = view(await loadTimer(db, user.id), now);
    if (!current || current.kind !== "task") return { outcome: "not_found" };
    if (action === "later") {
      const dropped = await dropTimer(db, user.id, current.itemId);
      return { outcome: dropped > 0 ? "ok" : "not_found", timer: current };
    }
    const today = await day.today(db, user, now);
    const row = workRows(today).find((task) => task.itemId === current.itemId);
    if (!row) {
      await dropTimer(db, user.id, current.itemId);
      return { outcome: "not_found", timer: current, today };
    }
    const result = await day.act(
      db,
      user,
      now,
      { slot: row.slot, position: row.position, action: action === "finish" ? "done" : "return" },
      body,
    );
    return { outcome: result.outcome === "ok" ? "ok" : "invalid", timer: current, today: result.today ?? today };
  },
};

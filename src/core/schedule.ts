import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import type { Db } from "../db/client";
import {
  claimMarks,
  claimReminders,
  deadlinesBetween,
  loadScheduleState,
  nightCleanup,
  setReminder,
  type MarkColumn,
} from "../db/schedule";
import type { User } from "../db/users";
import { addDays, day, localDate, localTime, type TodayView } from "./day";
import { defaults } from "./settings";

export type ScheduleEvent = "survey" | "morning" | "deadline" | "night";
type Marks = Pick<User, "surveyOn" | "morningOn" | "deadlineOn" | "nightOn">;

const events: { event: ScheduleEvent; at: string; mark: keyof Marks; column: MarkColumn }[] = [
  { event: "night", at: defaults.nightAt, mark: "nightOn", column: "night_on" },
  { event: "morning", at: defaults.morningAt, mark: "morningOn", column: "morning_on" },
  { event: "deadline", at: defaults.deadlineNoticeAt, mark: "deadlineOn", column: "deadline_on" },
  { event: "survey", at: defaults.surveyAt, mark: "surveyOn", column: "survey_on" },
];

/** События дня, время которых по поясу пользователя наступило, а за сегодняшнюю дату они еще не выполнены. */
export function dueEvents(marks: Marks, timezone: string, now: number): ScheduleEvent[] {
  const date = localDate(now, timezone);
  const time = localTime(now, timezone);
  return events.filter(({ at, mark }) => time >= at && (marks[mark] ?? "") < date).map(({ event }) => event);
}

/** Начало дня `date` в часовом поясе, в миллисекундах UTC. */
export function startOfLocalDay(date: string, timezone: string): number {
  return fromZonedTime(`${date}T00:00:00`, timezone).getTime();
}

/** То же время суток, что у `original`, на следующий день после сегодняшнего (по поясу пользователя). */
export function sameTimeTomorrow(original: number, now: number, timezone: string): number {
  const time = formatInTimeZone(original, timezone, "HH:mm:ss");
  return fromZonedTime(`${addDays(localDate(now, timezone), 1)}T${time}`, timezone).getTime();
}

/** Что отправить пользователю в этот запуск расписания. */
export type UserTick = {
  user: User;
  /** Вечерний опрос: принятые несделанные задачи. */
  survey?: TodayView;
  /** Утро: пять кнопок и список, если опрос пройден; иначе сначала вчерашний опрос (`reprompt`). */
  morning?: { view: TodayView; reprompt: boolean };
  /** Задачи с дедлайном завтра. */
  deadlines?: string[];
};
export type Reminder = { user: User; itemId: string; title: string; remindAt: number };

const markOf: Record<Exclude<ScheduleEvent, "morning">, MarkColumn> = {
  survey: "survey_on",
  deadline: "deadline_on",
  night: "night_on",
};

export const schedule = {
  /**
   * Один запуск расписания: события дня по поясу каждого пользователя и наступившие напоминания. Событие и
   * напоминание берет ровно один запуск (отметка за дату, снятие напоминания). Что отправить, решает вызывающий.
   * QUERY BUDGET EXCEPTION: без событий — один batch; событие дня пользователя (раз в сутки) — свои запросы.
   */
  async tick(db: Db, now: number): Promise<{ users: UserTick[]; reminders: Reminder[] }> {
    const state = await loadScheduleState(db, now);
    const due = state.users.map((user) => ({ user, events: dueEvents(user, user.timezone, now) }));
    const claims = due.flatMap(({ user, events: list }) =>
      list
        .filter((event): event is Exclude<ScheduleEvent, "morning"> => event !== "morning")
        .map((event) => ({ userId: user.id, column: markOf[event], date: localDate(now, user.timezone) })),
    );
    const claimed = await claimMarks(db, claims);
    const has = (userId: string, column: MarkColumn) => claimed.some((claim) => claim.userId === userId && claim.column === column);

    const ticks: UserTick[] = [];
    for (const { user, events: list } of due) {
      const tick: UserTick = { user };
      const date = localDate(now, user.timezone);
      if (has(user.id, "night_on")) {
        const promptsBefore = now - defaults.botPromptKeepHours * 3_600_000;
        await nightCleanup(db, user.id, addDays(date, -defaults.dayPlanKeepDays), promptsBefore, now);
      }
      if (list.includes("morning")) {
        const view = await day.today(db, user, now);
        const reprompt = view.locked;
        const won = reprompt
          ? (user.repromptOn ?? "") < date && (await claimMarks(db, [{ userId: user.id, column: "reprompt_on", date }])).length > 0
          : await schedule.claimMorning(db, user, now);
        if (won) tick.morning = { view, reprompt };
      }
      if (has(user.id, "deadline_on")) {
        const tomorrow = addDays(date, 1);
        const from = startOfLocalDay(tomorrow, user.timezone);
        const titles = await deadlinesBetween(db, user.id, from, startOfLocalDay(addDays(tomorrow, 1), user.timezone));
        if (titles.length > 0) tick.deadlines = titles;
      }
      if (has(user.id, "survey_on")) {
        const view = await day.today(db, user, now);
        if (view.survey.length > 0) tick.survey = view;
      }
      if (tick.morning || tick.deadlines || tick.survey) ticks.push(tick);
    }

    const owners = new Map(state.users.map((user) => [user.id, user]));
    const taken = await claimReminders(db, state.reminders.map((reminder) => reminder.id), now);
    const reminders = state.reminders.flatMap((reminder) => {
      const user = owners.get(reminder.ownerId);
      return reminder.send && user && taken.has(reminder.id)
        ? [{ user, itemId: reminder.id, title: reminder.title, remindAt: reminder.remindAt }]
        : [];
    });
    return { users: ticks, reminders };
  },

  /**
   * Утреннее сообщение (пять кнопок и список) за сегодня: берется один раз, когда наступило время утра.
   * Так утро получает и запуск расписания, и прохождение вчерашнего опроса после времени утра.
   */
  async claimMorning(db: Db, user: Pick<User, "id" | "timezone">, now: number): Promise<boolean> {
    if (localTime(now, user.timezone) < defaults.morningAt) return false;
    const date = localDate(now, user.timezone);
    return (await claimMarks(db, [{ userId: user.id, column: "morning_on", date }])).length > 0;
  },

  /** «Напомнить снова завтра»: напоминание в то же время на следующий день. */
  async remindTomorrow(db: Db, user: Pick<User, "id" | "timezone">, itemId: string, original: number, now: number): Promise<boolean> {
    return setReminder(db, user.id, itemId, sameTimeTomorrow(original, now, user.timezone));
  },
};

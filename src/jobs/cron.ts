import { Api } from "grammy/web";
import { schedule, type UserTick } from "../core/schedule";
import { createDb } from "../db/client";
import type { Env } from "../env";
import { sendDeadlines, sendMorning, sendReminder, sendSurvey, type Tg } from "../telegram/day";

/** Запуск расписания (cron раз в 5 минут): события дня и напоминания отправляются в бот. */
export async function runSchedule(env: Env, now: number): Promise<void> {
  const db = createDb(env.DB);
  const api = new Api(env.TELEGRAM_BOT_TOKEN);
  const { users, reminders } = await schedule.tick(db, now);
  const name = (error: unknown) => (error instanceof Error ? error.name : "unknown");
  // при ошибке отправки событие возвращается (undo), и следующий запуск расписания отправит его снова
  const send = async (work: () => Promise<void>, undo: () => Promise<void>) => {
    try {
      await work();
    } catch (error) {
      console.error("schedule send failed", name(error));
      await undo().catch((undoError) => console.error("schedule undo failed", name(undoError)));
    }
  };
  for (const tick of users) {
    const tg: Tg = { api, db, user: tick.user, url: env.PUBLIC_URL };
    const release = (key: keyof UserTick["claims"]) => async () => {
      const claim = tick.claims[key];
      if (claim) await schedule.release(db, tick.user.id, claim);
    };
    for (const messageId of tick.staleMessages ?? []) {
      await api.deleteMessage(tick.user.telegramId, messageId).catch(() => undefined);
    }
    if (tick.morning) {
      const { view, reprompt } = tick.morning;
      await send(() => (reprompt ? sendSurvey(tg, view, true) : sendMorning(tg, view)), release("morning"));
    }
    if (tick.deadlines) {
      const titles = tick.deadlines;
      await send(() => sendDeadlines(tg, titles), release("deadlines"));
    }
    if (tick.survey) {
      const view = tick.survey;
      await send(() => sendSurvey(tg, view), release("survey"));
    }
  }
  for (const reminder of reminders) {
    const tg: Tg = { api, db, user: reminder.user, url: env.PUBLIC_URL };
    await send(
      () => sendReminder(tg, reminder.itemId, reminder.title, reminder.remindAt),
      () => schedule.restoreReminder(db, reminder.itemId, reminder.remindAt),
    );
  }
}

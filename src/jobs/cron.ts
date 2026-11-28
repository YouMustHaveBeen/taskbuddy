import { Api } from "grammy/web";
import { schedule } from "../core/schedule";
import { createDb } from "../db/client";
import type { Env } from "../env";
import { sendDeadlines, sendMorning, sendReminder, sendSurvey, type Tg } from "../telegram/day";

/** Запуск расписания (cron раз в 5 минут): события дня и напоминания отправляются в бот. */
export async function runSchedule(env: Env, now: number): Promise<void> {
  const db = createDb(env.DB);
  const api = new Api(env.TELEGRAM_BOT_TOKEN);
  const { users, reminders } = await schedule.tick(db, now);
  const send = async (work: () => Promise<void>) => {
    try {
      await work();
    } catch (error) {
      console.error("schedule send failed", error instanceof Error ? error.name : "unknown");
    }
  };
  for (const tick of users) {
    const tg: Tg = { api, db, user: tick.user, url: env.PUBLIC_URL };
    if (tick.morning) {
      const { view, reprompt } = tick.morning;
      await send(() => (reprompt ? sendSurvey(tg, view, true) : sendMorning(tg, view)));
    }
    if (tick.deadlines) {
      const titles = tick.deadlines;
      await send(() => sendDeadlines(tg, titles));
    }
    if (tick.survey) {
      const view = tick.survey;
      await send(() => sendSurvey(tg, view));
    }
  }
  for (const reminder of reminders) {
    const tg: Tg = { api, db, user: reminder.user, url: env.PUBLIC_URL };
    await send(() => sendReminder(tg, reminder.itemId, reminder.title, reminder.remindAt));
  }
}

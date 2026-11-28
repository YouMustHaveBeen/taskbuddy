import { DurableObject } from "cloudflare:workers";
import { Api } from "grammy/web";
import { timer } from "../core/timer";
import { createDb } from "../db/client";
import { findUserById } from "../db/users";
import type { Env } from "../env";
import { sendTimerEnded } from "../telegram/timer";

/** Будильник таймера: один объект на пользователя, точное время окончания — alarm хранилища. */
export class TimerAlarm extends DurableObject<Env> {
  async set(userId: string, at: number): Promise<void> {
    await this.ctx.storage.put("user", userId);
    await this.ctx.storage.setAlarm(at);
  }

  /** Время вышло: таймер останавливается; если его запустили в боте, в бот приходит «Время вышло» с четырьмя кнопками. */
  async alarm(): Promise<void> {
    const userId = await this.ctx.storage.get<string>("user");
    if (!userId) return;
    const db = createDb(this.env.DB);
    // пауза, «Стоп» или «Сделано» раньше окончания: таймер не меняется; «Продолжить» сам ставит будильник заново
    const result = await timer.expire(db, userId, Date.now());
    const current = result.timer;
    if (result.outcome !== "ok" || !current || current.startedIn !== "bot") return;
    const user = await findUserById(db, userId);
    if (!user) return;
    const api = new Api(this.env.TELEGRAM_BOT_TOKEN);
    await sendTimerEnded({ api, db, user, url: this.env.PUBLIC_URL, alarm: timerAlarms(this.env) }, current);
  }
}

/** Ставит будильник таймера пользователя на время `at`. */
export function timerAlarms(env: Env): (userId: string, at: number) => Promise<void> {
  return async (userId, at) => {
    await env.TIMERS.get(env.TIMERS.idFromName(userId)).set(userId, at);
  };
}

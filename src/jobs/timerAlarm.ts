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

  /**
   * Время вышло: таймер, запущенный в боте, сначала присылает «Время вышло» с четырьмя кнопками, затем останавливается;
   * запущенный на странице — только останавливается. Ошибка отправки в Telegram запускает повтор будильника.
   */
  async alarm(): Promise<void> {
    const userId = await this.ctx.storage.get<string>("user");
    if (!userId) return;
    const db = createDb(this.env.DB);
    const now = Date.now();
    const current = await timer.current(db, userId, now);
    // пауза, «Стоп» или «Сделано» раньше окончания: таймер не меняется; «Продолжить» сам ставит будильник заново
    if (!timer.due(current, now)) return;
    const user = current.startedIn === "bot" ? await findUserById(db, userId) : undefined;
    if (!user) {
      await timer.expire(db, userId, current.endsAt, null);
      return;
    }
    const tg = { api: new Api(this.env.TELEGRAM_BOT_TOKEN), db, user, url: this.env.PUBLIC_URL, alarm: timerAlarms(this.env) };
    const messageId = await sendTimerEnded(tg, current);
    // таймер изменили, пока отправлялось сообщение: новое сообщение уже не нужно; иначе удаляется прежнее
    const expired = await timer.expire(db, userId, current.endsAt, messageId);
    const stale = expired ? current.botMessageId : messageId;
    if (stale !== null) await tg.api.deleteMessage(user.telegramId, stale).catch(() => undefined);
  }
}

/** Ставит будильник таймера пользователя на время `at`. */
export function timerAlarms(env: Env): (userId: string, at: number) => Promise<void> {
  return async (userId, at) => {
    await env.TIMERS.get(env.TIMERS.idFromName(userId)).set(userId, at);
  };
}

import type { TimerAlarm } from "./jobs/timerAlarm";

export type Env = {
  DB: D1Database;
  /** Будильники таймеров (Durable Object на пользователя). */
  TIMERS: DurableObjectNamespace<TimerAlarm>;
  ASSETS: Fetcher;
  TELEGRAM_BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  OWNER_INVITE_CODE: string;
  /** Адрес страницы для ссылок входа в сообщениях расписания. */
  PUBLIC_URL: string;
};

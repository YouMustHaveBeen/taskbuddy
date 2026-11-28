export type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  TELEGRAM_BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  OWNER_INVITE_CODE: string;
  /** Адрес страницы для ссылок входа в сообщениях расписания. */
  PUBLIC_URL: string;
};

import { Api } from "grammy/web";
import { Hono, type Context } from "hono";
import type { TextKey } from "../../i18n";
import { items } from "../core/items";
import { timer, type TimerOutcome, type TimerResult, type TimerView } from "../core/timer";
import { timerAlarms } from "../jobs/timerAlarm";
import type { Tg } from "../telegram/common";
import { showTimerInBot } from "../telegram/timer";
import { requireUser, type ApiEnv } from "./session";

export const timerRoutes = new Hono<ApiEnv>();

const statuses: Record<Exclude<TimerOutcome, "ok">, 400 | 404 | 409> = { invalid: 400, not_found: 404, busy: 409 };

function tgFor(c: Context<ApiEnv>): Tg {
  return { api: new Api(c.env.TELEGRAM_BOT_TOKEN), db: c.var.db, user: c.var.user, url: c.env.PUBLIC_URL, alarm: timerAlarms(c.env) };
}

/** Таймер, запущенный в боте, показывается там же: сообщение бота меняется в фоне, ответ страницы его не ждет. */
function syncBot(c: Context<ApiEnv>, before: TimerView | undefined, after: TimerView | undefined, closed?: TextKey) {
  if (!(before?.botMessageId ?? after?.botMessageId)) return;
  const work = showTimerInBot(tgFor(c), before, after, closed).catch((error: unknown) =>
    console.error("timer bot sync failed", error instanceof Error ? error.name : "unknown"),
  );
  try {
    c.executionCtx.waitUntil(work);
  } catch {
    // без контекста выполнения (тесты app.request) сообщение меняется без ожидания
  }
}

function reply(c: Context<ApiEnv>, result: TimerResult) {
  const body = { timer: result.timer ?? null, ...(result.today ? { today: result.today } : {}) };
  return result.outcome === "ok" ? c.json(body) : c.json({ ...body, error: result.outcome }, statuses[result.outcome]);
}

/** Запущенный таймер: будильник на его окончание. */
async function arm(c: Context<ApiEnv>, result: TimerResult) {
  const current = result.timer;
  if (result.outcome === "ok" && current?.state === "running" && current.endsAt !== null) {
    await timerAlarms(c.env)(c.var.user.id, current.endsAt);
  }
}

timerRoutes.get("/timer", requireUser, async (c) => c.json({ timer: (await timer.current(c.var.db, c.var.user.id, Date.now())) ?? null }));

timerRoutes.post("/timer/start/:slot/:position/:minutes", requireUser, async (c) => {
  const target = { slot: c.req.param("slot"), position: Number(c.req.param("position")), minutes: Number(c.req.param("minutes")) };
  const result = await timer.start(c.var.db, c.var.user, Date.now(), target, "web");
  await arm(c, result);
  return reply(c, result);
});

/** «Старт» у открытой награды списка на сегодня. */
timerRoutes.post("/timer/reward/:position", requireUser, async (c) => {
  const result = await timer.reward(c.var.db, c.var.user, Date.now(), Number(c.req.param("position")), "web");
  await arm(c, result);
  return reply(c, result);
});

timerRoutes.post("/timer/again/:minutes", requireUser, async (c) => {
  const result = await timer.again(c.var.db, c.var.user, Date.now(), Number(c.req.param("minutes")), "web");
  await arm(c, result);
  // таймер из бота продолжен на странице: дальше он показывается на странице, сообщение бота отмечается
  if (result.outcome === "ok") syncBot(c, result.previous, undefined, "timer.again");
  return reply(c, result);
});

for (const action of ["pause", "resume", "stop"] as const) {
  timerRoutes.post(`/timer/${action}`, requireUser, async (c) => {
    const now = Date.now();
    const result =
      action === "pause"
        ? await timer.pause(c.var.db, c.var.user.id, now)
        : action === "resume"
          ? await timer.resume(c.var.db, c.var.user.id, now)
          : await timer.stop(c.var.db, c.var.user.id, now);
    if (action === "resume") await arm(c, result);
    if (result.outcome === "ok") syncBot(c, undefined, result.timer);
    return reply(c, result);
  });
}

const closeLabels = { finish: "timer.finish", later: "timer.later", back: "timer.return" } as const satisfies Record<string, TextKey>;

for (const action of ["finish", "later", "back"] as const) {
  timerRoutes.post(`/timer/${action}`, requireUser, async (c) => {
    const body: unknown = await c.req.json().catch(() => undefined);
    const result = await timer.close(c.var.db, c.var.user, Date.now(), action, body);
    if (result.outcome === "ok") syncBot(c, result.timer, undefined, closeLabels[action]);
    return reply(c, result);
  });
}

/** «Парковка» на странице: мысль во время таймера уходит в инбокс. */
timerRoutes.post("/timer/park", requireUser, async (c) => {
  const body = (await c.req.json().catch(() => undefined)) as { text?: unknown } | undefined;
  const { outcome } = await items.addInbox(c.var.db, c.var.user.id, body?.text, "web");
  return outcome === "ok" ? c.json({ ok: true }) : c.json({ error: outcome }, 400);
});

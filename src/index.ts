import { Hono } from "hono";
import { apiRoutes } from "./api/routes";
import type { Env } from "./env";
import { runSchedule } from "./jobs/cron";
import { telegramRoutes } from "./telegram/routes";

const app = new Hono<{ Bindings: Env }>();

app.route("/api", apiRoutes);
app.route("/tg", telegramRoutes);

export { TimerAlarm } from "./jobs/timerAlarm";

export default {
  fetch: app.fetch,
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runSchedule(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;

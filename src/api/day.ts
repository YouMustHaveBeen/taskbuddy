import { Hono, type Context } from "hono";
import { day, type DayOutcome, type DayResult } from "../core/day";
import { requireUser, type ApiEnv } from "./session";

export const dayRoutes = new Hono<ApiEnv>();

const statuses: Record<Exclude<DayOutcome, "ok">, 400 | 404 | 409> = { invalid: 400, not_found: 404, none: 409 };

function reply(c: Context<ApiEnv>, result: DayResult) {
  return result.outcome === "ok" ? c.json(result.today) : c.json({ error: result.outcome }, statuses[result.outcome]);
}

dayRoutes.get("/today", requireUser, async (c) => c.json(await day.today(c.var.db, c.var.user, Date.now())));

dayRoutes.post("/today/pick", requireUser, async (c) => {
  const body = (await c.req.json().catch(() => undefined)) as { itemId?: unknown } | undefined;
  return reply(c, await day.pick(c.var.db, c.var.user, Date.now(), body?.itemId));
});

dayRoutes.post("/today/survey/:date/:slot/:position/:answer", requireUser, async (c) => {
  const body: unknown = await c.req.json().catch(() => undefined);
  const target = {
    date: c.req.param("date"),
    slot: c.req.param("slot"),
    position: Number(c.req.param("position")),
    answer: c.req.param("answer"),
  };
  return reply(c, await day.survey(c.var.db, c.var.user, Date.now(), target, body));
});

dayRoutes.post("/today/:slot/:position/:action", requireUser, async (c) => {
  const body: unknown = await c.req.json().catch(() => undefined);
  const target = { slot: c.req.param("slot"), position: Number(c.req.param("position")), action: c.req.param("action") };
  return reply(c, await day.act(c.var.db, c.var.user, Date.now(), target, body));
});

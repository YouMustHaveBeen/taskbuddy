import { Hono } from "hono";
import { insights } from "../core/insights";
import { requireUser, type ApiEnv } from "./session";

export const insightRoutes = new Hono<ApiEnv>();

insightRoutes.get("/insights", requireUser, async (c) => c.json({ insights: await insights.list(c.var.db, c.var.user.id) }));

insightRoutes.patch("/insights/:id", requireUser, async (c) => {
  const body: unknown = await c.req.json().catch(() => undefined);
  const result = await insights.update(c.var.db, c.var.user.id, c.req.param("id"), body);
  if (result.outcome === "ok") return c.json({ insight: result.insight });
  return c.json({ error: result.outcome }, result.outcome === "invalid" ? 400 : 404);
});

insightRoutes.delete("/insights/:id", requireUser, async (c) =>
  (await insights.remove(c.var.db, c.var.user.id, c.req.param("id"))) ? c.body(null, 204) : c.json({ error: "not_found" }, 404),
);

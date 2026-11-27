import { Hono, type Context } from "hono";
import { items, type ItemOutcome } from "../core/items";
import { requireUser, type ApiEnv } from "./session";

export const itemRoutes = new Hono<ApiEnv>();

const statuses = { invalid: 400, not_found: 404, incomplete: 409 } as const;

function reply(c: Context<ApiEnv>, outcome: ItemOutcome, body: Record<string, unknown> = {}) {
  return outcome === "ok" ? c.json(body) : c.json({ error: outcome }, statuses[outcome]);
}

async function jsonBody(c: Context<ApiEnv>): Promise<unknown> {
  return c.req.json().catch(() => undefined);
}

itemRoutes.get("/inbox", requireUser, async (c) => c.json({ items: await items.listInbox(c.var.db, c.var.user.id) }));

itemRoutes.post("/inbox", requireUser, async (c) => {
  const body = (await jsonBody(c)) as { title?: unknown } | undefined;
  const { outcome, id } = await items.addInbox(c.var.db, c.var.user.id, body?.title, "web");
  return reply(c, outcome, { id });
});

itemRoutes.get("/tasks", requireUser, async (c) =>
  c.json({ tasks: await items.listTasks(c.var.db, c.var.user.id, Date.now()) }),
);

itemRoutes.get("/projects", requireUser, async (c) => c.json({ projects: await items.listProjects(c.var.db, c.var.user.id) }));

itemRoutes.get("/items/:id", requireUser, async (c) => {
  const card = await items.get(c.var.db, c.var.user.id, c.req.param("id"));
  return card ? c.json({ card }) : c.json({ error: "not_found" }, 404);
});

itemRoutes.patch("/items/:id", requireUser, async (c) => {
  const { outcome, card } = await items.save(c.var.db, c.var.user.id, c.req.param("id"), await jsonBody(c), Date.now());
  return reply(c, outcome, { card });
});

itemRoutes.post("/items/:id/promote", requireUser, async (c) => {
  const { outcome, card } = await items.promote(
    c.var.db,
    c.var.user.id,
    c.req.param("id"),
    ((await jsonBody(c)) as { type?: unknown } | undefined)?.type,
    Date.now(),
  );
  return reply(c, outcome, { card });
});

itemRoutes.delete("/items/:id", requireUser, async (c) =>
  reply(c, await items.archive(c.var.db, c.var.user.id, c.req.param("id"))),
);

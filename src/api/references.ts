import { Hono, type Context } from "hono";
import { references, type Outcome } from "../core/references";
import { nameLists, type NameList } from "../db/references";
import { requireUser, type ApiEnv } from "./session";

export const referenceRoutes = new Hono<ApiEnv>();
referenceRoutes.use(requireUser);

const statuses = { invalid: 400, not_found: 404, duplicate: 409, in_use: 409 } as const;

function reply(c: Context<ApiEnv>, outcome: Outcome, body: Record<string, unknown> = {}) {
  return outcome === "ok" ? c.json(body) : c.json({ error: outcome }, statuses[outcome]);
}

async function jsonBody(c: Context<ApiEnv>): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => undefined);
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
}

function nameList(c: Context<ApiEnv>): NameList | undefined {
  const list = c.req.param("list") ?? "";
  return Object.hasOwn(nameLists, list) ? (list as NameList) : undefined;
}

referenceRoutes.get("/", async (c) => c.json(await references.listAll(c.var.db, c.var.user.id)));

referenceRoutes.post("/compat", async (c) => {
  const { a, b } = await jsonBody(c);
  return reply(c, await references.addCompat(c.var.db, c.var.user.id, a, b));
});

referenceRoutes.delete("/compat", async (c) => {
  const { a, b } = await jsonBody(c);
  return reply(c, await references.removeCompat(c.var.db, c.var.user.id, a, b));
});

referenceRoutes.post("/rewards", async (c) => {
  const { title, minutes } = await jsonBody(c);
  const { outcome, id } = await references.addReward(c.var.db, c.var.user.id, title, minutes);
  return reply(c, outcome, { id });
});

referenceRoutes.patch("/rewards/:id", async (c) => {
  const { title, minutes } = await jsonBody(c);
  const outcome = await references.updateReward(c.var.db, c.var.user.id, c.req.param("id"), {
    title,
    minutes,
  });
  return reply(c, outcome);
});

referenceRoutes.delete("/rewards/:id", async (c) =>
  reply(c, await references.removeReward(c.var.db, c.var.user.id, c.req.param("id"))),
);

referenceRoutes.post("/:list", async (c) => {
  const list = nameList(c);
  if (!list) return c.body(null, 404);
  const { name } = await jsonBody(c);
  const { outcome, id } = await references.addName(c.var.db, list, c.var.user.id, name);
  return reply(c, outcome, { id });
});

referenceRoutes.patch("/:list/:id", async (c) => {
  const list = nameList(c);
  if (!list) return c.body(null, 404);
  const { name } = await jsonBody(c);
  const outcome = await references.renameName(
    c.var.db,
    list,
    c.var.user.id,
    c.req.param("id"),
    name,
  );
  return reply(c, outcome);
});

referenceRoutes.delete("/:list/:id", async (c) => {
  const list = nameList(c);
  if (!list) return c.body(null, 404);
  return reply(c, await references.removeName(c.var.db, list, c.var.user.id, c.req.param("id")));
});

import { createMiddleware } from "hono/factory";
import { userBySession } from "../core/auth";
import { createDb, type Db } from "../db/client";
import type { User } from "../db/users";
import type { Env } from "../env";

export type ApiEnv = { Bindings: Env; Variables: { user: User; db: Db } };

export const requireUser = createMiddleware<ApiEnv>(async (c, next) => {
  const token = c.req.header("Authorization")?.replace(/^Bearer /i, "") ?? "";
  const db = createDb(c.env.DB);
  const user = token ? await userBySession(db, token, Date.now()) : undefined;
  if (!user) return c.body(null, 401);
  c.set("user", user);
  c.set("db", db);
  await next();
});

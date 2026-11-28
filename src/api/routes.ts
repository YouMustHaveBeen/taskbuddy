import { Hono, type Context } from "hono";
import { signInByLink, type SignedIn } from "../core/auth";
import { createDb } from "../db/client";
import type { User } from "../db/users";
import { dayRoutes } from "./day";
import { insightRoutes } from "./insights";
import { itemRoutes } from "./items";
import { referenceRoutes } from "./references";
import { requireUser, type ApiEnv } from "./session";
import { timerRoutes } from "./timer";

export const apiRoutes = new Hono<ApiEnv>();

apiRoutes.post("/auth/link", async (c) => {
  const token = await bodyField(c, "token");
  if (typeof token !== "string") return c.body(null, 401);
  return signedIn(c, await signInByLink(createDb(c.env.DB), token, Date.now()));
});

apiRoutes.get("/me", requireUser, (c) => c.json({ user: publicUser(c.var.user) }));

apiRoutes.route("/references", referenceRoutes);
apiRoutes.route("/", itemRoutes);
apiRoutes.route("/", dayRoutes);
apiRoutes.route("/", insightRoutes);
apiRoutes.route("/", timerRoutes);

async function bodyField(c: Context, name: string): Promise<unknown> {
  const body: unknown = await c.req.json().catch(() => undefined);
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>)[name] : undefined;
}

function signedIn(c: Context, result?: SignedIn) {
  if (!result) return c.body(null, 401);
  return c.json({ token: result.token, user: publicUser(result.user) });
}

function publicUser(user: User) {
  return { name: user.name, language: user.language };
}

import { Hono, type Context } from "hono";
import { signInByLink, signInByTelegramId, type SignedIn } from "../core/auth";
import { defaults } from "../core/settings";
import { createDb } from "../db/client";
import type { User } from "../db/users";
import { verifyInitData } from "../telegram/initData";
import { dayRoutes } from "./day";
import { itemRoutes } from "./items";
import { referenceRoutes } from "./references";
import { requireUser, type ApiEnv } from "./session";

export const apiRoutes = new Hono<ApiEnv>();

apiRoutes.post("/auth/telegram", async (c) => {
  const initData = await bodyField(c, "initData");
  if (typeof initData !== "string") return c.body(null, 401);
  const now = Date.now();
  const telegramId = await verifyInitData(
    initData,
    c.env.TELEGRAM_BOT_TOKEN,
    now,
    defaults.initDataMaxAgeMinutes * 60_000,
  );
  if (telegramId === undefined) return c.body(null, 401);
  return signedIn(c, await signInByTelegramId(createDb(c.env.DB), telegramId, now));
});

apiRoutes.post("/auth/link", async (c) => {
  const token = await bodyField(c, "token");
  if (typeof token !== "string") return c.body(null, 401);
  return signedIn(c, await signInByLink(createDb(c.env.DB), token, Date.now()));
});

apiRoutes.get("/me", requireUser, (c) => c.json({ user: publicUser(c.var.user) }));

apiRoutes.route("/references", referenceRoutes);
apiRoutes.route("/", itemRoutes);
apiRoutes.route("/", dayRoutes);

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

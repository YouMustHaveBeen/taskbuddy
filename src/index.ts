import { Hono } from "hono";
import { apiRoutes } from "./api/routes";
import type { Env } from "./env";
import { telegramRoutes } from "./telegram/routes";

const app = new Hono<{ Bindings: Env }>();

app.route("/api", apiRoutes);
app.route("/tg", telegramRoutes);

export default app;

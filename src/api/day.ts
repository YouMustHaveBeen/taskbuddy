import { Hono } from "hono";
import { day } from "../core/day";
import { requireUser, type ApiEnv } from "./session";

export const dayRoutes = new Hono<ApiEnv>();

dayRoutes.get("/today", requireUser, async (c) => c.json(await day.today(c.var.db, c.var.user, Date.now())));

import type { Db } from "../db/client";
import { deleteInsight, listInsights, updateInsight, type InsightRow } from "../db/insights";
import { defaults } from "./settings";

export type InsightResult = { outcome: "ok" | "invalid" | "not_found"; insight?: InsightRow };

/** Правка инсайта: текст (не пустой, в пределах длины) и сферы (до itemMaxSpheres, без повторов). */
function parse(raw: unknown): { text?: string; sphereIds?: string[] } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const body = raw as Record<string, unknown>;
  const patch: { text?: string; sphereIds?: string[] } = {};
  if (body.text !== undefined) {
    if (typeof body.text !== "string") return undefined;
    const text = body.text.trim();
    if (text === "" || text.length > defaults.itemTextMaxLength) return undefined;
    patch.text = text;
  }
  if (body.sphereIds !== undefined) {
    const ids = body.sphereIds;
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) return undefined;
    const unique = [...new Set(ids as string[])];
    if (unique.length > defaults.itemMaxSpheres) return undefined;
    patch.sphereIds = unique;
  }
  return patch.text === undefined && patch.sphereIds === undefined ? undefined : patch;
}

export const insights = {
  list: listInsights,

  async update(db: Db, userId: string, id: string, raw: unknown): Promise<InsightResult> {
    const patch = parse(raw);
    if (!patch) return { outcome: "invalid" };
    const insight = await updateInsight(db, userId, id, patch);
    return insight ? { outcome: "ok", insight } : { outcome: "not_found" };
  },

  remove: deleteInsight,
};

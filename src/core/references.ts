import type { Db } from "../db/client";
import {
  addCompat,
  addName,
  addReward,
  listAll,
  removeCompat,
  removeName,
  removeReward,
  renameName,
  updateReward,
  type CompatPair,
  type NameList,
  type RewardRow,
  type WriteResult,
} from "../db/references";
import { defaults } from "./settings";

export type Outcome = WriteResult | "invalid";

export function cleanText(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const text = raw.trim();
  return text.length > 0 && text.length <= defaults.referenceNameMaxLength ? text : undefined;
}

function cleanMinutes(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : undefined;
}

export const references = {
  listAll,

  async addName(
    db: Db,
    list: NameList,
    userId: string,
    raw: unknown,
  ): Promise<{ outcome: Outcome; id?: string }> {
    const name = cleanText(raw);
    if (!name) return { outcome: "invalid" };
    const id = crypto.randomUUID();
    const outcome = await addName(db, list, userId, id, name);
    return outcome === "ok" ? { outcome, id } : { outcome };
  },

  async renameName(
    db: Db,
    list: NameList,
    userId: string,
    id: string,
    raw: unknown,
  ): Promise<Outcome> {
    const name = cleanText(raw);
    return name ? renameName(db, list, userId, id, name) : "invalid";
  },

  removeName,

  async addReward(
    db: Db,
    userId: string,
    title: unknown,
    minutes: unknown,
  ): Promise<{ outcome: Outcome; id?: string }> {
    const cleanTitle = cleanText(title);
    const cleanTime = minutes === undefined ? defaults.rewardMinutes : cleanMinutes(minutes);
    if (!cleanTitle || cleanTime === undefined) return { outcome: "invalid" };
    const row: RewardRow = { id: crypto.randomUUID(), title: cleanTitle, minutes: cleanTime };
    await addReward(db, userId, row);
    return { outcome: "ok", id: row.id };
  },

  async updateReward(
    db: Db,
    userId: string,
    id: string,
    fields: { title?: unknown; minutes?: unknown },
  ): Promise<Outcome> {
    const changes: Partial<Pick<RewardRow, "title" | "minutes">> = {};
    if (fields.title !== undefined) {
      const title = cleanText(fields.title);
      if (!title) return "invalid";
      changes.title = title;
    }
    if (fields.minutes !== undefined) {
      const minutes = cleanMinutes(fields.minutes);
      if (minutes === undefined) return "invalid";
      changes.minutes = minutes;
    }
    return Object.keys(changes).length > 0 ? updateReward(db, userId, id, changes) : "invalid";
  },

  removeReward,

  async addCompat(db: Db, userId: string, a: unknown, b: unknown): Promise<Outcome> {
    const pair = orderedPair(a, b);
    return pair ? addCompat(db, userId, pair) : "invalid";
  },

  async removeCompat(db: Db, userId: string, a: unknown, b: unknown): Promise<Outcome> {
    const pair = orderedPair(a, b);
    return pair ? removeCompat(db, userId, pair) : "invalid";
  },
};

function orderedPair(a: unknown, b: unknown): CompatPair | undefined {
  if (typeof a !== "string" || typeof b !== "string" || a === b) return undefined;
  return a < b ? { categoryA: a, categoryB: b } : { categoryA: b, categoryB: a };
}

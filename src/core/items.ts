import type { Db } from "../db/client";
import {
  archiveItem,
  promoteCard,
  createInbox,
  listInbox,
  listProjects,
  loadCard,
  referencesBelongTo,
  saveCard,
  type Card,
  type CardWrite,
  type Flavor,
  type InboxRow,
  type TaskFields,
} from "../db/items";
import { defaults } from "./settings";

export type { Card, InboxRow };
export type ItemOutcome = "ok" | "not_found" | "invalid" | "incomplete";
export type MissingField = "why" | "spheres" | "kind";

/** Обязательные поля карточки; те же условия повторены в SQL (completeSql в src/db/items.ts). */
export function missingFields(card: Card): MissingField[] {
  const missing: MissingField[] = [];
  if ((card.important || card.impactful) && !card.why) missing.push("why");
  if (card.sphereIds.length === 0) missing.push("spheres");
  if (card.actionKindId === null) missing.push("kind");
  return missing;
}

const flavors: readonly Flavor[] = ["dopamine", "frog"];

function text(raw: unknown, max: number): string | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  if (value.length > max) return undefined;
  return value === "" ? null : value;
}

const mark = (raw: unknown) => (raw === null || typeof raw === "boolean" ? raw : undefined);
const flag = (raw: unknown) => (typeof raw === "boolean" ? raw : undefined);
const id = (raw: unknown) => (raw === null || (typeof raw === "string" && raw !== "") ? raw : undefined);
const moment = (raw: unknown) =>
  raw === null || (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) ? raw : undefined;

type Parsed = { write: CardWrite; references: { sphereIds?: string[]; actionKindId?: string | null; categoryId?: string | null; projectId?: string | null } };

/** Проверяет изменения карточки: только известные поля нужных типов. */
export function parsePatch(raw: unknown): Parsed | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const body = raw as Record<string, unknown>;
  const task: TaskFields = {};
  const write: CardWrite = { task };
  const references: Parsed["references"] = {};
  const max = defaults.itemTextMaxLength;

  const simple: Record<string, (value: unknown) => unknown> = {
    important: mark,
    urgent: mark,
    impactful: mark,
    easy: mark,
    why: (value) => text(value, max),
    actionKindId: id,
    categoryId: id,
    projectId: id,
    deadline: moment,
    remindAt: moment,
    deferredUntil: moment,
    isProject: flag,
    deferred: flag,
    queued: flag,
    waitingFor: (value) => text(value, max),
    firstStepText: (value) => text(value, max),
    flavor: (value) => (value === null || flavors.includes(value as Flavor) ? value : undefined),
  };

  for (const [key, value] of Object.entries(body)) {
    if (key === "title") {
      const title = typeof value === "string" ? value.trim() : "";
      if (title === "" || title.length > defaults.itemTitleMaxLength) return undefined;
      write.title = title;
    } else if (key === "sphereIds") {
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry === "")) return undefined;
      write.sphereIds = [...new Set(value as string[])];
      if (write.sphereIds.length > defaults.itemMaxSpheres) return undefined;
      references.sphereIds = write.sphereIds;
    } else if (Object.hasOwn(simple, key)) {
      const parsed = simple[key](value);
      if (parsed === undefined) return undefined;
      (task as Record<string, unknown>)[key] = parsed;
      if (key === "actionKindId" || key === "categoryId" || key === "projectId") references[key] = parsed as string | null;
    } else {
      return undefined;
    }
  }
  return { write, references };
}

export function titleFrom(raw: unknown): string | undefined {
  const title = typeof raw === "string" ? raw.trim() : "";
  return title !== "" && title.length <= defaults.itemTitleMaxLength ? title : undefined;
}

export type CardView = Card & { missing: MissingField[] };

function view(card: Card): CardView {
  return { ...card, missing: missingFields(card) };
}

export const items = {
  async addInbox(db: Db, userId: string, rawTitle: unknown, source: "bot" | "web"): Promise<{ outcome: ItemOutcome; id?: string }> {
    const title = titleFrom(rawTitle);
    if (!title) return { outcome: "invalid" };
    const newId = crypto.randomUUID();
    await createInbox(db, { id: newId, ownerId: userId, title, source, now: Date.now() });
    return { outcome: "ok", id: newId };
  },

  listInbox,
  listProjects,

  async get(db: Db, userId: string, itemId: string): Promise<CardView | undefined> {
    const card = await loadCard(db, userId, itemId);
    return card && view(card);
  },

  async save(
    db: Db,
    userId: string,
    itemId: string,
    rawPatch: unknown,
    now: number,
  ): Promise<{ outcome: ItemOutcome; card?: CardView }> {
    const parsed = parsePatch(rawPatch);
    if (!parsed) return { outcome: "invalid" };
    const before = await loadCard(db, userId, itemId);
    if (!before) return { outcome: "not_found" };
    if (before.kind !== "inbox" && before.kind !== "task") return { outcome: "invalid" };
    if (parsed.references.projectId === itemId) return { outcome: "invalid" };
    const hasReferences = Object.values(parsed.references).some((value) => (Array.isArray(value) ? value.length : value));
    if (hasReferences && !(await referencesBelongTo(db, before.ownerId, parsed.references))) {
      return { outcome: "invalid" };
    }
    const { write } = parsed;
    if (write.task.waitingFor !== undefined) {
      if (write.task.waitingFor === null) write.task.waitingSince = null;
      else if (before.waitingFor === null) write.task.waitingSince = now;
    }
    return { outcome: "ok", card: view(await saveCard(db, itemId, write, now)) };
  },

  /** Кнопка «Добавить задачу»: запись уходит из инбокса, если заполнены обязательные поля. */
  async promote(db: Db, userId: string, itemId: string, now: number): Promise<{ outcome: ItemOutcome; card?: CardView }> {
    const before = await loadCard(db, userId, itemId);
    if (!before) return { outcome: "not_found" };
    if (before.kind !== "inbox" && before.kind !== "task") return { outcome: "invalid" };
    if (missingFields(before).length > 0) return { outcome: "incomplete" };
    if (!(await promoteCard(db, itemId, now))) return { outcome: "incomplete" };
    const card = await loadCard(db, userId, itemId);
    return card ? { outcome: "ok", card: view(card) } : { outcome: "not_found" };
  },

  async archive(db: Db, userId: string, itemId: string): Promise<ItemOutcome> {
    return (await archiveItem(db, userId, itemId, "irrelevant", Date.now())) ? "ok" : "not_found";
  },
};

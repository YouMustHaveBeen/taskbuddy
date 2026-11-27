import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import type { Db } from "./client";
import { actionKinds, categories, itemSpheres, items, spheres, tasks } from "./schema";

export type Flavor = "dopamine" | "frog";
export type ItemKind = "inbox" | "idea" | "task" | "routine" | "practice";

export type Card = {
  id: string;
  kind: ItemKind;
  ownerId: string;
  title: string;
  important: boolean | null;
  urgent: boolean | null;
  impactful: boolean | null;
  easy: boolean | null;
  why: string | null;
  sphereIds: string[];
  actionKindId: string | null;
  categoryId: string | null;
  deadline: number | null;
  remindAt: number | null;
  projectId: string | null;
  isProject: boolean;
  deferred: boolean;
  deferredUntil: number | null;
  queued: boolean;
  waitingFor: string | null;
  waitingSince: number | null;
  flavor: Flavor | null;
  firstStepText: string | null;
};

/** Поля карточки, лежащие в таблице tasks (кроме id). */
export type TaskFields = Partial<
  Pick<
    Card,
    | "important"
    | "urgent"
    | "impactful"
    | "easy"
    | "why"
    | "actionKindId"
    | "categoryId"
    | "deadline"
    | "remindAt"
    | "projectId"
    | "deferred"
    | "deferredUntil"
    | "queued"
    | "waitingFor"
    | "waitingSince"
    | "flavor"
    | "firstStepText"
  >
>;

export type CardWrite = { title?: string; sphereIds?: string[]; task: TaskFields };

export type References = {
  sphereIds?: string[];
  actionKindId?: string | null;
  categoryId?: string | null;
  projectId?: string | null;
};

const taskColumns: Record<keyof TaskFields, string> = {
  important: "important",
  urgent: "urgent",
  impactful: "impactful",
  easy: "easy",
  why: "why",
  actionKindId: "action_kind_id",
  categoryId: "category_id",
  deadline: "deadline",
  remindAt: "remind_at",
  projectId: "project_id",
  deferred: "deferred",
  deferredUntil: "deferred_until",
  queued: "queued",
  waitingFor: "waiting_for",
  waitingSince: "waiting_since",
  flavor: "flavor",
  firstStepText: "first_step_text",
};

const visible = (userId: string) => or(eq(items.ownerId, userId), eq(items.creatorId, userId));

export async function createInbox(
  db: Db,
  row: { id: string; ownerId: string; title: string; source: "bot" | "web" | "mcp"; now: number },
): Promise<void> {
  await db.$client
    .prepare(
      `INSERT INTO items (id, kind, title, owner_id, creator_id, household_id, source, created_at, updated_at)
      SELECT ?, 'inbox', ?, id, id, household_id, ?, ?, ? FROM users WHERE id = ?`,
    )
    .bind(row.id, row.title, row.source, row.now, row.now, row.ownerId)
    .run();
}

export type InboxRow = { id: string; title: string; createdAt: number };

/** Индекс items_owner_kind (owner_id, kind, archived_at); записи автора ищутся по items_creator. */
export async function listInbox(db: Db, userId: string): Promise<InboxRow[]> {
  return db
    .select({ id: items.id, title: items.title, createdAt: items.createdAt })
    .from(items)
    .where(and(visible(userId), eq(items.kind, "inbox"), isNull(items.archivedAt)))
    .orderBy(desc(items.createdAt));
}

export async function listProjects(db: Db, userId: string): Promise<{ id: string; title: string }[]> {
  return db
    .select({ id: items.id, title: items.title })
    .from(items)
    .innerJoin(tasks, eq(tasks.id, items.id))
    .where(and(visible(userId), eq(items.kind, "task"), eq(tasks.isProject, true), isNull(items.archivedAt)))
    .orderBy(items.title);
}

function cardFrom(
  row: {
    item: typeof items.$inferSelect;
    task: typeof tasks.$inferSelect | null;
  },
  sphereIds: string[],
): Card {
  const { item, task } = row;
  return {
    id: item.id,
    kind: item.kind,
    ownerId: item.ownerId,
    title: item.title,
    important: task?.important ?? null,
    urgent: task?.urgent ?? null,
    impactful: task?.impactful ?? null,
    easy: task?.easy ?? null,
    why: task?.why ?? null,
    sphereIds,
    actionKindId: task?.actionKindId ?? null,
    categoryId: task?.categoryId ?? null,
    deadline: task?.deadline ?? null,
    remindAt: task?.remindAt ?? null,
    projectId: task?.projectId ?? null,
    isProject: task?.isProject ?? false,
    deferred: task?.deferred ?? false,
    deferredUntil: task?.deferredUntil ?? null,
    queued: task?.queued ?? false,
    waitingFor: task?.waitingFor ?? null,
    waitingSince: task?.waitingSince ?? null,
    flavor: task?.flavor ?? null,
    firstStepText: task?.firstStepText ?? null,
  };
}

/** Читает карточку записи, видимую пользователю; один batch (запись, ее поля задачи и сферы). */
export async function loadCard(db: Db, userId: string, id: string): Promise<Card | undefined> {
  const [itemRows, taskRows, sphereRows] = await db.batch([
    db
      .select()
      .from(items)
      .where(and(eq(items.id, id), visible(userId), isNull(items.archivedAt))),
    db.select().from(tasks).where(eq(tasks.id, id)),
    db.select({ sphereId: itemSpheres.sphereId }).from(itemSpheres).where(eq(itemSpheres.itemId, id)),
  ]);
  const item = itemRows[0];
  if (!item) return undefined;
  return cardFrom({ item, task: taskRows[0] ?? null }, sphereRows.map((r) => r.sphereId));
}

/** Проверяет, что сферы, вид, категория и проект принадлежат владелице записи. Один batch. */
export async function referencesBelongTo(db: Db, ownerId: string, refs: References): Promise<boolean> {
  const sphereIds = [...new Set(refs.sphereIds ?? [])];
  const one = (value: string | null | undefined) => (value ? [value] : []);
  const kindIds = one(refs.actionKindId);
  const categoryIds = one(refs.categoryId);
  const projectIds = one(refs.projectId);
  // QUERY BUDGET EXCEPTION: проверка принадлежности четырех видов ссылок
  const [ownSpheres, ownKinds, ownCategories, ownProjects] = await db.batch([
    db
      .select({ id: spheres.id })
      .from(spheres)
      .where(and(eq(spheres.userId, ownerId), inArray(spheres.id, sphereIds))),
    db
      .select({ id: actionKinds.id })
      .from(actionKinds)
      .where(and(eq(actionKinds.userId, ownerId), inArray(actionKinds.id, kindIds))),
    db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.userId, ownerId), inArray(categories.id, categoryIds))),
    db
      .select({ id: tasks.id })
      .from(tasks)
      .innerJoin(items, eq(items.id, tasks.id))
      .where(
        and(
          inArray(tasks.id, projectIds),
          eq(tasks.isProject, true),
          eq(items.kind, "task"),
          isNull(items.archivedAt),
          eq(items.ownerId, ownerId),
        ),
      ),
  ]);
  return (
    ownSpheres.length === sphereIds.length &&
    ownKinds.length === kindIds.length &&
    ownCategories.length === categoryIds.length &&
    ownProjects.length === projectIds.length
  );
}

/** Условие «обязательные поля заполнены»; должно совпадать с missingFields в core. */
const completeSql = `
  EXISTS (
    SELECT 1 FROM tasks t WHERE t.id = items.id
      AND t.action_kind_id IS NOT NULL
      AND ((coalesce(t.important, 0) = 0 AND coalesce(t.impactful, 0) = 0) OR length(trim(coalesce(t.why, ''))) > 0)
  )
  AND EXISTS (SELECT 1 FROM item_spheres s WHERE s.item_id = items.id)`;

type RawItem = {
  id: string;
  kind: ItemKind;
  owner_id: string;
  title: string;
};

type RawTask = {
  important: number | null;
  urgent: number | null;
  impactful: number | null;
  easy: number | null;
  why: string | null;
  action_kind_id: string | null;
  category_id: string | null;
  deadline: number | null;
  remind_at: number | null;
  project_id: string | null;
  is_project: number;
  deferred: number;
  deferred_until: number | null;
  queued: number;
  waiting_for: string | null;
  waiting_since: number | null;
  flavor: Flavor | null;
  first_step_text: string | null;
};

const flag = (value: number | null): boolean | null => (value === null ? null : value !== 0);

function cardFromRaw(item: RawItem, task: RawTask, sphereIds: string[]): Card {
  return {
    id: item.id,
    kind: item.kind,
    ownerId: item.owner_id,
    title: item.title,
    important: flag(task.important),
    urgent: flag(task.urgent),
    impactful: flag(task.impactful),
    easy: flag(task.easy),
    why: task.why,
    sphereIds,
    actionKindId: task.action_kind_id,
    categoryId: task.category_id,
    deadline: task.deadline,
    remindAt: task.remind_at,
    projectId: task.project_id,
    isProject: task.is_project !== 0,
    deferred: task.deferred !== 0,
    deferredUntil: task.deferred_until,
    queued: task.queued !== 0,
    waitingFor: task.waiting_for,
    waitingSince: task.waiting_since,
    flavor: task.flavor,
    firstStepText: task.first_step_text,
  };
}

/**
 * Сохраняет изменения карточки (вид записи не меняет) и в том же batch читает итоговую карточку из базы.
 */
export async function saveCard(db: Db, id: string, write: CardWrite, now: number): Promise<Card> {
  const d1 = db.$client;
  const statements: D1PreparedStatement[] = [d1.prepare("INSERT OR IGNORE INTO tasks (id) VALUES (?)").bind(id)];

  const columns = Object.keys(write.task) as (keyof TaskFields)[];
  if (columns.length > 0) {
    const set = columns.map((key) => `${taskColumns[key]} = ?`).join(", ");
    const values = columns.map((key) => {
      const value = write.task[key];
      return typeof value === "boolean" ? Number(value) : (value ?? null);
    });
    statements.push(d1.prepare(`UPDATE tasks SET ${set} WHERE id = ?`).bind(...values, id));
  }

  if (write.title !== undefined) {
    statements.push(d1.prepare("UPDATE items SET title = ?, updated_at = ? WHERE id = ?").bind(write.title, now, id));
  } else {
    statements.push(d1.prepare("UPDATE items SET updated_at = ? WHERE id = ?").bind(now, id));
  }

  if (write.sphereIds) {
    statements.push(d1.prepare("DELETE FROM item_spheres WHERE item_id = ?").bind(id));
    for (const sphereId of write.sphereIds) {
      statements.push(d1.prepare("INSERT INTO item_spheres (item_id, sphere_id) VALUES (?, ?)").bind(id, sphereId));
    }
  }

  statements.push(
    d1.prepare("SELECT id, kind, owner_id, title FROM items WHERE id = ?").bind(id),
    d1.prepare("SELECT * FROM tasks WHERE id = ?").bind(id),
    d1.prepare("SELECT sphere_id FROM item_spheres WHERE item_id = ?").bind(id),
  );

  const results = await d1.batch(statements);
  const [item, task, spheresRaw] = results.slice(-3);
  return cardFromRaw(
    item.results[0] as RawItem,
    task.results[0] as RawTask,
    (spheresRaw.results as { sphere_id: string }[]).map((row) => row.sphere_id),
  );
}

/** Кнопка «Добавить»: условный перевод в задачи или проекты и чтение итоговой карточки одним batch. */
export async function promoteCard(db: Db, userId: string, id: string, asProject: boolean, now: number): Promise<Card | "other_kind" | undefined> {
  const d1 = db.$client;
  const mine = "(owner_id = ? OR creator_id = ?) AND archived_at IS NULL";
  // QUERY BUDGET EXCEPTION: создание строки задачи, перевод в задачи и чтение карточки (запись, задача, сферы)
  const results = await d1.batch([
    d1.prepare(`INSERT OR IGNORE INTO tasks (id) SELECT id FROM items WHERE id = ? AND kind IN ('inbox', 'task') AND ${mine}`).bind(id, userId, userId),
    d1
      .prepare(
        `UPDATE tasks SET is_project = ? WHERE id = ? AND EXISTS (
          SELECT 1 FROM items WHERE items.id = tasks.id AND items.kind = 'inbox' AND ${mine} AND ${completeSql})`,
      )
      .bind(Number(asProject), id, userId, userId),
    d1
      .prepare(`UPDATE items SET kind = 'task', updated_at = ? WHERE id = ? AND kind = 'inbox' AND ${mine} AND ${completeSql}`)
      .bind(now, id, userId, userId),
    d1.prepare(`SELECT id, kind, owner_id, title FROM items WHERE id = ? AND ${mine}`).bind(id, userId, userId),
    d1.prepare("SELECT * FROM tasks WHERE id = ?").bind(id),
    d1.prepare("SELECT sphere_id FROM item_spheres WHERE item_id = ?").bind(id),
  ]);
  const [, , , item, task, spheresRaw] = results;
  const found = item.results[0] as RawItem | undefined;
  if (!found) return undefined;
  if (found.kind !== "inbox" && found.kind !== "task") return "other_kind";
  return cardFromRaw(
    item.results[0] as RawItem,
    task.results[0] as RawTask,
    (spheresRaw.results as { sphere_id: string }[]).map((row) => row.sphere_id),
  );
}

/** ownerName: имя хозяина задачи, если это не сам пользователь (задача, которой поделились); иначе null. */
export type TaskRow = Card & { createdAt: number; ownerName: string | null };

/** Задачи, видимые пользователю (владелица или автор), не в архиве; UNION по индексам items_owner_kind и items_creator. Один batch. */
export async function listTasks(db: Db, userId: string): Promise<TaskRow[]> {
  const d1 = db.$client;
  const active = "kind = 'task' AND archived_at IS NULL";
  const mine = `i.id IN (SELECT id FROM items WHERE owner_id = ?1 AND ${active} UNION SELECT id FROM items WHERE creator_id = ?1 AND ${active})`;
  const [taskRows, sphereRows] = await d1.batch([
    d1
      .prepare(
        `SELECT t.*, i.id, i.kind, i.owner_id, i.title, i.created_at,
          CASE WHEN i.owner_id = ?1 THEN NULL ELSE u.name END AS owner_name
        FROM items i JOIN tasks t ON t.id = i.id JOIN users u ON u.id = i.owner_id WHERE ${mine}`,
      )
      .bind(userId),
    d1.prepare(`SELECT s.item_id, s.sphere_id FROM item_spheres s JOIN items i ON i.id = s.item_id WHERE ${mine}`).bind(userId),
  ]);
  const spheresOf = new Map<string, string[]>();
  for (const row of sphereRows.results as { item_id: string; sphere_id: string }[]) {
    spheresOf.set(row.item_id, [...(spheresOf.get(row.item_id) ?? []), row.sphere_id]);
  }
  return (taskRows.results as (RawItem & RawTask & { created_at: number; owner_name: string | null })[]).map((row) => ({
    ...cardFromRaw(row, row, spheresOf.get(row.id) ?? []),
    createdAt: row.created_at,
    ownerName: row.owner_name,
  }));
}

export async function archiveItem(
  db: Db,
  userId: string,
  id: string,
  reason: "done" | "irrelevant",
  now: number,
): Promise<boolean> {
  const row = await db
    .update(items)
    .set({ archivedAt: now, archiveReason: reason, updatedAt: now })
    .where(and(eq(items.id, id), visible(userId), isNull(items.archivedAt)))
    .returning({ id: items.id })
    .get();
  return row !== undefined;
}

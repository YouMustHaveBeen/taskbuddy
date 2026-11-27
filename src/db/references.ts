import { and, asc, eq, or } from "drizzle-orm";
import type { Db } from "./client";
import { actionKinds, categories, categoryCompat, rewards, spheres } from "./schema";

export const nameLists = { spheres, "action-kinds": actionKinds, categories } as const;
export type NameList = keyof typeof nameLists;

export type WriteResult = "ok" | "duplicate" | "not_found" | "in_use";

export type NameRow = { id: string; name: string };
export type RewardRow = { id: string; title: string; minutes: number };
export type CompatPair = { categoryA: string; categoryB: string };

function failure(error: unknown): WriteResult {
  const message = error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : "";
  if (message.includes("UNIQUE")) return "duplicate";
  if (message.includes("FOREIGN KEY")) return "in_use";
  throw error;
}

export async function addName(
  db: Db,
  list: NameList,
  userId: string,
  id: string,
  name: string,
): Promise<WriteResult> {
  try {
    await db.insert(nameLists[list]).values({ id, userId, name });
    return "ok";
  } catch (error) {
    return failure(error);
  }
}

export async function renameName(
  db: Db,
  list: NameList,
  userId: string,
  id: string,
  name: string,
): Promise<WriteResult> {
  const table = nameLists[list];
  try {
    const row = await db
      .update(table)
      .set({ name })
      .where(and(eq(table.id, id), eq(table.userId, userId)))
      .returning({ id: table.id })
      .get();
    return row ? "ok" : "not_found";
  } catch (error) {
    return failure(error);
  }
}

export async function removeName(
  db: Db,
  list: NameList,
  userId: string,
  id: string,
): Promise<WriteResult> {
  const table = nameLists[list];
  const removeRow = db
    .delete(table)
    .where(and(eq(table.id, id), eq(table.userId, userId)))
    .returning({ id: table.id });
  try {
    if (list === "categories") {
      const [, removed] = await db.batch([
        db
          .delete(categoryCompat)
          .where(
            and(
              eq(categoryCompat.userId, userId),
              or(eq(categoryCompat.categoryA, id), eq(categoryCompat.categoryB, id)),
            ),
          ),
        removeRow,
      ]);
      return removed.length > 0 ? "ok" : "not_found";
    }
    return (await removeRow.get()) ? "ok" : "not_found";
  } catch (error) {
    return failure(error);
  }
}

export async function addReward(db: Db, userId: string, row: RewardRow): Promise<void> {
  await db.insert(rewards).values({ ...row, userId });
}

export async function updateReward(
  db: Db,
  userId: string,
  id: string,
  changes: Partial<Pick<RewardRow, "title" | "minutes">>,
): Promise<WriteResult> {
  const row = await db
    .update(rewards)
    .set(changes)
    .where(and(eq(rewards.id, id), eq(rewards.userId, userId)))
    .returning({ id: rewards.id })
    .get();
  return row ? "ok" : "not_found";
}

export async function removeReward(db: Db, userId: string, id: string): Promise<WriteResult> {
  const row = await db
    .delete(rewards)
    .where(and(eq(rewards.id, id), eq(rewards.userId, userId)))
    .returning({ id: rewards.id })
    .get();
  return row ? "ok" : "not_found";
}

export async function addCompat(
  db: Db,
  userId: string,
  pair: CompatPair,
): Promise<WriteResult> {
  const own = await db
    .select({ id: categories.id })
    .from(categories)
    .where(
      and(
        eq(categories.userId, userId),
        or(eq(categories.id, pair.categoryA), eq(categories.id, pair.categoryB)),
      ),
    );
  if (own.length !== 2) return "not_found";
  try {
    await db.insert(categoryCompat).values({ userId, ...pair });
    return "ok";
  } catch (error) {
    return failure(error);
  }
}

export async function removeCompat(
  db: Db,
  userId: string,
  pair: CompatPair,
): Promise<WriteResult> {
  const row = await db
    .delete(categoryCompat)
    .where(
      and(
        eq(categoryCompat.userId, userId),
        eq(categoryCompat.categoryA, pair.categoryA),
        eq(categoryCompat.categoryB, pair.categoryB),
      ),
    )
    .returning({ userId: categoryCompat.userId })
    .get();
  return row ? "ok" : "not_found";
}

export type ReferenceLists = {
  spheres: NameRow[];
  actionKinds: NameRow[];
  categories: NameRow[];
  rewards: RewardRow[];
  compat: CompatPair[];
};

export async function listAll(db: Db, userId: string): Promise<ReferenceLists> {
  const names = (table: (typeof nameLists)[NameList]) =>
    db
      .select({ id: table.id, name: table.name })
      .from(table)
      .where(eq(table.userId, userId))
      .orderBy(asc(table.name));
  // QUERY BUDGET EXCEPTION: пять списков справочников одним batch для вкладки
  const [spheresRows, actionKindRows, categoryRows, rewardRows, compat] = await db.batch([
    names(spheres),
    names(actionKinds),
    names(categories),
    db
      .select({ id: rewards.id, title: rewards.title, minutes: rewards.minutes })
      .from(rewards)
      .where(eq(rewards.userId, userId))
      .orderBy(asc(rewards.title)),
    db
      .select({ categoryA: categoryCompat.categoryA, categoryB: categoryCompat.categoryB })
      .from(categoryCompat)
      .where(eq(categoryCompat.userId, userId)),
  ]);
  return {
    spheres: spheresRows,
    actionKinds: actionKindRows,
    categories: categoryRows,
    rewards: rewardRows,
    compat,
  };
}

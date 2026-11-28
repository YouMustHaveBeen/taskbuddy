import { eq } from "drizzle-orm";
import type { Db } from "./client";
import { users } from "./schema";

export type User = typeof users.$inferSelect;

export async function findUserByTelegramId(db: Db, telegramId: number): Promise<User | undefined> {
  return db.select().from(users).where(eq(users.telegramId, telegramId)).get();
}

/** Пользователь по id (первичный ключ). */
export async function findUserById(db: Db, id: string): Promise<User | undefined> {
  return db.select().from(users).where(eq(users.id, id)).get();
}

export async function createFirstUser(db: Db, user: User): Promise<User | undefined> {
  const noUsers = "WHERE NOT EXISTS (SELECT 1 FROM users)";
  const d1 = db.$client;
  const [, inserted] = await d1.batch([
    d1
      .prepare(`INSERT INTO households (id, created_at) SELECT ?, ? ${noUsers}`)
      .bind(user.householdId, user.createdAt),
    d1
      .prepare(
        `INSERT INTO users (id, household_id, telegram_id, name, language, timezone, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ? ${noUsers} RETURNING id`,
      )
      .bind(
        user.id,
        user.householdId,
        user.telegramId,
        user.name,
        user.language,
        user.timezone,
        user.createdAt,
      ),
  ]);
  return inserted.results.length > 0 ? user : undefined;
}

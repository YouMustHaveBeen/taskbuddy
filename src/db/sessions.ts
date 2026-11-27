import { and, eq, gt, isNull, lt } from "drizzle-orm";
import type { Db } from "./client";
import { sessions, users } from "./schema";
import type { User } from "./users";

type NewSession = typeof sessions.$inferInsert;

export async function insertSession(db: Db, session: NewSession): Promise<void> {
  await db.batch([
    db.delete(sessions).where(lt(sessions.expiresAt, session.createdAt)),
    db.insert(sessions).values(session),
  ]);
}

export async function insertSessionAndGetUser(
  db: Db,
  session: NewSession,
): Promise<User | undefined> {
  const [, , user] = await db.batch([
    db.delete(sessions).where(lt(sessions.expiresAt, session.createdAt)),
    db.insert(sessions).values(session),
    db.select().from(users).where(eq(users.id, session.userId)),
  ]);
  return user[0];
}

export async function consumeLoginLink(
  db: Db,
  id: string,
  now: number,
): Promise<string | undefined> {
  const row = await db
    .update(sessions)
    .set({ usedAt: now })
    .where(
      and(
        eq(sessions.id, id),
        eq(sessions.kind, "login_link"),
        isNull(sessions.usedAt),
        gt(sessions.expiresAt, now),
      ),
    )
    .returning({ userId: sessions.userId })
    .get();
  return row?.userId;
}

export async function findSessionUser(db: Db, id: string, now: number): Promise<User | undefined> {
  const row = await db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, id), eq(sessions.kind, "session"), gt(sessions.expiresAt, now)))
    .get();
  return row?.user;
}

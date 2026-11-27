import { lt } from "drizzle-orm";
import type { Db } from "./client";
import { tgUpdates } from "./schema";

export async function claimUpdate(
  db: Db,
  updateId: number,
  now: number,
  olderThan: number,
): Promise<boolean> {
  const [, inserted] = await db.batch([
    db.delete(tgUpdates).where(lt(tgUpdates.receivedAt, olderThan)),
    db
      .insert(tgUpdates)
      .values({ updateId, receivedAt: now })
      .onConflictDoNothing()
      .returning({ updateId: tgUpdates.updateId }),
  ]);
  return inserted.length > 0;
}

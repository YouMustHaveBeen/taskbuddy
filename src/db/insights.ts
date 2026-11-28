import type { Db } from "./client";

export type InsightRow = { id: string; text: string; sphereIds: string[] };

/** Инсайты владелицы, новые сверху (порядок записи, rowid): индекс insights_user, сферы по первичному ключу. */
export async function listInsights(db: Db, userId: string): Promise<InsightRow[]> {
  const { results } = await db.$client
    .prepare(
      `SELECT n.id, n.text, group_concat(s.sphere_id) AS spheres
      FROM insights n LEFT JOIN insight_spheres s ON s.insight_id = n.id
      WHERE n.user_id = ?
      GROUP BY n.id
      ORDER BY n.rowid DESC`,
    )
    .bind(userId)
    .all<{ id: string; text: string; spheres: string | null }>();
  return results.map((row) => ({ id: row.id, text: row.text, sphereIds: row.spheres ? row.spheres.split(",") : [] }));
}

/**
 * Правка инсайта одним batch: текст и (если переданы) сферы; сфера записывается, только если она принадлежит
 * владелице. Возвращает инсайт после правки или undefined, если инсайта нет.
 */
export async function updateInsight(
  db: Db,
  userId: string,
  id: string,
  patch: { text?: string; sphereIds?: string[] },
): Promise<InsightRow | undefined> {
  const d1 = db.$client;
  const own = "EXISTS (SELECT 1 FROM insights WHERE id = ? AND user_id = ?)";
  const statements: D1PreparedStatement[] = [];
  if (patch.text !== undefined) {
    statements.push(d1.prepare("UPDATE insights SET text = ? WHERE id = ? AND user_id = ?").bind(patch.text, id, userId));
  }
  if (patch.sphereIds) {
    statements.push(d1.prepare(`DELETE FROM insight_spheres WHERE insight_id = ? AND ${own}`).bind(id, id, userId));
    for (const sphereId of patch.sphereIds) {
      statements.push(
        d1
          .prepare(`INSERT INTO insight_spheres (insight_id, sphere_id) SELECT ?, id FROM spheres WHERE id = ? AND user_id = ? AND ${own}`)
          .bind(id, sphereId, userId, id, userId),
      );
    }
  }
  statements.push(
    d1
      .prepare(
        `SELECT n.id, n.text, group_concat(s.sphere_id) AS spheres
        FROM insights n LEFT JOIN insight_spheres s ON s.insight_id = n.id
        WHERE n.id = ? AND n.user_id = ? GROUP BY n.id`,
      )
      .bind(id, userId),
  );
  // QUERY BUDGET EXCEPTION: правка текста, сфер и чтение инсайта — один batch
  const results = await d1.batch(statements);
  const row = results[results.length - 1].results[0] as { id: string; text: string; spheres: string | null } | undefined;
  return row ? { id: row.id, text: row.text, sphereIds: row.spheres ? row.spheres.split(",") : [] } : undefined;
}

export async function deleteInsight(db: Db, userId: string, id: string): Promise<boolean> {
  const result = await db.$client.prepare("DELETE FROM insights WHERE id = ? AND user_id = ?").bind(id, userId).run();
  return result.meta.changes > 0;
}

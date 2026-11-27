import { drizzle } from "drizzle-orm/d1";

export type Db = ReturnType<typeof drizzle>;

export function createDb(d1: D1Database): Db {
  return drizzle(d1);
}

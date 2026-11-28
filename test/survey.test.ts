import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { day } from "../src/core/day";
import { createDb } from "../src/db/client";
import { createUser, resetDb } from "./helpers";

const db = () => createDb(env.DB);
const D = "2026-11-10";
const NEXT = "2026-11-11";
/** Время по Дублину (в ноябре совпадает с UTC). */
const at = (date: string, time: string) => Date.parse(`${date}T${time}:00Z`);

let ann: { id: string; timezone: string; language: string };
let bob: { id: string; timezone: string; language: string };

beforeEach(async () => {
  await resetDb();
  ann = { id: (await createUser(1001, "Ann")).id, timezone: "Europe/Dublin", language: "ru" };
  bob = { id: (await createUser(2002, "Bob")).id, timezone: "Europe/Dublin", language: "ru" };
});

async function insertTask(ownerId: string, title: string, fields: Record<string, string | number | null> = {}): Promise<string> {
  const id = crypto.randomUUID();
  const columns = Object.keys(fields);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO items (id, kind, title, owner_id, creator_id, household_id, source, created_at, updated_at)
      SELECT ?, 'task', ?, ?, ?, household_id, 'web', 0, 0 FROM users WHERE id = ?`,
    ).bind(id, title, ownerId, ownerId, ownerId),
    env.DB.prepare(
      `INSERT INTO tasks (id${columns.map((c) => `, ${c}`).join("")}) VALUES (?${columns.map(() => ", ?").join("")})`,
    ).bind(id, ...Object.values(fields)),
  ]);
  return id;
}

/** Принятая задача в плане дня `date` (как после «Выбрать»). */
async function accepted(ownerId: string, itemId: string, date: string, position = 0) {
  await env.DB.prepare(
    "INSERT INTO day_plan (user_id, date, slot, position, item_id, state, hidden, created_at) VALUES (?, ?, 'picked', ?, ?, 'accepted', 0, 0)",
  )
    .bind(ownerId, date, position, itemId)
    .run();
}

const task = (id: string) =>
  env.DB.prepare("SELECT skip_count, last_fail_on, flavor, frog_auto FROM tasks WHERE id = ?")
    .bind(id)
    .first<{ skip_count: number; last_fail_on: string | null; flavor: string | null; frog_auto: number }>();
const insights = async () =>
  (await env.DB.prepare("SELECT text FROM insights WHERE user_id = ?").bind(ann.id).all<{ text: string }>()).results.map((r) => r.text);

describe("вечерний опрос", () => {
  it("сегодняшние принятые задачи попадают в опрос с времени опроса; прошлый непройденный опрос закрывает новые задачи", async () => {
    for (let i = 0; i < 5; i++) await insertTask(ann.id, `задача ${i}`, { important: 1, why: "нужно" });
    await day.today(db(), ann, at(D, "12:00"));
    await day.act(db(), ann, at(D, "12:00"), { slot: "important", position: 0, action: "reveal" }, undefined);
    await day.act(db(), ann, at(D, "12:00"), { slot: "important", position: 0, action: "accept" }, undefined);

    expect((await day.today(db(), ann, at(D, "20:59"))).survey).toHaveLength(0);
    const evening = await day.today(db(), ann, at(D, "21:00"));
    expect(evening.survey).toMatchObject([{ date: D, slot: "important", position: 0, askBlocks: true }]);
    expect(evening.locked).toBe(false);

    const morning = await day.today(db(), ann, at(NEXT, "08:00"));
    expect(morning).toMatchObject({ locked: true, buttons: {}, deadlines: [], picked: [] });
    expect(morning.survey).toHaveLength(1);
    const planned = await env.DB.prepare("SELECT count(*) AS n FROM day_plan WHERE date = ?").bind(NEXT).first<{ n: number }>();
    expect(planned?.n).toBe(0);
  });

  it("«На завтра»: задача принятой в плане следующего дня, неудача, «Что мешает?» в инсайты; план дописывается без нее", async () => {
    for (let i = 0; i < 6; i++) await insertTask(ann.id, `задача ${i}`, { important: 1, why: "нужно" });
    const id = await insertTask(ann.id, "перенести");
    await accepted(ann.id, id, D);

    const result = await day.survey(db(), ann, at(NEXT, "08:00"), { date: D, slot: "picked", position: 0, answer: "tomorrow" }, { blocks: "нет времени" });
    expect(result.outcome).toBe("ok");
    expect(result.today).toMatchObject({ locked: false, survey: [] });
    expect(result.today?.picked).toMatchObject([{ itemId: id, date: NEXT, state: "accepted" }]);
    expect(Object.keys(result.today?.buttons ?? {})).toHaveLength(4);
    expect(await task(id)).toMatchObject({ skip_count: 1, last_fail_on: D });
    expect(await insights()).toEqual(["нет времени"]);

    const plan = await day.today(db(), ann, at(NEXT, "08:00"));
    expect(Object.keys(plan.buttons)).toHaveLength(4);
    expect(Object.values(plan.buttons).some((row) => row?.itemId === id)).toBe(false);
    expect(plan.picked.map((row) => row.itemId)).toEqual([id]);
    expect(plan.list.map((row) => row.itemId)).toEqual([id]);

    const again = await day.survey(db(), ann, at(NEXT, "08:00"), { date: D, slot: "picked", position: 0, answer: "tomorrow" }, undefined);
    expect(again.outcome).toBe("not_found");
  });

  it("опрос, пройденный вечером, переносит на завтра; утром опроса нет", async () => {
    const id = await insertTask(ann.id, "перенести");
    await accepted(ann.id, id, D);
    const result = await day.survey(db(), ann, at(D, "21:30"), { date: D, slot: "picked", position: 0, answer: "tomorrow" }, undefined);
    expect(result.today?.survey).toEqual([]);
    const next = await day.today(db(), ann, at(NEXT, "09:00"));
    expect(next.locked).toBe(false);
    expect(next.picked).toMatchObject([{ itemId: id, state: "accepted", date: NEXT }]);
  });

  it("«В хранилище» — неудача; «Удалить» — в архив как неактуальная, без неудачи", async () => {
    const back = await insertTask(ann.id, "вернуть");
    const drop = await insertTask(ann.id, "удалить");
    await accepted(ann.id, back, D, 0);
    await accepted(ann.id, drop, D, 1);
    await day.survey(db(), ann, at(NEXT, "08:00"), { date: D, slot: "picked", position: 0, answer: "back" }, undefined);
    const dropped = await day.survey(db(), ann, at(NEXT, "08:00"), { date: D, slot: "picked", position: 1, answer: "drop" }, { blocks: "x" });
    expect(dropped.today?.locked).toBe(false);
    expect(await task(back)).toMatchObject({ skip_count: 1 });
    expect(await task(drop)).toMatchObject({ skip_count: 0 });
    const item = await env.DB.prepare("SELECT archive_reason FROM items WHERE id = ?").bind(drop).first<{ archive_reason: string }>();
    expect(item?.archive_reason).toBe("irrelevant");
    expect(await insights()).toEqual([]);
    const states = await env.DB.prepare("SELECT state FROM day_plan WHERE date = ? ORDER BY position").bind(D).all<{ state: string }>();
    expect(states.results.map((row) => row.state)).toEqual(["returned", "dropped"]);
  });

  it("не больше одной неудачи на задачу в день: второй раз счетчик не растет и «Что мешает?» не спрашивается", async () => {
    const id = await insertTask(ann.id, "задача", { skip_count: 1, last_fail_on: D });
    await accepted(ann.id, id, D);
    const view = await day.today(db(), ann, at(NEXT, "08:00"));
    expect(view.survey[0].askBlocks).toBe(false);
    await day.survey(db(), ann, at(NEXT, "08:00"), { date: D, slot: "picked", position: 0, answer: "back" }, { blocks: "x" });
    expect(await task(id)).toMatchObject({ skip_count: 1 });
    expect(await insights()).toEqual([]);
  });

  it("на третьей неудаче задача становится лягушкой, а в план следующего дня шестой задачей встает «Подумай, почему откладываешь»", async () => {
    const id = await insertTask(ann.id, "разобрать шкаф", { skip_count: 2 });
    await accepted(ann.id, id, D);
    await day.survey(db(), ann, at(D, "21:30"), { date: D, slot: "picked", position: 0, answer: "back" }, undefined);
    expect(await task(id)).toMatchObject({ skip_count: 3, flavor: "frog", frog_auto: 1 });
    const next = await day.today(db(), ann, at(NEXT, "09:00"));
    expect(next.picked).toMatchObject([{ slot: "think", state: "accepted", title: "Подумай, почему откладываешь: разобрать шкаф" }]);

    const done = await day.act(db(), ann, at(NEXT, "10:00"), { slot: "think", position: 0, action: "done" }, undefined);
    expect(done.today?.picked[0].state).toBe("done");
  });

  it("задача, отмеченная выполненной вне плана, в опрос не попадает", async () => {
    const id = await insertTask(ann.id, "задача");
    await accepted(ann.id, id, D);
    await env.DB.prepare("UPDATE items SET archived_at = 1, archive_reason = 'done' WHERE id = ?").bind(id).run();
    const view = await day.today(db(), ann, at(NEXT, "08:00"));
    expect(view).toMatchObject({ locked: false, survey: [] });
  });

  it("чужую строку опроса не ответить; неверный ответ отвергается", async () => {
    const id = await insertTask(ann.id, "задача");
    await accepted(ann.id, id, D);
    const target = { date: D, slot: "picked", position: 0, answer: "back" };
    expect((await day.survey(db(), bob, at(NEXT, "08:00"), target, undefined)).outcome).toBe("not_found");
    expect((await day.survey(db(), ann, at(NEXT, "08:00"), { ...target, answer: "later" }, undefined)).outcome).toBe("invalid");
    expect((await day.survey(db(), ann, at(NEXT, "08:00"), { ...target, date: "10.11.2026" }, undefined)).outcome).toBe("invalid");
    expect((await task(id))?.skip_count).toBe(0);
  });
});

describe("неудача при отказе", () => {
  it("отказ на третьей неудаче делает задачу лягушкой и ставит «Подумай, почему откладываешь» на завтра", async () => {
    const id = await insertTask(ann.id, "позвонить в банк", { important: 1, why: "долг", skip_count: 2 });
    await day.today(db(), ann, at(D, "12:00"));
    await day.act(db(), ann, at(D, "12:00"), { slot: "important", position: 0, action: "reveal" }, undefined);
    await day.act(db(), ann, at(D, "12:00"), { slot: "important", position: 0, action: "refuse" }, undefined);
    const next = await day.act(db(), ann, at(D, "12:01"), { slot: "important", position: 0, action: "next" }, undefined);
    expect(next.today?.buttons.important?.state).toBe("closed");
    expect(await task(id)).toMatchObject({ skip_count: 3, last_fail_on: D, flavor: "frog", frog_auto: 1 });
    const tomorrow = await day.today(db(), ann, at(NEXT, "09:00"));
    expect(tomorrow.picked).toMatchObject([{ slot: "think", title: "Подумай, почему откладываешь: позвонить в банк" }]);
  });
});

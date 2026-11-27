import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, createUser, mockTelegram, resetDb, sendUpdate } from "./helpers";

type CardView = {
  id: string;
  kind: string;
  title: string;
  why: string | null;
  firstStepText: string | null;
  sphereIds: string[];
  waitingFor: string | null;
  waitingSince: number | null;
  missing: string[];
};

let ann: { id: string; token: string };
let bob: { id: string; token: string };

beforeEach(async () => {
  await resetDb();
  ann = await createUser(1001, "Ann");
  bob = await createUser(2002, "Bob");
});

afterEach(() => vi.restoreAllMocks());

async function addRef(token: string, list: string, name: string): Promise<string> {
  const response = await api(token, "POST", `/references/${list}`, { name });
  expect(response.status).toBe(200);
  return (await response.json<{ id: string }>()).id;
}

async function newItem(token: string, title = "купить хлеб"): Promise<string> {
  const response = await api(token, "POST", "/inbox", { title });
  expect(response.status).toBe(200);
  return (await response.json<{ id: string }>()).id;
}

async function save(token: string, id: string, patch: unknown): Promise<{ status: number; card?: CardView }> {
  const response = await api(token, "PATCH", `/items/${id}`, patch);
  return { status: response.status, card: response.status === 200 ? (await response.json<{ card: CardView }>()).card : undefined };
}

async function inboxTitles(token: string): Promise<string[]> {
  const body = await (await api(token, "GET", "/inbox")).json<{ items: { title: string }[] }>();
  return body.items.map((item) => item.title);
}

const marks = { important: false, urgent: true, impactful: false, easy: true };

describe("бот: запись в инбокс", () => {
  it("текст попадает в инбокс, бот ставит лайк на сообщение", async () => {
    const calls = mockTelegram();
    const owner = ann;
    await sendUpdate("позвонить маме");
    expect(calls.filter((call) => call.method === "sendMessage")).toEqual([]);
    const reactions = calls.filter((call) => call.method === "setMessageReaction");
    expect(reactions.map((call) => call.payload.reaction)).toEqual([[{ type: "emoji", emoji: "👍" }]]);
    expect(await inboxTitles(owner.token)).toEqual(["позвонить маме"]);
    const row = await env.DB.prepare("SELECT source, owner_id, creator_id FROM items").first<{
      source: string;
      owner_id: string;
      creator_id: string;
    }>();
    expect(row).toEqual({ source: "bot", owner_id: owner.id, creator_id: owner.id });
  });

  it("команды не сохраняются как записи", async () => {
    mockTelegram();
    await sendUpdate("/unknown");
    expect(await inboxTitles(ann.token)).toEqual([]);
  });

  it("незнакомому человеку бот не сохраняет запись", async () => {
    const calls = mockTelegram();
    await sendUpdate("привет", { id: 9999, first_name: "Eve", language_code: "en" });
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM items").first<{ count: number }>();
    expect(count?.count).toBe(0);
    expect(calls.some((call) => call.method === "sendMessage")).toBe(true);
  });
});

describe("инбокс: доступ", () => {
  it("без сессии 401", async () => {
    expect((await api("forged", "GET", "/inbox")).status).toBe(401);
    expect((await api("forged", "PATCH", "/items/x", {})).status).toBe(401);
  });

  it("чужие записи не видны и не меняются", async () => {
    const id = await newItem(ann.token);
    expect(await inboxTitles(bob.token)).toEqual([]);
    expect((await api(bob.token, "GET", `/items/${id}`)).status).toBe(404);
    expect((await save(bob.token, id, { title: "чужое" })).status).toBe(404);
    expect((await api(bob.token, "DELETE", `/items/${id}`)).status).toBe(404);
    expect(await inboxTitles(ann.token)).toEqual(["купить хлеб"]);
  });
});

describe("карточка: черновик и задача", () => {
  it("пустое название и неизвестные поля отклоняются", async () => {
    expect((await api(ann.token, "POST", "/inbox", { title: "  " })).status).toBe(400);
    const id = await newItem(ann.token);
    expect((await save(ann.token, id, { title: "" })).status).toBe(400);
    expect((await save(ann.token, id, { kind: "task" })).status).toBe(400);
    expect((await save(ann.token, id, { important: "yes" })).status).toBe(400);
    expect((await save(ann.token, id, { flavor: "other" })).status).toBe(400);
    expect((await save(ann.token, id, { deadline: -1 })).status).toBe(400);
  });

  it("частично заполненная запись остается черновиком в инбоксе", async () => {
    const id = await newItem(ann.token);
    const { card } = await save(ann.token, id, marks);
    expect(card?.kind).toBe("inbox");
    expect(card?.missing).toEqual(["spheres", "kind"]);
    expect(await inboxTitles(ann.token)).toEqual(["купить хлеб"]);
  });

  it("запись становится задачей, когда заполнено последнее обязательное поле", async () => {
    const id = await newItem(ann.token);
    const sphere = await addRef(ann.token, "spheres", "дом");
    const kind = await addRef(ann.token, "action-kinds", "купить");
    await save(ann.token, id, marks);
    await save(ann.token, id, { sphereIds: [sphere] });
    const done = await save(ann.token, id, { actionKindId: kind });
    expect(done.card?.kind).toBe("task");
    expect(done.card?.missing).toEqual([]);
    expect(await inboxTitles(ann.token)).toEqual([]);
  });

  it("метки приоритета не обязательны: без галочек запись тоже становится задачей", async () => {
    const id = await newItem(ann.token);
    const sphere = await addRef(ann.token, "spheres", "дом");
    const kind = await addRef(ann.token, "action-kinds", "купить");
    const done = await save(ann.token, id, { sphereIds: [sphere], actionKindId: kind });
    expect(done.card?.kind).toBe("task");
    expect(done.card?.missing).toEqual([]);
  });

  it("если важно или есть влияние, нужна фраза «зачем»", async () => {
    const id = await newItem(ann.token);
    const sphere = await addRef(ann.token, "spheres", "дом");
    const kind = await addRef(ann.token, "action-kinds", "купить");
    const first = await save(ann.token, id, { ...marks, important: true, sphereIds: [sphere], actionKindId: kind });
    expect(first.card?.kind).toBe("inbox");
    expect(first.card?.missing).toEqual(["why"]);
    const second = await save(ann.token, id, { why: "  чтобы был завтрак  " });
    expect(second.card?.kind).toBe("task");
    expect(second.card?.why).toBe("чтобы был завтрак");
  });

  it("одновременные сохранения разных полей не теряют переход в задачу", async () => {
    const id = await newItem(ann.token);
    const sphere = await addRef(ann.token, "spheres", "дом");
    const kind = await addRef(ann.token, "action-kinds", "купить");
    await Promise.all([
      save(ann.token, id, marks),
      save(ann.token, id, { sphereIds: [sphere] }),
      save(ann.token, id, { actionKindId: kind }),
    ]);
    const card = (await (await api(ann.token, "GET", `/items/${id}`)).json<{ card: CardView }>()).card;
    expect(card.kind).toBe("task");
  });

  it("если очистить обязательное поле, запись возвращается в инбокс", async () => {
    const id = await newItem(ann.token);
    const sphere = await addRef(ann.token, "spheres", "дом");
    const kind = await addRef(ann.token, "action-kinds", "купить");
    await save(ann.token, id, { ...marks, sphereIds: [sphere], actionKindId: kind });
    const back = await save(ann.token, id, { sphereIds: [] });
    expect(back.card?.kind).toBe("inbox");
    expect(await inboxTitles(ann.token)).toEqual(["купить хлеб"]);
  });

  it("нельзя взять сферу, вид, категорию или проект другого пользователя", async () => {
    const id = await newItem(ann.token);
    const foreignSphere = await addRef(bob.token, "spheres", "работа");
    const foreignKind = await addRef(bob.token, "action-kinds", "позвонить");
    const foreignCategory = await addRef(bob.token, "categories", "дом");
    expect((await save(ann.token, id, { sphereIds: [foreignSphere] })).status).toBe(400);
    expect((await save(ann.token, id, { actionKindId: foreignKind })).status).toBe(400);
    expect((await save(ann.token, id, { categoryId: foreignCategory })).status).toBe(400);
    const foreignProject = await newItem(bob.token, "чужой проект");
    const bobSphere = await addRef(bob.token, "spheres", "семья");
    const bobKind = await addRef(bob.token, "action-kinds", "сделать");
    const ready = await save(bob.token, foreignProject, { ...marks, sphereIds: [bobSphere], actionKindId: bobKind, isProject: true });
    expect(ready.card?.kind).toBe("task");
    expect((await save(ann.token, id, { projectId: foreignProject })).status).toBe(400);
    expect((await save(ann.token, id, { projectId: crypto.randomUUID() })).status).toBe(400);
    const card = (await (await api(ann.token, "GET", `/items/${id}`)).json<{ card: CardView }>()).card;
    expect(card.sphereIds).toEqual([]);
  });

  it("в проект можно положить только готовый проект, не саму запись", async () => {
    const sphere = await addRef(ann.token, "spheres", "дом");
    const kind = await addRef(ann.token, "action-kinds", "купить");
    const project = await newItem(ann.token, "ремонт кухни");
    const step = await newItem(ann.token, "купить краску");
    expect((await save(ann.token, step, { projectId: project })).status).toBe(400);
    await save(ann.token, project, { ...marks, sphereIds: [sphere], actionKindId: kind, isProject: true });
    expect((await save(ann.token, step, { projectId: project })).status).toBe(200);
    expect((await save(ann.token, project, { projectId: project })).status).toBe(400);
    const list = await (await api(ann.token, "GET", "/projects")).json<{ projects: { id: string }[] }>();
    expect(list.projects.map((row) => row.id)).toEqual([project]);
  });

  it("«жду»: дата начала ставится при вводе и сбрасывается при очистке", async () => {
    const id = await newItem(ann.token);
    const first = await save(ann.token, id, { waitingFor: "дочь меряет туфли" });
    expect(first.card?.waitingSince).toBeTypeOf("number");
    const second = await save(ann.token, id, { waitingFor: "дочь все еще меряет" });
    expect(second.card?.waitingSince).toBe(first.card?.waitingSince);
    const stored = await env.DB.prepare("SELECT waiting_since FROM tasks WHERE id = ?").bind(id).first();
    expect(stored).toEqual({ waiting_since: first.card?.waitingSince });
    const cleared = await save(ann.token, id, { waitingFor: "" });
    expect(cleared.card?.waitingFor).toBeNull();
    expect(cleared.card?.waitingSince).toBeNull();
  });

  it("удаление убирает запись из инбокса как неактуальную", async () => {
    const id = await newItem(ann.token);
    expect((await api(ann.token, "DELETE", `/items/${id}`)).status).toBe(200);
    expect(await inboxTitles(ann.token)).toEqual([]);
    const row = await env.DB.prepare("SELECT archive_reason FROM items WHERE id = ?").bind(id).first();
    expect(row).toEqual({ archive_reason: "irrelevant" });
    expect((await api(ann.token, "DELETE", `/items/${id}`)).status).toBe(404);
  });

  it("архивную запись нельзя открыть и менять", async () => {
    const id = await newItem(ann.token);
    await api(ann.token, "DELETE", `/items/${id}`);
    expect((await api(ann.token, "GET", `/items/${id}`)).status).toBe(404);
    expect((await save(ann.token, id, { title: "правка" })).status).toBe(404);
  });

  it("у записи не больше трех сфер", async () => {
    const id = await newItem(ann.token);
    const ids = [await addRef(ann.token, "spheres", "а"), await addRef(ann.token, "spheres", "б"), await addRef(ann.token, "spheres", "в")];
    const extra = await addRef(ann.token, "spheres", "г");
    expect((await save(ann.token, id, { sphereIds: ids })).status).toBe(200);
    expect((await save(ann.token, id, { sphereIds: [...ids, extra] })).status).toBe(400);
  });

  it("ответ на сохранение содержит состояние из базы, а не только последнюю правку", async () => {
    const id = await newItem(ann.token);
    await save(ann.token, id, { why: "первое" });
    const second = await save(ann.token, id, { firstStepText: "шаг" });
    expect(second.card?.why).toBe("первое");
    expect(second.card?.firstStepText).toBe("шаг");
  });
});

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { defaults } from "../src/core/settings";
import { api, call, createUser, resetDb } from "./helpers";

type Lists = {
  spheres: { id: string; name: string }[];
  actionKinds: { id: string; name: string }[];
  categories: { id: string; name: string }[];
  rewards: { id: string; title: string; minutes: number }[];
  compat: { categoryA: string; categoryB: string }[];
};

let ann: { id: string; token: string };
let bob: { id: string; token: string };

beforeEach(async () => {
  await resetDb();
  ann = await createUser(1001, "Ann");
  bob = await createUser(2002, "Bob");
});

async function lists(token: string): Promise<Lists> {
  return (await api(token, "GET", "/references")).json<Lists>();
}

async function add(token: string, list: string, name: string): Promise<string> {
  const response = await api(token, "POST", `/references/${list}`, { name });
  expect(response.status).toBe(200);
  return (await response.json<{ id: string }>()).id;
}

describe("справочники: доступ", () => {
  it("без сессии отвечают 401", async () => {
    const response = await api("forged", "GET", "/references");
    expect(response.status).toBe(401);
    expect((await api("forged", "POST", "/references/spheres", { name: "дом" })).status).toBe(401);
  });

  it("схема Bearer принимается в любом регистре", async () => {
    const response = await call("/api/references", { headers: { Authorization: `bearer ${ann.token}` } });
    expect(response.status).toBe(200);
  });

  it("пользователь не видит чужие значения", async () => {
    await add(ann.token, "spheres", "дом");
    await api(ann.token, "POST", "/references/rewards", { title: "планка" });
    expect((await lists(bob.token)).spheres).toEqual([]);
    expect((await lists(bob.token)).rewards).toEqual([]);
  });

  it("чужое значение нельзя переименовать, удалить и использовать в совместимости", async () => {
    const sphere = await add(ann.token, "spheres", "дом");
    expect((await api(bob.token, "PATCH", `/references/spheres/${sphere}`, { name: "x" })).status).toBe(404);
    expect((await api(bob.token, "DELETE", `/references/spheres/${sphere}`)).status).toBe(404);
    expect((await lists(ann.token)).spheres.map((row) => row.name)).toEqual(["дом"]);

    const reward = (
      await (await api(ann.token, "POST", "/references/rewards", { title: "планка" })).json<{ id: string }>()
    ).id;
    expect((await api(bob.token, "PATCH", `/references/rewards/${reward}`, { title: "x" })).status).toBe(404);
    expect((await api(bob.token, "DELETE", `/references/rewards/${reward}`)).status).toBe(404);

    const mine = await add(ann.token, "categories", "дом");
    const yours = await add(bob.token, "categories", "поездка");
    const mixed = await api(ann.token, "POST", "/references/compat", { a: mine, b: yours });
    expect(mixed.status).toBe(404);
  });
});

describe("справочники: списки названий", () => {
  it("добавляет, переименовывает и удаляет в каждом из трех списков", async () => {
    for (const [list, key] of [
      ["spheres", "spheres"],
      ["action-kinds", "actionKinds"],
      ["categories", "categories"],
    ] as const) {
      const id = await add(ann.token, list, "  первое  ");
      expect((await lists(ann.token))[key]).toEqual([{ id, name: "первое" }]);
      expect((await api(ann.token, "PATCH", `/references/${list}/${id}`, { name: "второе" })).status).toBe(200);
      expect((await lists(ann.token))[key][0].name).toBe("второе");
      expect((await api(ann.token, "DELETE", `/references/${list}/${id}`)).status).toBe(200);
      expect((await lists(ann.token))[key]).toEqual([]);
    }
  });

  it("у разных пользователей названия могут совпадать, у одного нет", async () => {
    await add(ann.token, "spheres", "дом");
    await add(bob.token, "spheres", "дом");
    const duplicate = await api(ann.token, "POST", "/references/spheres", { name: "дом" });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ error: "duplicate" });
  });

  it("переименование в существующее название отклоняется", async () => {
    await add(ann.token, "spheres", "дом");
    const work = await add(ann.token, "spheres", "работа");
    expect((await api(ann.token, "PATCH", `/references/spheres/${work}`, { name: "дом" })).status).toBe(409);
  });

  it("пустое, слишком длинное и не строка отклоняются", async () => {
    for (const name of ["", "   ", "я".repeat(defaults.referenceNameMaxLength + 1), 5, null]) {
      expect((await api(ann.token, "POST", "/references/spheres", { name })).status).toBe(400);
    }
    expect((await api(ann.token, "POST", "/references/spheres", null)).status).toBe(400);
  });

  it("неизвестный список дает 404", async () => {
    for (const list of ["nothing", "constructor", "toString"]) {
      expect((await api(ann.token, "POST", `/references/${list}`, { name: "x" })).status).toBe(404);
    }
  });

  it("сферу, привязанную к записи, удалить нельзя", async () => {
    const sphere = await add(ann.token, "spheres", "дом");
    const itemId = crypto.randomUUID();
    await env.DB.batch([
      env.DB
        .prepare(
          "INSERT INTO items (id, kind, title, owner_id, creator_id, household_id, source, created_at, updated_at) SELECT ?, 'idea', 'идея', ?, ?, household_id, 'web', 0, 0 FROM users WHERE id = ?",
        )
        .bind(itemId, ann.id, ann.id, ann.id),
      env.DB.prepare("INSERT INTO item_spheres (item_id, sphere_id) VALUES (?, ?)").bind(itemId, sphere),
    ]);
    const response = await api(ann.token, "DELETE", `/references/spheres/${sphere}`);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "in_use" });
    expect((await lists(ann.token)).spheres).toHaveLength(1);
  });
});

describe("справочники: награды", () => {
  it("по умолчанию 10 минут, можно менять", async () => {
    const created = await api(ann.token, "POST", "/references/rewards", { title: "планка" });
    const { id } = await created.json<{ id: string }>();
    expect((await lists(ann.token)).rewards).toEqual([{ id, title: "планка", minutes: defaults.rewardMinutes }]);

    expect((await api(ann.token, "PATCH", `/references/rewards/${id}`, { minutes: 5 })).status).toBe(200);
    expect((await api(ann.token, "PATCH", `/references/rewards/${id}`, { title: "присесть" })).status).toBe(200);
    expect((await lists(ann.token)).rewards).toEqual([{ id, title: "присесть", minutes: 5 }]);
    expect((await api(ann.token, "DELETE", `/references/rewards/${id}`)).status).toBe(200);
    expect((await lists(ann.token)).rewards).toEqual([]);
  });

  it("неверные минуты и пустой запрос отклоняются", async () => {
    for (const minutes of [0, -1, 1.5, "10", null]) {
      expect((await api(ann.token, "POST", "/references/rewards", { title: "x", minutes })).status).toBe(400);
    }
    const { id } = await (await api(ann.token, "POST", "/references/rewards", { title: "x" })).json<{ id: string }>();
    expect((await api(ann.token, "PATCH", `/references/rewards/${id}`, {})).status).toBe(400);
  });
});

describe("справочники: совместимость категорий", () => {
  it("пара хранится в одном порядке и не повторяется", async () => {
    const a = await add(ann.token, "categories", "наушники");
    const b = await add(ann.token, "categories", "прогулка");
    expect((await api(ann.token, "POST", "/references/compat", { a, b })).status).toBe(200);
    expect((await api(ann.token, "POST", "/references/compat", { a: b, b: a })).status).toBe(409);
    const pairs = (await lists(ann.token)).compat;
    expect(pairs).toHaveLength(1);
    expect(pairs[0].categoryA < pairs[0].categoryB).toBe(true);

    expect((await api(ann.token, "DELETE", "/references/compat", { a: b, b: a })).status).toBe(200);
    expect((await lists(ann.token)).compat).toEqual([]);
  });

  it("категорию нельзя связать с самой собой", async () => {
    const a = await add(ann.token, "categories", "дом");
    expect((await api(ann.token, "POST", "/references/compat", { a, b: a })).status).toBe(400);
  });

  it("при удалении категории ее пары удаляются", async () => {
    const a = await add(ann.token, "categories", "наушники");
    const b = await add(ann.token, "categories", "прогулка");
    await api(ann.token, "POST", "/references/compat", { a, b });
    expect((await api(ann.token, "DELETE", `/references/categories/${a}`)).status).toBe(200);
    const result = await lists(ann.token);
    expect(result.compat).toEqual([]);
    expect(result.categories.map((row) => row.name)).toEqual(["прогулка"]);
  });
});

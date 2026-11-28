import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { api, createUser, resetDb } from "./helpers";

let ann: { id: string; token: string };
let bob: { id: string; token: string };

beforeEach(async () => {
  await resetDb();
  ann = await createUser(1001, "Ann");
  bob = await createUser(2002, "Bob");
});

async function addInsight(userId: string, text: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO insights (id, user_id, text) VALUES (?, ?, ?)").bind(id, userId, text).run();
  return id;
}

async function addSphere(userId: string, name: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO spheres (id, user_id, name) VALUES (?, ?, ?)").bind(id, userId, name).run();
  return id;
}

describe("вкладка «Инсайты»", () => {
  it("список своих инсайтов, новые сверху", async () => {
    await addInsight(ann.id, "первый");
    await addInsight(ann.id, "второй");
    await addInsight(bob.id, "чужой");
    const response = await api(ann.token, "GET", "/insights");
    const body = await response.json<{ insights: { text: string; sphereIds: string[] }[] }>();
    expect(body.insights).toEqual([
      { id: expect.any(String), text: "второй", sphereIds: [] },
      { id: expect.any(String), text: "первый", sphereIds: [] },
    ]);
  });

  it("правка текста и сфер; чужая сфера не записывается; больше трех сфер нельзя", async () => {
    const id = await addInsight(ann.id, "текст");
    const mine = await addSphere(ann.id, "Дом");
    const theirs = await addSphere(bob.id, "Чужая");
    const response = await api(ann.token, "PATCH", `/insights/${id}`, { text: " новый ", sphereIds: [mine, theirs] });
    expect(await response.json()).toEqual({ insight: { id, text: "новый", sphereIds: [mine] } });
    const four = [mine, crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    expect((await api(ann.token, "PATCH", `/insights/${id}`, { sphereIds: four })).status).toBe(400);
    expect((await api(ann.token, "PATCH", `/insights/${id}`, { text: "  " })).status).toBe(400);
  });

  it("чужой инсайт не изменить и не удалить; свой удаляется", async () => {
    const id = await addInsight(ann.id, "текст");
    expect((await api(bob.token, "PATCH", `/insights/${id}`, { text: "взлом" })).status).toBe(404);
    expect((await api(bob.token, "DELETE", `/insights/${id}`)).status).toBe(404);
    expect((await api(ann.token, "DELETE", `/insights/${id}`)).status).toBe(204);
    const left = await env.DB.prepare("SELECT count(*) AS n FROM insights").first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});

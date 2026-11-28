import { describe, expect, it } from "vitest";
import en from "../i18n/en.json";
import ru from "../i18n/ru.json";
import { pickLanguage, t } from "../i18n";

describe("i18n", () => {
  it("ru и en содержат одинаковые ключи", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(ru).sort());
  });

  it("у каждого текста со склонением есть форма other", () => {
    for (const texts of [ru, en]) {
      for (const value of Object.values(texts)) {
        if (typeof value !== "string") expect(value).toHaveProperty("other");
      }
    }
  });

  it("подставляет параметры", () => {
    expect(t("en", "web.signedIn", { name: "Ann" })).toBe("Signed in: Ann");
  });

  it("берет язык из кода Telegram", () => {
    expect(pickLanguage("ru")).toBe("ru");
    expect(pickLanguage("ru-RU")).toBe("ru");
    expect(pickLanguage("de")).toBe("en");
    expect(pickLanguage(undefined)).toBe("en");
  });
});

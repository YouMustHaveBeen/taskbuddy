import en from "./en.json";
import ru from "./ru.json";

export const languages = { ru, en };
export type Language = keyof typeof languages;
export type TextKey = keyof typeof ru;

export function pickLanguage(code: string | undefined): Language {
  return code?.toLowerCase().startsWith("ru") ? "ru" : "en";
}

export function t(
  language: Language,
  key: TextKey,
  params: Record<string, string | number> = {},
): string {
  const entry: string | Record<string, string> = languages[language][key];
  const template =
    typeof entry === "string"
      ? entry
      : (entry[new Intl.PluralRules(language).select(Number(params.count))] ?? entry.other);
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ""));
}

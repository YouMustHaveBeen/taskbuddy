import { pickLanguage } from "../../i18n";
import type { Db } from "../db/client";
import {
  consumeLoginLink,
  findSessionUser,
  insertSession,
  insertSessionAndGetUser,
} from "../db/sessions";
import { createFirstUser, findUserByTelegramId, type User } from "../db/users";
import { randomToken, safeEqual, sha256Hex } from "./crypto";
import { defaults } from "./settings";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export type Profile = { telegramId: number; name: string; languageCode?: string };

export async function registerByInvite(
  db: Db,
  profile: Profile,
  code: string,
  inviteCode: string,
  now: number,
): Promise<User | undefined> {
  if (!code || !(await safeEqual(code, inviteCode))) return undefined;
  return createFirstUser(db, {
    id: crypto.randomUUID(),
    householdId: crypto.randomUUID(),
    telegramId: profile.telegramId,
    name: profile.name,
    language: pickLanguage(profile.languageCode),
    timezone: defaults.timezone,
    createdAt: now,
    surveyOn: null,
    morningOn: null,
    repromptOn: null,
    deadlineOn: null,
    nightOn: null,
    listMessageId: null,
  });
}

export async function createLoginLink(db: Db, userId: string, now: number): Promise<string> {
  const token = randomToken();
  await insertSession(db, {
    id: await sha256Hex(token),
    userId,
    kind: "login_link",
    createdAt: now,
    expiresAt: now + defaults.loginLinkTtlMinutes * MINUTE,
  });
  return token;
}

export type SignedIn = { token: string; user: User };

export async function signInByLink(
  db: Db,
  linkToken: string,
  now: number,
): Promise<SignedIn | undefined> {
  const userId = await consumeLoginLink(db, await sha256Hex(linkToken), now);
  if (!userId) return undefined;
  const token = randomToken();
  const user = await insertSessionAndGetUser(db, newSession(await sha256Hex(token), userId, now));
  return user && { token, user };
}

export async function signInByTelegramId(
  db: Db,
  telegramId: number,
  now: number,
): Promise<SignedIn | undefined> {
  const user = await findUserByTelegramId(db, telegramId);
  if (!user) return undefined;
  const token = randomToken();
  await insertSession(db, newSession(await sha256Hex(token), user.id, now));
  return { token, user };
}

export async function userBySession(db: Db, token: string, now: number): Promise<User | undefined> {
  return findSessionUser(db, await sha256Hex(token), now);
}

function newSession(id: string, userId: string, now: number) {
  return {
    id,
    userId,
    kind: "session" as const,
    createdAt: now,
    expiresAt: now + defaults.sessionTtlHours * HOUR,
  };
}

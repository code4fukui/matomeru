import { db, now, row } from "./db.ts";

const encoder = new TextEncoder();
function hex(bytes: Uint8Array) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function bytes(value: string) {
  return new Uint8Array(value.match(/.{2}/g)?.map((x) => parseInt(x, 16)) ?? []);
}
export async function hashPassword(
  password: string,
  salt = hex(crypto.getRandomValues(new Uint8Array(16))),
) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: bytes(salt), iterations: 210_000, hash: "SHA-256" },
    key,
    256,
  );
  return `pbkdf2$${salt}$${hex(new Uint8Array(bits))}`;
}
export async function verifyPassword(password: string, stored: string) {
  const [, salt, expected] = stored.split("$");
  if (!salt || !expected) return false;
  return (await hashPassword(password, salt)).split("$")[2] === expected;
}
export function sessionCookie(id: string) {
  return `session=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`;
}
export function clearSessionCookie() {
  return "session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
}
export function currentUser(request: Request) {
  const id = request.headers.get("cookie")?.match(/(?:^|; )session=([^;]+)/)?.[1];
  if (!id) return undefined;
  const adminUserId = Deno.env.get("ADMIN_USER_ID")?.trim() || "";
  return row<{ id: string; is_admin: number; must_change_password: number; points: number }>(
    `SELECT u.id, CASE WHEN ? <> '' AND u.id=? THEN 1 ELSE 0 END AS is_admin, u.must_change_password, u.points FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.expires_at>?`,
    adminUserId,
    adminUserId,
    id,
    now(),
  );
}
export function createSession(userId: string) {
  const id = hex(crypto.getRandomValues(new Uint8Array(32)));
  db.prepare("INSERT INTO sessions(id,user_id,expires_at,created_at) VALUES(?,?,?,?)").run(
    id,
    userId,
    new Date(Date.now() + 604800000).toISOString(),
    now(),
  );
  return id;
}

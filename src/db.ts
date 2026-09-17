import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

const root = new URL("../", import.meta.url).pathname;
await Deno.mkdir(join(root, "data"), { recursive: true });
export const db = new DatabaseSync(join(root, "data", "matomeru.sqlite"));
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
const migration = await Deno.readTextFile(join(root, "migrations/001_init.sql"));
db.exec(migration);

export function now() {
  return new Date().toISOString();
}
type SqlValue = string | number | bigint | Uint8Array | null;
export function row<T>(sql: string, ...params: SqlValue[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}
export function rows<T>(sql: string, ...params: SqlValue[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

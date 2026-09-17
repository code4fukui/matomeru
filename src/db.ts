import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

const root = new URL("../", import.meta.url).pathname;
await Deno.mkdir(join(root, "data"), { recursive: true });
export const db = new DatabaseSync(join(root, "data", "matomeru.sqlite"));
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
db.exec("CREATE TABLE IF NOT EXISTS schema_migrations(version TEXT PRIMARY KEY) STRICT;");
const migrationFiles = [];
for await (const entry of Deno.readDir(join(root, "migrations"))) {
  if (entry.isFile && entry.name.endsWith(".sql")) migrationFiles.push(entry.name);
}
for (const file of migrationFiles.sort()) {
  const applied = db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(file);
  if (applied) continue;
  db.exec(await Deno.readTextFile(join(root, "migrations", file)));
  db.prepare("INSERT INTO schema_migrations(version) VALUES(?)").run(file);
}

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

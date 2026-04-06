import Database from "better-sqlite3";
import path from "path";

const DB_PATH = process.env["REVEAL_DB_PATH"] ?? path.join(process.cwd(), "reveals.db");

let db: Database.Database;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS reveals (
        commit TEXT PRIMARY KEY,
        reveal TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);
  }
  return db;
}

export function storeReveal(commit: string, reveal: bigint): void {
  const stmt = getDb().prepare("INSERT OR REPLACE INTO reveals (commit, reveal) VALUES (?, ?)");
  stmt.run(commit.toLowerCase(), reveal.toString());
}

export function getReveal(commit: string): bigint | undefined {
  const row = getDb().prepare("SELECT reveal FROM reveals WHERE commit = ?").get(commit.toLowerCase()) as
    | { reveal: string }
    | undefined;
  return row ? BigInt(row.reveal) : undefined;
}

export function deleteReveal(commit: string): void {
  getDb().prepare("DELETE FROM reveals WHERE commit = ?").run(commit.toLowerCase());
}

export function countReveals(): number {
  const row = getDb().prepare("SELECT COUNT(*) as count FROM reveals").get() as { count: number };
  return row.count;
}

export function pruneOldReveals(maxAgeSeconds = 3600): number {
  const result = getDb().prepare("DELETE FROM reveals WHERE created_at < unixepoch() - ?").run(maxAgeSeconds);
  return result.changes;
}

// src/services/node-dictionary.ts
import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { log } from '../core/logger';

export interface DictionaryEntry {
  word: string;
  /** Replacement / preferred form (optional) */
  replacement?: string;
  /** Times seen */
  count: number;
  /** Last used */
  lastUsedAt: number;
  /** User-pinned (never auto-prune) */
  pinned: boolean;
}

export class NodeDictionary {
  private db: Database.Database | null = null;
  private dbPath = '';

  init(): void {
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    this.dbPath = path.join(dir, 'jarvis-dictionary.db');

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dictionary (
        word         TEXT PRIMARY KEY,
        replacement  TEXT,
        count        INTEGER NOT NULL DEFAULT 1,
        last_used_at INTEGER NOT NULL,
        pinned       INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_dict_count ON dictionary(count DESC);
      CREATE INDEX IF NOT EXISTS idx_dict_last  ON dictionary(last_used_at DESC);

      CREATE TABLE IF NOT EXISTS replacements (
        from_word TEXT PRIMARY KEY,
        to_word   TEXT NOT NULL
      );
    `);

    log.services.info(`node-dictionary ready at ${this.dbPath}`);
  }

  dispose(): void {
    this.db?.close();
    this.db = null;
  }

  /* ---- Dictionary ------------------------------------------------------- */

  addWord(word: string, replacement?: string): void {
    if (!this.db) throw new Error('dictionary not initialized');
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO dictionary (word, replacement, count, last_used_at, pinned)
         VALUES (?, ?, 1, ?, 0)
         ON CONFLICT(word) DO UPDATE SET
           count = count + 1,
           last_used_at = excluded.last_used_at,
           replacement = COALESCE(excluded.replacement, dictionary.replacement)`
      )
      .run(word, replacement ?? null, now);
  }

  getWord(word: string): DictionaryEntry | null {
    if (!this.db) return null;
    const row = this.db
      .prepare('SELECT * FROM dictionary WHERE word = ?')
      .get(word) as
      | { word: string; replacement: string | null; count: number; last_used_at: number; pinned: number }
      | undefined;
    if (!row) return null;
    return {
      word: row.word,
      replacement: row.replacement ?? undefined,
      count: row.count,
      lastUsedAt: row.last_used_at,
      pinned: row.pinned === 1,
    };
  }

  search(prefix: string, limit = 20): DictionaryEntry[] {
    if (!this.db) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM dictionary
         WHERE word LIKE ? COLLATE NOCASE
         ORDER BY count DESC, last_used_at DESC
         LIMIT ?`
      )
      .all(`${prefix}%`, limit) as Array<{
      word: string;
      replacement: string | null;
      count: number;
      last_used_at: number;
      pinned: number;
    }>;

    return rows.map((r) => ({
      word: r.word,
      replacement: r.replacement ?? undefined,
      count: r.count,
      lastUsedAt: r.last_used_at,
      pinned: r.pinned === 1,
    }));
  }

  setPinned(word: string, pinned: boolean): void {
    if (!this.db) return;
    this.db.prepare('UPDATE dictionary SET pinned = ? WHERE word = ?').run(pinned ? 1 : 0, word);
  }

  removeWord(word: string): void {
    if (!this.db) return;
    this.db.prepare('DELETE FROM dictionary WHERE word = ?').run(word);
  }

  /** Prune low-frequency words (never pinned). */
  prune(keepTop = 5000): number {
    if (!this.db) return 0;
    const info = this.db
      .prepare(
        `DELETE FROM dictionary
         WHERE pinned = 0
           AND word NOT IN (
             SELECT word FROM dictionary
             WHERE pinned = 0
             ORDER BY count DESC, last_used_at DESC
             LIMIT ?
           )`
      )
      .run(keepTop);
    log.services.info(`pruned ${info.changes} dictionary entries`);
    return info.changes;
  }

  /* ---- Replacements ----------------------------------------------------- */

  setReplacement(from: string, to: string): void {
    if (!this.db) return;
    this.db
      .prepare(
        `INSERT INTO replacements (from_word, to_word) VALUES (?, ?)
         ON CONFLICT(from_word) DO UPDATE SET to_word = excluded.to_word`
      )
      .run(from, to);
  }

  getReplacement(from: string): string | null {
    if (!this.db) return null;
    const row = this.db
      .prepare('SELECT to_word FROM replacements WHERE from_word = ?')
      .get(from) as { to_word: string } | undefined;
    return row?.to_word ?? null;
  }

  removeReplacement(from: string): void {
    if (!this.db) return;
    this.db.prepare('DELETE FROM replacements WHERE from_word = ?').run(from);
  }

  /** Apply all replacements to a string. */
  applyReplacements(text: string): string {
    if (!this.db) return text;
    const rows = this.db.prepare('SELECT from_word, to_word FROM replacements').all() as Array<{
      from_word: string;
      to_word: string;
    }>;
    let out = text;
    for (const { from_word, to_word } of rows) {
      out = out.replaceAll(from_word, to_word);
    }
    return out;
  }

  /* ---- Stats ------------------------------------------------------------ */

  size(): number {
    if (!this.db) return 0;
    const row = this.db.prepare('SELECT COUNT(*) as n FROM dictionary').get() as { n: number };
    return row.n;
  }
}

let instance: NodeDictionary | null = null;
export function initNodeDictionary(): NodeDictionary {
  if (instance) return instance;
  instance = new NodeDictionary();
  return instance;
}
export function getNodeDictionary(): NodeDictionary {
  if (!instance) throw new Error('NodeDictionary not initialized');
  return instance;
}

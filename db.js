import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(__dirname, 'family.db');

let rawDb;

export async function initDb() {
  const SQL = await initSqlJs();

  // Всегда начинаем с чистой базы, если файла нет
  if (fs.existsSync(DB_FILE)) {
    try {
      const buf = fs.readFileSync(DB_FILE);
      rawDb = new SQL.Database(buf);
      console.log('БД загружена из файла');
    } catch (e) {
      console.log('Не удалось прочитать family.db, создаём новую');
      rawDb = new SQL.Database();
    }
  } else {
    rawDb = new SQL.Database();
    console.log('Создана новая БД');
  }

  // Проверяем, есть ли нужные колонки в persons
  // Если база старая — пересоздаём ВСЕ таблицы
  let needsRebuild = false;
  try {
    const res = rawDb.exec("PRAGMA table_info(persons)");
    if (res.length > 0) {
      const cols = res[0].values.map(row => row[1]);
      if (!cols.includes('pos_x') || !cols.includes('pos_y')) {
        console.log('Старая схема persons — пересоздаём таблицы');
        needsRebuild = true;
      }
    }
  } catch {
    // Таблицы вообще нет — не страшно, CREATE IF NOT EXISTS создаст
  }

  if (needsRebuild) {
    rawDb.run('DROP TABLE IF EXISTS relations');
    rawDb.run('DROP TABLE IF EXISTS persons');
    rawDb.run('DROP TABLE IF EXISTS trees');
    rawDb.run('DROP TABLE IF EXISTS users');
  }

  rawDb.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS trees (
      id TEXT PRIMARY KEY,
      owner_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      is_public INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS persons (
      id TEXT PRIMARY KEY,
      tree_id TEXT NOT NULL,
      name TEXT NOT NULL,
      photo TEXT,
      pos_x REAL,
      pos_y REAL
    );

    CREATE TABLE IF NOT EXISTS relations (
      id TEXT PRIMARY KEY,
      tree_id TEXT NOT NULL,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      type TEXT NOT NULL
    );
  `);

  save();
  console.log('БД готова к работе');
}

function save() {
  const data = rawDb.export();
  fs.writeFileSync(DB_FILE, Buffer.from(data));
}

export const db = {
  prepare(sql) {
    return {
      run(...params) {
        rawDb.run(sql, params);
        save();
        const res = rawDb.exec('SELECT last_insert_rowid() AS id');
        const lastInsertRowid = res[0]?.values[0][0] ?? null;
        return { lastInsertRowid };
      },
      get(...params) {
        const stmt = rawDb.prepare(sql);
        stmt.bind(params);
        let row;
        if (stmt.step()) row = stmt.getAsObject();
        stmt.free();
        return row;
      },
      all(...params) {
        const stmt = rawDb.prepare(sql);
        stmt.bind(params);
        const rows = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        stmt.free();
        return rows;
      }
    };
  },
  exec(sql) {
    rawDb.run(sql);
    save();
  }
};

export { save };
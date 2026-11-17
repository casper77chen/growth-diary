const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const THUMB_DIR = path.join(MEDIA_DIR, 'thumbs');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
const ICONS_DIR = path.join(DATA_DIR, 'icons');
for (const d of [DATA_DIR, MEDIA_DIR, THUMB_DIR, TMP_DIR, ICONS_DIR]) fs.mkdirSync(d, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'growth.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS child(
  id INTEGER PRIMARY KEY CHECK(id=1),
  name TEXT NOT NULL,
  birthdate TEXT NOT NULL,
  sex TEXT NOT NULL CHECK(sex IN ('M','F'))
);
CREATE TABLE IF NOT EXISTS milestones(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  typical_from REAL,
  typical_to REAL,
  builtin INTEGER DEFAULT 0,
  sort INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS records(
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('milestone','daily','growth')),
  title TEXT DEFAULT '',
  note TEXT DEFAULT '',
  date TEXT NOT NULL,
  date_approx INTEGER DEFAULT 0,
  milestone_id INTEGER REFERENCES milestones(id) ON DELETE SET NULL,
  recorded_by INTEGER REFERENCES users(id),
  favorite INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_records_date ON records(date);
CREATE TABLE IF NOT EXISTS media(
  id INTEGER PRIMARY KEY,
  record_id INTEGER NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('photo','video')),
  file TEXT NOT NULL,
  thumb TEXT,
  taken_at TEXT,
  bytes INTEGER
);
CREATE TABLE IF NOT EXISTS metrics(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  unit TEXT NOT NULL,
  builtin INTEGER DEFAULT 0,
  who TEXT
);
CREATE TABLE IF NOT EXISTS measurements(
  id INTEGER PRIMARY KEY,
  record_id INTEGER REFERENCES records(id) ON DELETE SET NULL,
  metric_id INTEGER NOT NULL REFERENCES metrics(id),
  date TEXT NOT NULL,
  value REAL NOT NULL,
  recorded_by INTEGER
);
CREATE INDEX IF NOT EXISTS idx_meas_metric ON measurements(metric_id, date);
CREATE TABLE IF NOT EXISTS poop_events(
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  time TEXT DEFAULT '',
  recorded_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_poop_date ON poop_events(date);
CREATE TABLE IF NOT EXISTS milk_events(
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  time TEXT DEFAULT '',
  ml INTEGER NOT NULL,
  kind TEXT DEFAULT '',
  recorded_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_milk_date ON milk_events(date);
CREATE TABLE IF NOT EXISTS tags(
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL
);
CREATE TABLE IF NOT EXISTS record_tags(
  record_id INTEGER NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY(record_id, tag_id)
);
`);

// 遷移：記錄者顯示名（可以不是登入者，例如阿嬤；空字串＝用登入者名字）
const recordCols = db.prepare('PRAGMA table_info(records)').all().map(c => c.name);
if (!recordCols.includes('recorder_name')) {
  db.exec(`ALTER TABLE records ADD COLUMN recorder_name TEXT DEFAULT ''`);
}

// 遷移：喝奶種類（母奶／配方奶；空字串＝加欄位前的舊資料，未分類）
const milkCols = db.prepare('PRAGMA table_info(milk_events)').all().map(c => c.name);
if (!milkCols.includes('kind')) {
  db.exec(`ALTER TABLE milk_events ADD COLUMN kind TEXT DEFAULT ''`);
}

// 遷移：通用化欄位——主題色（舊站升級後預設值＝原本寫死的藍色，外觀不變）、
// 排便／喝奶功能開關（舊資料庫預設＝開啟，關閉只是隱藏入口，資料不刪）
const childCols = db.prepare('PRAGMA table_info(child)').all().map(c => c.name);
if (!childCols.includes('theme_color')) {
  db.exec(`ALTER TABLE child ADD COLUMN theme_color TEXT DEFAULT '#658dc6'`);
}
if (!childCols.includes('show_poop')) {
  db.exec(`ALTER TABLE child ADD COLUMN show_poop INTEGER DEFAULT 1`);
}
if (!childCols.includes('show_milk')) {
  db.exec(`ALTER TABLE child ADD COLUMN show_milk INTEGER DEFAULT 1`);
}

// 內建里程碑（月齡區間取自常見發展參考；生活事件類不設區間）
const BUILTIN_MILESTONES = [
  ['第一次笑', 1, 3],
  ['第一次翻身', 3, 6],
  ['第一次吃副食品', 4, 6],
  ['第一顆牙', 5, 10],
  ['第一次坐穩', 6, 9],
  ['第一次爬行', 7, 10],
  ['第一次站立', 9, 12],
  ['第一次叫爸爸／媽媽', 9, 14],
  ['第一步', 11, 15],
  ['第一次出國', null, null],
  ['第一次過年', null, null],
  ['第一次生日', null, null],
  ['第一天上學', null, null],
  ['第一次生病', null, null],
  ['第一次自己完成某件事', null, null],
];
if (db.prepare('SELECT COUNT(*) c FROM milestones').get().c === 0) {
  const ins = db.prepare('INSERT INTO milestones(name,typical_from,typical_to,builtin,sort) VALUES (?,?,?,1,?)');
  BUILTIN_MILESTONES.forEach((m, i) => ins.run(m[0], m[1], m[2], i));
}

if (db.prepare('SELECT COUNT(*) c FROM metrics').get().c === 0) {
  const ins = db.prepare('INSERT INTO metrics(name,unit,builtin,who) VALUES (?,?,1,?)');
  ins.run('身高', 'cm', 'lhfa');
  ins.run('體重', 'kg', 'wfa');
  ins.run('頭圍', 'cm', 'hcfa');
}

module.exports = { db, DATA_DIR, MEDIA_DIR, THUMB_DIR, TMP_DIR, ICONS_DIR };

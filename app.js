const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { ZipArchive } = require('archiver');
const { db, DATA_DIR, MEDIA_DIR, TMP_DIR, ICONS_DIR } = require('./db');
const { processUpload, deleteFiles, isAllowed } = require('./lib/media');
const { today, ageLabel, ageMonthsDecimal, shiftDate } = require('./lib/age');
const { buildTheme, themeToCssVars, isValidThemeColor, DEFAULT_THEME_COLOR } = require('./lib/theme');
const { footprintIconBuffer, hasCustomIcon, saveCustomIcon, clearCustomIcon, customIconPath } = require('./lib/icons');

const app = express();
const PORT = process.env.PORT || 3000;

// session 金鑰：env 優先，否則產生一次並存在 data/（重啟不掉登入）
function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const f = path.join(DATA_DIR, '.session-secret');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'));
  return fs.readFileSync(f, 'utf8').trim();
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// 線條 icon（feather 風格），模板用 <%- ICONS.xxx %> 嵌入，顏色跟隨文字
app.locals.ICONS = {
  award: '<svg class="ico" viewBox="0 0 24 24"><circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/></svg>',
  trend: '<svg class="ico" viewBox="0 0 24 24"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>',
  search: '<svg class="ico" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
  gear: '<svg class="ico" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
};
// 搬家轉址：舊站設 REDIRECT_TO（例 https://example.com）→ 所有請求 308 轉到新站同路徑，舊站不再寫入
if (process.env.REDIRECT_TO) {
  const target = process.env.REDIRECT_TO.replace(/\/+$/, '');
  app.use((req, res) => res.redirect(308, target + req.originalUrl));
}
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(cookieSession({
  name: process.env.SESSION_COOKIE_NAME || 'gd_session',
  keys: [sessionSecret()],
  maxAge: 180 * 24 * 60 * 60 * 1000,
  sameSite: 'lax',
}));

const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: 80 * 1024 * 1024, files: 10 },
});
const uploadIcon = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});

// ---------- 共用查詢 ----------
const getChild = () => db.prepare('SELECT * FROM child WHERE id=1').get();
const getUsers = () => db.prepare('SELECT id,name FROM users ORDER BY id').all();
const getUser = id => db.prepare('SELECT id,name FROM users WHERE id=?').get(id);

// 每一頁都要有主題色與站名（設定前也要有預設值，/setup、/login、錯誤頁都用得到）
app.use((req, res, next) => {
  const child = getChild();
  const color = child && isValidThemeColor(child.theme_color) ? child.theme_color
    : (isValidThemeColor(process.env.THEME_COLOR) ? process.env.THEME_COLOR : DEFAULT_THEME_COLOR);
  res.locals.theme = buildTheme(color);
  res.locals.themeCssVars = themeToCssVars(res.locals.theme);
  res.locals.siteName = child ? `${child.name}成長日記` : '成長日記';
  next();
});

// 產生的「主色＋小腳印」圖示存記憶體快取（主色不同就是不同的 key，等於主色改了自動重產）
const footprintCache = new Map();
async function getFootprintIcon(size, colorHex) {
  const key = `${size}-${colorHex}`;
  if (footprintCache.has(key)) return footprintCache.get(key);
  const buf = await footprintIconBuffer(size, colorHex);
  footprintCache.set(key, buf);
  return buf;
}
function iconRoute(size) {
  return async (req, res) => {
    try {
      if (hasCustomIcon(ICONS_DIR)) {
        return res.sendFile(customIconPath(ICONS_DIR, size));
      }
      const buf = await getFootprintIcon(size, res.locals.theme.accent);
      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'public, max-age=3600');
      res.send(buf);
    } catch (e) {
      res.status(500).send('圖示產生失敗');
    }
  };
}

// 可勾選的記錄者名單：爸媽＋曾經手動填過的人（例如阿嬤）
function getRecorderNames() {
  const names = getUsers().map(u => u.name);
  const extra = db.prepare(`SELECT DISTINCT recorder_name n FROM records WHERE recorder_name != '' ORDER BY n`).all();
  for (const { n } of extra) if (!names.includes(n)) names.push(n);
  return names;
}

function attachMedia(records) {
  const stmt = db.prepare('SELECT * FROM media WHERE record_id=? ORDER BY id');
  for (const r of records) r.media = stmt.all(r.id);
  return records;
}
function attachTags(records) {
  const stmt = db.prepare('SELECT t.name FROM record_tags rt JOIN tags t ON t.id=rt.tag_id WHERE rt.record_id=? ORDER BY t.name');
  for (const r of records) r.tags = stmt.all(r.id).map(x => x.name);
  return records;
}
function attachMeasurements(records) {
  const stmt = db.prepare('SELECT m.value, mt.name, mt.unit FROM measurements m JOIN metrics mt ON mt.id=m.metric_id WHERE m.record_id=?');
  for (const r of records) if (r.type === 'growth') r.measurements = stmt.all(r.id);
  return records;
}
function hydrate(records, child) {
  attachMedia(records); attachTags(records); attachMeasurements(records);
  for (const r of records) {
    r.age = child ? ageLabel(child.birthdate, r.date) : '';
    // 拍攝者可能是其他家人，爸媽只是協助記錄；兩者相同就只顯示一個
    r.credit = r.recorder_name && r.recorder_name !== r.by_name
      ? `${r.recorder_name} 拍攝・${r.by_name} 記錄`
      : `${r.by_name} 記錄`;
  }
  return records;
}

// 時間軸／搜尋共用的條件組裝
function queryRecords({ q, type, by, tag, fav, page = 1, perPage = 20 }) {
  const cond = [], args = [];
  if (q) { cond.push('(r.title LIKE ? OR r.note LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
  if (type) { cond.push('r.type = ?'); args.push(type); }
  if (by) {
    // 拍攝者或記錄者其中之一符合就算
    cond.push(`(r.recorder_name = ? OR (SELECT name FROM users WHERE id=r.recorded_by) = ?)`);
    args.push(by, by);
  }
  if (fav) cond.push('r.favorite = 1');
  if (tag) {
    cond.push('r.id IN (SELECT record_id FROM record_tags rt JOIN tags t ON t.id=rt.tag_id WHERE t.name = ?)');
    args.push(tag);
  }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) c FROM records r ${where}`).get(...args).c;
  const rows = db.prepare(
    `SELECT r.*, u.name AS by_name, ms.name AS milestone_name
     FROM records r
     LEFT JOIN users u ON u.id = r.recorded_by
     LEFT JOIN milestones ms ON ms.id = r.milestone_id
     ${where}
     ORDER BY r.date DESC, r.id DESC LIMIT ? OFFSET ?`
  ).all(...args, perPage, (page - 1) * perPage);
  return { rows, total, hasMore: page * perPage < total };
}

// 回顧卡：去年今天 → 一個月前 → 隨機老回憶
function reviewCard() {
  const t = today();
  const pick = (date, label) => {
    const rows = db.prepare(
      `SELECT r.*, u.name AS by_name, ms.name AS milestone_name FROM records r
       LEFT JOIN users u ON u.id=r.recorded_by LEFT JOIN milestones ms ON ms.id=r.milestone_id
       WHERE r.date = ? ORDER BY RANDOM() LIMIT 1`).all(date);
    return rows.length ? { label, record: rows[0] } : null;
  };
  let card = pick(shiftDate(t, { years: -1 }), '一年前的今天');
  if (!card) card = pick(shiftDate(t, { months: -1 }), '一個月前的今天');
  if (!card) {
    const rows = db.prepare(
      `SELECT r.*, u.name AS by_name, ms.name AS milestone_name FROM records r
       LEFT JOIN users u ON u.id=r.recorded_by LEFT JOIN milestones ms ON ms.id=r.milestone_id
       WHERE r.date <= ? ORDER BY RANDOM() LIMIT 1`).all(shiftDate(t, { days: -90 }));
    if (rows.length) card = { label: '隨機回憶', record: rows[0] };
  }
  return card;
}

// ---------- 登入保護 ----------
function requireLogin(req, res, next) {
  if (db.prepare('SELECT COUNT(*) c FROM users').get().c === 0) return res.redirect('/setup');
  if (!req.session.uid) return res.redirect('/login');
  req.user = getUser(req.session.uid);
  if (!req.user) { req.session = null; return res.redirect('/login'); }
  res.locals.user = req.user;
  res.locals.child = getChild();
  res.locals.todayStr = today();
  res.locals.ageLabel = ageLabel;
  next();
}

// 排便／喝奶這類可關閉的功能：關掉之後對應的 API 直接 404（資料不刪，重開就看得到）
function requireFeature(flagName) {
  return (req, res, next) => {
    const child = res.locals.child || getChild();
    if (!child || !child[flagName]) return res.status(404).render('error', { message: '找不到這一頁', back: '/' });
    next();
  };
}

// 壓縮後媒體（需登入才看得到）
app.use('/media', (req, res, next) => {
  if (!req.session.uid) return res.status(401).send('請先登入');
  next();
}, express.static(MEDIA_DIR));

// PWA manifest 與圖示：名字／主題色隨當前設定走，不是寫死的靜態檔
app.get('/manifest.webmanifest', (req, res) => {
  const child = getChild();
  const name = child ? `${child.name}成長日記` : '成長日記';
  const shortName = child ? `${child.name}日記` : '成長日記';
  res.set('Content-Type', 'application/manifest+json');
  res.json({
    name,
    short_name: shortName,
    start_url: '/',
    display: 'standalone',
    background_color: res.locals.theme.bg,
    theme_color: res.locals.theme.bg,
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  });
});
app.get('/icons/icon-192.png', iconRoute(192));
app.get('/icons/icon-512.png', iconRoute(512));
app.get('/apple-touch-icon.png', iconRoute(180));

// ---------- 初次設定與登入 ----------
// 有設 SETUP_TOKEN 時，/setup 一定要帶對的 token 才能用（GET 用網址 ?token=，POST 用表單隱藏欄位）
function setupTokenOk(req) {
  const token = process.env.SETUP_TOKEN;
  if (!token) return true;
  const given = String(req.query.token || (req.body && req.body.token) || '');
  const a = Buffer.from(given), b = Buffer.from(token);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
function setupForbidden(res) {
  return res.status(403).render('error', {
    message: '這個設定連結不對，或是少了存取密語（token）。請跟管理者確認完整的設定網址。',
    back: '/',
  });
}
app.get('/setup', (req, res) => {
  if (db.prepare('SELECT COUNT(*) c FROM users').get().c > 0) return res.redirect('/login');
  if (!setupTokenOk(req)) return setupForbidden(res);
  res.render('setup', {
    error: null,
    token: req.query.token || '',
    defaultName: process.env.CHILD_NAME || '',
    defaultColor: isValidThemeColor(process.env.THEME_COLOR) ? process.env.THEME_COLOR : DEFAULT_THEME_COLOR,
  });
});
app.post('/setup', (req, res) => {
  if (db.prepare('SELECT COUNT(*) c FROM users').get().c > 0) return res.redirect('/login');
  if (!setupTokenOk(req)) return setupForbidden(res);
  const { childName, birthdate, sex, papaPw, mamaPw, themeColor } = req.body;
  const defaultName = process.env.CHILD_NAME || '';
  const defaultColor = isValidThemeColor(process.env.THEME_COLOR) ? process.env.THEME_COLOR : DEFAULT_THEME_COLOR;
  if (!childName || !birthdate || !['M', 'F'].includes(sex) || !papaPw || !mamaPw) {
    return res.render('setup', { error: '每個欄位都要填喔', token: req.body.token || '', defaultName, defaultColor });
  }
  const color = isValidThemeColor(themeColor) ? themeColor : defaultColor;
  db.prepare('INSERT INTO child(id,name,birthdate,sex,theme_color) VALUES (1,?,?,?,?)').run(childName.trim(), birthdate, sex, color);
  const ins = db.prepare('INSERT INTO users(name,password_hash) VALUES (?,?)');
  ins.run('爸爸', bcrypt.hashSync(papaPw, 10));
  ins.run('媽媽', bcrypt.hashSync(mamaPw, 10));
  res.redirect('/login');
});

app.get('/login', (req, res) => {
  if (db.prepare('SELECT COUNT(*) c FROM users').get().c === 0) return res.redirect('/setup');
  res.render('login', { users: getUsers(), child: getChild(), error: null });
});
app.post('/login', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.body.uid);
  if (!u || !bcrypt.compareSync(req.body.password || '', u.password_hash)) {
    return res.render('login', { users: getUsers(), child: getChild(), error: '密碼不對，再試一次' });
  }
  req.session.uid = u.id;
  res.redirect('/');
});
app.post('/logout', (req, res) => { req.session = null; res.redirect('/login'); });

// ---------- 時間軸 ----------
app.get('/', requireLogin, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const { rows, hasMore } = queryRecords({ page });
  hydrate(rows, res.locals.child);
  let review = null;
  if (page === 1) {
    review = reviewCard();
    if (review) {
      hydrate([review.record], res.locals.child);
      // 回顧卡和第一頁重複就不顯示媒體兩次也無妨，保持簡單
    }
  }
  res.render('index', { records: rows, page, hasMore, review });
});

// ---------- 新增紀錄 ----------
app.get('/new', requireLogin, (req, res) => {
  const milestones = db.prepare(
    `SELECT m.*, (SELECT COUNT(*) FROM records r WHERE r.milestone_id=m.id) done
     FROM milestones m ORDER BY m.builtin DESC, m.sort, m.id`).all();
  const usedTags = db.prepare('SELECT name FROM tags ORDER BY name').all().map(t => t.name);
  res.render('new', {
    milestones, usedTags, recorders: getRecorderNames(),
    presetType: req.query.type || 'daily', presetMilestone: req.query.milestone || '',
    lastMilkMl: db.prepare('SELECT ml FROM milk_events ORDER BY id DESC LIMIT 1').get()?.ml || '',
    lastMilkKind: db.prepare(`SELECT kind FROM milk_events WHERE kind!='' ORDER BY id DESC LIMIT 1`).get()?.kind || '母奶',
  });
});

app.post('/records', requireLogin, (req, res) => {
  upload.array('files', 10)(req, res, async err => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? '有檔案超過 80MB。影片請先在 iPhone 分享時選較小尺寸，或剪短一點再上傳。'
        : `上傳失敗：${err.message}`;
      return res.status(400).render('error', { message: msg, back: '/new' });
    }
    try {
      const { type, title, note, date, date_approx, milestone_id, new_milestone, tags } = req.body;
      if (!['milestone', 'daily'].includes(type)) throw new Error('紀錄類型不對');
      if (!date) throw new Error('日期必填');
      for (const f of req.files || []) {
        if (!isAllowed(f.mimetype)) {
          (req.files || []).forEach(x => { try { fs.unlinkSync(x.path); } catch {} });
          throw new Error(`不支援的檔案格式（${f.mimetype}）。iPhone 的 Live Photo 動態與 HEIC 請改用「存成影片／JPEG」後再上傳。`);
        }
      }
      let msId = null;
      if (type === 'milestone') {
        if (new_milestone && new_milestone.trim()) {
          msId = db.prepare('INSERT INTO milestones(name,builtin,sort) VALUES (?,0,999)').run(new_milestone.trim()).lastInsertRowid;
        } else if (milestone_id) {
          msId = Number(milestone_id);
        }
      }
      let recorder = (req.body.recorder || '').trim();
      if (recorder === '__other') recorder = (req.body.recorder_other || '').trim();
      if (!recorder) recorder = req.user.name;
      const msName = msId ? db.prepare('SELECT name FROM milestones WHERE id=?').get(msId)?.name : null;
      const rid = db.prepare(
        `INSERT INTO records(type,title,note,date,date_approx,milestone_id,recorded_by,recorder_name)
         VALUES (?,?,?,?,?,?,?,?)`
      ).run(type, (title || msName || '').trim(), (note || '').trim(), date, date_approx ? 1 : 0, msId, req.user.id, recorder).lastInsertRowid;
      const insMedia = db.prepare('INSERT INTO media(record_id,kind,file,thumb,taken_at,bytes) VALUES (?,?,?,?,?,?)');
      for (const f of req.files || []) {
        const m = await processUpload(f);
        insMedia.run(rid, m.kind, m.file, m.thumb, m.taken_at, m.bytes);
      }
      const checked = [].concat(req.body.tag_check || []);
      saveTags(rid, [String(tags || ''), ...checked].join(' '));
      res.redirect(`/records/${rid}`);
    } catch (e) {
      res.status(400).render('error', { message: e.message, back: '/new' });
    }
  });
});

function saveTags(recordId, raw) {
  db.prepare('DELETE FROM record_tags WHERE record_id=?').run(recordId);
  const names = String(raw || '').split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
  const insTag = db.prepare('INSERT OR IGNORE INTO tags(name) VALUES (?)');
  const getTag = db.prepare('SELECT id FROM tags WHERE name=?');
  const link = db.prepare('INSERT OR IGNORE INTO record_tags(record_id,tag_id) VALUES (?,?)');
  for (const n of names) { insTag.run(n); link.run(recordId, getTag.get(n).id); }
}

// ---------- 單筆紀錄 ----------
function loadRecord(id) {
  const r = db.prepare(
    `SELECT r.*, u.name AS by_name, ms.name AS milestone_name FROM records r
     LEFT JOIN users u ON u.id=r.recorded_by LEFT JOIN milestones ms ON ms.id=r.milestone_id
     WHERE r.id=?`).get(id);
  return r;
}
app.get('/records/:id', requireLogin, (req, res) => {
  const r = loadRecord(req.params.id);
  if (!r) return res.status(404).render('error', { message: '找不到這筆紀錄', back: '/' });
  hydrate([r], res.locals.child);
  res.render('record', { r });
});
app.post('/records/:id', requireLogin, (req, res) => {
  upload.array('files', 10)(req, res, async err => {
    const r = loadRecord(req.params.id);
    if (!r) return res.status(404).render('error', { message: '找不到這筆紀錄', back: '/' });
    const back = `/records/${r.id}`;
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? '有檔案超過 80MB。影片請先在 iPhone 分享時選較小尺寸，或剪短一點再上傳。'
        : `上傳失敗：${err.message}`;
      return res.status(400).render('error', { message: msg, back });
    }
    try {
      const { title, note, date, date_approx, tags } = req.body;
      for (const f of req.files || []) {
        if (!isAllowed(f.mimetype)) {
          (req.files || []).forEach(x => { try { fs.unlinkSync(x.path); } catch {} });
          throw new Error(`不支援的檔案格式（${f.mimetype}）。iPhone 的 Live Photo 動態與 HEIC 請改用「存成影片／JPEG」後再上傳。`);
        }
      }
      db.prepare(`UPDATE records SET title=?, note=?, date=?, date_approx=?, updated_at=datetime('now','localtime') WHERE id=?`)
        .run((title || '').trim(), (note || '').trim(), date || r.date, date_approx ? 1 : 0, r.id);
      saveTags(r.id, tags);
      const insMedia = db.prepare('INSERT INTO media(record_id,kind,file,thumb,taken_at,bytes) VALUES (?,?,?,?,?,?)');
      for (const f of req.files || []) {
        const m = await processUpload(f);
        insMedia.run(r.id, m.kind, m.file, m.thumb, m.taken_at, m.bytes);
      }
      res.redirect(back);
    } catch (e) {
      res.status(400).render('error', { message: e.message, back });
    }
  });
});
// 編輯時移除單張照片／影片：只刪 app 內壓縮檔，iCloud 原圖不受影響
app.post('/records/:id/media/:mid/delete', requireLogin, (req, res) => {
  const m = db.prepare('SELECT * FROM media WHERE id=? AND record_id=?').get(req.params.mid, req.params.id);
  if (m) {
    db.prepare('DELETE FROM media WHERE id=?').run(m.id);
    deleteFiles(m);
  }
  res.redirect(`/records/${req.params.id}`);
});
app.post('/records/:id/favorite', requireLogin, (req, res) => {
  db.prepare('UPDATE records SET favorite = 1 - favorite WHERE id=?').run(req.params.id);
  res.redirect(req.get('referer') || `/records/${req.params.id}`);
});
app.post('/records/:id/delete', requireLogin, (req, res) => {
  const r = loadRecord(req.params.id);
  if (r) {
    const files = db.prepare('SELECT * FROM media WHERE record_id=?').all(r.id);
    db.prepare('DELETE FROM records WHERE id=?').run(r.id);
    files.forEach(deleteFiles);
  }
  res.redirect('/');
});

// ---------- 里程碑 ----------
app.get('/milestones', requireLogin, (req, res) => {
  const all = db.prepare(
    `SELECT m.*, r.id AS record_id, r.date AS done_date FROM milestones m
     LEFT JOIN records r ON r.id = (SELECT id FROM records WHERE milestone_id=m.id ORDER BY date LIMIT 1)
     ORDER BY m.sort, m.id`).all();
  const done = all.filter(m => m.record_id);
  const todo = all.filter(m => !m.record_id);
  for (const m of done) m.age = ageLabel(res.locals.child.birthdate, m.done_date);
  res.render('milestones', { done, todo });
});
app.post('/milestones', requireLogin, (req, res) => {
  const name = (req.body.name || '').trim();
  if (name) db.prepare('INSERT INTO milestones(name,typical_from,typical_to,builtin,sort) VALUES (?,?,?,0,999)')
    .run(name, req.body.typical_from || null, req.body.typical_to || null);
  res.redirect('/milestones');
});

// ---------- 成長數據 ----------
// 排便：逐次記錄存 poop_events，成長頁以「每日總次數」呈現（不佔 metrics 表、不進時間軸）
// 從第一筆紀錄那天到今天，沒紀錄的日期補 0（顯示層補，不塞假資料進 DB）
function poopDailyEntries(child) {
  const rows = db.prepare('SELECT id, date, time FROM poop_events ORDER BY date, time, id').all();
  const byDate = new Map();
  for (const r of rows) {
    if (!byDate.has(r.date)) byDate.set(r.date, { date: r.date, times: [], lastId: r.id, lastTime: r.time });
    const d = byDate.get(r.date);
    d.times.push(r.time); d.lastId = r.id; d.lastTime = r.time;
  }
  if (byDate.size) {
    const end = today();
    for (let d = [...byDate.keys()][0]; d <= end; d = shiftDate(d, { days: 1 })) {
      if (!byDate.has(d)) byDate.set(d, { date: d, times: [], lastId: null, lastTime: '' });
    }
  }
  return [...byDate.values()].sort((a, b) => a.date < b.date ? -1 : 1).map(d => ({
    id: d.lastId, date: d.date, value: d.times.length,
    ageMonths: ageMonthsDecimal(child.birthdate, d.date),
    age: ageLabel(child.birthdate, d.date),
    by: d.times.filter(Boolean).join('、'),
    lastTime: d.lastTime,
  }));
}

app.get('/growth', requireLogin, (req, res) => {
  const metrics = db.prepare('SELECT * FROM metrics ORDER BY builtin DESC, id').all();
  const child = res.locals.child;
  for (const m of metrics) {
    m.entries = db.prepare(
      `SELECT ms.*, u.name AS by_name FROM measurements ms LEFT JOIN users u ON u.id=ms.recorded_by
       WHERE ms.metric_id=? ORDER BY ms.date`).all(m.id)
      .map(e => ({ ...e, ageMonths: ageMonthsDecimal(child.birthdate, e.date), age: ageLabel(child.birthdate, e.date) }));
  }
  res.render('growth', {
    metrics, child,
    poopEntries: child.show_poop ? poopDailyEntries(child) : [],
    milkEntries: child.show_milk ? milkDailyEntries(child) : [],
    selectedTab: (req.query.tab === 'poop' && child.show_poop) || (req.query.tab === 'milk' && child.show_milk)
      ? req.query.tab : null,
  });
});

// 喝奶：逐次記時間＋毫升，成長頁以「每日總奶量」呈現
function milkDailyEntries(child) {
  const rows = db.prepare('SELECT id, date, time, ml, kind FROM milk_events ORDER BY date, time, id').all();
  const byDate = new Map();
  for (const r of rows) {
    if (!byDate.has(r.date)) byDate.set(r.date, { date: r.date, feeds: [], lastId: 0, lastTime: '', lastMl: 0, lastKind: '' });
    const d = byDate.get(r.date);
    d.feeds.push(r); d.lastId = r.id; d.lastTime = r.time; d.lastMl = r.ml; d.lastKind = r.kind;
  }
  const KIND_TAG = { '母奶': '母', '配方奶': '配' };
  return [...byDate.values()].map(d => ({
    id: d.lastId, date: d.date,
    value: d.feeds.reduce((s, f) => s + f.ml, 0),
    breastMl: d.feeds.filter(f => f.kind === '母奶').reduce((s, f) => s + f.ml, 0),
    formulaMl: d.feeds.filter(f => f.kind === '配方奶').reduce((s, f) => s + f.ml, 0),
    count: d.feeds.length,
    ageMonths: ageMonthsDecimal(child.birthdate, d.date),
    age: ageLabel(child.birthdate, d.date),
    by: d.feeds.map(f => (f.time ? f.time + ' ' : '') + (KIND_TAG[f.kind] || '') + f.ml).join('、'),
    lastTime: d.lastTime, lastMl: d.lastMl, lastKind: d.lastKind,
  }));
}

function quickDateTime(body) {
  return {
    date: /^\d{4}-\d{2}-\d{2}$/.test(body.date || '') ? body.date : today(),
    time: /^\d{2}:\d{2}$/.test(body.time || '') ? body.time : '',
  };
}
app.post('/poop', requireLogin, requireFeature('show_poop'), (req, res) => {
  const { date, time } = quickDateTime(req.body);
  db.prepare('INSERT INTO poop_events(date,time,recorded_by) VALUES (?,?,?)').run(date, time, req.user.id);
  res.redirect('/growth?tab=poop');
});
app.post('/poop/:id/delete', requireLogin, requireFeature('show_poop'), (req, res) => {
  db.prepare('DELETE FROM poop_events WHERE id=?').run(req.params.id);
  res.redirect('/growth?tab=poop');
});
app.post('/milk', requireLogin, requireFeature('show_milk'), (req, res) => {
  const { date, time } = quickDateTime(req.body);
  const ml = parseInt(req.body.ml, 10);
  if (!ml || ml <= 0) return res.status(400).render('error', { message: '奶量要填正整數（毫升）', back: '/new' });
  const kind = ['母奶', '配方奶'].includes(req.body.kind) ? req.body.kind : '';
  db.prepare('INSERT INTO milk_events(date,time,ml,kind,recorded_by) VALUES (?,?,?,?,?)').run(date, time, ml, kind, req.user.id);
  res.redirect('/growth?tab=milk');
});
app.post('/milk/:id/delete', requireLogin, requireFeature('show_milk'), (req, res) => {
  db.prepare('DELETE FROM milk_events WHERE id=?').run(req.params.id);
  res.redirect('/growth?tab=milk');
});
app.post('/growth', requireLogin, (req, res) => {
  const date = req.body.date || today();
  const metrics = db.prepare('SELECT * FROM metrics').all();
  const entries = [];
  for (const m of metrics) {
    const v = parseFloat(req.body[`metric_${m.id}`]);
    if (!isNaN(v) && v > 0) entries.push({ metric: m, value: v });
  }
  if (entries.length) {
    const summary = entries.map(e => `${e.metric.name} ${e.value}${e.metric.unit}`).join('、');
    const rid = db.prepare(`INSERT INTO records(type,title,date,recorded_by) VALUES ('growth',?,?,?)`)
      .run(summary, date, req.user.id).lastInsertRowid;
    const ins = db.prepare('INSERT INTO measurements(record_id,metric_id,date,value,recorded_by) VALUES (?,?,?,?,?)');
    for (const e of entries) ins.run(rid, e.metric.id, date, e.value, req.user.id);
  }
  res.redirect('/growth');
});
app.post('/metrics', requireLogin, (req, res) => {
  const name = (req.body.name || '').trim(), unit = (req.body.unit || '').trim();
  if (name && unit) db.prepare('INSERT INTO metrics(name,unit,builtin) VALUES (?,?,0)').run(name, unit);
  res.redirect('/growth');
});
app.post('/metrics/:id/delete', requireLogin, (req, res) => {
  const m = db.prepare('SELECT * FROM metrics WHERE id=? AND builtin=0').get(req.params.id);
  if (m) {
    db.transaction(() => {
      const rids = db.prepare('SELECT DISTINCT record_id FROM measurements WHERE metric_id=? AND record_id IS NOT NULL')
        .all(m.id).map(r => r.record_id);
      db.prepare('DELETE FROM measurements WHERE metric_id=?').run(m.id);
      for (const rid of rids) {
        if (db.prepare('SELECT COUNT(*) c FROM measurements WHERE record_id=?').get(rid).c === 0) {
          db.prepare(`DELETE FROM records WHERE id=? AND type='growth'`).run(rid);
        }
      }
      db.prepare('DELETE FROM metrics WHERE id=?').run(m.id);
    })();
  }
  res.redirect('/growth');
});
app.post('/measurements/:id/delete', requireLogin, (req, res) => {
  const ms = db.prepare('SELECT * FROM measurements WHERE id=?').get(req.params.id);
  if (ms) {
    db.prepare('DELETE FROM measurements WHERE id=?').run(ms.id);
    if (ms.record_id && db.prepare('SELECT COUNT(*) c FROM measurements WHERE record_id=?').get(ms.record_id).c === 0) {
      db.prepare(`DELETE FROM records WHERE id=? AND type='growth'`).run(ms.record_id);
    }
  }
  res.redirect('/growth');
});

// ---------- 搜尋 ----------
app.get('/search', requireLogin, (req, res) => {
  const { q, type, by, tag, fav } = req.query;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const hasQuery = q || type || by || tag || fav;
  const result = hasQuery ? queryRecords({ q, type, by, tag, fav, page }) : { rows: [], total: 0, hasMore: false };
  hydrate(result.rows, res.locals.child);
  const tags = db.prepare('SELECT name FROM tags ORDER BY name').all().map(t => t.name);
  res.render('search', { ...result, page, params: { q: q || '', type: type || '', by: by || '', tag: tag || '', fav: fav || '' }, recorders: getRecorderNames(), tags, hasQuery });
});

// ---------- 設定與匯出 ----------
app.get('/settings', requireLogin, (req, res) => {
  const stats = {
    records: db.prepare('SELECT COUNT(*) c FROM records').get().c,
    photos: db.prepare(`SELECT COUNT(*) c FROM media WHERE kind='photo'`).get().c,
    videos: db.prepare(`SELECT COUNT(*) c FROM media WHERE kind='video'`).get().c,
    bytes: db.prepare('SELECT COALESCE(SUM(bytes),0) b FROM media').get().b,
  };
  res.render('settings', { stats, message: req.query.msg || null, hasCustomIcon: hasCustomIcon(ICONS_DIR), iconV: Date.now() });
});
app.post('/settings/child', requireLogin, (req, res) => {
  const { name, birthdate, sex, themeColor } = req.body;
  if (name && birthdate && ['M', 'F'].includes(sex)) {
    const color = isValidThemeColor(themeColor) ? themeColor : (getChild().theme_color || DEFAULT_THEME_COLOR);
    const showPoop = req.body.show_poop ? 1 : 0;
    const showMilk = req.body.show_milk ? 1 : 0;
    db.prepare('UPDATE child SET name=?, birthdate=?, sex=?, theme_color=?, show_poop=?, show_milk=? WHERE id=1')
      .run(name.trim(), birthdate, sex, color, showPoop, showMilk);
  }
  res.redirect('/settings?msg=' + encodeURIComponent('基本資料已更新'));
});
app.post('/settings/icon', requireLogin, (req, res) => {
  uploadIcon.single('icon')(req, res, async err => {
    if (err) return res.redirect('/settings?msg=' + encodeURIComponent('上傳失敗：' + err.message));
    if (!req.file) return res.redirect('/settings?msg=' + encodeURIComponent('請選一張圖片'));
    if (!['image/jpeg', 'image/png'].includes(req.file.mimetype)) {
      return res.redirect('/settings?msg=' + encodeURIComponent('只支援 jpg 或 png 圖片'));
    }
    try {
      await saveCustomIcon(req.file.buffer, ICONS_DIR);
      res.redirect('/settings?msg=' + encodeURIComponent('自訂圖示已更新'));
    } catch (e) {
      res.redirect('/settings?msg=' + encodeURIComponent('圖示處理失敗：' + e.message));
    }
  });
});
app.post('/settings/icon/reset', requireLogin, (req, res) => {
  clearCustomIcon(ICONS_DIR);
  res.redirect('/settings?msg=' + encodeURIComponent('已恢復預設圖示（主色＋小腳印）'));
});
app.post('/settings/password', requireLogin, (req, res) => {
  const { oldPw, newPw } = req.body;
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!bcrypt.compareSync(oldPw || '', u.password_hash)) {
    return res.redirect('/settings?msg=' + encodeURIComponent('舊密碼不對，沒有更改'));
  }
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(newPw, 10), u.id);
  res.redirect('/settings?msg=' + encodeURIComponent('密碼已更新'));
});

app.get('/export.zip', requireLogin, (req, res) => {
  const child = res.locals.child;
  const records = db.prepare(
    `SELECT r.*, u.name AS by_name, ms.name AS milestone_name FROM records r
     LEFT JOIN users u ON u.id=r.recorded_by LEFT JOIN milestones ms ON ms.id=r.milestone_id
     ORDER BY r.date, r.id`).all();
  hydrate(records, child);
  const measurements = db.prepare(
    `SELECT ms.date, ms.value, mt.name, mt.unit FROM measurements ms JOIN metrics mt ON mt.id=ms.metric_id ORDER BY ms.date`).all();

  res.attachment(`${child.name}-成長日記-${today()}.zip`);
  const zip = new ZipArchive({ zlib: { level: 6 } });
  zip.on('error', () => { try { res.end(); } catch {} });
  zip.pipe(res);
  zip.append(JSON.stringify({ child, records, measurements }, null, 2), { name: 'data.json' });
  zip.append(renderExportHtml(child, records, measurements), { name: 'index.html' });
  for (const r of records) for (const m of r.media) {
    const p = path.join(MEDIA_DIR, m.file);
    if (fs.existsSync(p)) zip.file(p, { name: `media/${m.file}` });
  }
  zip.finalize();
});

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function renderExportHtml(child, records, measurements) {
  const items = records.map(r => `
    <div class="card">
      <div class="meta">${esc(r.date)}${r.date_approx ? '（大約）' : ''} ・ ${esc(r.age)} ・ ${esc(r.credit || '')}</div>
      <h3>${r.type === 'milestone' ? '🏆 ' : ''}${esc(r.title || r.milestone_name || '')}</h3>
      ${r.note ? `<p>${esc(r.note)}</p>` : ''}
      ${(r.measurements || []).map(m => `<span class="pill">${esc(m.name)} ${m.value}${esc(m.unit)}</span>`).join(' ')}
      ${r.media.map(m => m.kind === 'photo'
        ? `<img src="media/${esc(m.file)}" loading="lazy">`
        : `<video src="media/${esc(m.file)}" controls preload="metadata"></video>`).join('')}
      ${r.tags.length ? `<div class="meta">#${r.tags.map(esc).join(' #')}</div>` : ''}
    </div>`).join('\n');
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(child.name)} 的成長日記</title>
<style>body{font-family:-apple-system,"PingFang TC",sans-serif;max-width:720px;margin:0 auto;padding:16px;background:#f2f5fa;color:#333944}
.card{background:#fff;border-radius:12px;padding:16px;margin:12px 0;box-shadow:0 1px 4px rgba(0,0,0,.06)}
.meta{color:#8d96a5;font-size:13px}img,video{max-width:100%;border-radius:8px;margin-top:8px}
.pill{background:#eef4ea;border-radius:99px;padding:2px 10px;font-size:13px}</style></head>
<body><h1>${esc(child.name)} 的成長日記</h1>
<p class="meta">出生：${esc(child.birthdate)}｜匯出日期:${today()}｜共 ${records.length} 筆紀錄、${measurements.length} 筆成長數據</p>
${items}</body></html>`;
}

app.use((req, res) => res.status(404).render('error', { message: '找不到這一頁', back: '/' }));

if (require.main === module) {
  app.listen(PORT, () => {
    const child = getChild();
    console.log(`${child ? child.name + '成長日記' : '成長日記'} http://localhost:${PORT}`);
  });
}
module.exports = app;

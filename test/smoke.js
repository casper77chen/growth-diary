// 冒煙測試：走完 設定→登入→發文→里程碑→成長數據→搜尋→匯出 全流程，
// 再加上通用化後新增的：SETUP_TOKEN 保護、主題色／圖示、排便喝奶開關、舊資料庫升級
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'growth-diary-test-'));
process.env.SETUP_TOKEN = 'letmein-test-token';
process.env.CHILD_NAME = '橘子';
process.env.THEME_COLOR = '#9ed8c5';
const app = require('../app');
const sharp = require('sharp');

let base = '';
let cookie = '';
let passed = 0;

function assert(cond, name) {
  if (!cond) { console.error(`❌ ${name}`); process.exit(1); }
  passed++;
  console.log(`✅ ${name}`);
}
function grabCookies(res) {
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (set.length) cookie = set.map(c => c.split(';')[0]).join('; ');
}
async function req(url, opts = {}) {
  const res = await fetch(base + url, { redirect: 'manual', ...opts, headers: { cookie, ...(opts.headers || {}) } });
  grabCookies(res);
  return res;
}
function form(obj) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(obj).toString(),
  };
}
async function pngPixel(buf, x, y) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const idx = (y * info.width + x) * info.channels;
  return [data[idx], data[idx + 1], data[idx + 2], data[idx + 3]];
}
function approx(a, b, tol = 10) { return Math.abs(a - b) <= tol; }
function approxRgb([r, g, b], [er, eg, eb], tol = 10) { return approx(r, er, tol) && approx(g, eg, tol) && approx(b, eb, tol); }

(async () => {
  const server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  const today = new Date().toISOString().slice(0, 10);

  // 未設定時導向 /setup（跟有沒有 token 無關）
  let res = await req('/', {});
  assert(res.status === 302 && res.headers.get('location').includes('/setup'), '未設定時導向 /setup');

  // ---------- SETUP_TOKEN 保護 ----------
  res = await req('/setup');
  assert(res.status === 403, '沒帶 token 時 /setup（GET）回 403');
  res = await req('/setup?token=wrong-token');
  assert(res.status === 403, '帶錯 token 時 /setup（GET）回 403');
  res = await req('/setup?token=letmein-test-token');
  let html = await res.text();
  assert(res.status === 200 && html.includes('初次設定'), '帶對 token 可以打開設定頁');
  assert(html.includes('value="橘子"'), '名字欄預設值讀到 env CHILD_NAME');
  assert(html.includes('#9ed8c5'), '主題色欄預設值讀到 env THEME_COLOR');
  res = await req('/setup', form({ childName: '小橘寶', birthdate: '2026-01-15', sex: 'M', papaPw: 'papa123', mamaPw: 'mama123', themeColor: '#658dc6' }));
  assert(res.status === 403, '沒帶 token 時 /setup（POST）回 403（不會因此被設定走）');
  res = await req('/setup?token=wrong-token', form({ childName: '小橘寶', birthdate: '2026-01-15', sex: 'M', papaPw: 'papa123', mamaPw: 'mama123', themeColor: '#658dc6' }));
  assert(res.status === 403, '帶錯 token 時 /setup（POST）也回 403');

  // ---------- 初次設定（帶對的 token） ----------
  res = await req('/setup', form({ token: 'letmein-test-token', childName: '小橘寶', birthdate: '2026-01-15', sex: 'M', papaPw: 'papa123', mamaPw: 'mama123', themeColor: '#658dc6' }));
  assert(res.status === 302, '帶對 token 初次設定完成');
  delete process.env.SETUP_TOKEN;
  delete process.env.CHILD_NAME;
  delete process.env.THEME_COLOR;

  // 已經設定過，/setup 就算帶對 token 也不能再用
  res = await req('/setup?token=letmein-test-token');
  assert(res.status === 302 && res.headers.get('location').includes('/login'), '設定過一次後 /setup 導向 /login（token 失去作用）');

  // 登入
  res = await req('/login', form({ uid: 1, password: 'wrong' }));
  assert((await res.text()).includes('密碼不對'), '錯誤密碼被擋');
  res = await req('/login', form({ uid: 1, password: 'papa123' }));
  assert(res.status === 302 && cookie.includes('gd_session'), '爸爸登入成功');
  res = await req('/');
  html = await res.text();
  assert(res.status === 200 && html.includes('小橘寶') && html.includes('還沒有任何紀錄'), '時間軸空狀態');

  // ---------- 主題色：預設藍＝原本寫死值、注入 :root CSS 變數 ----------
  assert(html.includes(':root{') && html.includes('--accent:#658dc6'), '預設主題色（#658dc6）注入頁面 :root CSS 變數');

  // ---------- 動態 manifest ----------
  res = await req('/manifest.webmanifest');
  const manifest = await res.json();
  assert(manifest.name === '小橘寶成長日記' && manifest.short_name === '小橘寶日記', 'manifest 名字跟著小孩名字走');
  assert(/^#[0-9a-f]{6}$/i.test(manifest.theme_color) && manifest.theme_color === manifest.background_color, 'manifest 主題色是合法 hex 且跟底色一致');
  assert(Array.isArray(manifest.icons) && manifest.icons.length === 2, 'manifest 列出兩個圖示尺寸');

  // ---------- 預設圖示：主色＋小腳印 ----------
  res = await req('/icons/icon-512.png');
  let buf = Buffer.from(await res.arrayBuffer());
  assert(res.status === 200 && res.headers.get('content-type').includes('image/png'), 'icon-512.png 回 200 且是 PNG');
  let px = await pngPixel(buf, 450, 450);
  assert(approxRgb(px.slice(0, 3), [101, 141, 198]), '預設圖示底色＝目前主題色（藍）');
  res = await req('/apple-touch-icon.png');
  assert(res.status === 200 && res.headers.get('content-type').includes('image/png'), 'apple-touch-icon.png 回 200 且是 PNG');

  // 新增日常紀錄（含照片上傳）
  const jpeg = await sharp({ create: { width: 1200, height: 900, channels: 3, background: { r: 240, g: 160, b: 75 } } }).jpeg().toBuffer();
  const fd = new FormData();
  fd.append('files', new Blob([jpeg], { type: 'image/jpeg' }), 'test.jpg');
  fd.append('type', 'daily');
  fd.append('title', '第一次抓周彩排');
  fd.append('note', '抓到聽診器，笑翻');
  fd.append('date', today);
  fd.append('tags', '搞笑 阿公阿嬤');
  res = await req('/records', { method: 'POST', body: fd });
  assert(res.status === 302, '日常紀錄建立成功');
  const recUrl = res.headers.get('location');
  res = await req(recUrl);
  html = await res.text();
  assert(html.includes('第一次抓周彩排') && html.includes('/media/') && html.includes('#搞笑'), '紀錄頁有標題、照片與標籤');
  res = await req('/');
  html = await res.text();
  assert(html.includes('第一次抓周彩排') && html.includes('thumbs/'), '時間軸出現紀錄與縮圖');

  // 新增頁：記錄者選項與常用標籤勾選
  res = await req('/new');
  html = await res.text();
  assert(html.includes('name="recorder"') && html.includes('>爸爸<') && html.includes('>媽媽<') && html.includes('其他…'), '新增頁有記錄者選項');
  assert(html.includes('name="tag_check"') && html.includes('#搞笑'), '新增頁列出曾用過的標籤');
  assert(html.includes('id="poopBtn"') && html.includes('id="milkBtn"'), '功能開啟中：新增頁有排便／喝奶按鈕');

  // 里程碑（記錄者用「其他」填阿嬤，並勾一個舊標籤）
  res = await req('/records', { method: 'POST', body: (() => {
    const f = new FormData();
    f.append('type', 'milestone'); f.append('milestone_id', '2'); f.append('date', today); f.append('note', '在阿嬤家翻的');
    f.append('recorder', '__other'); f.append('recorder_other', '阿嬤'); f.append('tag_check', '阿公阿嬤');
    return f;
  })() });
  assert(res.status === 302, '里程碑紀錄建立成功');
  res = await req(res.headers.get('location'));
  html = await res.text();
  assert(html.includes('阿嬤 拍攝・爸爸 記錄') && html.includes('#阿公阿嬤'), '拍攝者與記錄者分開顯示、勾選標籤生效');
  res = await req('/new');
  assert((await res.text()).includes('value="阿嬤"'), '阿嬤成為可勾選的拍攝者');
  res = await req('/search?by=' + encodeURIComponent('阿嬤'));
  assert((await res.text()).includes('第一次翻身'), '依拍攝者阿嬤篩選命中');
  res = await req('/search?by=' + encodeURIComponent('爸爸'));
  html = await res.text();
  assert(html.includes('第一次抓周彩排') && html.includes('第一次翻身'), '依爸爸篩選同時命中親拍與協助記錄的');
  res = await req('/milestones');
  html = await res.text();
  assert(html.includes('已達成（1）') && html.includes('第一次翻身'), '里程碑頁顯示已達成');
  assert(html.includes('待收集'), '里程碑頁顯示待收集清單');

  // 成長數據
  res = await req('/growth', form({ date: today, metric_1: '68.5', metric_2: '8.2', metric_3: '' }));
  assert(res.status === 302, '成長數據建立成功');
  res = await req('/growth');
  html = await res.text();
  assert(html.includes('68.5') && html.includes('8.2'), '成長頁包含測量值');
  res = await req('/who-lms.json');
  const who = await res.json();
  assert(who.wfa && who.wfa.M.length === 61 && Math.abs(who.wfa.M[0][1] - 3.3464) < 0.01, 'WHO LMS 資料完整');
  res = await req('/');
  html = await res.text();
  assert(html.includes('身高 68.5cm'), '時間軸出現成長數據卡');

  // 排便快速記錄（逐次記、每日累積）
  res = await req('/new');
  html = await res.text();
  assert(html.includes('id="poopBtn"') && html.includes('id="poopDialog"'), '新增頁有排便按鈕與確認視窗');
  res = await req('/poop', form({ date: today, time: '08:12' }));
  assert(res.status === 302 && res.headers.get('location').includes('tab=poop'), '排便記錄成功並導向成長頁排便分頁');
  await req('/poop', form({ date: today, time: '14:30' }));
  res = await req('/growth?tab=poop');
  html = await res.text();
  const poopJson = (html.match(/\{"id":"poop".*?\]\}/) || [])[0] || '';
  assert(poopJson.includes('"value":2') && poopJson.includes('08:12、14:30'), '同一天累積 2 次且列出時間');
  const poopDelId = (poopJson.match(/"entries":\[\{"id":(\d+)/) || [])[1];
  assert(poopDelId, '取得排便刪除用 id');
  res = await req(`/poop/${poopDelId}/delete`, form({}));
  assert(res.status === 302, '刪除該日最後一次排便成功');
  res = await req('/growth');
  html = await res.text();
  assert(((html.match(/\{"id":"poop".*?\]\}/) || [])[0] || '').includes('"value":1'), '刪除後該日剩 1 次');
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  res = await req('/poop', form({ date: yesterday, time: '20:00' }));
  assert(res.status === 302, '補記昨天的排便成功');
  res = await req('/growth');
  html = await res.text();
  assert(((html.match(/\{"id":"poop".*?\]\}/) || [])[0] || '').includes(`"date":"${yesterday}"`), '補記的排便記在昨天那天');

  // 喝奶快速記錄（逐次記時間＋毫升、每日加總）
  res = await req('/new');
  html = await res.text();
  assert(html.includes('id="milkBtn"') && html.includes('id="milkDialog"'), '新增頁有喝奶按鈕與確認視窗');
  res = await req('/milk', form({ date: today, time: '07:30', ml: '120', kind: '母奶' }));
  assert(res.status === 302 && res.headers.get('location').includes('tab=milk'), '喝奶記錄成功並導向奶量分頁');
  await req('/milk', form({ date: today, time: '11:00', ml: '150', kind: '配方奶' }));
  res = await req('/growth?tab=milk');
  html = await res.text();
  const milkJson = (html.match(/\{"id":"milk".*?\]\}/) || [])[0] || '';
  assert(milkJson.includes('"value":270') && milkJson.includes('07:30 母120、11:00 配150'), '同一天奶量加總 270 且列出各次（含母／配標記）');
  assert(milkJson.includes('"breastMl":120') && milkJson.includes('"formulaMl":150'), '母奶／配方奶分量各自加總');
  res = await req('/new');
  html = await res.text();
  assert(html.includes('value="150"'), '奶量欄自動帶上一次的量');
  assert(html.includes('value="配方奶" checked'), '種類自動帶上一次選的（配方奶）');
  const milkDelId = (milkJson.match(/"entries":\[\{"id":(\d+)/) || [])[1];
  assert(milkDelId, '取得喝奶刪除用 id');
  res = await req(`/milk/${milkDelId}/delete`, form({}));
  res = await req('/growth');
  html = await res.text();
  assert(((html.match(/\{"id":"milk".*?\]\}/) || [])[0] || '').includes('"value":120'), '刪除最後一次後剩 120');
  res = await req('/milk', form({ date: today, ml: 'abc' }));
  assert(res.status === 400, '奶量非數字被擋');
  res = await req('/milk', form({ date: yesterday, time: '21:00', ml: '90' }));
  assert(res.status === 302, '補記昨天的喝奶成功（沒帶種類也能存＝舊版相容）');
  res = await req('/growth');
  html = await res.text();
  const milkJson2 = (html.match(/\{"id":"milk".*?\]\}/) || [])[0] || '';
  assert(milkJson2.includes(`"date":"${yesterday}"`) && milkJson2.includes('"value":90'), '補記的喝奶記在昨天那天且加總 90');

  // ---------- 主題色：改色後色票跟著換、按鈕文字在淺色主色下自動變深色字 ----------
  res = await req('/settings/child', form({ name: '小橘寶', birthdate: '2026-01-15', sex: 'M', themeColor: '#f5d5e0', show_poop: '1', show_milk: '1' }));
  assert(res.status === 302, '更改主題色成功');
  res = await req('/');
  html = await res.text();
  assert(/--accent:#f5d5e0/i.test(html), '頁面 :root 變數換成新主題色');
  assert(!/--accent-ink:#ffffff/i.test(html), '淺色主色下按鈕文字不是白字（對比不夠會自動換深色字）');
  res = await req('/icons/icon-512.png');
  buf = Buffer.from(await res.arrayBuffer());
  px = await pngPixel(buf, 450, 450);
  assert(approxRgb(px.slice(0, 3), [245, 213, 224]), '圖示底色跟著新主題色（粉色）重新產生');

  // ---------- 排便／喝奶開關：關掉後入口與 API 都不見，資料不刪；重開後恢復 ----------
  res = await req('/settings/child', form({ name: '小橘寶', birthdate: '2026-01-15', sex: 'M', themeColor: '#f5d5e0' }));
  assert(res.status === 302, '關閉排便／喝奶（表單沒勾＝關閉）成功');
  res = await req('/new');
  html = await res.text();
  assert(!html.includes('id="poopBtn"') && !html.includes('id="milkBtn"') && !html.includes('id="poopDialog"') && !html.includes('id="milkDialog"'), '關閉後新增頁不再顯示排便／喝奶入口');
  res = await req('/growth');
  html = await res.text();
  assert(!html.includes('name="mtab" value="poop"') && !html.includes('name="mtab" value="milk"'), '關閉後成長頁不再顯示排便／奶量分頁籤');
  assert(!html.includes('"id":"poop"') && !html.includes('"id":"milk"'), '關閉後成長頁資料也不帶出排便／喝奶');
  res = await req('/poop', form({ date: today, time: '09:00' }));
  assert(res.status === 404, '關閉後新增排便 API 回 404');
  res = await req('/milk', form({ date: today, ml: '100' }));
  assert(res.status === 404, '關閉後新增喝奶 API 回 404');
  res = await req(`/poop/1/delete`, form({}));
  assert(res.status === 404, '關閉後刪除排便 API 也回 404');
  res = await req('/settings/child', form({ name: '小橘寶', birthdate: '2026-01-15', sex: 'M', themeColor: '#f5d5e0', show_poop: '1', show_milk: '1' }));
  assert(res.status === 302, '重新打開排便／喝奶成功');
  res = await req('/new');
  html = await res.text();
  assert(html.includes('id="poopBtn"') && html.includes('id="milkBtn"'), '重新打開後新增頁入口恢復');
  res = await req('/growth');
  html = await res.text();
  assert(html.includes(`"date":"${yesterday}"`) && html.includes('"value":90'), '重新打開後，關閉期間保留的喝奶資料還在（昨天 90ml）');
  assert(html.includes('"value":1') && html.includes(`"date":"${yesterday}"`), '重新打開後，關閉期間保留的排便資料還在（昨天 1 次）');

  // ---------- 自訂圖示：上傳後優先顯示、恢復預設後回小腳印 ----------
  const redSquare = await sharp({ create: { width: 300, height: 450, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer();
  const iconFd = new FormData();
  iconFd.append('icon', new Blob([redSquare], { type: 'image/png' }), 'custom.png');
  res = await req('/settings/icon', { method: 'POST', body: iconFd });
  assert(res.status === 302, '上傳自訂圖示成功');
  res = await req('/settings');
  html = await res.text();
  assert(html.includes('目前使用自訂圖示'), '設定頁顯示目前為自訂圖示');
  res = await req('/icons/icon-512.png');
  buf = Buffer.from(await res.arrayBuffer());
  const meta = await sharp(buf).metadata();
  assert(meta.width === 512 && meta.height === 512, '自訂圖示輸出尺寸正確（512x512，非方形圖已置中裁切）');
  px = await pngPixel(buf, 256, 256);
  assert(approxRgb(px.slice(0, 3), [255, 0, 0], 5), '上傳後 icon-512.png 回傳的是自訂圖（紅色）而不是小腳印');
  res = await req('/icons/icon-192.png');
  const meta192 = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
  assert(meta192.width === 192, '自訂圖示也產出 192 尺寸');
  res = await req('/apple-touch-icon.png');
  const meta180 = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
  assert(meta180.width === 180, '自訂圖示也產出 180（apple-touch-icon）尺寸');

  res = await req('/settings/icon/reset', form({}));
  assert(res.status === 302, '恢復預設圖示成功');
  res = await req('/settings');
  html = await res.text();
  assert(!html.includes('目前使用自訂圖示') && html.includes('目前使用預設圖示'), '設定頁顯示已恢復預設圖示');
  res = await req('/icons/icon-512.png');
  buf = Buffer.from(await res.arrayBuffer());
  px = await pngPixel(buf, 450, 450);
  assert(approxRgb(px.slice(0, 3), [245, 213, 224]), '恢復預設後 icon-512.png 回到主色小腳印（不是紅色自訂圖）');

  // 自訂項目與自訂里程碑
  res = await req('/metrics', form({ name: '牙齒數量', unit: '顆' }));
  res = await req('/growth');
  assert((await res.text()).includes('牙齒數量'), '自訂測量項目出現');
  res = await req('/milestones', form({ name: '第一次游泳' }));
  res = await req('/milestones');
  assert((await res.text()).includes('第一次游泳'), '自訂里程碑出現');

  // 刪除自訂項目（連同其測量與空掉的成長紀錄）
  res = await req('/growth');
  html = await res.text();
  const toothId = (html.match(/"id":(\d+),"name":"牙齒數量"/) || [])[1];
  assert(toothId, '從成長頁取得自訂項目 id');
  res = await req('/growth', form({ date: today, [`metric_${toothId}`]: '2' }));
  assert(res.status === 302, '自訂項目測量建立成功');
  res = await req(`/metrics/${toothId}/delete`, form({}));
  assert(res.status === 302, '刪除自訂項目成功');
  res = await req('/growth');
  html = await res.text();
  assert(!html.includes('"name":"牙齒數量"'), '自訂項目已從成長頁消失');
  res = await req('/search?q=' + encodeURIComponent('牙齒數量'));
  assert(!(await res.text()).includes('牙齒數量 2顆'), '空掉的成長紀錄已一併刪除');
  res = await req('/metrics/1/delete', form({}));
  res = await req('/growth');
  assert((await res.text()).includes('身高'), '內建項目不可刪除');

  // 搜尋
  res = await req('/search?q=' + encodeURIComponent('抓周'));
  assert((await res.text()).includes('第一次抓周彩排'), '文字搜尋命中');
  res = await req('/search?tag=' + encodeURIComponent('搞笑'));
  assert((await res.text()).includes('第一次抓周彩排'), '標籤篩選命中');

  // 編輯與收藏（編輯可補傳照片、移除單張照片）
  const jpeg2 = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 120, g: 180, b: 200 } } }).jpeg().toBuffer();
  res = await req(recUrl, { method: 'POST', body: (() => {
    const f = new FormData();
    f.append('files', new Blob([jpeg2], { type: 'image/jpeg' }), 'extra.jpg');
    f.append('title', '第一次抓周彩排（改）');
    f.append('note', '改過的描述');
    f.append('date', today);
    f.append('tags', '搞笑');
    return f;
  })() });
  assert(res.status === 302, '編輯（含補傳照片）成功');
  res = await req(recUrl);
  html = await res.text();
  assert(html.includes('第一次抓周彩排（改）'), '編輯紀錄生效');
  assert((html.match(/class="full-media"/g) || []).length === 2, '補傳的照片出現在紀錄頁');
  const mids = [...html.matchAll(/media\/(\d+)\/delete/g)].map(m => m[1]);
  assert(mids.length === 2, '編輯框列出全部媒體可移除');
  res = await req(`${recUrl}/media/${mids[1]}/delete`, { method: 'POST' });
  res = await req(recUrl);
  html = await res.text();
  assert((html.match(/class="full-media"/g) || []).length === 1, '移除單張照片生效');
  res = await req(recUrl + '/favorite', { method: 'POST' });
  res = await req('/search?fav=1');
  assert((await res.text()).includes('第一次抓周彩排（改）'), '收藏篩選命中');

  // 匯出
  res = await req('/export.zip');
  const exportBuf = Buffer.from(await res.arrayBuffer());
  assert(res.status === 200 && exportBuf.slice(0, 2).toString() === 'PK'
    && exportBuf.includes('data.json') && exportBuf.includes('index.html') && exportBuf.includes('media/'),
    '匯出 zip 含 data.json、index.html 與媒體');

  // 未登入保護
  cookie = '';
  res = await req('/media/thumbs/x.jpg');
  assert(res.status === 401, '未登入不能看媒體');
  res = await req('/');
  assert(res.status === 302, '未登入導向登入頁');

  server.close();

  // ---------- 舊資料庫升級：沒有 theme_color／show_poop／show_milk 欄位，開啟後自動補欄位且是預設值 ----------
  const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'growth-diary-olddb-'));
  {
    const Database = require('better-sqlite3');
    const oldDb = new Database(path.join(oldDir, 'growth.db'));
    oldDb.exec(`CREATE TABLE child(id INTEGER PRIMARY KEY CHECK(id=1), name TEXT NOT NULL, birthdate TEXT NOT NULL, sex TEXT NOT NULL CHECK(sex IN ('M','F')))`);
    oldDb.prepare('INSERT INTO child(id,name,birthdate,sex) VALUES (1,?,?,?)').run('舊寶寶', '2025-01-01', 'F');
    oldDb.close();
  }
  const dbPath = JSON.stringify(path.join(__dirname, '..', 'db.js'));
  const migrateOut = execFileSync(process.execPath, ['-e', `
    process.env.DATA_DIR = ${JSON.stringify(oldDir)};
    const { db } = require(${dbPath});
    const row = db.prepare('SELECT theme_color, show_poop, show_milk FROM child WHERE id=1').get();
    console.log(JSON.stringify(row));
  `], { encoding: 'utf8' }).trim().split('\n').pop();
  const migrated = JSON.parse(migrateOut);
  assert(migrated.theme_color === '#658dc6', '舊資料庫升級：theme_color 自動補欄位且預設為原本的藍色');
  assert(migrated.show_poop === 1 && migrated.show_milk === 1, '舊資料庫升級：show_poop／show_milk 自動補欄位且預設為開啟');

  console.log(`\n全部通過（${passed} 項）`);
  process.exit(0);
})().catch(e => { console.error('❌ 測試炸掉：', e); process.exit(1); });

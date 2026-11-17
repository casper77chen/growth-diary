// 把 WHO expanded tables（逐日 LMS）轉成 public/who-lms.json（逐月 0-60，[L,M,S]）
// 來源：https://www.who.int/tools/child-growth-standards/standards （官方 xlsx，已下載到 data/who-src/）
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

const SRC = path.join(__dirname, '..', 'data', 'who-src');
const OUT = path.join(__dirname, '..', 'public', 'who-lms.json');
const FILES = {
  wfa: { M: 'wfa-boys-zscore-expanded-tables.xlsx', F: 'wfa-girls-zscore-expanded-tables.xlsx' },
  lhfa: { M: 'lhfa-boys-zscore-expanded-tables.xlsx', F: 'lhfa-girls-zscore-expanded-tables.xlsx' },
  hcfa: { M: 'hcfa-boys-zscore-expanded-tables.xlsx', F: 'hcfa-girls-zscore-expanded-tables.xlsx' },
};

function readLMS(file) {
  const wb = XLSX.readFile(path.join(SRC, file));
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });
  if (!rows.length) throw new Error(`${file}: 空表`);
  const keys = Object.keys(rows[0]);
  const find = name => keys.find(k => k.trim().toLowerCase() === name);
  const dayKey = find('day') || find('age');
  const lKey = find('l'), mKey = find('m'), sKey = find('s');
  if (!dayKey || !lKey || !mKey || !sKey) throw new Error(`${file}: 找不到欄位，實際欄位=${keys.join(',')}`);
  const byDay = new Map(rows.map(r => [Number(r[dayKey]), r]));
  const months = [];
  for (let mo = 0; mo <= 60; mo++) {
    const day = Math.round(mo * 30.4375);
    let row = byDay.get(day);
    for (let d = 1; !row && d <= 3; d++) row = byDay.get(day - d) || byDay.get(day + d);
    if (!row) throw new Error(`${file}: 第 ${mo} 個月（day ${day}）找不到資料`);
    months.push([Number(row[lKey]), Number(row[mKey]), Number(row[sKey])]);
  }
  return months;
}

const out = {};
for (const [ind, files] of Object.entries(FILES)) {
  out[ind] = {};
  for (const [sex, file] of Object.entries(files)) {
    out[ind][sex] = readLMS(file);
    console.log(`${ind}/${sex}: 61 個月的 LMS，M(0m)=${out[ind][sex][0][1]}, M(12m)=${out[ind][sex][12][1]}, M(60m)=${out[ind][sex][60][1]}`);
  }
}
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(`寫入 ${OUT}（${(fs.statSync(OUT).size / 1024).toFixed(0)} KB）`);

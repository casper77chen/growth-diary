// 年齡計算：全部以 YYYY-MM-DD 字串為輸入，避免時區偏移
function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function fmtDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function today() {
  return fmtDate(new Date());
}

// 日曆式年齡：X 歲 Y 個月 Z 天
function ageParts(birth, at) {
  const b = parseDate(birth), a = parseDate(at);
  if (a < b) return null;
  let years = a.getFullYear() - b.getFullYear();
  let months = a.getMonth() - b.getMonth();
  let days = a.getDate() - b.getDate();
  if (days < 0) {
    months -= 1;
    const prevMonthEnd = new Date(a.getFullYear(), a.getMonth(), 0).getDate();
    days += prevMonthEnd;
  }
  if (months < 0) { years -= 1; months += 12; }
  return { years, months, days };
}

function ageLabel(birth, at) {
  const p = ageParts(birth, at);
  if (!p) return '出生前';
  if (p.years === 0 && p.months === 0) return `${p.days} 天`;
  if (p.years === 0) return `${p.months} 個月 ${p.days} 天`;
  return `${p.years} 歲 ${p.months} 個月 ${p.days} 天`;
}

// 十進位月齡（給生長曲線 x 軸用）
function ageMonthsDecimal(birth, at) {
  const days = (parseDate(at) - parseDate(birth)) / 86400000;
  return days / 30.4375;
}

function shiftDate(s, { years = 0, months = 0, days = 0 }) {
  const d = parseDate(s);
  const target = new Date(d.getFullYear() + years, d.getMonth() + months, d.getDate() + days);
  return fmtDate(target);
}

module.exports = { parseDate, fmtDate, today, ageParts, ageLabel, ageMonthsDecimal, shiftDate };

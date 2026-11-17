// 從一個主色（hex）推算整套帶藍調的色票（原本 style.css 裡寫死的那些藍色全部來自這套規則）。
// 原理：原始設計其實是同一個色相＋飽和度，只是取不同明度（HSL 的 L）畫出來的階梯。
// 所以我們把使用者選的主色轉成 HSL，固定住它的色相／飽和度，照同一套明度梯去生出每個色，
// 淺色主色（粉色、淡黃）一樣適用；深色字另外降低一點飽和度、固定在偏低明度，確保可讀。

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_THEME_COLOR = '#658dc6';

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function toHex(r, g, b) {
  const h = v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const delta = max - min;
  if (delta < 1e-6) return { h: 0, s: 0, l };
  const s = delta / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === r) h = ((g - b) / delta) % 6;
  else if (max === g) h = (b - r) / delta + 2;
  else h = (r - g) / delta + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}
function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r1, g1, b1;
  if (h < 60) [r1, g1, b1] = [c, x, 0];
  else if (h < 120) [r1, g1, b1] = [x, c, 0];
  else if (h < 180) [r1, g1, b1] = [0, c, x];
  else if (h < 240) [r1, g1, b1] = [0, x, c];
  else if (h < 300) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  return { r: (r1 + m) * 255, g: (g1 + m) * 255, b: (b1 + m) * 255 };
}
// WCAG 相對亮度，用來判斷按鈕底色配白字還是深色字對比夠不夠
function relLuminance(r, g, b) {
  const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(l1, l2) {
  const [a, b] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (a + 0.05) / (b + 0.05);
}

function isValidThemeColor(hex) {
  return typeof hex === 'string' && HEX_RE.test(hex);
}

// 建出整套色票。輸入不是合法 hex 就退回預設藍色。
function buildTheme(inputHex) {
  const hex = isValidThemeColor(inputHex) ? inputHex : DEFAULT_THEME_COLOR;
  const { r, g, b } = hexToRgb(hex);
  let { h, s } = rgbToHsl(r, g, b);
  // 近乎灰色（飽和度太低）時色相計算會很不穩定，給一個淡淡的藍灰色相墊底
  if (s < 0.04) { h = 215; s = 0.12; }

  const tint = L => toHex(...Object.values(hslToRgb(h, s, L)));
  const darkRgb = hslToRgb(h, Math.min(s * 0.76, 0.5), 0.40);
  const darkText = toHex(darkRgb.r, darkRgb.g, darkRgb.b);

  // 按鈕文字選白字還是深色字：兩個都試算對比度，誰贏用誰（不要求一定要到 4.5：
  // 原本寫死的藍色＋白字對比只有約 3.4，一直用得好好的，硬性要求 4.5 會把預設配色也改掉）
  const accentLum = relLuminance(r, g, b);
  const whiteLum = relLuminance(255, 255, 255);
  const darkLum = relLuminance(darkRgb.r, darkRgb.g, darkRgb.b);
  const onAccent = contrast(accentLum, whiteLum) >= contrast(accentLum, darkLum) ? '#ffffff' : darkText;

  return {
    accent: hex,
    accentSoft: tint(0.93),
    bg: tint(0.965),
    border: tint(0.898),       // 一般輸入框／按鈕邊框（原 #dce3ee）
    borderSoft: tint(0.9175),  // topbar／bottomnav 邊框（原 #e2e8f2）
    borderTable: tint(0.934),  // 表格列邊框（原 #e7edf5）
    inputBg: tint(0.99),       // 輸入框底色（原 #fbfcfe）
    filepickBorder: tint(0.8075), // 選檔框虛線邊框／待完成點點（原 #b9c8e3）
    darkText,                  // 深色字：徽章、連結色塊文字（原 #46618f）
    accentRgb: `${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}`, // 給 rgba() 陰影用
    onAccent,                  // 按鈕疊在主色底上的文字顏色（白字對比不夠就用深色字）
  };
}

function themeToCssVars(theme) {
  return `:root{` +
    `--accent:${theme.accent};` +
    `--accent-soft:${theme.accentSoft};` +
    `--accent-dark:${theme.darkText};` +
    `--accent-ink:${theme.onAccent};` +
    `--accent-rgb:${theme.accentRgb};` +
    `--bg:${theme.bg};` +
    `--border:${theme.border};` +
    `--border-soft:${theme.borderSoft};` +
    `--border-table:${theme.borderTable};` +
    `--input-bg:${theme.inputBg};` +
    `--filepick-border:${theme.filepickBorder};` +
    `}`;
}

module.exports = { buildTheme, themeToCssVars, isValidThemeColor, HEX_RE, DEFAULT_THEME_COLOR };

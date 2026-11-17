// App 圖示：預設是「主題色＋小腳印」，用 SVG 畫好再用 sharp 轉 PNG（容器沒有中文字體，
// 所以預設圖示刻意不含任何文字）。也支援爸媽上傳自己的圖（例如舊站用的「多」「樂」字圖示），
// 上傳後優先顯示自訂圖，沒上傳才用小腳印。
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { buildTheme } = require('./theme');

const CUSTOM_SIZES = [512, 192, 180];

// 腳印本體：寶寶右腳——前寬後窄的腳掌（花生形）＋大到小五個腳趾，畫在 0..512 的座標系。
// 腳印顏色跟按鈕文字同一套判斷：主色夠深用白色，淺色主色（粉、淡黃）改用加深的主色，避免糊成一片
function footprintSvg(size, colorHex) {
  const fill = buildTheme(colorHex).onAccent;
  const toes = [
    { cx: 206, cy: 160, r: 29 },
    { cx: 252, cy: 136, r: 21 },
    { cx: 289, cy: 138, r: 18 },
    { cx: 320, cy: 153, r: 15.5 },
    { cx: 344, cy: 176, r: 13.5 },
  ];
  const toeCircles = toes.map(t => `<circle cx="${t.cx}" cy="${t.cy}" r="${t.r}"/>`).join('');
  const sole = 'M262 196 C318 196 342 236 336 290 C330 336 312 352 312 390 C312 432 290 456 258 456 ' +
    'C222 456 204 430 206 396 C208 360 196 330 190 290 C184 236 210 196 262 196 Z';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="112" fill="${colorHex}"/>
  <g fill="${fill}" opacity="0.95" transform="translate(-6 -26) rotate(-12 266 296)">
    <path d="${sole}"/>
    ${toeCircles}
  </g>
</svg>`;
}

async function footprintIconBuffer(size, colorHex) {
  return sharp(Buffer.from(footprintSvg(size, colorHex))).resize(size, size).png().toBuffer();
}

function customIconPath(iconsDir, size) {
  return path.join(iconsDir, `custom-${size}.png`);
}
function hasCustomIcon(iconsDir) {
  return fs.existsSync(customIconPath(iconsDir, 512));
}
function clearCustomIcon(iconsDir) {
  for (const size of CUSTOM_SIZES) {
    const p = customIconPath(iconsDir, size);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}
// 把爸媽上傳的圖（可能不是正方形）置中裁切成正方形，產出 512/192/180 三個尺寸存進 iconsDir
async function saveCustomIcon(buffer, iconsDir) {
  const base = sharp(buffer).rotate(); // 先轉正方向（含 EXIF）
  const meta = await base.metadata();
  const w = meta.width, h = meta.height;
  if (!w || !h) throw new Error('看不出圖片尺寸，請換一張圖片');
  const side = Math.min(w, h);
  const left = Math.max(0, Math.floor((w - side) / 2));
  const top = Math.max(0, Math.floor((h - side) / 2));
  const squared = await sharp(buffer).rotate().extract({ left, top, width: side, height: side }).png().toBuffer();
  for (const size of CUSTOM_SIZES) {
    await sharp(squared).resize(size, size).png().toFile(customIconPath(iconsDir, size));
  }
}

module.exports = { footprintIconBuffer, hasCustomIcon, saveCustomIcon, clearCustomIcon, customIconPath, CUSTOM_SIZES };

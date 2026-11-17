const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sharp = require('sharp');
const exifr = require('exifr');
const { MEDIA_DIR, THUMB_DIR } = require('../db');

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const VIDEO_MIMES = new Set(['video/mp4', 'video/quicktime', 'video/webm']);
const VIDEO_EXT = { 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm' };

function isAllowed(mime) {
  return IMAGE_MIMES.has(mime) || VIDEO_MIMES.has(mime);
}

// 處理一個 multer 暫存檔：照片壓縮＋縮圖，影片原樣搬移。回傳 media row 欄位。
async function processUpload(file) {
  const id = crypto.randomUUID();
  if (IMAGE_MIMES.has(file.mimetype)) {
    let takenAt = null;
    try {
      const exif = await exifr.parse(file.path, { pick: ['DateTimeOriginal', 'CreateDate'] });
      const dt = exif && (exif.DateTimeOriginal || exif.CreateDate);
      if (dt instanceof Date && !isNaN(dt)) {
        const p = n => String(n).padStart(2, '0');
        takenAt = `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
      }
    } catch { /* 沒有 EXIF 就算了 */ }
    const name = `${id}.jpg`;
    await sharp(file.path).rotate()
      .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true })
      .toFile(path.join(MEDIA_DIR, name));
    await sharp(file.path).rotate()
      .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 70, mozjpeg: true })
      .toFile(path.join(THUMB_DIR, name));
    const bytes = fs.statSync(path.join(MEDIA_DIR, name)).size;
    fs.unlinkSync(file.path);
    return { kind: 'photo', file: name, thumb: `thumbs/${name}`, taken_at: takenAt, bytes };
  }
  if (VIDEO_MIMES.has(file.mimetype)) {
    const name = `${id}${VIDEO_EXT[file.mimetype] || '.mp4'}`;
    fs.renameSync(file.path, path.join(MEDIA_DIR, name));
    return { kind: 'video', file: name, thumb: null, taken_at: null, bytes: file.size };
  }
  fs.unlinkSync(file.path);
  throw new Error(`不支援的檔案格式：${file.mimetype}`);
}

function deleteFiles(mediaRow) {
  for (const f of [mediaRow.file, mediaRow.thumb]) {
    if (!f) continue;
    const p = path.join(MEDIA_DIR, f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

module.exports = { processUpload, deleteFiles, isAllowed, IMAGE_MIMES, VIDEO_MIMES };

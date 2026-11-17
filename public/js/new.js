// 新增紀錄頁：檔案預覽＋EXIF 日期自動帶入＋里程碑選單切換
(function () {
  const filesInput = document.getElementById('files');
  const preview = document.getElementById('preview');
  const dateInput = document.getElementById('dateInput');
  const exifHint = document.getElementById('exifHint');
  const typeSeg = document.getElementById('typeSeg');
  const msBox = document.getElementById('msBox');
  const msSelect = document.getElementById('msSelect');
  const newMs = document.getElementById('newMs');
  const submitBtn = document.getElementById('submitBtn');
  let userTouchedDate = false;

  dateInput.addEventListener('change', () => { userTouchedDate = true; });

  typeSeg.addEventListener('change', () => {
    const isMs = typeSeg.querySelector('input:checked').value === 'milestone';
    msBox.classList.toggle('hidden', !isMs);
  });

  const recorderSeg = document.getElementById('recorderSeg');
  const recorderOther = document.getElementById('recorderOther');
  recorderSeg.addEventListener('change', () => {
    const isOther = recorderSeg.querySelector('input:checked').value === '__other';
    recorderOther.classList.toggle('hidden', !isOther);
    if (isOther) recorderOther.focus();
  });
  msSelect.addEventListener('change', () => {
    newMs.classList.toggle('hidden', msSelect.value !== '__new');
    if (msSelect.value === '__new') newMs.focus();
  });

  function fmt(d) {
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  filesInput.addEventListener('change', async () => {
    preview.innerHTML = '';
    const files = Array.from(filesInput.files || []);
    for (const f of files) {
      const url = URL.createObjectURL(f);
      let el;
      if (f.type.startsWith('video/')) {
        el = document.createElement('video');
        el.src = url; el.muted = true; el.playsInline = true; el.preload = 'metadata';
      } else {
        el = document.createElement('img');
        el.src = url;
      }
      preview.appendChild(el);
    }
    // 日期自動帶入：EXIF 拍攝日期優先，抓不到用檔案時間；使用者改過就不動
    if (userTouchedDate || !files.length) return;
    const first = files[0];
    let picked = null, source = '';
    if (first.type.startsWith('image/') && window.exifr) {
      try {
        const exif = await exifr.parse(first, { pick: ['DateTimeOriginal', 'CreateDate'] });
        const dt = exif && (exif.DateTimeOriginal || exif.CreateDate);
        if (dt instanceof Date && !isNaN(dt)) { picked = dt; source = '照片拍攝日期'; }
      } catch (e) { /* 讀不到就用檔案時間 */ }
    }
    if (!picked && first.lastModified) {
      picked = new Date(first.lastModified);
      source = '檔案日期';
    }
    if (picked) {
      dateInput.value = fmt(picked);
      exifHint.textContent = '日期已自動帶入（' + source + '），不對可以直接改。';
      exifHint.classList.remove('hidden');
    }
  });

  // 快速記錄（排便／喝奶）：點按鈕跳視窗，帶入現在的日期時間讓使用者確認
  // 日期用下拉選單（今天～往前 7 天），日期在前端算——伺服器在 UTC 容器，算「今天」會差一天
  function bindQuickDialog(prefix, onOpen) {
    const dlg = document.getElementById(prefix + 'Dialog');
    const btn = document.getElementById(prefix + 'Btn');
    if (!dlg || !btn) return; // 功能關閉時頁面上不會有這些元素
    btn.addEventListener('click', () => {
      const now = new Date();
      const p = n => String(n).padStart(2, '0');
      const dateSel = document.getElementById(prefix + 'Date');
      dateSel.innerHTML = '';
      for (let i = 0; i <= 7; i++) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        const name = ['今天', '昨天', '前天'][i] || i + ' 天前';
        const opt = document.createElement('option');
        opt.value = fmt(d);
        opt.textContent = name + '（' + fmt(d) + '）';
        dateSel.appendChild(opt);
      }
      document.getElementById(prefix + 'Time').value = p(now.getHours()) + ':' + p(now.getMinutes());
      dlg.showModal();
      if (onOpen) onOpen();
    });
    const cancelBtn = document.getElementById(prefix + 'Cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', () => dlg.close());
  }
  bindQuickDialog('poop');
  bindQuickDialog('milk', () => {
    const ml = document.getElementById('milkMl');
    ml.focus(); ml.select();
  });

  document.getElementById('newForm').addEventListener('submit', () => {
    submitBtn.disabled = true;
    submitBtn.textContent = '上傳中…（影片會需要一點時間）';
  });
})();

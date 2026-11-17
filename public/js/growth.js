// 成長數據頁：WHO 百分位曲線＋歷史列表
(function () {
  const D = window.GROWTH_DATA;
  const canvas = document.getElementById('chart');
  const hint = document.getElementById('chartHint');
  const table = document.getElementById('entriesTable');
  const tabs = document.getElementById('metricTabs');
  let who = null;
  let chart = null;

  const Z = { P3: -1.8808, P15: -1.0364, P50: 0, P85: 1.0364, P97: 1.8808 };

  function lmsAt(rows, month) {
    // rows: [[L,M,S], ...] 以月為索引 0..60，線性內插
    const i = Math.min(Math.max(month, 0), rows.length - 1);
    const lo = Math.floor(i), hi = Math.min(lo + 1, rows.length - 1), t = i - lo;
    const mix = k => rows[lo][k] * (1 - t) + rows[hi][k] * t;
    return { L: mix(0), M: mix(1), S: mix(2) };
  }
  function valueAt(lms, z) {
    return Math.abs(lms.L) < 1e-6 ? lms.M * Math.exp(lms.S * z) : lms.M * Math.pow(1 + lms.L * lms.S * z, 1 / lms.L);
  }
  function zOf(lms, x) {
    return Math.abs(lms.L) < 1e-6 ? Math.log(x / lms.M) / lms.S : (Math.pow(x / lms.M, lms.L) - 1) / (lms.L * lms.S);
  }
  function cdf(z) { // 標準常態 CDF（Abramowitz–Stegun 近似）
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989423 * Math.exp(-z * z / 2);
    let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return z > 0 ? 1 - p : p;
  }

  function render(metricId) {
    const m = D.metrics.find(x => String(x.id) === String(metricId));
    if (!m) return;
    const rows = m.who && who && who[m.who] ? who[m.who][D.sex] : null;
    const maxAge = m.entries.length ? Math.max(...m.entries.map(e => e.ageMonths)) : 0;
    const xMax = Math.min(60, Math.max(12, Math.ceil(maxAge) + 2));
    const datasets = [];
    if (rows) {
      for (const [name, z] of Object.entries(Z)) {
        const data = [];
        for (let mo = 0; mo <= xMax; mo += 0.5) data.push({ x: mo, y: valueAt(lmsAt(rows, mo), z) });
        datasets.push({
          label: name, data, pointRadius: 0, borderWidth: name === 'P50' ? 2 : 1,
          borderColor: name === 'P50' ? '#9db4d6' : '#d4deee',
          borderDash: name === 'P50' ? [] : [5, 4], fill: false, tension: .3,
        });
      }
    }
    datasets.push({
      label: m.name, data: m.entries.map(e => ({ x: e.ageMonths, y: e.value })),
      borderColor: '#658dc6', backgroundColor: '#658dc6', pointRadius: 4, borderWidth: 2, tension: .2, fill: false,
    });
    if (chart) chart.destroy();
    chart = new Chart(canvas, {
      type: 'line',
      data: { datasets },
      options: {
        animation: false, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { type: 'linear', min: 0, max: xMax, title: { display: true, text: '月齡' } },
          y: { title: { display: true, text: m.unit }, ticks: m.id === 'poop' || m.id === 'milk' ? { precision: 0 } : {} },
        },
      },
    });

    if (m.id === 'poop') {
      hint.textContent = m.entries.length
        ? '每天的排便總次數（時間列在「記錄」欄）；沒紀錄的日子自動算 0。刪除會移除該日最後一次。'
        : '還沒有紀錄。到「＋」新增頁點「💩 排便」就能快速記一筆。';
    } else if (m.id === 'milk') {
      const last = m.entries[m.entries.length - 1];
      const split = last && (last.breastMl || last.formulaMl)
        ? `（${[last.breastMl ? `母奶 ${last.breastMl}` : '', last.formulaMl ? `配方 ${last.formulaMl}` : ''].filter(Boolean).join('＋')}）`
        : '';
      hint.textContent = m.entries.length
        ? `最新（${last.date}）：共 ${last.value} ml${split}、${last.count} 次（各次列在「記錄」欄，母＝母奶、配＝配方奶）。刪除會移除該日最後一次。`
        : '還沒有紀錄。到「＋」新增頁點「🍼 喝奶」就能快速記一筆。';
    } else if (!m.entries.length) {
      hint.textContent = '還沒有資料，先在下面新增一筆吧。';
    } else if (rows) {
      const last = m.entries[m.entries.length - 1];
      const pct = Math.round(cdf(zOf(lmsAt(rows, last.ageMonths), last.value)) * 100);
      hint.textContent = `最新（${last.date}）：${last.value} ${m.unit}，約第 ${Math.min(99, Math.max(1, pct))} 百分位（WHO 0-5 歲標準）。虛線由下而上為 P3／P15／P50／P85／P97。`;
    } else if (m.who) {
      hint.textContent = 'WHO 曲線資料載入失敗，只顯示自己的數據。';
    } else {
      hint.textContent = '自訂項目沒有標準曲線，顯示自己的趨勢。';
    }

    table.innerHTML = '<tr><th>日期</th><th>月齡</th><th>數值</th><th>記錄</th><th></th></tr>' +
      m.entries.slice().reverse().map(e => {
        let del = `data-action="/measurements/${e.id}/delete"`;
        if (m.id === 'poop') del = `data-action="/poop/${e.id}/delete" data-msg="刪除 ${e.date} 最後一次排便${e.lastTime ? '（' + e.lastTime + '）' : ''}？該日次數會減 1。"`;
        if (m.id === 'milk') del = `data-action="/milk/${e.id}/delete" data-msg="刪除 ${e.date} 最後一次喝奶${e.lastTime ? '（' + e.lastTime + '）' : ''}${e.lastKind ? ' ' + e.lastKind : ''} ${e.lastMl} ml？"`;
        const delBtn = e.id == null ? '' : `<button class="del" ${del}>刪除</button>`;
        return `<tr><td>${e.date}</td><td>${e.age}</td><td>${e.value} ${m.unit}</td><td>${e.by || ''}</td>` +
          `<td>${delBtn}</td></tr>`;
      }).join('');
  }

  table.addEventListener('click', e => {
    const btn = e.target.closest('.del');
    if (!btn || !confirm(btn.dataset.msg || '刪除這筆測量？')) return;
    const f = document.createElement('form');
    f.method = 'post'; f.action = btn.dataset.action;
    document.body.appendChild(f); f.submit();
  });

  tabs.addEventListener('change', () => render(tabs.querySelector('input:checked').value));

  fetch('/who-lms.json').then(r => r.ok ? r.json() : null).catch(() => null).then(data => {
    who = data;
    render(tabs.querySelector('input:checked').value);
  });
})();

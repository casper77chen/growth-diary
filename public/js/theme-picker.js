// 主題色選色器：色塊（<input type=color>）與 hex 文字框互相同步，點預設色塊也同步
(function () {
  const HEX_RE = /^#[0-9a-fA-F]{6}$/;
  document.querySelectorAll('.colorpick').forEach(wrap => {
    const name = wrap.dataset.name;
    const swatch = wrap.querySelector('input[type=color]');
    const hexInput = wrap.querySelector('input[type=text]');
    if (!swatch || !hexInput) return;
    swatch.addEventListener('input', () => { hexInput.value = swatch.value; });
    hexInput.addEventListener('input', () => {
      if (HEX_RE.test(hexInput.value)) swatch.value = hexInput.value;
    });
    document.querySelectorAll(`.color-preset[data-for="${name}"]`).forEach(btn => {
      btn.addEventListener('click', () => {
        const c = btn.dataset.color;
        swatch.value = c; hexInput.value = c;
      });
    });
  });
})();

// ---- logo: smooth -> dithered -> pixel, drawn once on a canvas ------------------------------------------------------------------
function drawLogo() {
  const cv = $('logo'), W2 = cv.width, H2 = cv.height, ctx = cv.getContext('2d'), txt = 'SHATTERWORLD';
  const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  const big = mk(W2, H2), bg = big.getContext('2d'); bg.textAlign = 'center'; bg.textBaseline = 'middle'; bg.letterSpacing = '6px'; let fs = 190; bg.font = `900 ${fs}px "Trebuchet MS", "Segoe UI", system-ui, sans-serif`; const tw = bg.measureText(txt).width; fs = Math.floor(fs * Math.min(1, (W2 * 0.92) / tw)); bg.font = `900 ${fs}px "Trebuchet MS", "Segoe UI", system-ui, sans-serif`;
  const gr = bg.createLinearGradient(0, 40, 0, 260); gr.addColorStop(0, '#fff6c8'); gr.addColorStop(0.45, '#ffcb55'); gr.addColorStop(1, '#ff8a2e'); bg.fillStyle = gr; bg.strokeStyle = 'rgba(70,25,0,.9)'; bg.lineWidth = 12; bg.lineJoin = 'round'; bg.letterSpacing = '6px';
  bg.strokeText(txt, W2 / 2, H2 / 2 + 6); bg.fillText(txt, W2 / 2, H2 / 2 + 6);
  const sm = mk(W2 / 12, H2 / 12), sx = sm.getContext('2d'); sx.imageSmoothingEnabled = true; sx.drawImage(big, 0, 0, sm.width, sm.height);
  const px = mk(W2, H2), pxc = px.getContext('2d'); pxc.imageSmoothingEnabled = false; pxc.drawImage(sm, 0, 0, W2, H2);
  // posterise the pixel half
  const pd = pxc.getImageData(0, 0, W2, H2), d = pd.data; for (let i = 0; i < d.length; i += 4) { d[i] = Math.round(d[i] / 64) * 64; d[i + 1] = Math.round(d[i + 1] / 64) * 64; d[i + 2] = Math.round(d[i + 2] / 48) * 48; } pxc.putImageData(pd, 0, 0);
  const bd = bg.getImageData(0, 0, W2, H2), od = new ImageData(W2, H2), B = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  for (let y = 0; y < H2; y++) for (let x = 0; x < W2; x++) { const k = (y * W2 + x) * 4, t = clamp((x / W2 - 0.52) / 0.2, 0, 1), th = (B[(y & 3) * 4 + (x & 3)] + 0.5) / 16, usePx = t > th; const src = usePx ? pd.data : bd.data; od.data[k] = src[k]; od.data[k + 1] = src[k + 1]; od.data[k + 2] = src[k + 2]; od.data[k + 3] = usePx ? pd.data[k + 3] : bd.data[k + 3]; }
  ctx.clearRect(0, 0, W2, H2); ctx.putImageData(od, 0, 0);
}


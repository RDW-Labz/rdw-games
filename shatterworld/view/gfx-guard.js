// <gfx-guard> ===================================================================================================================
// SHATTERWORLD graphics hardening (pass B, "black graphics at high settings"). The high / medium tiers render through an EffectComposer with a HALF-FLOAT target (+ 4x MSAA on high) and a bloom pass.
// On GPUs / drivers where that path is not fully supported, or when a pixel becomes NaN / Inf / negative before bloom blurs it, the picture goes black (whole frame or blotches). Nothing here changes how a healthy GPU looks:
//   * the render target type / sample count follow the GPU's real capabilities (half float needs EXT_color_buffer_(half_)float, multisampled float needs EXT_color_buffer_float, samples <= MAX_SAMPLES),
//   * the pixel ratio is capped by MAX_RENDERBUFFER_SIZE / MAX_TEXTURE_SIZE and by ~8.3 megapixels (a 4K target),
//   * a tiny guard pass between the scene and bloom replaces NaN / Inf / negative values by 0 and clamps the HDR range, so one bad pixel can never spread into a black blotch,
//   * a watchdog reads 9 pixels of the finished frame every 45 frames in flat play: three all-black probes in a row step the pipeline down (byte target -> no MSAA -> no bloom -> next tier),
//   * a lost WebGL context is counted; a second loss within two minutes steps the pipeline down too.
// Tests: scratchpad/shatter-passB/gfx-test.mjs (fake GPUs without float targets, forced black frames), hdr-scan.mjs, black-hunt.mjs, sampler-count.mjs.
function gfxS() { return window.__gfxS || (window.__gfxS = { forceByte: 0, noMsaa: 0, noBloom: 0, bad: 0, lost: [], steps: [], px: null }); }
function gfxCaps() { const ex = renderer.extensions, gl = renderer.getContext(); return { half: !!(ex.has('EXT_color_buffer_float') || ex.has('EXT_color_buffer_half_float')), flt: !!ex.has('EXT_color_buffer_float'), maxS: renderer.capabilities.maxSamples | 0, rb: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) | 0, tex: renderer.capabilities.maxTextureSize | 0 }; }
function gfxRtType() { return gfxCaps().half && !gfxS().forceByte ? THREE.HalfFloatType : THREE.UnsignedByteType; }
function gfxSamples(w, h) { const c = gfxCaps(); if (gfxS().noMsaa || !Q.msaa || w * h > 4.2e6) return 0; if (gfxRtType() === THREE.HalfFloatType && !c.flt) return 0; return Math.min(Q.msaa, c.maxS); }
function gfxPr(w, h) { const c = gfxCaps(); let pr = Math.min(window.devicePixelRatio || 1, Q.pr) * qScale; const side = Math.max(64, Math.min(c.rb || 4096, c.tex || 4096) - 2); pr = Math.min(pr, side / Math.max(w, h, 1)); const px = w * h * pr * pr; if (px > 8.3e6) pr *= Math.sqrt(8.3e6 / px); return Math.max(0.5, pr); }
const HdrGuardShader = { uniforms: { tDiffuse: { value: null } }, vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: 'uniform sampler2D tDiffuse; varying vec2 vUv; void main(){ vec4 c = texture2D(tDiffuse, vUv); if (any(isnan(c)) || any(isinf(c))) c = vec4(0.0, 0.0, 0.0, 1.0); c.rgb = clamp(c.rgb, vec3(0.0), vec3(48.0)); gl_FragColor = c; }' };
function gfxDegrade(why) { // one step down the ladder per call; returns the step taken
  const S = gfxS(); let step = '';
  if (!S.forceByte && gfxCaps().half && Q.bloom) { S.forceByte = 1; step = 'byte render target'; } else if (!S.noMsaa && Q.msaa) { S.noMsaa = 1; step = 'no MSAA'; } else if (!S.noBloom && Q.bloom) { S.noBloom = 1; step = 'no bloom'; }
  else { const i = QORDER.indexOf(qName); if (i >= 0 && i < QORDER.length - 1) { applyQuality(QORDER[i + 1], true); step = 'tier ' + qName; } }
  if (!step) return ''; S.steps.push(step + ' (' + why + ')'); console.warn('[gfx] ' + why + ' -> ' + step); buildComposer(); if (typeof toast === 'function') toast('Graphics: ' + step); return step;
}
function gfxProbe() { // 9 pixels of the finished frame: a healthy frame is never pure black
  const S = gfxS(); if (VR.presenting || G.state !== 'play' || G.trans || G.finale || document.hidden || frameCount % (S.interval || 45) !== 0) return; const cv = renderer.domElement, w = cv.width, h = cv.height; if (w < 16 || h < 16) return;
  const gl = renderer.getContext(), px = S.px || (S.px = new Uint8Array(4)); let nz = 0;
  for (let i = 0; i < 9; i++) { gl.readPixels(((i % 3) + 0.5) / 3 * w | 0, (((i / 3) | 0) + 0.5) / 3 * h | 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); if (px[0] + px[1] + px[2] > 2) nz++; }
  if (window.__gfxForceBlack) nz = 0; if (nz > 0) { S.bad = 0; return; } if (++S.bad >= 3) { S.bad = 0; gfxDegrade('black frames'); }
}
function gfxHook() { // boot log + context-loss bookkeeping
  const cv = renderer.domElement, S = gfxS(); try { const gl = renderer.getContext(), x = gl.getExtension('WEBGL_debug_renderer_info'), c = gfxCaps(); console.info('[gfx] ' + (x ? gl.getParameter(x.UNMASKED_RENDERER_WEBGL) : 'gpu') + ' caps ' + JSON.stringify(c) + ' tier ' + qName); } catch (e) { }
  cv.addEventListener('webglcontextlost', () => { const t = performance.now(); S.lost.push(t); S.lost = S.lost.filter(q => t - q < 120000); console.warn('[gfx] webgl context lost (' + S.lost.length + ')'); if (S.lost.length >= 2) setTimeout(() => gfxDegrade('context lost twice'), 800); });
  cv.addEventListener('webglcontextrestored', () => { console.warn('[gfx] webgl context restored'); try { renderer.resetState(); buildComposer(); } catch (e) { } });
}
window.__game.gfx = () => ({ THREE, composer, bloomPass, gradePass, renderPass, Q, qName, S: gfxS(), caps: gfxCaps() });
// </gfx-guard>


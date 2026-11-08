// ============================================================================
// POST: HDR render target (MSAA on High) -> bloom -> grade (god rays, split-tone, vignette, chroma pulse, dither) -> ACES output
// ============================================================================
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uSun: { value: new THREE.Vector2(0.5, 0.5) }, uGod: { value: 0 }, uSunCol: { value: new THREE.Color(1, 0.8, 0.5) }, uSat: { value: 1.1 }, uCon: { value: 1.04 },
    uVig: { value: 0.32 }, uTime: U.time, uChroma: { value: 0 }, uShadow: { value: new THREE.Color(0.9, 0.95, 1.08) }, uHigh: { value: new THREE.Color(1.07, 1.0, 0.9) }, uAspect: { value: 1.78 }, uFlash: { value: 0 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `uniform sampler2D tDiffuse; uniform vec2 uSun; uniform float uGod; uniform vec3 uSunCol; uniform float uSat; uniform float uCon; uniform float uVig; uniform float uTime; uniform float uChroma; uniform vec3 uShadow; uniform vec3 uHigh; uniform float uAspect; uniform float uFlash;
varying vec2 vUv;
float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main(){
  vec2 uv = vUv; vec2 cc = uv - 0.5;
  vec3 c;
  if (uChroma > 0.001) { vec2 o = cc * uChroma * 0.03; c = vec3(texture2D(tDiffuse, uv + o).r, texture2D(tDiffuse, uv).g, texture2D(tDiffuse, uv - o).b); }
  else c = texture2D(tDiffuse, uv).rgb;
  if (uGod > 0.002) {
    vec2 dir = (uSun - uv) / 22.0; vec2 p = uv + dir * ign(gl_FragCoord.xy); float w = 1.0; vec3 acc = vec3(0.0);
    for (int i = 0; i < 22; i++) { p += dir; vec3 s = texture2D(tDiffuse, p).rgb; float l = max(dot(s, vec3(0.3, 0.55, 0.15)) - 0.85, 0.0); acc += uSunCol * min(l, 4.0) * w; w *= 0.935; }
    c += acc * uGod * 0.07;
  }
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uSat);
  c *= mix(uShadow, uHigh, smoothstep(0.0, 0.9, l));
  c = (c - 0.18) * uCon + 0.18; c = max(c, 0.0);
  float v = 1.0 - dot(cc * vec2(1.0, 1.0 / max(uAspect, 0.5)) * 1.55, cc * vec2(1.0, 1.0 / max(uAspect, 0.5)) * 1.55);
  c *= mix(1.0, smoothstep(0.0, 1.0, clamp(v, 0.0, 1.0)), uVig);
  c += (ign(gl_FragCoord.xy + uTime * 60.0) - 0.5) * 0.006;
  c += vec3(1.0, 0.95, 0.85) * uFlash;
  gl_FragColor = vec4(c, 1.0);
}`,
};
let composerBuilt = '', qScale = 1;
function buildComposer() {
  if (composer) { composer.dispose(); composer = null; }
  const pr = renderer.getPixelRatio();
  if (!(Q.bloom || Q.god || Q.msaa)) { composer = null; return; }   // low tier renders straight to the canvas
  const rt = new THREE.WebGLRenderTarget(Math.max(2, Math.floor(W * pr)), Math.max(2, Math.floor(H * pr)), { type: gfxRtType(), samples: gfxSamples(Math.max(2, Math.floor(W * pr)), Math.max(2, Math.floor(H * pr))) });
  composer = new EffectComposer(renderer, rt); composer.setPixelRatio(pr); composer.setSize(W, H);
  renderPass = new RenderPass(scene, camera); composer.addPass(renderPass); composer.addPass(new ShaderPass(HdrGuardShader));
  bloomPass = new UnrealBloomPass(new THREE.Vector2(W * pr * Q.bloomRes, H * pr * Q.bloomRes), 0.3, 0.7, 1.0); bloomPass.enabled = !!Q.bloom && !gfxS().noBloom; composer.addPass(bloomPass);
  gradePass = new ShaderPass(GradeShader); composer.addPass(gradePass);
  composer.addPass(new OutputPass());
}
function applyQuality(name, silent) {
  if (!QUALITY[name]) return; if (window.__qdbg) console.log('applyQuality ' + name + ' ' + new Error().stack.split('\n').slice(1, 4).join(' | ')); qName = name; Q = QUALITY[name];
  try { if (!Q.vr) localStorage.setItem('swn_q', name); } catch (e) { }
  renderer.setPixelRatio(gfxPr(W, H)); renderer.setSize(W, H, false);
  buildComposer(); configureShadow();
  if (typeof onQualityChanged === 'function') onQualityChanged();
  const tag = $('qTag'); if (tag) tag.textContent = name.toUpperCase();
  document.querySelectorAll('.qrow button[data-q]').forEach(b => b.classList.toggle('on', b.dataset.q === name));
  if (!silent && typeof toast === 'function') toast('Quality: ' + name.toUpperCase());
}
function onResize() {
  if (VR.presenting) return; // the XR layer owns the framebuffer + projection while presenting
  W = Math.max(2, innerWidth); H = Math.max(2, innerHeight);
  renderer.setPixelRatio(gfxPr(W, H)); renderer.setSize(W, H, false);
  camera.aspect = W / H; camera.updateProjectionMatrix();
  if (composer) { composer.setPixelRatio(renderer.getPixelRatio()); composer.setSize(W, H); }
  GradeShader.uniforms.uAspect.value = W / H;
}
addEventListener('resize', onResize);
const _sv = new THREE.Vector3(), _fw = new THREE.Vector3();
function renderFrame() {
  if (VR.presenting) { vrRenderPrep(); renderer.render(scene, camera); return; }
  if (CSU.open) { clsRender(); return; } // character select: live 3D portraits // the EffectComposer cannot draw into the XR framebuffer: straight render
  // sun position on screen for god rays
  if (composer && gradePass) {
    _sv.copy(camera.position).addScaledVector(U.sunDir.value, 500).project(camera);
    camera.getWorldDirection(_fw); const facing = _fw.dot(U.sunDir.value);
    const u = gradePass.uniforms; u.uSun.value.set(_sv.x * 0.5 + 0.5, _sv.y * 0.5 + 0.5); u.uGod.value = (Q.god ? 1 : 0) * sstep(-0.1, 0.5, facing) * ATM.sunI * 0.2;
    u.uSunCol.value.copy(ATM.sun);
    composer.render(); gfxProbe();
  } else renderer.render(scene, camera);
}


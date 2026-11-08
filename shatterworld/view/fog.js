// ---------------------------------------------------------------------------
// global fog override: exponential-squared with height falloff (valley mist), used by every built-in material
// ---------------------------------------------------------------------------
THREE.ShaderChunk.fog_pars_vertex = `#ifdef USE_FOG
varying float vFogDepth; varying float vFogY;
#endif`;
THREE.ShaderChunk.fog_vertex = `#ifdef USE_FOG
vFogDepth = -mvPosition.z;
vFogY = cameraPosition.y + dot(vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]), mvPosition.xyz);
#endif`;
THREE.ShaderChunk.fog_pars_fragment = `#ifdef USE_FOG
uniform vec3 fogColor; varying float vFogDepth; varying float vFogY;
#ifdef FOG_EXP2
uniform float fogDensity;
#else
uniform float fogNear; uniform float fogFar;
#endif
#endif`;
THREE.ShaderChunk.fog_fragment = `#ifdef USE_FOG
{ float hAvg = max(0.5 * (cameraPosition.y + vFogY), 0.0);
  float dens = fogDensity * (0.42 + 1.5 * exp(-hAvg * 0.05));
  float ff = 1.0 - exp(-dens * dens * vFogDepth * vFogDepth);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, clamp(ff, 0.0, 1.0)); }
#endif`;
scene.fog = new THREE.FogExp2(0xe9c99a, 0.0062);


/** The photo look's colour grade (render.ts), shared with the hex view (hex.ts). */
/** Photographic grade: softer saturation and contrast, a faint cool cast, deep blacks kept. */
export const GRADE_SHADER = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      vec3 g = mix(vec3(l), c.rgb, 0.78);                 // desaturate
      g = mix(g, g * vec3(0.96, 0.99, 1.05), 0.6);        // cool cast
      g = pow(max(g, 0.0), vec3(1.06));                  // a touch more depth in the darks
      gl_FragColor = vec4(g, c.a);
    }`,
};

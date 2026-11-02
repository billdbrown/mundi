import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyticErosion } from '../src/analyticerosion.ts';

// A cone: one mountain in a sea.
const n = 96, N = n * n, h = new Float32Array(N);
for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
  const r = Math.hypot(x - n / 2, y - n / 2) / (n / 2);
  h[y * n + x] = Math.max(-0.001, 0.012 * (1 - r * 1.2) + 0.0005 * Math.sin(x * 0.7) * Math.cos(y * 0.9));
}
const { carve, area } = analyticErosion({ height: h, n, spacing: 0.0004 });

test('erosion only removes land, and never below the sea', () => {
  for (let i = 0; i < N; i++) {
    assert.ok(carve[i] >= 0);
    if (h[i] > 0) assert.ok(h[i] - carve[i] >= -1e-6);
  }
});

test('after erosion, ridges (small catchments) stand higher than valleys (large ones)', () => {
  let big = 0, nb = 0, small = 0, ns = 0;
  for (let i = 0; i < N; i++) {
    if (h[i] < 0.003) continue;
    const e = h[i] - carve[i];
    if (area[i] > 50) { big += e; nb++; } else if (area[i] <= 2) { small += e; ns++; }
  }
  assert.ok(nb > 0 && ns > 0);
  assert.ok(small / ns > big / nb, `ridges ${small / ns} vs valleys ${big / nb}`);
});

test('all water drains out: drainage areas sum through to the outlets', () => {
  let max = 0;
  for (let i = 0; i < N; i++) max = Math.max(max, area[i]);
  assert.ok(max > 100, `largest catchment ${max}`);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sunDirection, sunElevation, hourForElevation, transmittance, daylight } from '../src/daylight.ts';
import { STYLE } from '../src/hexstyle.ts';

const D = Math.PI / 180;
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test('equinox sun: rises in the east at 06:00, highest at noon, sets in the west at 18:00', () => {
  for (const lat of [-50 * D, 0, 35 * D, 70 * D]) {
    near(sunElevation(lat, 6), 0);
    near(sunElevation(lat, 18), 0);
    near(sunElevation(lat, 12), 90 - Math.abs(lat) / D);
    assert.ok(sunDirection(lat, 6)[0] > 0.99, 'east at sunrise');
    assert.ok(sunDirection(lat, 18)[0] < -0.99, 'west at sunset');
  }
  // Noon sun stands to the south in the north, to the north in the south (z is south).
  assert.ok(sunDirection(40 * D, 12)[2] > 0);
  assert.ok(sunDirection(-40 * D, 12)[2] < 0);
});

test('hourForElevation is the afternoon hour of that elevation, or noon if out of reach', () => {
  const lat = 30 * D;
  const h = hourForElevation(lat, 25);
  assert.ok(h > 12 && h < 18);
  near(sunElevation(lat, h), 25, 1e-6);
  assert.equal(hourForElevation(80 * D, 30), 12);
});

test('sunlight reddens and dims toward the horizon', () => {
  const hi = transmittance(60), lo = transmittance(3);
  assert.ok(lo[0] < hi[0] && lo[2] < hi[2]);
  assert.ok(lo[2] / lo[0] < hi[2] / hi[0], 'blue lost first');
});

test("the style looks exactly as designed at its own hour", () => {
  const lat = 25 * D;
  for (const st of [STYLE]) {
    const L = daylight(st, lat, hourForElevation(lat, st.sun.elev));
    near(L.elev, st.sun.elev, 1e-6);
    near(L.key.intensity, st.sun.intensity, 1e-3);
    near(L.hemiI, st.hemi.intensity, 1e-6);
    near(L.exposure, st.exposure, 1e-3);
    assert.equal(L.key.moon, false);
    assert.equal(L.windows, 0);
  }
});

test('at night the moon takes over, faint, and windows light up', () => {
  const st = STYLE;
  const L = daylight(st, 20 * D, 0);
  assert.equal(L.key.moon, true);
  assert.ok(L.key.dir[1] > 0.5, 'moon above the horizon');
  assert.ok(L.key.intensity < st.sun.intensity * 0.3);
  assert.equal(L.windows, 1);
  assert.ok(L.hemiI < st.hemi.intensity * 0.25);
});

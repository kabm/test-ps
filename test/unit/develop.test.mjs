import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultDevelop, normalizeDevelop, isIdentityDevelop, developKey, wbMultipliers, wbFromNeutral, applyPreset, BUILTIN_PRESETS,
} from '../../src/js/develop.js';

test('default settings are identity', () => {
  assert.ok(isIdentityDevelop(defaultDevelop()));
  assert.equal(developKey(defaultDevelop()), 'id');
  const s = defaultDevelop();
  s.exposure = 0.5;
  assert.ok(!isIdentityDevelop(s));
  const h = defaultDevelop();
  h.hsl.sat[3] = 10;
  assert.ok(!isIdentityDevelop(h));
});

test('normalize fills missing nested fields', () => {
  const s = normalizeDevelop({ exposure: 1, grading: { shadows: { s: 20 } } });
  assert.equal(s.exposure, 1);
  assert.equal(s.grading.shadows.s, 20);
  assert.equal(s.grading.shadows.h, 220);
  assert.equal(s.hsl.hue.length, 8);
  assert.deepEqual(s.curve.master, [[0, 0], [1, 1]]);
});

test('white balance multipliers keep luminance and invert correctly', () => {
  const [r, g, b] = wbMultipliers(40, -20);
  assert.ok(Math.abs(0.2126 * r + 0.7152 * g + 0.0722 * b - 1) < 1e-9);
  // a grey lit by a cast; the computed WB must neutralise it
  const cast = [1.3, 1.0, 0.75];
  const { temp, tint } = wbFromNeutral(...cast);
  const m = wbMultipliers(temp, tint);
  const out = cast.map((c, i) => c * m[i]);
  const spread = Math.max(...out) / Math.min(...out);
  assert.ok(spread < 1.03, 'neutral after WB, spread ' + spread);
});

test('every built-in preset normalises to a valid settings object', () => {
  for (const p of BUILTIN_PRESETS) {
    const s = applyPreset(p.settings);
    assert.equal(typeof s.exposure, 'number', p.name);
    assert.equal(s.hsl.lum.length, 8, p.name);
    assert.ok(!isIdentityDevelop(s), p.name + ' should change the image');
  }
});

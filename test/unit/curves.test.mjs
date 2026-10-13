import test from 'node:test';
import assert from 'node:assert/strict';
import { curveFunction, curveLUT, isIdentityCurve, curveTextureData } from '../../src/js/curves.js';

test('identity curve maps x to x', () => {
  const f = curveFunction([[0, 0], [1, 1]]);
  for (const x of [0, 0.1, 0.5, 0.9, 1]) assert.ok(Math.abs(f(x) - x) < 1e-9);
  assert.ok(isIdentityCurve([[0, 0], [1, 1]]));
  assert.ok(!isIdentityCurve([[0, 0], [0.5, 0.6], [1, 1]]));
});

test('curve passes through control points and is monotone', () => {
  const pts = [[0, 0], [0.25, 0.15], [0.75, 0.85], [1, 1]];
  const f = curveFunction(pts);
  for (const [x, y] of pts) assert.ok(Math.abs(f(x) - y) < 1e-9);
  let prev = -1;
  for (let i = 0; i <= 100; i++) {
    const v = f(i / 100);
    assert.ok(v >= prev - 1e-9, 'monotone');
    prev = v;
  }
});

test('LUT is clamped to [0,1] and texture has 4 rows', () => {
  const lut = curveLUT([[0, 0.2], [0.5, 1.2], [1, 0.8]]);
  assert.equal(lut.length, 256);
  for (const v of lut) assert.ok(v >= 0 && v <= 1);
  const tex = curveTextureData({ master: [[0, 0], [1, 1]], r: [[0, 1], [1, 0]], g: null, b: [[0, 0], [1, 1]] });
  assert.equal(tex.length, 256 * 4 * 4);
  assert.equal(tex[(1 * 256 + 0) * 4], 255); // inverted red starts at 255
  assert.equal(tex[(1 * 256 + 255) * 4], 0);
});

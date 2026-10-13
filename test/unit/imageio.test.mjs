import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readExif, findEmbeddedJpegs, formatExif, exifSummary } from '../../src/js/imageio.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
const load = (f) => {
  const b = fs.readFileSync(path.join(fixtures, f));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

test('finds the largest embedded JPEG in a RAW-style file', () => {
  const jpegs = findEmbeddedJpegs(load('fake.nef'));
  assert.equal(jpegs.length, 2);
  assert.equal(jpegs[0].width, 1800);
  assert.equal(jpegs[0].height, 1200);
  assert.equal(jpegs[1].width, 900);
});

test('reads TIFF-style orientation and make from RAW header', () => {
  const e = readExif(load('fake.nef'));
  assert.equal(e.orientation, 6);
  assert.equal(e.make, 'NAC');
});

test('builds a JPEG with EXIF and parses camera fields', () => {
  // Minimal JPEG: SOI + APP1(Exif, little-endian TIFF with Make, ISO via ExifIFD) + EOI
  const tiff = [];
  const u16 = (v) => tiff.push(v & 255, (v >> 8) & 255);
  const u32 = (v) => { u16(v & 0xffff); u16(v >>> 16); };
  tiff.push(0x49, 0x49); u16(42); u32(8);
  // IFD0 at 8: 2 entries
  u16(2);
  u16(0x010f); u16(2); u32(4); u32(0x00584966); // bytes 66 49 58 00 -> make "fIX"
  u16(0x8769); u16(4); u32(1); u32(38);          // ExifIFD pointer
  u32(0);
  // ExifIFD at 38: ISO 400, FNumber rational at 60
  u16(2);
  u16(0x8827); u16(3); u32(1); u32(400);
  u16(0x829d); u16(5); u32(1); u32(68);
  u32(0);
  while (tiff.length < 68) tiff.push(0);
  u32(28); u32(10); // f/2.8
  const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const len = app1.length + 2;
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, len >> 8, len & 255, ...app1, 0xff, 0xd9]);
  const e = readExif(bytes.buffer);
  assert.equal(e.make, 'fIX');
  assert.equal(e.iso, 400);
  assert.ok(Math.abs(e.fNumber - 2.8) < 1e-9);
  const rows = Object.fromEntries(formatExif(e));
  assert.equal(rows.ISO, '400');
  assert.equal(rows.Aperture, 'f/2.8');
  assert.match(exifSummary(e), /ISO 400/);
});

test('plain JPEG without EXIF returns null', () => {
  assert.equal(readExif(load('photo2.jpg')), null);
});

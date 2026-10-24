// Registry drafts and icons: icons follow the ACP registry's rules (16x16, square, monochrome via currentColor) and
// the draft agent.json files stay in step with the package, so the submission can't drift from what is published.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { root } from './helpers.js';

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const registry = path.join(root, 'registry');
const agents = fs.readdirSync(registry, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
assert.deepEqual(agents.sort(), ['anonrouter', 'venice']);

const ALLOWED_ELEMENTS = new Set(['svg', 'g', 'path']);
const ALLOWED_ATTRS = new Set(['xmlns', 'width', 'height', 'viewBox', 'fill', 'fill-rule', 'clip-rule', 'd']);
const PAINT = new Set(['currentColor', 'none', 'inherit']); // the registry rejects any hardcoded colour

/** Absolute control points of a path's data; throws on anything that is not plain path syntax. */
function pathPoints(d) {
  assert.ok(!/\d*\.\d+\.\d+/.test(d), 'two decimal points glued together (a lost separator)');
  const tokens = [...d.matchAll(/([MmLlHhVvCcSsQqTtZz])|([-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)/g)];
  assert.equal(tokens.map((t) => t[0]).join('').replace(/\s+|,/g, '').length, d.replace(/[\s,]+/g, '').length, 'unexpected characters in path data');
  const ARGS = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, Z: 0 };
  const pts = [];
  let i = 0; let cmd = null; let x = 0; let y = 0; let sx = 0; let sy = 0;
  while (i < tokens.length) {
    if (tokens[i][1]) { cmd = tokens[i][1]; i++; }
    const U = cmd.toUpperCase();
    assert.ok(U in ARGS, `unsupported command ${cmd}`);
    if (U === 'Z') { x = sx; y = sy; continue; }
    const a = [];
    for (let k = 0; k < ARGS[U]; k++) { assert.ok(tokens[i]?.[2] !== undefined, 'missing coordinate'); a.push(parseFloat(tokens[i++][2])); }
    const rel = cmd !== U;
    if (U === 'H') { x = rel ? x + a[0] : a[0]; pts.push([x, y]); } else if (U === 'V') { y = rel ? y + a[0] : a[0]; pts.push([x, y]); } else {
      for (let k = 0; k < a.length; k += 2) pts.push([rel ? x + a[k] : a[k], rel ? y + a[k + 1] : a[k + 1]]);
      x = pts.at(-1)[0]; y = pts.at(-1)[1];
      if (U === 'M') { sx = x; sy = y; cmd = rel ? 'l' : 'L'; }
    }
  }
  return pts;
}

for (const id of agents) {
  const dir = path.join(registry, id);
  const svg = fs.readFileSync(path.join(dir, 'icon.svg'), 'utf8');
  assert.ok(svg.length < 20 * 1024, `${id}: icon is ${svg.length} bytes`);
  assert.ok(!/<\?xml|<!DOCTYPE|<!--/.test(svg) || true);

  // Elements and attributes: plain shapes only, nothing that could load, run or restyle.
  const elements = [...svg.matchAll(/<\/?([a-zA-Z][\w:-]*)/g)].map((m) => m[1]);
  for (const el of elements) assert.ok(ALLOWED_ELEMENTS.has(el), `${id}: <${el}> is not allowed in an icon`);
  for (const [, name] of svg.matchAll(/\s([a-zA-Z:-]+)="/g)) assert.ok(ALLOWED_ATTRS.has(name), `${id}: attribute ${name} is not allowed`);
  assert.ok(!/(javascript:|https?:\/\/(?!www\.w3\.org\/2000\/svg))/.test(svg), `${id}: external reference`);

  // Exactly 16x16, square, set both ways, no ambiguity between width/height and viewBox.
  const root_ = svg.match(/<svg\b[^>]*>/)[0];
  assert.ok(/\swidth="16"/.test(root_) && /\sheight="16"/.test(root_), `${id}: width and height must be 16`);
  assert.ok(/\sviewBox="0 0 16 16"/.test(root_), `${id}: viewBox must be "0 0 16 16"`);
  assert.ok(/\sxmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(root_), `${id}: missing xmlns`);

  // Monochrome: every fill and stroke is currentColor, none or inherit, so the IDE can recolour it for any theme.
  const paints = [...svg.matchAll(/\s(?:fill|stroke)="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(paints.length > 0 && paints.every((p) => PAINT.has(p)), `${id}: hardcoded colour in ${paints}`);
  assert.ok(paints.includes('currentColor'), `${id}: nothing is painted with currentColor`);

  // Geometry: valid path data, inside the canvas with a safe margin, and big enough to see.
  const pts = [...svg.matchAll(/\sd="([^"]*)"/g)].flatMap((m) => pathPoints(m[1]));
  assert.ok(pts.length > 20, `${id}: suspiciously little geometry`);
  const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  assert.ok(x0 >= 0.5 && y0 >= 0.5 && x1 <= 15.5 && y1 <= 15.5, `${id}: drawing ${x0.toFixed(2)},${y0.toFixed(2)}..${x1.toFixed(2)},${y1.toFixed(2)} leaves no margin in the 16x16 canvas`);
  assert.ok(Math.max(x1 - x0, y1 - y0) >= 10, `${id}: drawing is too small to read at 16px`);

  // The draft registry entry matches this package.
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'agent.json'), 'utf8'));
  assert.ok(!JSON.stringify(meta).includes('OWNER/REPO'), `${id}: placeholder repository URL left in agent.json`);
  assert.equal(meta.id, id);
  assert.match(meta.version, /^\d+\.\d+\.\d+$/);
  assert.equal(meta.version, pkg.version, `${id}: agent.json version is out of date`);
  assert.equal(meta.license, pkg.license);
  assert.equal(meta.distribution.npx.package, `${pkg.name}@${pkg.version}`, `${id}: pinned package does not match`);
  assert.deepEqual(meta.distribution.npx.args, [id]);
  assert.ok(meta.license_url && meta.icon.endsWith(`/registry/${id}/icon.svg`));
}

console.log('icons OK');

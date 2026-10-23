import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWrite } from '../src/store.mjs';

const temp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fewr2-store-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };

test('atomicWrite writes new files as 0600 and keeps an existing file\'s permission bits', t => {
  const dir = temp(t), file = path.join(dir, 'a', 'b.json');
  atomicWrite(file, 'one');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.chmodSync(file, 0o644);
  atomicWrite(file, 'two');
  assert.equal(fs.readFileSync(file, 'utf8'), 'two');
  assert.equal(fs.statSync(file).mode & 0o777, 0o644);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['b.json'], 'no temp file left');
});

test('atomicWrite writes through a symlink, also a dangling one, and leaves the link in place', t => {
  const dir = temp(t), target = path.join(dir, 'real.json'), link = path.join(dir, 'link.json');
  fs.symlinkSync(target, link);
  atomicWrite(link, 'created');
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(fs.readFileSync(target, 'utf8'), 'created');
  atomicWrite(link, 'updated');
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(fs.readFileSync(target, 'utf8'), 'updated');
});

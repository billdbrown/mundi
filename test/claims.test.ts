import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanLink, cleanOwner, isRude, worldKey } from '../worker/rules.ts';

test('world keys are seed names or numbers', () => {
  assert.equal(worldKey('Nethamol'), 'nethamol');
  assert.equal(worldKey('123456'), '123456');
  assert.equal(worldKey('a'), null);
  assert.equal(worldKey('net hamol'), null);
  assert.equal(worldKey('<script>'), null);
});

test('owner names', () => {
  assert.equal(cleanOwner('  Bill  '), 'Bill');
  assert.equal(cleanOwner('Zoë O\'Brien'), 'Zoë O\'Brien');
  assert.equal(cleanOwner(''), null);
  assert.equal(cleanOwner('<b>hi</b>'), null);
  assert.equal(cleanOwner('x'.repeat(25)), null);
});

test('links must describe the same world and nothing else', () => {
  assert.equal(cleanLink('seed=Nethamol&kind=desert', 'nethamol'), 'seed=nethamol&kind=desert');
  assert.equal(cleanLink('#seed=nethamol&ocean=0.5', 'nethamol'), 'seed=nethamol&ocean=0.5');
  assert.equal(cleanLink('seed=zalund', 'nethamol'), null);
  assert.equal(cleanLink('seed=nethamol&x=<img>', 'nethamol'), null);
});

test('the word filter catches the obvious and spares ordinary names', () => {
  for (const bad of ['fuck', 'FuUuCk', 'f.u.c.k', 'sh1t', 'bigshitworld', 'Dick', 'rape']) assert.ok(isRude(bad), bad);
  for (const ok of ['Bill', 'Scunthorpe', 'Essex', 'Torpedo', 'Grapeland', 'Niger', 'Canal', 'Cucumber',
    'Raccoon', 'Spice', 'Dickens', 'Nethamol', 'Zalund', 'Analise', 'Shiitake', 'Therapist']) assert.ok(!isRude(ok), ok);
});

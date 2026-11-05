import { test } from 'node:test';
import assert from 'node:assert/strict';
import { titleCase } from '../src/index.js';

test('titleCase capitalizes the first letter of each word', () => {
  assert.equal(titleCase('hello world'), 'Hello World');
});

test('titleCase leaves an empty string empty', () => {
  assert.equal(titleCase(''), '');
});

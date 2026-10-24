import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatContent } from './ui/content-format.js';

test('recognizes whole JSON objects and arrays, including multiline input', () => {
  assert.deepEqual(formatContent(' {"command":"echo one\\necho two","ok":true,"count":2,"empty":null} '), [{ type: 'json', value: { command: 'echo one\necho two', ok: true, count: 2, empty: null } }]);
  assert.deepEqual(formatContent('[\n {"id":1},\n {}\n]\n'), [{ type: 'json', value: [{ id: 1 }, {}] }]);
  for (const value of ['{}', '[]']) assert.equal(formatContent(value)[0].type, 'json');
});

test('separates JSON lines from text without changing text or line endings', () => {
  assert.deepEqual(formatContent('Starting\r\n\r\n{"ok":true}\r\n[1,2]\nDone\n'), [
    { type: 'text', text: 'Starting\r\n\r\n' },
    { type: 'json', value: { ok: true } },
    { type: 'json', value: [1, 2] },
    { type: 'text', text: 'Done\n' },
  ]);
});

test('leaves malformed JSON, primitives, inline fragments and unsafe numbers unchanged', () => {
  for (const text of ['', 'plain text', '{broken}', '{"partial":', 'null', 'true', '42', '"hello"', 'Result: {"ok":true}', '{"id":1790496016931000001}', '{"n":1e999}']) {
    assert.deepEqual(formatContent(text), [{ type: 'text', text }]);
  }
});

test('does not reinterpret JSON lines inside fenced code', () => {
  for (const fence of ['```', '~~~~']) {
    const text = `Code:\n${fence}text\n{"example":true}\n${fence}\n`;
    assert.deepEqual(formatContent(text + '{"actual":true}\n'), [{ type: 'text', text }, { type: 'json', value: { actual: true } }]);
  }
  const unclosed = '```js\n{"example":true}\n``\n{"stillCode":true}';
  assert.deepEqual(formatContent(unclosed), [{ type: 'text', text: unclosed }]);
});

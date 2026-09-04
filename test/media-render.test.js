const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderFileList, formatBytes, renderUsageBar } = require('../public/media.js');

test('formatBytes renders bytes, KB, MB', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(340), '340 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(1_258_291), '1.2 MB');
});

test('renderFileList shows path, title, tags, size, and a Missing badge', () => {
  const html = renderFileList([
    { path: 'nibiru/briefcase_2.mp3', title: 'Briefcase clue 2', tags: 'nibiru', bytes: 2048, missing: false },
    { path: 'ghost.mp3', title: 'ghost.mp3', tags: '', bytes: 0, missing: true },
  ]);
  assert.match(html, /nibiru\/briefcase_2\.mp3/);
  assert.match(html, /Briefcase clue 2/);
  assert.match(html, /2\.0 KB/);
  assert.match(html, /Missing/);
});

test('renderFileList defaults usedBy to 0 when no usage map is given', () => {
  const html = renderFileList([{ path: 'a.mp3', title: 'a.mp3', tags: '', bytes: 10, missing: false }]);
  assert.match(html, /used by 0 hint/i);
});

test('renderUsageBar shows byte total and count', () => {
  const html = renderUsageBar({ bytes: 3145728, count: 4, freeBytes: 10_000_000_000 });
  assert.match(html, /3\.0 MB/);
  assert.match(html, /4/);
});

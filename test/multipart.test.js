const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseMultipart } = require('../src/multipart');

function buildBody(boundary, parts) {
  const CRLF = '\r\n';
  let body = '';
  for (const p of parts) {
    body += `--${boundary}${CRLF}`;
    if (p.filename !== undefined) {
      body += `Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"${CRLF}`;
      body += `Content-Type: ${p.contentType || 'application/octet-stream'}${CRLF}${CRLF}`;
    } else {
      body += `Content-Disposition: form-data; name="${p.name}"${CRLF}${CRLF}`;
    }
    body += p.content + CRLF;
  }
  body += `--${boundary}--${CRLF}`;
  return Buffer.from(body, 'binary');
}

test('parses a field and a file part', () => {
  const boundary = 'X-BOUNDARY-1';
  const buf = buildBody(boundary, [
    { name: 'folder', content: 'nibiru' },
    { name: 'file', filename: 'clip.mp3', contentType: 'audio/mpeg', content: 'FAKE-MP3-BYTES' },
  ]);
  const { fields, files } = parseMultipart(buf, `multipart/form-data; boundary=${boundary}`);
  assert.equal(fields.folder, 'nibiru');
  assert.equal(files.file.filename, 'clip.mp3');
  assert.equal(files.file.buffer.toString('binary'), 'FAKE-MP3-BYTES');
});

test('throws when content-type has no boundary', () => {
  assert.throws(() => parseMultipart(Buffer.from(''), 'multipart/form-data'));
});

test('handles binary content containing bytes that look like CRLF', () => {
  const boundary = 'B2';
  const binary = Buffer.from([0x00, 0x0d, 0x0a, 0xff, 0x10, 0x0d, 0x0a]);
  const CRLF = '\r\n';
  const head = Buffer.from(
    `--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="x.wav"${CRLF}Content-Type: audio/wav${CRLF}${CRLF}`,
    'binary'
  );
  const tail = Buffer.from(`${CRLF}--${boundary}--${CRLF}`, 'binary');
  const buf = Buffer.concat([head, binary, tail]);
  const { files } = parseMultipart(buf, `multipart/form-data; boundary=${boundary}`);
  assert.ok(files.file.buffer.equals(binary));
});

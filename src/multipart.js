function parseMultipart(buffer, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) throw new Error('multipart content-type missing boundary');
  const boundary = Buffer.from('--' + (m[1] || m[2]).trim());
  const CRLF = Buffer.from('\r\n');

  const fields = {};
  const files = {};

  let pos = buffer.indexOf(boundary);
  if (pos === -1) throw new Error('multipart body missing boundary');
  pos += boundary.length;

  while (true) {
    if (buffer.slice(pos, pos + 2).toString() === '--') break; // trailing boundary
    if (buffer.slice(pos, pos + 2).equals(CRLF)) pos += 2;

    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), pos);
    if (headerEnd === -1) throw new Error('multipart part missing header terminator');
    const headerText = buffer.slice(pos, headerEnd).toString('utf8');
    const bodyStart = headerEnd + 4;

    const nextBoundary = buffer.indexOf(boundary, bodyStart);
    if (nextBoundary === -1) throw new Error('multipart part missing closing boundary');
    // body ends 2 bytes (CRLF) before the boundary marker
    const bodyEnd = nextBoundary - 2;
    const partBody = buffer.slice(bodyStart, bodyEnd);

    const nameMatch = /name="([^"]*)"/i.exec(headerText);
    const filenameMatch = /filename="([^"]*)"/i.exec(headerText);
    const name = nameMatch ? nameMatch[1] : '';

    if (filenameMatch) {
      files[name] = { filename: filenameMatch[1], buffer: partBody };
    } else {
      fields[name] = partBody.toString('utf8');
    }

    pos = nextBoundary + boundary.length;
    if (buffer.slice(pos, pos + 2).toString() === '--') break;
  }

  return { fields, files };
}

module.exports = { parseMultipart };

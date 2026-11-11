export function parseMultipart(buf, boundary) {
  const fields = {};
  const files = {};
  const delim = Buffer.from(`--${boundary}`);
  let pos = buf.indexOf(delim);
  if (pos === -1) return { fields, files };
  pos += delim.length;
  while (pos < buf.length) {
    if (buf[pos] === 0x2d && buf[pos + 1] === 0x2d) break;
    if (buf[pos] === 0x0d && buf[pos + 1] === 0x0a) pos += 2;
    const headerEnd = buf.indexOf('\r\n\r\n', pos);
    if (headerEnd === -1) break;
    const headerText = buf.toString('latin1', pos, headerEnd);
    const next = buf.indexOf(delim, headerEnd + 4);
    if (next === -1) break;
    const data = buf.subarray(headerEnd + 4, next - 2);
    const headers = {};
    for (const line of headerText.split('\r\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
    const cd = headers['content-disposition'] || '';
    const nameM = cd.match(/name="([^"]*)"/);
    const fileM = cd.match(/filename="([^"]*)"/);
    if (nameM) {
      if (fileM && fileM[1]) {
        files[nameM[1]] = {
          filename: fileM[1],
          contentType: headers['content-type'] || 'application/octet-stream',
          data,
        };
      } else {
        fields[nameM[1]] = data.toString('utf8');
      }
    }
    pos = next + delim.length;
  }
  return { fields, files };
}

export function multipartBoundary(contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  return m ? (m[1] || m[2]).trim() : null;
}

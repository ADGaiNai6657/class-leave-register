'use strict';

/**
 * 分隔符文本（.csv / .tsv / .txt）与 .json 花名册解析。
 * 纯文本处理，不依赖任何第三方库。
 */

/** 解码文件内容：优先 UTF-8，失败则尝试 GBK（Excel 在 Windows 上另存的 CSV 常见编码） */
function decodeText(buffer) {
  let buf = buffer;
  let bom = '';
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    buf = buf.subarray(3);
    bom = 'utf-8-bom';
  } else if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.subarray(2).toString('utf16le'), encoding: 'utf-16le' };
  }

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return { text, encoding: bom || 'utf-8' };
  } catch {
    /* 继续尝试其他编码 */
  }

  for (const enc of ['gbk', 'big5']) {
    try {
      const text = new TextDecoder(enc, { fatal: true }).decode(buf);
      return { text, encoding: enc };
    } catch {
      /* 继续 */
    }
  }

  return { text: new TextDecoder('utf-8').decode(buf), encoding: 'utf-8(replace)' };
}

function sniffDelimiter(text) {
  const sample = text.split(/\r?\n/).filter((l) => l.trim() !== '').slice(0, 30);
  if (sample.length === 0) return ',';
  const candidates = [',', '\t', ';', '|'];
  let best = ',';
  let bestScore = -1;

  for (const delim of candidates) {
    const counts = sample.map((line) => countOutsideQuotes(line, delim));
    const max = Math.max(...counts);
    if (max === 0) continue;
    const mode = counts.filter((c) => c === max).length;
    const score = max * 10 + mode;
    if (score > bestScore) {
      bestScore = score;
      best = delim;
    }
  }
  return best;
}

function countOutsideQuotes(line, delim) {
  let inQuotes = false;
  let count = 0;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') i += 1;
      else inQuotes = !inQuotes;
    } else if (ch === delim && !inQuotes) {
      count += 1;
    }
  }
  return count;
}

/** RFC4180 风格的分隔符解析（支持引号、转义引号、字段内换行） */
function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"' && field === '') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      pushField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      if (text[i + 1] === '\n') i += 1;
      pushRow();
      i += 1;
      continue;
    }
    if (ch === '\n') {
      pushRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }

  if (field !== '' || row.length > 0) pushRow();

  // 去掉末尾的纯空行
  while (rows.length > 0) {
    const last = rows[rows.length - 1];
    if (last.length === 1 && String(last[0]).trim() === '') rows.pop();
    else break;
  }
  return rows.map((r) => r.map((c) => String(c)));
}

function readDelimited(buffer) {
  const { text, encoding } = decodeText(buffer);
  const rows = parseDelimited(text, sniffDelimiter(text));
  return {
    sheets: [{ name: '（文本文件）', hidden: false, rows }],
    meta: { encoding, delimiter: sniffDelimiter(text) },
  };
}

function readJson(buffer) {
  const { text, encoding } = decodeText(buffer);
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`JSON 解析失败：${err.message}`);
  }

  let rows = [];
  if (Array.isArray(data) && data.every((v) => typeof v === 'string')) {
    rows = [['姓名'], ...data.map((v) => [String(v)])];
  } else if (Array.isArray(data)) {
    const keys = [];
    for (const item of data) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        for (const k of Object.keys(item)) if (!keys.includes(k)) keys.push(k);
      }
    }
    if (keys.length === 0) throw new Error('JSON 数组中没有任何对象字段');
    rows = [keys, ...data.map((item) => keys.map((k) => (item && item[k] !== undefined && item[k] !== null ? String(item[k]) : '')))];
  } else if (data && typeof data === 'object') {
    const arr = data.students || data.student || data.list || data.data;
    if (!Array.isArray(arr)) throw new Error('JSON 结构无法识别（需要数组，或包含 students 数组）');
    return readJson(Buffer.from(JSON.stringify(arr), 'utf8'));
  } else {
    throw new Error('JSON 结构无法识别（需要数组或对象）');
  }

  return { sheets: [{ name: '（JSON）', hidden: false, rows }], meta: { encoding } };
}

module.exports = { decodeText, parseDelimited, sniffDelimiter, readDelimited, readJson };

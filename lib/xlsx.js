'use strict';

/**
 * 最小实现的 .xlsx 读取器（xlsx 就是一个 ZIP + XML）。
 *
 * 只读取单元格文本，用于读取现代 Excel 格式的花名册；不依赖任何第三方库，
 * 只用 Node 内置的 zlib 解压。不写入、不联网。
 */

const zlib = require('zlib');

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

function isZip(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 4 && buffer.readUInt32LE(0) === 0x04034b50;
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

function readZipEntries(buf) {
  const eocd = findEocd(buf);
  if (eocd === -1) throw new Error('不是有效的 .xlsx（未找到 ZIP 结尾记录）');
  const total = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdOffset === 0xffffffff) {
    throw new Error('暂不支持 ZIP64 格式的 .xlsx，请另存为普通 .xlsx 或 .csv 后重试');
  }

  const entries = new Map();
  let off = cdOffset;
  for (let i = 0; i < total; i += 1) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== CD_SIG) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8');

    if (buf.readUInt32LE(localOff) === LFH_SIG) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(dataStart, dataStart + compSize);
      entries.set(name, { method, raw });
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntry(entries, name) {
  const entry = entries.get(name);
  if (!entry) return null;
  if (entry.method === 0) return entry.raw;
  if (entry.method === 8) return zlib.inflateRawSync(entry.raw);
  throw new Error(`不支持的 ZIP 压缩方式：${entry.method}`);
}

function decodeXmlEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function safeFromCodePoint(code) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

function columnIndexFromRef(ref) {
  const letters = /^([A-Z]+)/.exec(String(ref).toUpperCase());
  if (!letters) return -1;
  let n = 0;
  for (const ch of letters[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g;
  let m;
  while ((m = siRe.exec(xml)) !== null) {
    const inner = m[1] || '';
    let text = '';
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g;
    let t;
    while ((t = tRe.exec(inner)) !== null) text += decodeXmlEntities(t[1] || '');
    out.push(text);
  }
  return out;
}

function parseSheet(xml, sharedStrings) {
  const cells = new Map();
  let maxRow = -1;
  let maxCol = -1;

  const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g;
  let rowMatch;
  while ((rowMatch = rowRe.exec(xml)) !== null) {
    const attrs = rowMatch[1] || rowMatch[3] || '';
    const body = rowMatch[2] || '';
    const rMatch = /\br="(\d+)"/.exec(attrs);
    const rowIndex = rMatch ? parseInt(rMatch[1], 10) - 1 : maxRow + 1;

    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cellMatch;
    while ((cellMatch = cellRe.exec(body)) !== null) {
      const cAttrs = cellMatch[1] || '';
      const cBody = cellMatch[2] || '';
      const refMatch = /\br="([A-Za-z]+\d+)"/.exec(cAttrs);
      const typeMatch = /\bt="([^"]+)"/.exec(cAttrs);
      const type = typeMatch ? typeMatch[1] : 'n';
      const col = refMatch ? columnIndexFromRef(refMatch[1]) : -1;
      if (col < 0) continue;

      let value = '';
      if (type === 'inlineStr') {
        let text = '';
        const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g;
        let t;
        while ((t = tRe.exec(cBody)) !== null) text += decodeXmlEntities(t[1] || '');
        value = text;
      } else {
        const vMatch = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(cBody);
        const rawV = vMatch ? decodeXmlEntities(vMatch[1]) : '';
        if (type === 's') {
          const idx = parseInt(rawV, 10);
          value = Number.isInteger(idx) && sharedStrings[idx] !== undefined ? sharedStrings[idx] : '';
        } else if (type === 'b') {
          value = rawV === '1' ? 'TRUE' : 'FALSE';
        } else if (type === 'e') {
          value = rawV || '#ERR';
        } else {
          value = rawV;
        }
      }

      if (value === '') continue;
      let rowMap = cells.get(rowIndex);
      if (!rowMap) {
        rowMap = new Map();
        cells.set(rowIndex, rowMap);
      }
      rowMap.set(col, value);
      if (rowIndex > maxRow) maxRow = rowIndex;
      if (col > maxCol) maxCol = col;
    }
  }

  const rows = [];
  for (let r = 0; r <= maxRow; r += 1) {
    const rowMap = cells.get(r);
    const row = new Array(maxCol + 1).fill('');
    if (rowMap) for (const [c, v] of rowMap.entries()) row[c] = v;
    rows.push(row);
  }
  return rows;
}

function parseWorkbookSheets(xml) {
  const sheets = [];
  const sheetRe = /<sheet\b([^>]*)\/?>/g;
  let m;
  while ((m = sheetRe.exec(xml)) !== null) {
    const attrs = m[1];
    const name = /\bname="([^"]*)"/.exec(attrs);
    const rid = /\br:id="([^"]*)"/.exec(attrs);
    const state = /\bstate="([^"]*)"/.exec(attrs);
    if (!name) continue;
    sheets.push({
      name: decodeXmlEntities(name[1]),
      rid: rid ? rid[1] : null,
      hidden: state ? state[1] !== 'visible' : false,
    });
  }
  return sheets;
}

function parseRels(xml) {
  const map = new Map();
  if (!xml) return map;
  const re = /<Relationship\b([^>]*)\/?>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    const id = /\bId="([^"]*)"/.exec(attrs);
    const target = /\bTarget="([^"]*)"/.exec(attrs);
    if (id && target) map.set(id[1], decodeXmlEntities(target[1]));
  }
  return map;
}

/** @returns {{sheets: Array<{name:string, hidden:boolean, rows:Array<Array<string>>}>}} */
function readXlsx(buffer) {
  if (!isZip(buffer)) throw new Error('不是有效的 .xlsx（ZIP）文件头');
  const entries = readZipEntries(buffer);

  const workbookXml = readEntry(entries, 'xl/workbook.xml');
  if (!workbookXml) throw new Error('未在 .xlsx 中找到 xl/workbook.xml');
  const relsXml = readEntry(entries, 'xl/_rels/workbook.xml.rels');
  const sharedStrings = parseSharedStrings(readEntry(entries, 'xl/sharedStrings.xml'));

  const sheetDefs = parseWorkbookSheets(workbookXml.toString('utf8'));
  const rels = parseRels(relsXml ? relsXml.toString('utf8') : '');
  if (sheetDefs.length === 0) throw new Error('未在 .xlsx 中找到任何工作表');

  const sheets = [];
  sheetDefs.forEach((def, index) => {
    let path = def.rid ? rels.get(def.rid) : null;
    if (path) {
      if (path.startsWith('/')) path = path.slice(1);
      else if (!path.startsWith('xl/')) path = `xl/${path.replace(/^\.\//, '')}`;
    } else {
      path = `xl/worksheets/sheet${index + 1}.xml`;
    }
    const xml = readEntry(entries, path);
    sheets.push({
      name: def.name,
      hidden: def.hidden,
      rows: xml ? parseSheet(xml.toString('utf8'), sharedStrings) : [],
    });
  });

  return { sheets };
}

module.exports = { isZip, readXlsx };

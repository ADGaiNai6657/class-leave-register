'use strict';

/**
 * 读取（导入）CSV 登记数据。
 *
 * 典型来源是本应用导出的「请假登记-年月日-时分秒.csv」：
 *   第一行标题、第二行表头（姓名 / 请假理由 / 是否补假）、之后是数据。
 * 也兼容：表头在第一行、没有标题行、逗号 / 制表符等不同分隔符、UTF-8 / GBK / UTF-16 编码。
 *
 * 本模块只做“解析 + 与花名册匹配”，不写任何文件，也不联网。
 */

const { readDelimited } = require('./delimited');

const MAX_RECORDS = 5000;
const HEADER_SCAN_ROWS = 20;

const NAME_HEADERS = ['姓名', '名字', '学生姓名', '学生名字', 'name', 'studentname', 'fullname', 'student'];
const REASON_HEADERS = ['请假理由', '理由', '请假事由', '事由', '原因', 'reason'];
const MAKEUP_HEADERS = ['是否补假', '补假', '是否补', 'makeup', 'supplement'];

function normalizeHeader(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/[\s\u3000]+/g, '')
    .toLowerCase();
}

/** 把“是否补假”单元格转成 true / false / null（无法识别一律按未选择处理） */
function parseMakeup(value) {
  const text = String(value === null || value === undefined ? '' : value).trim().toLowerCase();
  if (text === '') return null;
  if (['是', 'true', 'yes', 'y', '1', '补假'].includes(text)) return true;
  if (['否', 'false', 'no', 'n', '0', '不补假'].includes(text)) return false;
  return null;
}

/** 在前若干行中寻找表头，返回各列的索引 */
function findHeader(rows) {
  const scan = Math.min(rows.length, HEADER_SCAN_ROWS);
  for (let r = 0; r < scan; r += 1) {
    const row = rows[r] || [];
    let nameCol = -1;
    let reasonCol = -1;
    let makeupCol = -1;
    for (let c = 0; c < row.length; c += 1) {
      const header = normalizeHeader(row[c]);
      if (header === '') continue;
      if (nameCol < 0 && NAME_HEADERS.includes(header)) nameCol = c;
      else if (reasonCol < 0 && REASON_HEADERS.includes(header)) reasonCol = c;
      else if (makeupCol < 0 && MAKEUP_HEADERS.includes(header)) makeupCol = c;
    }
    if (nameCol >= 0) return { headerRow: r, nameCol, reasonCol, makeupCol };
  }
  return null;
}

/** 表头之前的第一段非空文字，作为 CSV 的标题（可能为空） */
function findTitle(rows, headerRow) {
  for (let r = 0; r < headerRow; r += 1) {
    for (const cell of rows[r] || []) {
      const text = String(cell === null || cell === undefined ? '' : cell).trim();
      if (text !== '') return text;
    }
  }
  return '';
}

function cleanCell(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/\u00a0/g, ' ')
    .trim();
}

/**
 * 解析 CSV / TSV 文本中的请假登记数据。
 * @param {Buffer|string} input
 * @returns {{records:Array<{name:string,reason:string,makeup:boolean|null}>, warnings:string[], encoding:string, delimiter:string, title:string, headerRow:number}}
 */
function parseLeaveCsv(input) {
  const buffer = Buffer.isBuffer(input)
    ? input
    : Buffer.from(input === null || input === undefined ? '' : String(input), 'utf8');
  if (buffer.length === 0) throw new Error('CSV 文件是空的（0 字节）。');

  let parsed;
  try {
    parsed = readDelimited(buffer);
  } catch (err) {
    throw new Error(`CSV 解析失败：${err.message}`);
  }

  const sheet = parsed.sheets && parsed.sheets[0];
  const rows = (sheet && sheet.rows) || [];
  if (rows.length === 0) throw new Error('CSV 中没有内容。');

  const header = findHeader(rows);
  if (!header) {
    throw new Error('无法识别 CSV 表头：至少需要“姓名”列（可选“请假理由”“是否补假”）。');
  }

  const warnings = [];
  const encoding = (parsed.meta && parsed.meta.encoding) || '';
  if (encoding && !/^utf-?8/i.test(encoding)) {
    warnings.push(`CSV 编码按 ${String(encoding).toUpperCase()} 解析。`);
  }

  const records = [];
  let skippedEmpty = 0;
  let unknownMakeup = 0;

  for (let r = header.headerRow + 1; r < rows.length; r += 1) {
    const row = rows[r] || [];
    const name = cleanCell(row[header.nameCol]);
    if (name === '') {
      skippedEmpty += 1;
      continue;
    }
    // 有些表格会在数据中间重复表头，忽略
    if (NAME_HEADERS.includes(normalizeHeader(name))) continue;

    const reason = header.reasonCol >= 0 ? cleanCell(row[header.reasonCol]) : '';
    let makeup = null;
    if (header.makeupCol >= 0) {
      const raw = String(row[header.makeupCol] === null || row[header.makeupCol] === undefined ? '' : row[header.makeupCol]).trim();
      makeup = parseMakeup(raw);
      if (raw !== '' && makeup === null) unknownMakeup += 1;
    }

    // 既没理由也没补假选择，视为未填写请假信息，不导入
    if (reason === '' && makeup === null) continue;

    records.push({ name, reason, makeup });
    if (records.length > MAX_RECORDS) {
      throw new Error(`CSV 中的请假记录超过 ${MAX_RECORDS} 条，疑似不是登记结果，已停止读取。`);
    }
  }

  if (skippedEmpty > 0) warnings.push(`已跳过 ${skippedEmpty} 行没有姓名的记录。`);
  if (unknownMakeup > 0) warnings.push(`有 ${unknownMakeup} 条记录的“是否补假”无法识别，已按未选择处理。`);

  return {
    records,
    warnings,
    encoding,
    delimiter: (parsed.meta && parsed.meta.delimiter) || '',
    title: findTitle(rows, header.headerRow),
    headerRow: header.headerRow,
  };
}

/**
 * 把 CSV 记录按姓名匹配到花名册学生。
 * 同名学生会按花名册顺序依次匹配（与导出时保留重复姓名的行为一致）。
 * @param {Array<{name:string}>} students 花名册学生
 * @param {Array<{name:string,reason:string,makeup:boolean|null}>} records
 */
function matchRecords(students, records) {
  const list = Array.isArray(students) ? students : [];
  const source = Array.isArray(records) ? records : [];

  const byName = new Map();
  list.forEach((student, index) => {
    const key = String(student && student.name !== undefined ? student.name : '').trim();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(index);
  });

  const matched = [];
  const unmatched = [];
  for (const record of source) {
    const key = String(record && record.name !== undefined ? record.name : '').trim();
    const queue = byName.get(key);
    if (queue && queue.length > 0) {
      const index = queue.shift();
      matched.push({
        index,
        name: list[index].name,
        reason: record.reason || '',
        makeup: record.makeup === true ? true : record.makeup === false ? false : null,
      });
    } else {
      unmatched.push({ name: key, reason: record.reason || '', makeup: record.makeup });
    }
  }

  return { matched, unmatched, appliedCount: matched.length, recordCount: source.length };
}

module.exports = {
  MAX_RECORDS,
  NAME_HEADERS,
  REASON_HEADERS,
  MAKEUP_HEADERS,
  normalizeHeader,
  parseMakeup,
  findHeader,
  parseLeaveCsv,
  matchRecords,
};

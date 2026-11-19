'use strict';

/**
 * 导出与格式化：剪切板文本（Tab 分隔）与 CSV 文件（默认写入项目根目录）。
 *
 * 格式化规则集中在这里，保证“剪切板”和“CSV”内容同源、内容一致。
 * 只有用户主动触发导出时才会调用写入函数。
 */

const fs = require('fs');
const path = require('path');

/** 项目根目录（lib/ 的上一级），CSV 默认输出到这里 */
const PROJECT_ROOT = path.resolve(__dirname, '..');

const HEADER = ['姓名', '请假理由', '是否补假'];
const CSV_BOM = '\uFEFF';

/**
 * 导出文本第一行的默认标题。
 * 这里是中性占位值：真实的班级名请放在本地配置 local-config.json（已被 .gitignore 排除），
 * 或用 --title / 环境变量 CLASS_LEAVE_TITLE 指定。
 */
const DEFAULT_TITLE = '本班请假登记';

/**
 * 判定一条登记数据是否属于“请假的人”：
 * 填了请假理由，或选择了“是否补假”，都算已填写（与界面上的“已填写”标记一致）。
 */
function isLeaveRecord(record) {
  if (!record) return false;
  return String(record.reason === undefined || record.reason === null ? '' : record.reason).trim() !== ''
    || record.makeup !== null;
}

/** 只保留请假的（已填写的）学生，导出范围以此为准 */
function selectLeaveRecords(records) {
  return (Array.isArray(records) ? records : []).filter(isLeaveRecord);
}

function makeupLabel(value) {
  if (value === true) return '是';
  if (value === false) return '否';
  return '';
}

/**
 * 校验并规范化来自界面的登记数据。
 * 花名册数据（姓名）与界面填写内容分离，这里只接受字符串/布尔值。
 */
function normalizeRecords(input) {
  if (!Array.isArray(input)) throw new Error('登记数据格式错误：应为数组');
  if (input.length > 5000) throw new Error('登记数据行数异常（超过 5000 行）');

  return input.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`第 ${index + 1} 条登记数据格式错误`);
    const name = String(item.name === undefined || item.name === null ? '' : item.name);
    const reason = String(item.reason === undefined || item.reason === null ? '' : item.reason);
    let makeup = null;
    if (item.makeup === true || item.makeup === 'true' || item.makeup === 'yes' || item.makeup === '是') makeup = true;
    else if (item.makeup === false || item.makeup === 'false' || item.makeup === 'no' || item.makeup === '否') makeup = false;
    if (name.length > 200) throw new Error(`第 ${index + 1} 条姓名过长`);
    if (reason.length > 20000) throw new Error(`第 ${index + 1} 条请假理由过长`);
    return { name, reason, makeup };
  });
}

/** CSV 字段转义：逗号、引号、换行、回车都用双引号包裹，内部引号翻倍 */
function csvEscape(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/**
 * 生成粘贴到聊天窗口用的对齐文本。
 *
 * 不使用 Tab（姓名长短不一时 Tab 停靠点会错位），而是按“显示宽度”补空格：
 *   姓名居左、请假理由居中、是否补假居右。
 * 字段内部的制表符/换行会被归一为空格，保证每条记录仍是一行。
 * CSV 文件仍使用逗号分隔，便于表格软件分列。
 */
function clipboardCell(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/[\t\r\n]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/**
 * 计算字符串的显示宽度：中日韩文字、全角符号、常见 emoji 占 2 列，其余占 1 列。
 * 这只是为了让空格补齐更接近聊天软件里的等宽观感，不涉及任何外部依赖。
 */
function displayWidth(text) {
  let width = 0;
  for (const ch of String(text === null || text === undefined ? '' : text)) {
    const cp = ch.codePointAt(0);
    if (cp === 0x200d || (cp >= 0x0300 && cp <= 0x036f)) continue; // 零宽连接符 / 组合音标
    if (
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f64f) ||
      (cp >= 0x1f900 && cp <= 0x1f9ff) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

function padRight(text, width) {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

function padLeft(text, width) {
  return ' '.repeat(Math.max(0, width - displayWidth(text))) + text;
}

function padCenter(text, width) {
  const space = Math.max(0, width - displayWidth(text));
  const left = Math.floor(space / 2);
  return ' '.repeat(left) + text + ' '.repeat(space - left);
}

/** 列与列之间的空格间距 */
const CLIPBOARD_GAP = '   ';
/** 请假理由列的最大宽度：避免个别超长理由把整张表撑得过宽 */
const MAX_REASON_WIDTH = 60;

function buildClipboardText(records, options = {}) {
  const title = options.title === undefined ? DEFAULT_TITLE : String(options.title);
  const header = (options.header || HEADER).map(clipboardCell);
  const rows = (Array.isArray(records) ? records : []).map((rec) => [
    clipboardCell(rec.name),
    clipboardCell(rec.reason),
    makeupLabel(rec.makeup),
  ]);

  const nameWidth = Math.max(displayWidth(header[0]), ...rows.map((row) => displayWidth(row[0])));
  const reasonWidth = Math.max(
    displayWidth(header[1]),
    Math.min(MAX_REASON_WIDTH, Math.max(0, ...rows.map((row) => displayWidth(row[1]))))
  );
  const makeupWidth = Math.max(displayWidth(header[2]), ...rows.map((row) => displayWidth(row[2])));

  const formatRow = (cells) =>
    [
      padRight(cells[0], nameWidth),
      padCenter(cells[1], reasonWidth),
      padLeft(cells[2], makeupWidth),
    ].join(CLIPBOARD_GAP);

  const lines = [title, formatRow(header)];
  for (const row of rows) lines.push(formatRow(row));
  return lines.join('\n');
}

/**
 * 生成 CSV 文本（含 UTF-8 BOM，CRLF 换行，便于 Excel / Numbers 正确显示中文）。
 * 第一行为标题（默认“本班请假登记”，可用参数覆盖），第二行为表头，之后是学生数据。
 */
function buildCsv(records, options = {}) {
  const title = options.title === undefined ? DEFAULT_TITLE : String(options.title);
  const lines = [csvEscape(title), (options.header || HEADER).map(csvEscape).join(',')];
  for (const rec of records) {
    lines.push([csvEscape(rec.name), csvEscape(rec.reason), csvEscape(makeupLabel(rec.makeup))].join(','));
  }
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}

/**
 * 导出目录：默认输出到**项目根目录**（不再写到桌面）。
 * 可用环境变量 CLASS_LEAVE_EXPORT_DIR 覆盖（主要供自动化测试隔离使用）。
 */
function defaultExportDir() {
  const override = process.env.CLASS_LEAVE_EXPORT_DIR;
  if (override && override.trim() !== '') return path.resolve(override.trim());
  return PROJECT_ROOT;
}

function timestampName(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function uniquePath(dir, fileName) {
  const ext = path.extname(fileName);
  const base = fileName.slice(0, fileName.length - ext.length);
  let candidate = path.join(dir, fileName);
  let n = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base}-${n}${ext}`);
    n += 1;
  }
  return candidate;
}

/**
 * 写出 CSV 到导出目录（默认项目根目录）。
 * @returns {{path:string, fileName:string, bytes:number, exportDir:string}}
 */
function writeCsv(records, options = {}) {
  const dir = options.dir ? path.resolve(options.dir) : defaultExportDir();

  if (!fs.existsSync(dir)) {
    throw new Error(`导出目录不存在：${dir}`);
  }
  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) {
    throw new Error(`导出目录不可用（不是文件夹）：${dir}`);
  }
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    throw new Error(`没有写入权限，无法导出到：${dir}`);
  }

  const csv = buildCsv(records, options);
  const baseName = `${options.filePrefix || '请假登记'}-${timestampName()}`;
  const target = uniquePath(dir, `${baseName}.csv`);
  try {
    fs.writeFileSync(target, csv, { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    if (err.code === 'EEXIST') {
      const alt = uniquePath(dir, `${baseName}-1.csv`);
      fs.writeFileSync(alt, csv, { encoding: 'utf8', flag: 'wx' });
      return { path: alt, fileName: path.basename(alt), bytes: Buffer.byteLength(csv, 'utf8'), exportDir: dir };
    }
    throw new Error(`写入 CSV 失败：${err.message}`);
  }

  return { path: target, fileName: path.basename(target), bytes: Buffer.byteLength(csv, 'utf8'), exportDir: dir };
}

/** 只有导出目录内的文件才允许“在文件夹中显示” */
function isInsideExportDir(filePath, dir = defaultExportDir()) {
  const resolved = path.resolve(filePath);
  const base = path.resolve(dir);
  return resolved === base || resolved.startsWith(base + path.sep);
}

module.exports = {
  HEADER,
  CSV_BOM,
  DEFAULT_TITLE,
  PROJECT_ROOT,
  isLeaveRecord,
  selectLeaveRecords,
  normalizeRecords,
  csvEscape,
  clipboardCell,
  displayWidth,
  buildClipboardText,
  buildCsv,
  defaultExportDir,
  writeCsv,
  isInsideExportDir,
  makeupLabel,
};

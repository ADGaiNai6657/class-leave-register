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
 * 生成适合直接粘贴到聊天软件 / 表格软件的文本（Tab 分隔）。
 * 因为制表符与换行会破坏行列结构，这里只把“字段内部的制表符/换行”替换为空格，
 * 文字内容本身不做其他改动（CSV 中仍保留原始换行）。
 */
function tsvCell(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/[\t\r\n]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

function buildTsv(records, options = {}) {
  const title = options.title === undefined ? DEFAULT_TITLE : String(options.title);
  const lines = [title, HEADER.join('\t')];
  for (const rec of records) {
    lines.push([tsvCell(rec.name), tsvCell(rec.reason), makeupLabel(rec.makeup)].join('\t'));
  }
  return lines.join('\n');
}

/**
 * 生成 CSV 文本（含 UTF-8 BOM，CRLF 换行，便于 Excel / Numbers 正确显示中文）。
 * 第一行为标题（默认“本班请假登记”，可用参数覆盖），第二行为表头，之后是学生数据。
 */
function buildCsv(records, options = {}) {
  const title = options.title === undefined ? DEFAULT_TITLE : String(options.title);
  const lines = [csvEscape(title), HEADER.map(csvEscape).join(',')];
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

  const csv = buildCsv(records, { title: options.title });
  const target = uniquePath(dir, `请假登记-${timestampName()}.csv`);
  try {
    fs.writeFileSync(target, csv, { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    if (err.code === 'EEXIST') {
      const alt = uniquePath(dir, `请假登记-${timestampName()}-1.csv`);
      fs.writeFileSync(alt, csv, { encoding: 'utf8', flag: 'wx' });
      return { path: alt, fileName: path.basename(alt), bytes: Buffer.byteLength(csv, 'utf8'), exportDir: dir };
    }
    throw new Error(`写入 CSV 失败：${err.message}`);
  }

  return { path: target, fileName: path.basename(target), bytes: Buffer.byteLength(csv, 'utf8'), exportDir: dir };
}

/** 只有导出目录内的文件才允许“在访达中显示” */
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
  tsvCell,
  buildTsv,
  buildCsv,
  defaultExportDir,
  writeCsv,
  isInsideExportDir,
  makeupLabel,
};

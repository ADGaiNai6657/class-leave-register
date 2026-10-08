'use strict';

/**
 * 花名册发现与解析。
 *
 * 职责：
 *  1. 在当前工作文件夹中查找花名册文件（不递归、不猜测）；
 *  2. 按实际文件格式解析成二维表格（.xls / .xlsx / .csv / .tsv / .txt / .json）；
 *  3. 定位“姓名”列（优先表头识别，其次带提示的自动识别，无法可靠判断时明确报错）；
 *  4. 生成学生数据模型 [{ name, id }]，并返回数据质量警告。
 *
 * 只读：本模块不修改任何花名册文件，也不联网。
 */

const fs = require('fs');
const path = require('path');

const { isXls, readXls } = require('./xls');
const { isZip, readXlsx } = require('./xlsx');
const { readDelimited, readJson } = require('./delimited');

const SUPPORTED_EXTENSIONS = ['.xls', '.xlsx', '.csv', '.tsv', '.txt', '.json'];
const IGNORED_FILES = new Set(['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'tsconfig.json', '.ds_store']);
const MAX_STUDENTS = 5000;

const FORMAT_LABELS = {
  '.xls': 'Excel 97-2003（.xls）',
  '.xlsx': 'Excel（.xlsx）',
  '.csv': 'CSV（.csv）',
  '.tsv': '制表符分隔（.tsv）',
  '.txt': '文本（.txt）',
  '.json': 'JSON（.json）',
};

const NAME_HEADERS = ['姓名', '名字', '学生姓名', '学生名字', '姓 名', 'name', 'studentname', 'fullname', 'student'];
const ID_HEADERS = ['学号', '学籍号', '学生学号', '编号', '序号', 'id', 'studentid', 'studentno', 'no', 'number', 'sid'];

class RosterError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'RosterError';
    Object.assign(this, extra);
  }
}

function normalizeHeader(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/[\s\u3000]+/g, '')
    .toLowerCase();
}

function readTables(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  let buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch (err) {
    throw new RosterError(`无法读取花名册文件：${err.message}`);
  }
  if (buffer.length === 0) throw new RosterError('花名册文件是空的（0 字节）');

  let parsed;
  if (ext === '.xls' || (!ext && isXls(buffer))) {
    if (!isXls(buffer)) {
      throw new RosterError(
        '文件扩展名是 .xls，但内容不是旧版 Excel 格式。请用 Excel/WPS/Numbers 另存为 .xlsx 或 .csv 后重试。'
      );
    }
    parsed = readXls(buffer);
  } else if (ext === '.xlsx' || isZip(buffer)) {
    parsed = readXlsx(buffer);
  } else if (ext === '.json') {
    parsed = readJson(buffer);
  } else {
    parsed = readDelimited(buffer);
  }

  const sheets = (parsed.sheets || []).filter((s) => Array.isArray(s.rows));
  if (sheets.length === 0) throw new RosterError('花名册中没有任何工作表');
  const nonEmpty = sheets.filter((s) => s.rows.some((r) => r.some((c) => String(c).trim() !== '')));
  if (nonEmpty.length === 0) throw new RosterError('花名册内容为空：所有工作表都没有数据');
  // 有数据的可见工作表优先
  nonEmpty.sort((a, b) => Number(a.hidden) - Number(b.hidden));
  return { sheets: nonEmpty, meta: parsed.meta || {}, format: FORMAT_LABELS[ext] || `${ext || '未知'} 文件` };
}

function isNameLike(value) {
  const v = String(value === null || value === undefined ? '' : value).trim();
  if (v === '' || v.length > 40) return false;
  if (/\d/.test(v)) return false;
  const normalized = normalizeHeader(v);
  if (NAME_HEADERS.includes(normalized) || ID_HEADERS.includes(normalized)) return false;
  // 中文姓名（允许少数民族姓名的间隔号与空格）
  if (/^[\u3400-\u4dbf\u4e00-\u9fff][\u3400-\u4dbf\u4e00-\u9fff\u00b7\u2022\u30fb\u3000 ]{1,9}$/.test(v)) return true;
  // 拉丁字母姓名（如 Tom Smith / O'Neil）
  if (/^[A-Za-z][A-Za-z'`\-.]*(?: [A-Za-z'`\-.]*)*$/.test(v) && v.length >= 2) return true;
  return false;
}

function columnStats(rows, col, maxRows) {
  const values = [];
  for (let r = 0; r < Math.min(rows.length, maxRows); r += 1) {
    const v = String(rows[r] && rows[r][col] !== undefined ? rows[r][col] : '').trim();
    if (v !== '') values.push(v);
  }
  const nonEmpty = values.length;
  if (nonEmpty === 0) return null;
  const nameLike = values.filter(isNameLike).length;
  const unique = new Set(values).size;
  return {
    nonEmpty,
    ratio: nameLike / nonEmpty,
    uniqueness: unique / nonEmpty,
  };
}

function findByNameHeader(rows) {
  const scanRows = Math.min(rows.length, 12);
  for (let r = 0; r < scanRows; r += 1) {
    const row = rows[r] || [];
    for (let c = 0; c < row.length; c += 1) {
      if (NAME_HEADERS.includes(normalizeHeader(row[c]))) {
        let idCol = -1;
        let idLabel = '';
        for (let c2 = 0; c2 < row.length; c2 += 1) {
          if (c2 === c) continue;
          if (ID_HEADERS.includes(normalizeHeader(row[c2]))) {
            idCol = c2;
            idLabel = String(row[c2]).trim();
            break;
          }
        }
        return { headerRow: r, nameCol: c, idCol, idLabel, nameLabel: String(row[c]).trim() };
      }
    }
  }
  return null;
}

function locateNameColumn(sheets) {
  for (const sheet of sheets) {
    const found = findByNameHeader(sheet.rows);
    if (found) {
      return {
        sheet,
        headerRow: found.headerRow,
        nameCol: found.nameCol,
        idCol: found.idCol,
        idLabel: found.idLabel,
        nameLabel: found.nameLabel,
        source: 'header',
      };
    }
  }

  // 没有表头时：按“像姓名的比例”自动识别，并在界面明确提示
  let best = null;
  let second = null;
  const notes = [];
  for (const sheet of sheets) {
    const rows = sheet.rows;
    const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 0);
    for (let c = 0; c < maxCols; c += 1) {
      const stats = columnStats(rows, c, 60);
      if (!stats) continue;
      if (stats.nonEmpty < 2 || stats.ratio < 0.7 || stats.uniqueness < 0.5) continue;
      const cand = { sheet, nameCol: c, headerRow: -1, stats };
      if (!best || cand.stats.ratio > best.stats.ratio + 1e-9) {
        second = best;
        best = cand;
      } else if (!second || cand.stats.ratio > second.stats.ratio) {
        second = cand;
      }
    }
  }

  if (!best) {
    throw new RosterError(
      '无法识别花名册中的“姓名”列：既没有找到“姓名”表头，也没有任何一列看起来是姓名。' +
        '请确认这是班级花名册，或在文件中把姓名列的标题写成“姓名”。'
    );
  }

  if (second && Math.abs(best.stats.ratio - second.stats.ratio) < 0.05 && best.sheet === second.sheet) {
    throw new RosterError(
      `无法可靠判断哪一列是姓名：第 ${best.nameCol + 1} 列与第 ${second.nameCol + 1} 列都像姓名。` +
        '请在花名册中把姓名列的标题写成“姓名”后重试。'
    );
  }

  notes.push(`花名册没有“姓名”表头，已自动识别第 ${best.nameCol + 1} 列为姓名列，请核对是否正确。`);
  return {
    sheet: best.sheet,
    headerRow: best.headerRow,
    nameCol: best.nameCol,
    idCol: -1,
    idLabel: '',
    nameLabel: `第 ${best.nameCol + 1} 列`,
    source: 'inferred',
    notes,
  };
}

function extractStudents(located) {
  const { sheet, headerRow, nameCol, idCol } = located;
  const warnings = [...(located.notes || [])];
  const students = [];
  const seen = new Map();
  let skippedEmpty = 0;
  let skippedHeader = 0;

  for (let r = headerRow + 1; r < sheet.rows.length; r += 1) {
    const row = sheet.rows[r] || [];
    const name = String(row[nameCol] === undefined || row[nameCol] === null ? '' : row[nameCol])
      .replace(/\u00a0/g, ' ')
      .trim();
    if (name === '') {
      skippedEmpty += 1;
      continue;
    }
    if (NAME_HEADERS.includes(normalizeHeader(name))) {
      skippedHeader += 1;
      continue;
    }
    let id = '';
    if (idCol >= 0) {
      id = String(row[idCol] === undefined || row[idCol] === null ? '' : row[idCol]).trim();
    }
    if (seen.has(name)) {
      const first = seen.get(name);
      warnings.push(`姓名重复：第 ${first + 1} 行与第 ${r + 1} 行都是“${name}”，两张卡片都会保留。`);
    } else {
      seen.set(name, r);
    }
    students.push({ name, id });
    if (students.length > MAX_STUDENTS) {
      throw new RosterError(`花名册人数超过 ${MAX_STUDENTS} 人，疑似不是班级花名册，已停止解析。`);
    }
  }

  if (skippedEmpty > 0) warnings.push(`已跳过 ${skippedEmpty} 行空姓名（没有姓名的行不会生成卡片）。`);
  if (skippedHeader > 0) warnings.push(`已跳过 ${skippedHeader} 行重复表头。`);
  if (students.length === 0) {
    throw new RosterError('在姓名列中找不到任何学生姓名，花名册可能为空或姓名列不正确。');
  }
  return { students, warnings };
}

/** 解析单个花名册文件 */
function loadRoster(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) throw new RosterError(`找不到花名册文件：${abs}`);
  const stat = fs.statSync(abs);
  if (!stat.isFile()) throw new RosterError(`花名册路径不是文件：${abs}`);

  const { sheets, meta, format } = readTables(abs);
  const located = locateNameColumn(sheets);
  const { students, warnings } = extractStudents(located);

  if (sheets.length > 1) {
    warnings.push(
      `工作簿共有 ${sheets.length} 个有数据的工作表，本应用读取的是“${located.sheet.name}”。`
    );
  }
  if (located.sheet.hidden) {
    warnings.push(`使用的是隐藏工作表“${located.sheet.name}”。`);
  }
  if (meta && meta.encoding && !/^utf-?8/.test(meta.encoding)) {
    warnings.push(`文本文件编码按 ${meta.encoding.toUpperCase()} 解析。`);
  }

  return {
    ok: true,
    filePath: abs,
    fileName: path.basename(abs),
    format,
    sheetName: located.sheet.name,
    sheetNames: sheets.map((s) => s.name),
    nameColumn: { index: located.nameCol, label: located.nameLabel, source: located.source },
    idColumn: located.idCol >= 0 ? { index: located.idCol, label: located.idLabel } : null,
    studentCount: students.length,
    students,
    warnings,
    modifiedAt: stat.mtime.toISOString(),
  };
}

/** 在给定目录中查找花名册候选文件（不递归） */
function discoverRosterFiles(searchDirs) {
  const found = [];
  const seenPaths = new Set();
  for (const dir of searchDirs) {
    if (!dir || !fs.existsSync(dir)) continue;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      if (name.startsWith('.') || IGNORED_FILES.has(name.toLowerCase())) continue;
      const ext = path.extname(name).toLowerCase();
      if (!SUPPORTED_EXTENSIONS.includes(ext)) continue;
      const full = path.join(dir, name);
      if (seenPaths.has(full)) continue;
      seenPaths.add(full);
      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch {
        /* 忽略 */
      }
      found.push({ path: full, fileName: name, size, extension: ext });
    }
  }
  found.sort((a, b) => a.fileName.localeCompare(b.fileName, 'zh-Hans-CN'));
  return found;
}

/** 默认搜索目录：应用所在目录、上级工作文件夹，以及常见的花名册子目录 */
function defaultSearchDirs(appDir) {
  const parent = path.dirname(appDir);
  const dirs = [appDir, path.join(appDir, '花名册'), path.join(appDir, 'roster')];
  if (parent && parent !== appDir) {
    dirs.push(parent, path.join(parent, '花名册'), path.join(parent, 'roster'));
  }
  return [...new Set(dirs)];
}

/**
 * 自动定位并解析花名册。
 * 没有候选或多个候选都会明确报错（附带候选清单），不会擅自猜测。
 */
function resolveRoster({ appDir, rosterPath }) {
  if (rosterPath) {
    return loadRoster(rosterPath);
  }

  const searchDirs = defaultSearchDirs(appDir);
  const candidates = discoverRosterFiles(searchDirs);
  if (candidates.length === 0) {
    throw new RosterError(
      `在以下位置没有找到花名册文件（支持 .xls/.xlsx/.csv/.tsv/.txt/.json）：\n${searchDirs.join('\n')}`,
      { searchDirs, candidates: [] }
    );
  }

  const valid = [];
  const failures = [];
  for (const cand of candidates) {
    try {
      const roster = loadRoster(cand.path);
      valid.push(roster);
    } catch (err) {
      failures.push({ path: cand.path, fileName: cand.fileName, message: err.message });
    }
  }

  if (valid.length === 0) {
    throw new RosterError(
      `找到了 ${candidates.length} 个可能的文件，但都无法作为花名册解析：\n` +
        failures.map((f) => `· ${f.fileName}：${f.message}`).join('\n'),
      { searchDirs, candidates: candidates.map((c) => ({ path: c.path, fileName: c.fileName })), failures }
    );
  }

  if (valid.length > 1) {
    throw new RosterError(
      `找到 ${valid.length} 个都像花名册的文件，无法确定使用哪一个，请选择：\n` +
        valid.map((v) => `· ${v.fileName}（${v.studentCount} 人）`).join('\n'),
      {
        searchDirs,
        ambiguous: true,
        candidates: valid.map((v) => ({ path: v.filePath, fileName: v.fileName, studentCount: v.studentCount })),
      }
    );
  }

  const roster = valid[0];
  if (failures.length > 0) {
    roster.warnings.push(
      `同一文件夹中还有 ${failures.length} 个无法解析的同名类型文件，已忽略：` +
        failures.map((f) => f.fileName).join('、')
    );
  }
  return roster;
}

module.exports = {
  RosterError,
  SUPPORTED_EXTENSIONS,
  FORMAT_LABELS,
  loadRoster,
  discoverRosterFiles,
  defaultSearchDirs,
  resolveRoster,
  isNameLike,
};

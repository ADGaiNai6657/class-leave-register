'use strict';

/**
 * 自动化测试（零依赖，使用 Node 内置测试运行器）
 * 运行：npm test  或  node --test test/selftest.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const zlib = require('node:zlib');

const { readXls } = require('../lib/xls');
const { readXlsx } = require('../lib/xlsx');
const { decodeText, parseDelimited, sniffDelimiter, readDelimited, readJson } = require('../lib/delimited');
const { isNameLike, loadRoster, resolveRoster, RosterError, discoverRosterFiles, defaultSearchDirs } = require('../lib/roster');
const {
  csvEscape,
  buildCsv,
  buildTsv,
  writeCsv,
  normalizeRecords,
  defaultExportDir,
  isInsideExportDir,
  DEFAULT_TITLE,
  selectLeaveRecords,
} = require('../lib/export');

const APP_DIR = path.resolve(__dirname, '..');
const TMP_DIR = path.join(__dirname, '.tmp');

/**
 * 自动发现工作文件夹里的花名册。
 * 找不到时相关测试会自动跳过 —— 这样在没有花名册的环境（例如公开仓库的克隆）里也能跑通其余测试。
 */
const ROSTER_FILE = (() => {
  for (const candidate of discoverRosterFiles(defaultSearchDirs(APP_DIR))) {
    try {
      loadRoster(candidate.path);
      return candidate.path;
    } catch {
      /* 不是可解析的花名册，继续找 */
    }
  }
  return null;
})();

// 已知花名册的完整内容校验（sha256 为“姓名/学号按顺序拼接”的摘要，避免在测试里复制个人数据）
const KNOWN_ROSTER_SIZE = 22016;
const KNOWN_NAMES_SHA256 = '3bc8878ee835e521e159183a01df03cd1e2786f40e563d6f603d59e66476d5a9';
const KNOWN_IDS_SHA256 = '07cea6ef46ee6128833a842bdc60f0d7e530862a5c7cfe066bd2916cfdf24e02';

function sha256(lines) {
  return crypto.createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}

function freshTmp(name) {
  const dir = path.join(TMP_DIR, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------- 测试用 ZIP 写入（用于合成 .xlsx）

function crc32(buf) {
  return typeof zlib.crc32 === 'function' ? zlib.crc32(buf) : 0;
}

function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const method = entry.store ? 0 : 8;
    const body = method === 0 ? raw : zlib.deflateRawSync(raw);
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([Buffer.concat(locals), centralBuf, eocd]);
}

function buildSampleXlsx() {
  const workbook =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="花名册" sheetId="1" r:id="rId1"/><sheet name="备注" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>';

  const rels =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>' +
    '</Relationships>';

  const sharedStrings =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="7" uniqueCount="7">' +
    '<si><t>学号</t></si>' +
    '<si><t>姓名</t></si>' +
    '<si><t>张三</t></si>' +
    '<si><r><t>李</t></r><r><t>四</t></r></si>' +
    '<si><t xml:space="preserve"> 王五 </t></si>' +
    '<si><t>赵六</t></si>' +
    '<si><t>孙七</t></si>' +
    '</sst>';

  const sheet1 =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
    '<row r="2"><c r="A2"><v>20250000001</v></c><c r="B2" t="s"><v>2</v></c></row>' +
    '<row r="3"><c r="A3"><v>20250000002</v></c><c r="B3" t="s"><v>3</v></c></row>' +
    '<row r="4"><c r="A4"><v>20250000003</v></c><c r="B4" t="s"><v>4</v></c></row>' +
    '<row r="5"><c r="A5"><v>20250000004</v></c><c r="B5" t="inlineStr"><is><t>赵六</t></is></c></row>' +
    '<row r="6"><c r="A6"><v>20250000005</v></c><c r="B6" t="s"><v>6</v></c><c r="C6"><v>1</v></c></row>' +
    '</sheetData></worksheet>';

  const sheet2 =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
    '<row r="1"><c r="A1" t="inlineStr"><is><t>隐藏表</t></is></c></row>' +
    '</sheetData></worksheet>';

  return writeZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types/>', store: true },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: rels },
    { name: 'xl/sharedStrings.xml', data: sharedStrings },
    { name: 'xl/worksheets/sheet1.xml', data: sheet1 },
    { name: 'xl/worksheets/sheet2.xml', data: sheet2, store: true },
  ]);
}

// ---------------------------------------------------------------- 花名册解析

test('花名册 .xls（BIFF8）可以完整解析', (t) => {
  if (!ROSTER_FILE) {
    t.skip('当前工作文件夹里没有花名册，跳过（公开仓库的克隆属于这种情况）');
    return;
  }
  const roster = loadRoster(ROSTER_FILE);
  assert.match(roster.format, /xls/);

  const names = roster.students.map((s) => s.name);
  const ids = roster.students.map((s) => s.id);
  assert.ok(names.length > 0, '至少应解析出 1 名学生');
  assert.equal(new Set(names).size, names.length, '不应有重复姓名');
  assert.equal(new Set(ids).size, ids.length, '不应有重复学号');
  for (const name of names) assert.ok(isNameLike(name), `姓名异常：${name}`);
  for (const id of ids) assert.match(id, /^\d+$/, `学号应为纯数字：${id}`);

  // 与本机这份基准花名册逐字节比对（换一份花名册时这些断言自动不生效）
  if (fs.statSync(ROSTER_FILE).size === KNOWN_ROSTER_SIZE) {
    assert.equal(roster.studentCount, 34);
    assert.equal(roster.nameColumn.source, 'header');
    assert.equal(roster.nameColumn.index, 1);
    assert.equal(roster.idColumn.index, 0);
    assert.equal(sha256(names), KNOWN_NAMES_SHA256, '姓名与学生顺序应与基准花名册完全一致');
    assert.equal(sha256(ids), KNOWN_IDS_SHA256, '学号应与基准花名册完全一致');
  }
});

test('.xls 直接读取应得到与表头一致的列结构', (t) => {
  if (!ROSTER_FILE) {
    t.skip('当前工作文件夹里没有花名册，跳过');
    return;
  }
  const wb = readXls(fs.readFileSync(ROSTER_FILE));
  assert.ok(wb.sheets.length >= 1);
  const rows = wb.sheets[0].rows;
  assert.ok(rows.length > 1, '表里应有表头与数据行');
  const flat = rows[0].map((c) => String(c).trim());
  assert.ok(flat.includes('姓名'), '表头应包含“姓名”列');

  if (fs.statSync(ROSTER_FILE).size === KNOWN_ROSTER_SIZE) {
    assert.equal(wb.sheets.length, 1);
    assert.deepEqual(rows[0].slice(0, 2), ['学号', '姓名']);
    assert.equal(rows.length, 35);
    assert.equal(rows[34][1], rows[34][1].trim());
  }
});

// ---------------------------------------------------------------- xlsx

test('合成的 .xlsx 可以解析（共享字符串 / 富文本 / inlineStr / 数字）', () => {
  const buffer = buildSampleXlsx();
  const wb = readXlsx(buffer);
  assert.equal(wb.sheets.length, 2);
  assert.equal(wb.sheets[0].name, '花名册');
  assert.equal(wb.sheets[1].hidden, true);

  const rows = wb.sheets[0].rows;
  assert.deepEqual(rows[0].slice(0, 2), ['学号', '姓名']);
  assert.equal(rows[1][0], '20250000001');
  assert.equal(rows[1][1], '张三');
  assert.equal(rows[2][1], '李四', '富文本运行应拼接为完整姓名');
  assert.equal(rows[3][1].trim(), '王五');
  assert.equal(rows[4][1], '赵六', 'inlineStr 应正确读取');
  assert.equal(rows[5][2], '1');
});

test('合成 .xlsx 写入临时文件后可被 loadRoster 识别', () => {
  const dir = freshTmp('xlsx');
  const file = path.join(dir, '花名册.xlsx');
  fs.writeFileSync(file, buildSampleXlsx());
  const roster = loadRoster(file);
  assert.equal(roster.studentCount, 5);
  assert.deepEqual(
    roster.students.map((s) => s.name),
    ['张三', '李四', '王五', '赵六', '孙七']
  );
  assert.equal(roster.nameColumn.source, 'header');
});

// ---------------------------------------------------------------- 文本 / JSON

test('CSV 解析支持引号、逗号、字段内换行与 CRLF', () => {
  const text = '姓名,请假理由,是否补假\r\n"张三","身体不适,需要休息",否\r\n李四,"他说""要考试""\r\n第二行",是\r\n';
  const rows = parseDelimited(text, ',');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], ['姓名', '请假理由', '是否补假']);
  assert.deepEqual(rows[1], ['张三', '身体不适,需要休息', '否']);
  assert.equal(rows[2][1], '他说"要考试"\r\n第二行');
  assert.equal(sniffDelimiter(text), ',');
});

test('Tab 分隔文本与 GBK 编码文件可以解析', () => {
  const dir = freshTmp('gbk');
  const file = path.join(dir, '花名册.csv');
  // GBK 编码内容：“姓名,学号\n张三,20250000001\n李四,20250000002\n”
  fs.writeFileSync(
    file,
    Buffer.from([
      0xd0, 0xd5, 0xc3, 0xfb, 0x2c, 0xd1, 0xa7, 0xba, 0xc5, 0x0a, 0xd5, 0xc5, 0xc8, 0xfd, 0x2c, 0x32,
      0x30, 0x32, 0x35, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x31, 0x0a, 0xc0, 0xee, 0xcb, 0xc4, 0x2c,
      0x32, 0x30, 0x32, 0x35, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x32, 0x0a,
    ])
  );
  const decoded = decodeText(fs.readFileSync(file));
  assert.equal(decoded.encoding, 'gbk');
  assert.ok(decoded.text.startsWith('姓名,学号\n张三'));

  const roster = loadRoster(file);
  assert.equal(roster.studentCount, 2);
  assert.deepEqual(
    roster.students.map((s) => s.name),
    ['张三', '李四']
  );
  assert.ok(roster.warnings.some((w) => w.includes('GBK')));

  const tsv = parseDelimited('姓名\t请假理由\n张三\t事假\n', '\t');
  assert.deepEqual(tsv, [
    ['姓名', '请假理由'],
    ['张三', '事假'],
  ]);
  assert.equal(sniffDelimiter('姓名\t请假理由\n张三\t事假\n'), '\t');
});

test('JSON 花名册（对象数组 / 字符串数组）可以解析', () => {
  const objs = readJson(Buffer.from(JSON.stringify([{ 姓名: '张三', 学号: '1' }, { 姓名: '李四', 学号: '2' }]), 'utf8'));
  assert.deepEqual(objs.sheets[0].rows[0], ['姓名', '学号']);

  const strs = readJson(Buffer.from(JSON.stringify(['张三', '李四']), 'utf8'));
  assert.deepEqual(strs.sheets[0].rows, [['姓名'], ['张三'], ['李四']]);

  assert.throws(() => readJson(Buffer.from('{ bad json', 'utf8')), /JSON 解析失败/);
});

test('文本文件读取带 BOM 的 UTF-8 不会把 BOM 当成姓名的一部分', () => {
  const dir = freshTmp('bom');
  const file = path.join(dir, 'roster.csv');
  fs.writeFileSync(file, '\uFEFF姓名,学号\r\n张三,1\r\n');
  const parsed = readDelimited(fs.readFileSync(file));
  assert.equal(parsed.sheets[0].rows[0][0], '姓名');
});

// ---------------------------------------------------------------- 姓名列识别

test('没有“姓名”表头时自动识别姓名列并给出提示', () => {
  const dir = freshTmp('infer');
  const file = path.join(dir, 'roster.csv');
  fs.writeFileSync(file, '20250000001,张三\n20250000002,李四\n20250000003,王五\n');
  const roster = loadRoster(file);
  assert.equal(roster.nameColumn.source, 'inferred');
  assert.equal(roster.nameColumn.index, 1);
  assert.equal(roster.studentCount, 3);
  assert.ok(roster.warnings.some((w) => w.includes('自动识别')));
});

test('两列都像姓名时明确报错，不擅自猜测', () => {
  const dir = freshTmp('ambiguous-col');
  const file = path.join(dir, 'roster.csv');
  fs.writeFileSync(file, '张三,李四\n王五,赵六\n孙七,周八\n');
  assert.throws(() => loadRoster(file), (err) => err instanceof RosterError && /无法可靠判断/.test(err.message));
});

test('找不到姓名列时明确报错', () => {
  const dir = freshTmp('no-name');
  const file = path.join(dir, 'roster.csv');
  fs.writeFileSync(file, '1,男,100\n2,女,101\n3,男,102\n');
  assert.throws(() => loadRoster(file), (err) => err instanceof RosterError && /无法识别/.test(err.message));
});

test('空文件 / 空花名册明确报错', () => {
  const dir = freshTmp('empty');
  const empty = path.join(dir, 'empty.csv');
  fs.writeFileSync(empty, '');
  assert.throws(() => loadRoster(empty), /空的（0 字节）/);

  const headerOnly = path.join(dir, 'header.csv');
  fs.writeFileSync(headerOnly, '学号,姓名\n');
  assert.throws(() => loadRoster(headerOnly), /找不到任何学生姓名/);
});

test('重复姓名与空姓名行会被提示/跳过', () => {
  const dir = freshTmp('dup');
  const file = path.join(dir, 'roster.csv');
  fs.writeFileSync(file, '学号,姓名\n1,张三\n2,张三\n3,\n4,李四\n');
  const roster = loadRoster(file);
  assert.equal(roster.studentCount, 3);
  assert.ok(roster.warnings.some((w) => w.includes('姓名重复')));
  assert.ok(roster.warnings.some((w) => w.includes('空姓名')));
});

// ---------------------------------------------------------------- 花名册定位

test('在指定目录中定位花名册：找不到时报错并给出搜索目录', () => {
  const dir = freshTmp('discover-empty');
  assert.throws(
    () => resolveRoster({ appDir: dir }),
    (err) => err instanceof RosterError && /没有找到花名册文件/.test(err.message)
  );
});

test('存在多个花名册时要求用户明确选择', () => {
  const dir = freshTmp('discover-multi');
  fs.writeFileSync(path.join(dir, 'a.csv'), '姓名\n张三\n李四\n');
  fs.writeFileSync(path.join(dir, 'b.csv'), '姓名\n王五\n赵六\n');
  assert.throws(
    () => resolveRoster({ appDir: dir }),
    (err) => err instanceof RosterError && err.ambiguous === true && err.candidates.length === 2
  );
  // 指定路径后应正常读取
  const roster = resolveRoster({ appDir: dir, rosterPath: path.join(dir, 'b.csv') });
  assert.deepEqual(
    roster.students.map((s) => s.name),
    ['王五', '赵六']
  );
});

test('忽略无关文件（package.json、.DS_Store 等）', () => {
  const dir = freshTmp('discover-ignore');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
  fs.writeFileSync(path.join(dir, '.DS_Store'), 'junk');
  fs.writeFileSync(path.join(dir, 'roster.csv'), '姓名\n张三\n李四\n');
  const roster = resolveRoster({ appDir: dir });
  assert.equal(roster.studentCount, 2);
});

// ---------------------------------------------------------------- 导出格式

test('CSV 转义符合 RFC4180（逗号 / 引号 / 换行）', () => {
  assert.equal(csvEscape('普通文本'), '普通文本');
  assert.equal(csvEscape('a,b'), '"a,b"');
  assert.equal(csvEscape('a"b'), '"a""b"');
  assert.equal(csvEscape('a\nb'), '"a\nb"');
  assert.equal(csvEscape('a\r\nb'), '"a\r\nb"');
  assert.equal(csvEscape(''), '');
});

test('CSV 内容：UTF-8 BOM、首行标题、CRLF，且中文不乱码', () => {
  const records = normalizeRecords([
    { name: '张三', reason: '身体不适', makeup: false },
    { name: '李四', reason: '', makeup: null },
    { name: '王五', reason: '参加考试，需要,提前离校', makeup: true },
    { name: '赵六', reason: '医生说"要休息"\n并复诊', makeup: false },
  ]);
  const csv = buildCsv(records);

  assert.ok(csv.startsWith('\uFEFF'), '应带 UTF-8 BOM');
  assert.ok(csv.includes('\r\n'), '应使用 CRLF');
  const lines = csv.slice(1).split('\r\n');
  assert.equal(lines[0], DEFAULT_TITLE, '第一行应为标题');
  assert.equal(lines[1], '姓名,请假理由,是否补假', '第二行应为表头');
  assert.equal(lines[2], '张三,身体不适,否');
  assert.equal(lines[3], '李四,,');
  assert.equal(lines[4], '王五,"参加考试，需要,提前离校",是');
  assert.equal(lines[5], '赵六,"医生说""要休息""\n并复诊",否');
  // 标题 + 表头 + 4 名学生 + 末尾空行
  assert.equal(lines.length, 7);
  // 重新解析回来，内容应与输入一致
  const parsed = parseDelimited(csv.slice(1).replace(/\r\n$/, ''), ',');
  assert.equal(parsed.length, 6);
  assert.deepEqual(parsed[0], [DEFAULT_TITLE]);
  assert.deepEqual(parsed[1], ['姓名', '请假理由', '是否补假']);
  assert.equal(parsed[5][1], '医生说"要休息"\n并复诊');
});

test('导出只保留请假的学生：填了理由 或 选了是否补假', () => {
  const all = normalizeRecords([
    { name: '张三', reason: '身体不适', makeup: false },
    { name: '李四', reason: '', makeup: null },
    { name: '王五', reason: '', makeup: true },
    { name: '赵六', reason: '   ', makeup: null },
    { name: '孙七', reason: '事假', makeup: null },
  ]);
  const keep = selectLeaveRecords(all);
  assert.deepEqual(
    keep.map((r) => r.name),
    ['张三', '王五', '孙七'],
    '只保留填写过的学生；只有空白字符的理由不算填写'
  );

  // 一个人都没填时：剪贴板内容为空，CSV 只有标题和表头
  const none = selectLeaveRecords(normalizeRecords([{ name: '李四', reason: '', makeup: null }]));
  assert.equal(none.length, 0);
  assert.equal(buildTsv(none), `${DEFAULT_TITLE}\n姓名\t请假理由\t是否补假`);
  assert.equal(buildCsv(none), `\uFEFF${DEFAULT_TITLE}\r\n姓名,请假理由,是否补假\r\n`);
});

test('标题行可以覆盖（--title / 环境变量之外的直接传参）', () => {
  const records = normalizeRecords([{ name: '张三', reason: '身体不适', makeup: false }]);
  assert.equal(buildTsv(records, { title: '本某某班' }).split('\n')[0], '本某某班');
  assert.equal(buildCsv(records, { title: '本某某班' }).slice(1).split('\r\n')[0], '本某某班');
  assert.equal(buildTsv(records).split('\n')[0], DEFAULT_TITLE, '默认标题');
  assert.equal(buildTsv([]).split('\n')[0], DEFAULT_TITLE, '空数据也保留标题');
});

test('导出标题优先级：--title > 环境变量 > local-config.json > 中性默认值', () => {
  const { resolveTitle, LOCAL_CONFIG_FILE } = require('../server');

  const withConfig = freshTmp('title-config');
  fs.writeFileSync(path.join(withConfig, LOCAL_CONFIG_FILE), JSON.stringify({ title: '本某某班' }));
  assert.equal(resolveTitle({ title: null }, withConfig).title, '本某某班', '本地配置生效');
  assert.equal(resolveTitle({ title: '本某甲班' }, withConfig).title, '本某甲班', '--title 优先于本地配置');

  process.env.CLASS_LEAVE_TITLE = '本某乙班';
  try {
    assert.equal(resolveTitle({ title: null }, withConfig).title, '本某乙班', '环境变量优先于本地配置');
    assert.equal(resolveTitle({ title: '本某甲班' }, withConfig).title, '本某甲班', '--title 优先级最高');
  } finally {
    delete process.env.CLASS_LEAVE_TITLE;
  }

  const noConfig = freshTmp('title-none');
  assert.equal(resolveTitle({ title: null }, noConfig).title, DEFAULT_TITLE, '没有本地配置时用中性默认值');
  assert.ok(DEFAULT_TITLE.includes('本班'), '默认标题应是中性值，不含具体班级名');

  fs.writeFileSync(path.join(noConfig, LOCAL_CONFIG_FILE), '{ 这不是合法 JSON');
  assert.equal(resolveTitle({ title: null }, noConfig).title, DEFAULT_TITLE, '坏配置不中断，退回默认值');
});

test('未选择是否补假时导出为空，而不是编造“否”', () => {
  const records = normalizeRecords([{ name: '李四', reason: '事假', makeup: null }]);
  assert.equal(buildCsv(records).slice(1).split('\r\n')[2], '李四,事假,');
  assert.equal(buildTsv(records).split('\n')[2], '李四\t事假\t');
});

test('剪切板文本使用 Tab 分隔，第一行标题，且字段内换行/制表符不会破坏结构', () => {
  const records = normalizeRecords([
    { name: '张三', reason: '身体不适', makeup: false },
    { name: '李四', reason: '', makeup: null },
    { name: '王五', reason: '参加考试\n需要提前离校\t谢谢', makeup: true },
  ]);
  const tsv = buildTsv(records);
  const lines = tsv.split('\n');
  assert.equal(lines[0], DEFAULT_TITLE);
  assert.equal(lines[1], '姓名\t请假理由\t是否补假');
  assert.equal(lines[2], '张三\t身体不适\t否');
  assert.equal(lines[3], '李四\t\t');
  assert.equal(lines[4], '王五\t参加考试 需要提前离校 谢谢\t是');
  assert.equal(lines.length, 5, '不应该因为字段内换行而多出记录行');
  assert.equal(lines[0].split('\t').length, 1, '标题行单独一行');
  for (const line of lines.slice(1)) assert.equal(line.split('\t').length, 3);
});

test('导出数据校验：非法输入会被拒绝', () => {
  assert.throws(() => normalizeRecords('not-array'), /应为数组/);
  assert.throws(() => normalizeRecords([null]), /格式错误/);
  assert.throws(() => normalizeRecords([{ name: 'x'.repeat(201) }]), /姓名过长/);
});

// ---------------------------------------------------------------- CSV 落盘

test('写出的 CSV 文件内容正确，重复导出不会覆盖旧文件', () => {
  const dir = freshTmp('export');
  const records = normalizeRecords([{ name: '张三', reason: '身体不适', makeup: false }]);
  const first = writeCsv(records, { dir });
  const second = writeCsv(records, { dir });

  assert.ok(fs.existsSync(first.path));
  assert.notEqual(first.path, second.path);
  assert.ok(fs.existsSync(second.path));

  const text = fs.readFileSync(first.path, 'utf8');
  assert.equal(text, `\uFEFF${DEFAULT_TITLE}\r\n姓名,请假理由,是否补假\r\n张三,身体不适,否\r\n`);
  assert.equal(fs.readFileSync(first.path).slice(0, 3).toString('hex'), 'efbbbf');
  assert.equal(first.bytes, Buffer.byteLength(text, 'utf8'));

  // 标题可以通过参数覆盖
  const custom = writeCsv(records, { dir, title: '本某某班' });
  assert.equal(fs.readFileSync(custom.path, 'utf8').slice(1).split('\r\n')[0], '本某某班');
});

test('导出目录不存在时报错而不是静默失败', () => {
  const dir = path.join(TMP_DIR, 'not-exists', 'desktop');
  fs.rmSync(dir, { recursive: true, force: true });
  assert.throws(() => writeCsv([{ name: '张三', reason: '', makeup: null }], { dir }), /导出目录不存在/);
});

test('默认导出目录是项目根目录（不是桌面），且访达只允许打开导出目录内的文件', () => {
  assert.equal(defaultExportDir(), APP_DIR);
  assert.notEqual(defaultExportDir(), path.join(os.homedir(), 'Desktop'));
  const inside = path.join(defaultExportDir(), '请假登记-1.csv');
  assert.equal(isInsideExportDir(inside), true);
  assert.equal(isInsideExportDir('/etc/passwd'), false);
  assert.equal(isInsideExportDir(path.join(defaultExportDir(), '..', 'x.csv')), false);
});

test('清理临时目录', () => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  assert.equal(fs.existsSync(TMP_DIR), false);
});

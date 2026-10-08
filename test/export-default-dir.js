'use strict';

/**
 * 真机验证：按默认设置导出 CSV（默认目录 = 项目根目录，不再是桌面）。
 *
 * 本脚本会：
 *   1. 以默认导出目录启动一次本地服务；
 *   2. 通过接口导出一份示例登记结果，并回读剪切板校验；
 *   3. 校验项目根目录下的 CSV 文件（标题行 / BOM / CRLF / 转义 / 只含请假学生）；
 *   4. 删除刚才生成的文件，不在项目目录里留下任何东西。
 *
 * 运行：
 *   node test/export-default-dir.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const APP_DIR = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures += 1;
  process.stdout.write(`${ok ? '✔' : '✖'} ${name}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ''}\n`);
}

async function main() {
  const before = new Set(fs.readdirSync(APP_DIR));

  const server = spawn(process.execPath, ['server.js', '--no-open', '--port', '0'], {
    cwd: APP_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let log = '';
  server.stdout.on('data', (d) => {
    log += d.toString();
  });
  server.stderr.on('data', (d) => {
    log += d.toString();
  });

  const created = [];
  try {
    const baseUrl = await (async () => {
      const start = Date.now();
      while (Date.now() - start < 10000) {
        const m = /界面地址：(http:\/\/127\.0\.0\.1:\d+\/)/.exec(log);
        if (m) return m[1];
        await sleep(100);
      }
      throw new Error(`服务启动失败：${log}`);
    })();

    const state = await (await fetch(`${baseUrl}api/state`)).json();
    if (!state.roster) {
      process.stdout.write('当前工作文件夹里没有可解析的花名册，跳过本验证（公开仓库的克隆属于这种情况）。\n');
      return;
    }
    check(`服务读取花名册成功（${state.roster.studentCount} 名学生）`, state.ok === true && state.roster.studentCount > 0);
    check('默认导出目录是项目根目录（不再是桌面）', state.exportDir === APP_DIR, state.exportDir);
    check('启动日志里的导出目录正确', log.includes(`导出目录：${APP_DIR}`));

    const students = state.roster.students;
    const records = students.map((s, i) => ({
      name: s.name,
      reason: i === 0 ? '身体不适' : i === 1 ? '参加考试，需要"提前"离校' : '',
      makeup: i === 0 ? false : i === 1 ? true : null,
    }));

    const res = await fetch(`${baseUrl}api/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ records }),
    });
    const data = await res.json();
    check('导出接口返回成功', data.ok === true, data);
    if (!data.ok) return;

    const csvPath = data.csv.path;
    check('CSV 写在项目根目录', path.dirname(csvPath) === APP_DIR, csvPath);
    check('CSV 文件确实存在', fs.existsSync(csvPath), csvPath);
    created.push(csvPath);

    const buf = fs.readFileSync(csvPath);
    check('CSV 带 UTF-8 BOM', buf.subarray(0, 3).toString('hex') === 'efbbbf');
    const text = buf.toString('utf8');
    const lines = text.slice(1).split('\r\n');
    check('CSV 第一行是导出标题', lines[0] === state.exportTitle, lines[0]);
    check('CSV 第二行是表头', lines[1] === '姓名,请假理由,是否补假', lines[1]);
    check('CSV 只含标题 + 表头 + 2 名请假学生 + 末尾换行', lines.length === 5, lines.length);
    check('只导出填写过的学生', text.includes(students[0].name) && text.includes(students[1].name));
    check(
      '未填写的学生不出现在导出内容里',
      [students[2].name, students[3].name, students[students.length - 1].name].every((n) => !text.includes(n))
    );
    check('逗号与引号被正确转义', lines[3] === `${students[1].name},"参加考试，需要""提前""离校",是`, lines[3]);

    const clip = execFileSync('/usr/bin/pbpaste', [], { encoding: 'utf8' });
    const clipLines = clip.split('\n');
    check('剪切板第一行是导出标题', clipLines[0] === state.exportTitle, clipLines[0]);
    check('剪切板第二行是 Tab 分隔表头', clipLines[1] === '姓名\t请假理由\t是否补假', clipLines[1]);
    check('剪切板只含 2 名请假学生', clipLines.length === 4, clipLines.length);

    process.stdout.write(`\n导出文件：${csvPath}\n前 4 行内容：\n${lines.slice(0, 4).join('\n')}\n\n`);
  } finally {
    if (!server.killed) server.kill('SIGTERM');
    await sleep(300);
    for (const file of created) {
      try {
        fs.unlinkSync(file);
        process.stdout.write(`已删除测试产生的文件：${file}\n`);
      } catch (err) {
        process.stdout.write(`清理失败，请手动删除：${file}（${err.message}）\n`);
        failures += 1;
      }
    }
    const after = fs.readdirSync(APP_DIR).filter((f) => !before.has(f));
    check('项目目录未留下任何多余文件', after.length === 0, after);
  }

  process.stdout.write(`\n默认导出目录验证：${failures === 0 ? '全部通过' : `${failures} 项失败`}\n`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  process.stdout.write(`默认导出目录验证异常：${err.stack || err.message}\n`);
  process.exitCode = 1;
});

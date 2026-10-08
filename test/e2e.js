'use strict';

/**
 * 端到端测试：真实启动本地服务 + 真实浏览器（Chrome headless，通过 DevTools 协议驱动）
 *
 * 覆盖：卡片渲染、卡片大小、双击展开、填写/修改、补假单选、编辑状态、
 *       剪切板写入（用 pbpaste 回读校验）、CSV 落盘与转义、重复导出、弹窗行为、
 *       无外部网络请求、无本地持久化。
 *
 * 运行：npm run test:e2e
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const APP_DIR = path.resolve(__dirname, '..');
const E2E_DIR = path.join(__dirname, '.e2e');
const EXPORT_DIR = path.join(E2E_DIR, 'desktop');
const PROFILE_DIR = path.join(E2E_DIR, 'chrome-profile');
const SHOT_DIR = path.join(__dirname, 'screenshots');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = 9333;

const results = [];
let failures = 0;

function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  if (!ok) failures += 1;
  const mark = ok ? '✔' : '✖';
  process.stdout.write(`${mark} ${name}${!ok && detail !== undefined ? `  → ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}\n`);
}

function equal(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? undefined : { actual, expected });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- CDP 客户端

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', (e) => reject(new Error(`DevTools 连接失败：${e.message || 'error'}`)), { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = (this.nextId += 1);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const source = `(() => { ${expression} })()`;
    const result = await this.send('Runtime.evaluate', {
      expression: source,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      const desc = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
      throw new Error(`页面脚本异常：${desc}\n出错脚本：${source}`);
    }
    return result.result.value;
  }

  async waitFor(expression, timeoutMs = 10000, label = expression) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const value = await this.eval(`return (${expression});`);
      if (value) return value;
      await sleep(80);
    }
    throw new Error(`等待超时：${label}`);
  }

  async screenshot(file) {
    const shot = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  }
}

async function fetchJson(url) {
  const res = await fetch(url);
  return res.json();
}

// ---------------------------------------------------------------- 主流程

async function main() {
  if (!fs.existsSync(CHROME)) {
    process.stdout.write(`未找到 Chrome，跳过端到端测试：${CHROME}\n`);
    return;
  }

  fs.rmSync(E2E_DIR, { recursive: true, force: true });
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  let server;
  let chrome;
  let cdp;

  try {
    // 1) 启动本地服务
    server = spawn(process.execPath, ['server.js', '--no-open', '--port', '0', '--export-dir', EXPORT_DIR], {
      cwd: APP_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let serverLog = '';
    server.stdout.on('data', (d) => {
      serverLog += d.toString();
    });
    server.stderr.on('data', (d) => {
      serverLog += d.toString();
    });

    const baseUrl = await (async () => {
      const start = Date.now();
      while (Date.now() - start < 10000) {
        const m = /界面地址：(http:\/\/127\.0\.0\.1:\d+\/)/.exec(serverLog);
        if (m) return m[1];
        await sleep(100);
      }
      throw new Error(`服务启动失败：${serverLog}`);
    })();
    check('本地服务启动成功', true);
    process.stdout.write(`   地址：${baseUrl}\n`);

    // 花名册基准（用于比对界面与 CSV 与人数）
    const state = await fetchJson(`${baseUrl}api/state`);
    if (!state.roster) {
      process.stdout.write('当前工作文件夹里没有可解析的花名册，跳过端到端测试（公开仓库的克隆属于这种情况）。\n');
      return;
    }
    const total = state.roster.studentCount;
    check(`API 读取到花名册（${total} 名学生）`, total > 0, total);
    const expectedNames = state.roster.students.map((s) => s.name);

    // 2) 启动 headless Chrome
    //    说明：--no-sandbox 仅用于本测试脚本（在受限环境中启动测试用的浏览器进程）。
    //    应用本身打开窗口时不带任何此类参数，走的是用户正常的 Chrome。
    chrome = spawn(
      CHROME,
      [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-breakpad',
        '--disable-crash-reporter',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--disable-features=Translate,MediaRouter,OptimizationHints',
        `--remote-debugging-port=${DEBUG_PORT}`,
        `--user-data-dir=${PROFILE_DIR}`,
        '--window-size=1500,1000',
        baseUrl,
      ],
      { stdio: 'ignore' }
    );

    const target = await (async () => {
      const start = Date.now();
      while (Date.now() - start < 20000) {
        try {
          const list = await fetchJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
          const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
          if (page) return page;
        } catch {
          /* 还没起来 */
        }
        await sleep(200);
      }
      throw new Error('无法连接 Chrome 调试端口');
    })();

    cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    await cdp.send('Log.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1500,
      height: 1000,
      deviceScaleFactor: 2,
      mobile: false,
    });

    // ---------------------------------------------------------- 渲染
    await cdp.waitFor("document.querySelectorAll('.card').length > 0", 15000, '卡片渲染');

    const rendered = await cdp.eval(`
      const names = [...document.querySelectorAll('.card .card-name')].map((el) => el.textContent);
      return { count: names.length, names };
    `);
    check(`界面渲染出全部 ${total} 张卡片`, rendered.count === total, rendered.count);
    equal('卡片姓名与花名册完全一致且顺序一致', rendered.names, expectedNames);
    check(
      '每张卡片都显示姓名',
      await cdp.eval(`return [...document.querySelectorAll('.card')].every((c) => c.querySelector('.card-name').textContent.trim() !== '');`)
    );
    equal(
      '初始状态没有“已填写”标记',
      await cdp.eval(`return { edited: document.querySelectorAll('.card.edited').length, stat: document.getElementById('statLine').textContent };`),
      { edited: 0, stat: `已填写 0 / ${total}` }
    );
    equal(
      '顶部显示花名册来源与人数',
      await cdp.eval(`return document.getElementById('rosterInfo').textContent.includes('${total} 名学生');`),
      true
    );

    await cdp.screenshot(path.join(SHOT_DIR, '01-卡片-中.png'));

    // ---------------------------------------------------------- 卡片大小
    const sizes = {};
    for (const size of ['small', 'medium', 'large']) {
      await cdp.eval(`document.querySelector('#sizeGroup button[data-size="${size}"]').click(); return true;`);
      await sleep(120);
      sizes[size] = await cdp.eval(`
        const grid = document.getElementById('grid');
        const card = document.querySelector('.card');
        const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').filter((v) => v !== '').length;
        return { width: Math.round(card.getBoundingClientRect().width), cols, dataSize: grid.dataset.size };
      `);
      await cdp.screenshot(path.join(SHOT_DIR, `02-卡片-${size}.png`));
    }
    check('卡片大小：小 < 中 < 大', sizes.small.width < sizes.medium.width && sizes.medium.width < sizes.large.width, sizes);
    check('卡片越小同屏列数越多', sizes.small.cols > sizes.large.cols, sizes);
    check('卡片大小切换后仍显示全部卡片', (await cdp.eval(`return document.querySelectorAll('.card').length;`)) === total);

    // 小尺寸下展开卡片（验证跨列后输入区域仍然可用）
    await cdp.eval(`
      document.querySelector('#sizeGroup button[data-size="small"]').click();
      document.querySelector('.card[data-index="0"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return true;
    `);
    await sleep(150);
    const smallExpanded = await cdp.eval(`
      const card = document.querySelector('.card[data-index="0"]');
      const ta = card.querySelector('textarea');
      const radios = [...card.querySelectorAll('.radio-row label')];
      return {
        editorWidth: Math.round(ta.getBoundingClientRect().width),
        textareaVisible: ta.getBoundingClientRect().height > 0,
        radiosInline: radios.every((r) => r.getBoundingClientRect().width > 0),
      };
    `);
    check('小尺寸展开后输入框宽度足够（> 180px）', smallExpanded.editorWidth > 180, smallExpanded);
    check('小尺寸展开后单选按钮仍可见', smallExpanded.radiosInline, smallExpanded);
    await cdp.screenshot(path.join(SHOT_DIR, '02b-小尺寸-展开.png'));
    await cdp.eval(`
      document.querySelector('.card[data-index="0"] .link-btn').click();
      document.querySelector('#sizeGroup button[data-size="medium"]').click();
      return true;
    `);
    await sleep(120);

    // ---------------------------------------------------------- 双击展开
    equal(
      '初始为收起状态',
      await cdp.eval(`return { expanded: document.querySelectorAll('.card.expanded').length, editorVisible: document.querySelector('.card .card-editor').getBoundingClientRect().height > 0 };`),
      { expanded: 0, editorVisible: false }
    );

    await cdp.eval(`
      const card = document.querySelector('.card[data-index="0"]');
      card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return true;
    `);
    await sleep(150);
    equal(
      '双击后卡片展开并显示编辑区',
      await cdp.eval(`
        const card = document.querySelector('.card[data-index="0"]');
        const editor = card.querySelector('.card-editor');
        return {
          expanded: card.classList.contains('expanded'),
          visible: editor.getBoundingClientRect().height > 0,
          focused: document.activeElement === card.querySelector('textarea'),
          placeholder: card.querySelector('textarea').placeholder,
          radios: card.querySelectorAll('input[type=radio]').length,
          makeupTitle: [...card.querySelectorAll('.field-label')].map((e) => e.textContent).includes('是否补假？'),
        };
      `),
      { expanded: true, visible: true, focused: true, placeholder: '请填入请假理由……', radios: 2, makeupTitle: true }
    );

    equal(
      '编辑区内双击不会收起卡片',
      await cdp.eval(`
        const card = document.querySelector('.card[data-index="0"]');
        card.querySelector('textarea').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        return card.classList.contains('expanded');
      `),
      true
    );

    // ---------------------------------------------------------- 填写内容
    const reason1 = '身体不适，需要休息';
    await cdp.eval(`
      const card = document.querySelector('.card[data-index="0"]');
      const ta = card.querySelector('textarea');
      ta.value = ${JSON.stringify(reason1)};
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    `);
    await sleep(100);
    equal(
      '填写理由后出现“已填写”状态与预览',
      await cdp.eval(`
        const card = document.querySelector('.card[data-index="0"]');
        return {
          edited: card.classList.contains('edited'),
          badge: !card.querySelector('.badge').hidden,
          preview: card.querySelector('.card-preview').textContent,
          stat: document.getElementById('statLine').textContent,
        };
      `),
      { edited: true, badge: true, preview: '身体不适，需要休息 · 补假未选', stat: `已填写 1 / ${total}` }
    );

    // 单选：先选“是”，再选“否”，同一学生只能有一个结果
    await cdp.eval(`document.querySelector('.card[data-index="0"] input[value="yes"]').click(); return true;`);
    await sleep(80);
    equal(
      '选择“是”后只有一个选中项',
      await cdp.eval(`
        const card = document.querySelector('.card[data-index="0"]');
        return { checked: [...card.querySelectorAll('input[type=radio]')].filter((r) => r.checked).map((r) => r.value), preview: card.querySelector('.card-preview').textContent };
      `),
      { checked: ['yes'], preview: '身体不适，需要休息 · 补假：是' }
    );
    await cdp.eval(`document.querySelector('.card[data-index="0"] input[value="no"]').click(); return true;`);
    await sleep(80);
    equal(
      '改选“否”后仍只有一个选中项',
      await cdp.eval(`
        const card = document.querySelector('.card[data-index="0"]');
        return { checked: [...card.querySelectorAll('input[type=radio]')].filter((r) => r.checked).map((r) => r.value), preview: card.querySelector('.card-preview').textContent };
      `),
      { checked: ['no'], preview: '身体不适，需要休息 · 补假：否' }
    );

    // 第二位学生：包含逗号、引号、换行（考验 CSV 转义与剪切板格式）
    const reason2 = '参加考试，需要"提前"离校\n并复诊';
    await cdp.eval(`
      const card = document.querySelector('.card[data-index="1"]');
      card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      const ta = card.querySelector('textarea');
      ta.value = ${JSON.stringify(reason2)};
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      card.querySelector('input[value="yes"]').click();
      return true;
    `);
    await sleep(120);
    equal('已填写人数统计正确', await cdp.eval(`return document.getElementById('statLine').textContent;`), `已填写 2 / ${total}`);

    // 收起再展开，内容仍然保留（可继续修改）
    await cdp.eval(`
      const card = document.querySelector('.card[data-index="1"]');
      card.querySelector('.link-btn').click();
      return true;
    `);
    await sleep(100);
    check('点击“收起”后编辑区隐藏但内容保留', await cdp.eval(`
      const card = document.querySelector('.card[data-index="1"]');
      return card.classList.contains('expanded') === false && card.querySelector('textarea').value === ${JSON.stringify(reason2)};
    `));
    await cdp.eval(`
      document.querySelector('.card[data-index="1"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return true;
    `);
    await sleep(100);
    check('重新双击展开后仍可继续修改', await cdp.eval(`
      const card = document.querySelector('.card[data-index="1"]');
      return card.classList.contains('expanded') && card.querySelector('textarea').value === ${JSON.stringify(reason2)} && card.querySelector('input[value="yes"]').checked;
    `));

    await cdp.screenshot(path.join(SHOT_DIR, '03-填写后.png'));

    // ---------------------------------------------------------- 导出弹窗
    await cdp.eval(`document.getElementById('exportBtn').click(); return true;`);
    await sleep(150);
    equal(
      '点击“导出”后弹出浮窗，含两个选项',
      await cdp.eval(`
        const modal = document.getElementById('modalBackdrop');
        return {
          visible: !modal.hidden,
          summary: document.getElementById('modalSummary').textContent,
          options: [document.getElementById('copyBtn').textContent.includes('复制到剪切板'), document.getElementById('copyCsvBtn').textContent.includes('输出 CSV')],
        };
      `),
      {
        visible: true,
        summary:
          `共 ${total} 名学生，已填写 2 名。导出只保留这 2 名请假的学生的信息。首行标题：${state.exportTitle}。CSV 保存到：${EXPORT_DIR}。`,
        options: [true, true],
      }
    );
    equal(
      '导出前“在访达中显示”按钮不可见（hidden 生效）',
      await cdp.eval(`
        const btn = document.getElementById('revealBtn');
        const rect = btn.getBoundingClientRect();
        return { hidden: btn.hidden, width: Math.round(rect.width), height: Math.round(rect.height) };
      `),
      { hidden: true, width: 0, height: 0 }
    );
    await cdp.screenshot(path.join(SHOT_DIR, '04-导出弹窗.png'));

    // ---------------------------------------------------------- 复制到剪切板
    // 等一次导出请求真正结束：状态已变成终态（success/error），且按钮恢复可用。
    // 不能只匹配状态文字——进行中的提示（如“正在复制并写出 CSV……”）也会含 “CSV”。
    async function clickAndWait(buttonId, timeoutMs = 20000) {
      await cdp.eval(`document.getElementById('${buttonId}').click(); return true;`);
      await cdp.waitFor(
        `(() => {
           const status = document.getElementById('modalStatus');
           const finished = status.classList.contains('success') || status.classList.contains('error');
           return finished && !document.getElementById('${buttonId}').disabled;
         })()`,
        timeoutMs,
        `${buttonId} 请求结束`
      );
    }

    const listCsv = () => fs.readdirSync(EXPORT_DIR).filter((f) => f.endsWith('.csv')).sort();

    // 等 CSV 文件真的落盘（最终结果的硬证据）
    async function waitForCsvCount(expected, label, timeoutMs = 20000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (listCsv().length >= expected) return;
        await sleep(100);
      }
      throw new Error(`等待超时：${label}（期望至少 ${expected} 个 CSV，实际 ${listCsv().length} 个）`);
    }

    await clickAndWait('copyBtn');
    const copyStatus = await cdp.eval(`return document.getElementById('modalStatus').textContent;`);
    check('复制成功提示为 2 行（只有请假的学生）', copyStatus.includes('已复制 2 行'), copyStatus);

    const clipboard = execFileSync('/usr/bin/pbpaste', [], { encoding: 'utf8' });
    const clipLines = clipboard.split('\n');
    equal('剪切板第一行是导出标题', clipLines[0], state.exportTitle);
    equal('剪切板第二行为表头（Tab 分隔）', clipLines[1], '姓名\t请假理由\t是否补假');
    equal('剪切板只含标题 + 表头 + 2 名请假学生', clipLines.length, 4);
    equal('剪切板学生行内容正确', clipLines[2], `${expectedNames[0]}\t身体不适，需要休息\t否`);
    equal('剪切板第 4 行（字段内换行已归一，仍是 3 列）', clipLines[3], `${expectedNames[1]}\t参加考试，需要"提前"离校 并复诊\t是`);
    check(
      '剪切板：标题行单独一行，其余每行 3 列',
      clipLines[0].split('\t').length === 1 && clipLines.slice(1).every((l) => l.split('\t').length === 3),
      clipLines.map((l) => l.split('\t').length)
    );
    check(
      '剪切板不再包含未填写请假信息的学生',
      [expectedNames[2], expectedNames[3], expectedNames[expectedNames.length - 1]].every((n) => !clipboard.includes(n)),
      expectedNames[2]
    );

    // ---------------------------------------------------------- 复制并输出 CSV
    // 注意：必须等“请求真正结束”，不能只等状态文字里出现 “CSV” —— 进行中的提示
    // “正在复制并写出 CSV……” 也含这两个字，会把断言抢跑在写文件之前（本测试早期版本的竞态）。
    await clickAndWait('copyCsvBtn');
    await waitForCsvCount(1, '第 1 个 CSV 文件写出');
    const csvStatus = await cdp.eval(`return document.getElementById('modalStatus').textContent;`);
    check('CSV 导出成功后提示保存路径', csvStatus.includes('CSV') && csvStatus.includes(EXPORT_DIR), csvStatus);
    check('CSV 导出后出现“在访达中显示”按钮', await cdp.eval(`
      const btn = document.getElementById('revealBtn');
      return !btn.hidden && btn.getBoundingClientRect().height > 0;
    `));

    const firstFiles = listCsv();
    equal('测试目录里出现 1 个 CSV 文件', firstFiles.length, 1);
    check('CSV 文件名包含“请假登记”', firstFiles[0].startsWith('请假登记-'), firstFiles[0]);

    const csvPath = path.join(EXPORT_DIR, firstFiles[0]);
    const csvBuffer = fs.readFileSync(csvPath);
    equal('CSV 以 UTF-8 BOM 开头', csvBuffer.subarray(0, 3).toString('hex'), 'efbbbf');
    const csvText = csvBuffer.toString('utf8');
    const csvLines = csvText.slice(1).split('\r\n');
    equal('CSV 第一行是导出标题', csvLines[0], state.exportTitle);
    equal('CSV 第二行为表头', csvLines[1], '姓名,请假理由,是否补假');
    equal('CSV 只含标题 + 表头 + 2 名学生 + 末尾换行', csvLines.length, 5);
    equal('CSV 学生行正确', csvLines[2], `${expectedNames[0]},身体不适，需要休息,否`);
    equal('CSV 正确转义逗号与引号', csvLines[3], `${expectedNames[1]},"参加考试，需要""提前""离校\n并复诊",是`);
    check(
      'CSV 不再包含未填写请假信息的学生',
      [expectedNames[2], expectedNames[3], expectedNames[expectedNames.length - 1]].every((n) => !csvText.includes(n)),
      expectedNames[2]
    );
    check('CSV 包含两名请假学生的姓名', expectedNames.slice(0, 2).every((n) => csvText.includes(n)));

    // CSV 能被重新解析回来（格式合法）
    const { parseDelimited } = require('../lib/delimited');
    const reparsed = parseDelimited(csvText.slice(1).replace(/\r\n$/, ''), ',');
    equal('CSV 可被重新解析为 标题 + 表头 + 2 行', reparsed.length, 4);
    equal('CSV 解析后标题单独一行', reparsed[0], [state.exportTitle]);
    equal('CSV 解析后字段内换行保持完整', reparsed[3][1], reason2);
    equal('CSV 解析后表头与学生行都是 3 列', reparsed.slice(1).every((r) => r.length === 3), true);

    // ---------------------------------------------------------- 重复导出
    for (let i = 0; i < 3; i += 1) {
      await clickAndWait('copyCsvBtn');
      await waitForCsvCount(i + 2, `第 ${i + 2} 个 CSV 文件写出`);
    }
    const manyFiles = listCsv();
    check('重复导出产生多个 CSV 且不覆盖旧文件', manyFiles.length === 4, manyFiles);
    check('4 个 CSV 文件名互不相同（同秒导出会自动加序号）', new Set(manyFiles).size === 4, manyFiles);
    check(
      '重复导出后每个 CSV 都完整可读',
      manyFiles.every((f) => fs.readFileSync(path.join(EXPORT_DIR, f), 'utf8').split('\r\n').length === 5)
    );

    // ---------------------------------------------------------- 弹窗行为
    await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return true;`);
    await sleep(100);
    check('Esc 可以关闭浮窗', await cdp.eval(`return document.getElementById('modalBackdrop').hidden;`));
    await cdp.eval(`document.getElementById('exportBtn').click(); return true;`);
    await sleep(80);
    await cdp.eval(`document.getElementById('modalBackdrop').click(); return true;`);
    await sleep(80);
    check('点击浮窗外部可以关闭', await cdp.eval(`return document.getElementById('modalBackdrop').hidden;`));

    // ---------------------------------------------------------- 隐私 / 无持久化 / 无外部请求
    const requests = cdp.events.filter((e) => e.method === 'Network.requestWillBeSent').map((e) => e.params.request.url);
    check(
      '所有网络请求都只访问本机服务（无任何外部请求）',
      requests.length > 0 && requests.every((u) => u.startsWith(baseUrl) || u.startsWith('data:')),
      requests.filter((u) => !u.startsWith(baseUrl) && !u.startsWith('data:'))
    );
    equal(
      '没有写入任何本地持久化数据（localStorage / cookie 为空）',
      await cdp.eval(`return { local: Object.keys(localStorage).length, session: Object.keys(sessionStorage).length, cookie: document.cookie };`),
      { local: 0, session: 0, cookie: '' }
    );

    const pageErrors = cdp.events
      .filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'))
      .map((e) => JSON.stringify(e.params).slice(0, 300));
    equal('页面无 JavaScript 报错', pageErrors, []);

    // ---------------------------------------------------------- 刷新后数据不保留（符合“不做持久化”）
    await cdp.send('Page.reload');
    await cdp.waitFor("document.querySelectorAll('.card').length > 0", 15000, '刷新后重新渲染');
    equal(
      '刷新后回到初始状态（填写内容不持久化）',
      await cdp.eval(`return { edited: document.querySelectorAll('.card.edited').length, stat: document.getElementById('statLine').textContent, count: document.querySelectorAll('.card').length };`),
      { edited: 0, stat: `已填写 0 / ${total}`, count: total }
    );

    // ---------------------------------------------------------- 一个人都没填写时的导出行为
    await cdp.eval(`document.getElementById('exportBtn').click(); return true;`);
    await sleep(120);
    check(
      '无人填写时弹窗给出提示',
      await cdp.eval(`return document.getElementById('modalSummary').textContent.includes('目前还没有人填写请假信息');`),
      await cdp.eval(`return document.getElementById('modalSummary').textContent;`)
    );

    await clickAndWait('copyBtn');
    check(
      '无人填写时“复制到剪切板”给出明确错误（不静默失败）',
      (await cdp.eval(`return document.getElementById('modalStatus').textContent;`)).includes('没有'),
      await cdp.eval(`return document.getElementById('modalStatus').textContent;`)
    );

    const filesBeforeEmpty = new Set(listCsv());
    await clickAndWait('copyCsvBtn');
    await waitForCsvCount(filesBeforeEmpty.size + 1, '无人填写时的 CSV 写出');
    const newFiles = listCsv().filter((f) => !filesBeforeEmpty.has(f));
    equal('无人填写时仍可导出 CSV（新增 1 个文件）', newFiles.length, 1);
    const emptyCsv = fs.readFileSync(path.join(EXPORT_DIR, newFiles[0]), 'utf8');
    equal('空的 CSV 只有标题与表头', emptyCsv, `\uFEFF${state.exportTitle}\r\n姓名,请假理由,是否补假\r\n`);
  } finally {
    if (cdp) {
      try {
        cdp.ws.close();
      } catch {
        /* ignore */
      }
    }
    if (chrome && !chrome.killed) chrome.kill('SIGKILL');
    if (server && !server.killed) server.kill('SIGTERM');
    await sleep(300);
    fs.rmSync(E2E_DIR, { recursive: true, force: true });
  }

  process.stdout.write(`\n端到端测试：${results.length - failures} 项通过，${failures} 项失败\n`);
  process.stdout.write(`截图目录：${SHOT_DIR}\n`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  process.stdout.write(`\n端到端测试异常终止：${err.stack || err.message}\n`);
  process.exitCode = 1;
});

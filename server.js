'use strict';

/**
 * 班级请假登记 —— 本地服务（零第三方依赖）
 *
 * 仅监听 127.0.0.1（本机回环地址），不对外提供任何服务、不发起任何外部网络请求。
 * 花名册只从本机磁盘读取；登记的请假信息只存在于内存中，关闭程序即丢失。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { resolveRoster, RosterError, defaultSearchDirs } = require('./lib/roster');
const {
  normalizeRecords,
  selectLeaveRecords,
  buildTsv,
  writeCsv,
  defaultExportDir,
  isInsideExportDir,
  DEFAULT_TITLE,
} = require('./lib/export');
const { writeClipboard } = require('./lib/clipboard');

const APP_DIR = __dirname;
const WEB_DIR = path.join(APP_DIR, 'web');
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** 可选的本地配置文件名（放在项目根目录，已被 .gitignore 排除，不会进入版本库） */
const LOCAL_CONFIG_FILE = 'local-config.json';

/**
 * 读取本地配置，用于在不把班级名写进代码/仓库的前提下自定义导出标题。
 * 格式：{"title": "本〇〇班"}
 * 读取失败只提示、不中断。
 */
function readLocalConfig(dir = APP_DIR) {
  const file = path.join(dir, LOCAL_CONFIG_FILE);
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('内容应为 JSON 对象，例如 {"title": "本〇〇班"}');
    }
    return data;
  } catch (err) {
    log(`本地配置 ${LOCAL_CONFIG_FILE} 无法使用，已忽略：${err.message}`);
    return null;
  }
}

/** 解析导出标题及其来源：--title > 环境变量 > 本地配置 > 中性默认值 */
function resolveTitle(options, dir = APP_DIR) {
  const localConfig = readLocalConfig(dir);
  const localTitle = localConfig && typeof localConfig.title === 'string' ? localConfig.title.trim() : '';

  if (options.title) return { title: String(options.title), source: '--title 参数' };
  if (process.env.CLASS_LEAVE_TITLE) {
    return { title: process.env.CLASS_LEAVE_TITLE, source: '环境变量 CLASS_LEAVE_TITLE' };
  }
  if (localTitle) return { title: localTitle, source: LOCAL_CONFIG_FILE };
  return { title: DEFAULT_TITLE, source: '默认值' };
}

function parseArgs(argv) {
  const options = { port: 0, open: true, rosterPath: null, exportDir: null, title: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--roster' || arg === '-r') options.rosterPath = argv[++i] || null;
    else if (arg === '--port' || arg === '-p') options.port = Number(argv[++i]) || 0;
    else if (arg === '--export-dir') options.exportDir = argv[++i] || null;
    else if (arg === '--title') options.title = argv[++i] || null;
    else if (arg === '--no-open') options.open = false;
    else if (arg === '--help' || arg === '-h') options.help = true;
  }
  return options;
}

function printHelp() {
  process.stdout.write(
    [
      '班级请假登记 —— 本地 macOS 应用',
      '',
      '用法：node server.js [选项]',
      '',
      '  -r, --roster <文件>     指定花名册文件（默认自动在当前工作文件夹中查找）',
      '  -p, --port <端口>       指定端口（默认自动选择空闲端口）',
      '      --export-dir <目录> 指定导出目录（默认项目根目录）',
      '      --title <文本>      指定导出文本的第一行标题（默认取 local-config.json，否则为本班请假登记）',
      '      --no-open           启动后不自动打开窗口',
      '  -h, --help              显示本帮助',
      '',
    ].join('\n')
  );
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function securityHeaders(extra = {}) {
  return {
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    ...extra,
  };
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, securityHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length }));
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求内容过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', (err) => reject(err));
  });
}

function parseJsonBody(raw) {
  if (!raw || raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('请求内容不是合法的 JSON');
  }
}

function createServer(context) {
  const { appDir, exportDir, title } = context;
  const exportTitle = title === null || title === undefined ? DEFAULT_TITLE : String(title);
  const allowedDirs = defaultSearchDirs(appDir).map((d) => path.resolve(d));

  const isAllowedRosterPath = (candidate) => {
    const resolved = path.resolve(candidate);
    return allowedDirs.some((dir) => resolved === dir || resolved.startsWith(dir + path.sep));
  };

  const state = {
    roster: null,
    error: null,
    errorDetails: null,
    loadedAt: null,
  };

  const loadRoster = (rosterPath) => {
    try {
      const roster = resolveRoster({ appDir, rosterPath: rosterPath || context.rosterPath });
      state.roster = roster;
      state.error = null;
      state.errorDetails = null;
      state.loadedAt = new Date().toISOString();
      log(`已读取花名册：${roster.fileName}（${roster.format}，${roster.studentCount} 名学生）`);
      for (const warning of roster.warnings) log(`提示：${warning}`);
    } catch (err) {
      state.roster = null;
      state.error = err.message;
      state.errorDetails = {
        candidates: err.candidates || [],
        searchDirs: err.searchDirs || allowedDirs,
        ambiguous: Boolean(err.ambiguous),
        failures: err.failures || [],
      };
      log(`读取花名册失败：${err.message}`);
    }
  };

  const server = http.createServer(async (req, res) => {
    try {
      const host = String(req.headers.host || '');
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) {
        sendJson(res, 403, { ok: false, error: '仅允许本机访问' });
        return;
      }

      const url = new URL(req.url, `http://${host}`);
      const pathname = decodeURIComponent(url.pathname);

      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        return serveStatic(res, 'index.html');
      }
      if (req.method === 'GET' && /^\/(styles\.css|app\.js|favicon\.svg)$/.test(pathname)) {
        return serveStatic(res, pathname.slice(1));
      }

      if (req.method === 'GET' && pathname === '/api/state') {
        return sendJson(res, 200, {
          ok: true,
          roster: state.roster,
          error: state.error,
          errorDetails: state.errorDetails,
          loadedAt: state.loadedAt,
          exportDir: exportDir || defaultExportDir(),
          exportTitle,
        });
      }

      if (req.method === 'POST' && pathname === '/api/reload') {
        const body = parseJsonBody(await readBody(req));
        if (body.path) {
          if (!isAllowedRosterPath(body.path)) {
            return sendJson(res, 400, { ok: false, error: '只能选择工作文件夹内的花名册文件' });
          }
          loadRoster(body.path);
        } else {
          loadRoster(null);
        }
        return sendJson(res, 200, {
          ok: !state.error,
          roster: state.roster,
          error: state.error,
          errorDetails: state.errorDetails,
          exportDir: exportDir || defaultExportDir(),
          exportTitle,
        });
      }

      // 导出只保留“请假的人”（填了理由，或选了是否补假）
      if (req.method === 'POST' && pathname === '/api/clipboard') {
        const body = parseJsonBody(await readBody(req));
        const all = normalizeRecords(body.records);
        const records = selectLeaveRecords(all);
        if (records.length === 0) {
          return sendJson(res, 400, { ok: false, error: '目前没有任何学生填写请假信息，没有可复制的内容。' });
        }
        const tsv = buildTsv(records, { title: exportTitle });
        await writeClipboard(tsv);
        return sendJson(res, 200, {
          ok: true,
          rowCount: records.length,
          skipped: all.length - records.length,
          message: `已复制 ${records.length} 行到剪切板（只包含已填写请假信息的学生）`,
        });
      }

      if (req.method === 'POST' && pathname === '/api/export') {
        const body = parseJsonBody(await readBody(req));
        const all = normalizeRecords(body.records);
        const records = selectLeaveRecords(all);
        const tsv = buildTsv(records, { title: exportTitle });
        const csv = writeCsv(records, { dir: exportDir || defaultExportDir(), title: exportTitle });
        let clipboardWarning = null;
        try {
          if (records.length === 0) throw new Error('目前没有任何学生填写请假信息');
          await writeClipboard(tsv);
        } catch (err) {
          clipboardWarning = err.message;
        }
        const scope = records.length === 0
          ? '没有学生填写请假信息，CSV 中只有标题和表头'
          : `只包含 ${records.length} 名已填写请假信息的学生`;
        return sendJson(res, 200, {
          ok: true,
          rowCount: records.length,
          skipped: all.length - records.length,
          csv,
          clipboardWarning,
          message: clipboardWarning
            ? `CSV 已保存到 ${csv.path}（${scope}），但复制到剪切板失败：${clipboardWarning}`
            : `已复制 ${records.length} 行到剪切板，并保存 CSV 到 ${csv.path}（${scope}）`,
        });
      }

      if (req.method === 'POST' && pathname === '/api/reveal') {
        const body = parseJsonBody(await readBody(req));
        const target = String(body.path || '');
        const dir = exportDir || defaultExportDir();
        if (!target || !fs.existsSync(target) || !isInsideExportDir(target, dir)) {
          return sendJson(res, 400, { ok: false, error: '只能打开导出目录中的文件' });
        }
        spawn('/usr/bin/open', ['-R', target], { detached: true, stdio: 'ignore' }).unref();
        return sendJson(res, 200, { ok: true });
      }

      sendJson(res, 404, { ok: false, error: '接口不存在' });
    } catch (err) {
      const status = err instanceof RosterError ? 400 : 500;
      sendJson(res, status, { ok: false, error: err.message || '服务器内部错误' });
    }
  });

  function serveStatic(res, fileName) {
    const full = path.join(WEB_DIR, fileName);
    if (!path.resolve(full).startsWith(path.resolve(WEB_DIR) + path.sep)) {
      sendJson(res, 403, { ok: false, error: '非法路径' });
      return;
    }
    fs.readFile(full, (err, data) => {
      if (err) {
        sendJson(res, 404, { ok: false, error: `找不到文件：${fileName}` });
        return;
      }
      res.writeHead(
        200,
        securityHeaders({
          'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
          'Content-Length': data.length,
        })
      );
      res.end(data);
    });
  }

  server.on('error', () => {});
  return { server, state, loadRoster };
}

function log(message) {
  process.stdout.write(`[班级请假登记] ${message}\n`);
}

/**
 * 用系统默认浏览器打开界面（macOS 自带的 /usr/bin/open）。
 * 不指定、也不依赖任何特定浏览器。
 */
function openWindow(url) {
  const hint = '若没有自动弹出，请手动在浏览器中打开上面的地址';
  try {
    spawn('/usr/bin/open', [url], { detached: true, stdio: 'ignore' }).unref();
    return `已用系统默认浏览器打开界面；${hint}`;
  } catch (err) {
    return `自动打开界面失败（${err.message}），请手动打开上面的地址`;
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const exportDir = options.exportDir ? path.resolve(options.exportDir) : null;
  if (exportDir) process.env.CLASS_LEAVE_EXPORT_DIR = exportDir;

  const { title, source: titleSource } = resolveTitle(options);

  const context = {
    appDir: APP_DIR,
    rosterPath: options.rosterPath ? path.resolve(options.rosterPath) : null,
    exportDir,
    title,
  };

  const { server, state, loadRoster } = createServer(context);
  loadRoster(null);

  server.on('error', (err) => {
    log(`服务启动失败：${err.message}`);
    process.exitCode = 1;
  });

  server.listen(options.port, '127.0.0.1', () => {
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/`;
    log(`界面地址：${url}`);
    log(`导出目录：${exportDir || defaultExportDir()}`);
    log(`导出文本首行标题：${title}（来源：${titleSource}；只导出已填写请假信息的学生）`);
    if (!state.roster) log(`注意：尚未成功读取花名册，请按界面提示处理。`);
    log('按 Control+C 退出程序（关闭后本次填写的数据不会保留）。');
    if (options.open) log(openWindow(url));
  });

  const shutdown = () => {
    log('正在退出……');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) main();

module.exports = { createServer, parseArgs, resolveTitle, readLocalConfig, LOCAL_CONFIG_FILE };

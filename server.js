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

const { resolveRoster, RosterError, defaultSearchDirs } = require('./lib/roster');
const {
  normalizeRecords,
  selectLeaveRecords,
  buildClipboardText,
  writeCsv,
  defaultExportDir,
  isInsideExportDir,
  DEFAULT_TITLE,
} = require('./lib/export');
const { writeClipboard } = require('./lib/clipboard');
const { openUrl, revealPath } = require('./lib/system');
const { parseLeaveCsv, matchRecords } = require('./lib/import');
const { pickCsvFile } = require('./lib/dialog');

const APP_DIR = __dirname;
const WEB_DIR = path.join(APP_DIR, 'web');
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_IMPORT_FILE_BYTES = 8 * 1024 * 1024;
const IMPORT_MAX_BODY_BYTES = Math.ceil((MAX_IMPORT_FILE_BYTES * 4) / 3) + 1024 * 1024;

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

/**
 * 解析导出标题及其来源：
 *   --title > 花名册文件名（自动去掉“副本 / (1)”等） > 环境变量 > 本地配置 > 中性默认值
 * 花名册可以随时重新扫描 / 切换，因此调用方可以每次传入当前花名册的 displayName。
 */
function resolveTitle(options, dir = APP_DIR, rosterName = '') {
  if (options.title) return { title: String(options.title), source: '--title 参数' };
  if (rosterName) return { title: String(rosterName), source: '花名册文件名' };

  const localConfig = readLocalConfig(dir);
  const localTitle = localConfig && typeof localConfig.title === 'string' ? localConfig.title.trim() : '';

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
      '班级请假登记 —— 本地应用（macOS / Windows）',
      '',
      '用法：node server.js [选项]',
      '',
      '  -r, --roster <文件>     指定花名册文件（默认自动在当前工作文件夹中查找）',
      '  -p, --port <端口>       指定端口（默认自动选择空闲端口）',
      '      --export-dir <目录> 指定导出目录（默认项目根目录）',
      '      --title <文本>      覆盖导出文本的第一行标题（默认取当前花名册文件名）',
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
  if (res.writableEnded || res.destroyed) return;
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, securityHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length }));
  res.end(body);
}

function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
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

  /** 每次导出时按“当前花名册”解析标题，重新扫描 / 切换花名册后自动跟着变 */
  const resolveCurrentTitle = () =>
    resolveTitle(
      { title: title === null || title === undefined ? null : String(title) },
      appDir,
      state.roster && state.roster.displayName ? state.roster.displayName : ''
    );

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

  let pickingFile = false;

  /**
   * 统一处理“读取 CSV”的结果：解析 + 与花名册匹配，然后返回给前端。
   * buffer 既可能来自拖拽上传，也可能来自原生文件选择窗口。
   */
  const respondImport = (res, buffer, fileName, sourcePath) => {
    if (!state.roster || !Array.isArray(state.roster.students) || state.roster.students.length === 0) {
      return sendJson(res, 400, { ok: false, error: '尚未成功读取花名册，无法读取 CSV。' });
    }
    if (!buffer || buffer.length === 0) {
      return sendJson(res, 400, { ok: false, error: 'CSV 文件是空的（0 字节）。' });
    }
    if (buffer.length > MAX_IMPORT_FILE_BYTES) {
      return sendJson(res, 400, { ok: false, error: 'CSV 文件过大（超过 8 MB）。' });
    }

    let parsed;
    try {
      parsed = parseLeaveCsv(buffer);
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }

    const report = matchRecords(state.roster.students, parsed.records);
    const warnings = [...parsed.warnings];
    if (report.unmatched.length > 0) {
      const sample = report.unmatched.slice(0, 5).map((item) => item.name).join('、');
      warnings.push(
        `CSV 中有 ${report.unmatched.length} 条记录在花名册里找不到对应学生` +
          `${sample ? `（${sample}${report.unmatched.length > 5 ? ' 等' : ''}）` : ''}。`
      );
    }

    log(`读取 CSV：${fileName}（${parsed.records.length} 条请假记录，匹配 ${report.matched.length} 条）`);
    return sendJson(res, 200, {
      ok: true,
      canceled: false,
      fileName,
      sourcePath,
      encoding: parsed.encoding,
      delimiter: parsed.delimiter,
      totalRecords: parsed.records.length,
      matched: report.matched,
      unmatched: report.unmatched,
      warnings,
      message:
        report.matched.length === 0
          ? `已读取「${fileName}」，但没有可导入的请假记录。`
          : `已从「${fileName}」读取并匹配 ${report.matched.length} 条请假记录。`,
    });
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
          exportTitle: resolveCurrentTitle().title,
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
          exportTitle: resolveCurrentTitle().title,
        });
      }

      if (req.method === 'POST' && (pathname === '/api/clipboard' || pathname === '/api/export')) {
        const body = parseJsonBody(await readBody(req));
        const all = normalizeRecords(body.records);
        const rosterMode = body.mode === 'roster';
        const includeUnfilled = typeof body.includeUnfilled === 'boolean' ? body.includeUnfilled : rosterMode;
        const records = includeUnfilled ? all : selectLeaveRecords(all);
        const emptyMessage = rosterMode ? '当前导出范围没有学生记录' : '目前没有任何学生填写请假信息';
        const options = { title: resolveCurrentTitle().title, dir: exportDir || defaultExportDir() };
        if (rosterMode) {
          options.title = '花名册';
          options.filePrefix = '花名册';
          options.header = ['姓名', ...['text', 'choice'].map((key) => {
            const value = body.headers?.[key];
            return typeof value === 'string' ? value.trim().slice(0, 100) : '';
          })];
        }
        const clipboardText = buildClipboardText(records, options);
        if (pathname === '/api/clipboard') {
          if (records.length === 0) {
            const error = `${emptyMessage}，没有可复制的内容。`;
            return sendJson(res, 400, { ok: false, error });
          }
          await writeClipboard(clipboardText);
          return sendJson(res, 200, {
            ok: true,
            rowCount: records.length,
            skipped: all.length - records.length,
            message: `已复制 ${records.length} 行到剪切板${includeUnfilled || rosterMode ? '' : '（只包含已填写请假信息的学生）'}`,
          });
        }

        const csv = writeCsv(records, options);
        let clipboardWarning = null;
        try {
          if (records.length === 0) {
            throw new Error(emptyMessage);
          }
          await writeClipboard(clipboardText);
        } catch (err) {
          clipboardWarning = err.message;
        }
        let scope = `包含 ${records.length} 名学生`;
        if (records.length === 0) scope = `${emptyMessage}，CSV 中只有标题和表头`;
        else if (!includeUnfilled) scope = `只包含 ${records.length} 名已填写${rosterMode ? '' : '请假信息'}的学生`;
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
        await revealPath(target);
        return sendJson(res, 200, { ok: true });
      }

      // 读取 CSV：浏览器拖拽 / 直接上传（内容以 base64 传输，服务端负责识别编码）
      if (req.method === 'POST' && pathname === '/api/import') {
        const body = parseJsonBody(await readBody(req, IMPORT_MAX_BODY_BYTES));
        let buffer = null;
        if (typeof body.contentBase64 === 'string' && body.contentBase64.trim() !== '') {
          buffer = Buffer.from(body.contentBase64, 'base64');
        } else if (typeof body.content === 'string' && body.content !== '') {
          buffer = Buffer.from(body.content, 'utf8');
        } else {
          return sendJson(res, 400, { ok: false, error: '没有收到 CSV 内容。' });
        }
        const fileName =
          typeof body.fileName === 'string' && body.fileName.trim() !== '' ? body.fileName.trim() : '（上传的 CSV）';
        return respondImport(res, buffer, fileName, null);
      }

      // 读取 CSV：弹出本机原生文件选择窗口，默认打开导出目录（CSV 默认保存位置）
      if (req.method === 'POST' && pathname === '/api/pick-csv') {
        if (!state.roster || !Array.isArray(state.roster.students) || state.roster.students.length === 0) {
          return sendJson(res, 400, { ok: false, error: '尚未成功读取花名册，无法读取 CSV。' });
        }
        if (pickingFile) {
          return sendJson(res, 409, { ok: false, error: '已有一个文件选择窗口打开，请先完成或取消。' });
        }
        const dir = exportDir || defaultExportDir();
        pickingFile = true;
        let picked;
        try {
          picked = await pickCsvFile({ initialDir: dir, title: '选择要读取的 CSV 文件' });
        } finally {
          pickingFile = false;
        }
        if (!picked || !picked.path) {
          return sendJson(res, 200, { ok: true, canceled: true });
        }
        const chosen = path.resolve(picked.path);
        if (!/\.csv$/i.test(chosen)) {
          return sendJson(res, 400, { ok: false, error: '请选择 .csv 文件。' });
        }
        let buffer;
        try {
          const stat = fs.statSync(chosen);
          if (!stat.isFile()) {
            return sendJson(res, 400, { ok: false, error: '选择的路径不是文件。' });
          }
          if (stat.size > MAX_IMPORT_FILE_BYTES) {
            return sendJson(res, 400, { ok: false, error: 'CSV 文件过大（超过 8 MB）。' });
          }
          buffer = fs.readFileSync(chosen);
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: `无法读取文件：${err.message}` });
        }
        return respondImport(res, buffer, path.basename(chosen), chosen);
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
  return { server, state, loadRoster, resolveCurrentTitle };
}

function log(message) {
  process.stdout.write(`[班级请假登记] ${message}\n`);
}

/**
 * 用系统默认浏览器打开界面（跨平台：macOS 用 open，Windows 用 start，其他用 xdg-open）。
 * 不指定、也不依赖任何特定浏览器。
 */
async function openWindow(url) {
  const hint = '若没有自动弹出，请手动在浏览器中打开上面的地址';
  try {
    await openUrl(url);
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

  const context = {
    appDir: APP_DIR,
    rosterPath: options.rosterPath ? path.resolve(options.rosterPath) : null,
    exportDir,
    // 只有显式的 --title 才作为最高优先级；其余标题在导出时按当前花名册动态解析
    title: options.title ? String(options.title) : null,
  };

  const { server, state, loadRoster, resolveCurrentTitle } = createServer(context);
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
    const { title: currentTitle, source: titleSource } = resolveCurrentTitle();
    log(`导出文本首行标题：${currentTitle}（来源：${titleSource}；只导出已填写请假信息的学生）`);
    if (!state.roster) log(`注意：尚未成功读取花名册，请按界面提示处理。`);
    log('按 Control+C 退出程序（关闭后本次填写的数据不会保留）。');
    if (options.open) openWindow(url).then((message) => log(message));
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

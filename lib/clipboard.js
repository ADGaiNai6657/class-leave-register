'use strict';

/**
 * 系统剪切板读写（跨平台，零第三方依赖，不联网）。
 *
 * 只调用操作系统自带的命令，按平台选择：
 *   - macOS ：pbcopy / pbpaste
 *   - Windows：PowerShell 的 Set-Clipboard / Get-Clipboard
 *   - 其他（Linux / BSD 等）：wl-clipboard（wl-copy / wl-paste）或 xclip 或 xsel
 *
 * Windows 下不能直接把中文从标准输入喂给 PowerShell（会按本地代码页解码而乱码），
 * 因此写入时先落一个临时 UTF-8 文件再让 PowerShell 以 UTF-8 读取，读完立即删除；
 * 读取时用 [Console]::Out.Write 输出，避免 PowerShell 额外追加换行。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

const PLATFORM = process.platform;
const MAX_BUFFER = 8 * 1024 * 1024;

/** 统一成字符串；null / undefined 视为空串 */
function toText(text) {
  return String(text === null || text === undefined ? '' : text);
}

function byteLength(text) {
  return Buffer.byteLength(text, 'utf8');
}

// ---------------------------------------------------------------- macOS

function writeClipboardMac(payload) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('/usr/bin/pbcopy', [], { stdio: ['pipe', 'ignore', 'pipe'] });
    } catch (err) {
      reject(new Error(`无法启动系统剪切板命令 pbcopy：${err.message}`));
      return;
    }
    let stderr = '';
    let settled = false;
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(new Error(`写入剪切板失败：${err.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve({ ok: true, bytes: byteLength(payload) });
      else reject(new Error(`写入剪切板失败（pbcopy 退出码 ${code}）${stderr ? `：${stderr.trim()}` : ''}`));
    });
    child.stdin.on('error', () => {
      /* 进程提前退出时忽略 stdin 报错，由 close 事件统一处理 */
    });
    child.stdin.end(Buffer.from(payload, 'utf8'));
  });
}

function readClipboardMac() {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/pbpaste', { encoding: 'utf8', maxBuffer: MAX_BUFFER }, (err, stdout) => {
      if (err) reject(new Error(`读取剪切板失败：${err.message}`));
      else resolve(stdout);
    });
  });
}

// ---------------------------------------------------------------- Windows

function writeClipboardWindows(payload) {
  return new Promise((resolve, reject) => {
    const tmp = path.join(os.tmpdir(), `class-leave-clipboard-${process.pid}-${Date.now()}.txt`);
    try {
      fs.writeFileSync(tmp, payload, { encoding: 'utf8' });
    } catch (err) {
      reject(new Error(`写入剪切板失败：无法创建临时文件（${err.message}）`));
      return;
    }
    const escaped = tmp.replace(/'/g, "''");
    const script = `Set-Clipboard -Value (Get-Content -LiteralPath '${escaped}' -Raw -Encoding UTF8)`;
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', windowsHide: true, maxBuffer: MAX_BUFFER },
      (err, _stdout, stderr) => {
        fs.unlink(tmp, () => {});
        if (err) {
          reject(new Error(`写入剪切板失败（PowerShell）${stderr ? `：${String(stderr).trim()}` : `：${err.message}`}`));
          return;
        }
        resolve({ ok: true, bytes: byteLength(payload) });
      }
    );
  });
}

function readClipboardWindows() {
  return new Promise((resolve, reject) => {
    const script = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Console]::Out.Write((Get-Clipboard -Raw))';
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', windowsHide: true, maxBuffer: MAX_BUFFER },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`读取剪切板失败（PowerShell）${stderr ? `：${String(stderr).trim()}` : `：${err.message}`}`));
          return;
        }
        resolve(stdout === null || stdout === undefined ? '' : String(stdout));
      }
    );
  });
}

// ---------------------------------------------------------------- Linux / BSD

function writeClipboardNix(payload) {
  const commands = [
    { file: 'wl-copy', args: [] },
    { file: 'xclip', args: ['-selection', 'clipboard'] },
    { file: 'xsel', args: ['--clipboard', '--input'] },
  ];
  return new Promise((resolve, reject) => {
    let index = 0;
    const attempt = () => {
      if (index >= commands.length) {
        reject(new Error('未找到可用的剪切板命令，请安装 wl-clipboard、xclip 或 xsel 后重试'));
        return;
      }
      const { file, args } = commands[index++];
      let child;
      try {
        child = spawn(file, args, { stdio: ['pipe', 'ignore', 'pipe'] });
      } catch (err) {
        reject(new Error(`无法启动剪切板命令 ${file}：${err.message}`));
        return;
      }
      let stderr = '';
      let settled = false;
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('error', (err) => {
        if (settled) return;
        if (err.code === 'ENOENT') {
          settled = true;
          attempt();
          return;
        }
        settled = true;
        reject(new Error(`写入剪切板失败：${err.message}`));
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        if (code === 0) resolve({ ok: true, bytes: byteLength(payload) });
        else reject(new Error(`写入剪切板失败（${file} 退出码 ${code}）${stderr ? `：${stderr.trim()}` : ''}`));
      });
      child.stdin.on('error', () => {});
      child.stdin.end(Buffer.from(payload, 'utf8'));
    };
    attempt();
  });
}

function readClipboardNix() {
  const commands = [
    { file: 'wl-paste', args: ['--no-newline'] },
    { file: 'xclip', args: ['-selection', 'clipboard', '-o'] },
    { file: 'xsel', args: ['--clipboard', '--output'] },
  ];
  return new Promise((resolve, reject) => {
    let index = 0;
    const attempt = () => {
      if (index >= commands.length) {
        reject(new Error('未找到可用的剪切板命令，请安装 wl-clipboard、xclip 或 xsel 后重试'));
        return;
      }
      const { file, args } = commands[index++];
      execFile(file, args, { encoding: 'utf8', maxBuffer: MAX_BUFFER }, (err, stdout) => {
        if (err) {
          if (err.code === 'ENOENT') {
            attempt();
            return;
          }
          reject(new Error(`读取剪切板失败（${file}）：${err.message}`));
          return;
        }
        resolve(stdout === null || stdout === undefined ? '' : String(stdout));
      });
    };
    attempt();
  });
}

// ---------------------------------------------------------------- 对外接口

/**
 * 把文本写入系统剪切板。
 * @param {string} text
 * @returns {Promise<{ok:true, bytes:number}>}
 */
function writeClipboard(text) {
  const payload = toText(text);
  if (payload === '') {
    return Promise.reject(new Error('剪切板内容为空，未执行复制'));
  }
  if (PLATFORM === 'darwin') return writeClipboardMac(payload);
  if (PLATFORM === 'win32') return writeClipboardWindows(payload);
  return writeClipboardNix(payload);
}

/**
 * 读取系统剪切板文本（主要用于自动化测试校验）。
 * @returns {Promise<string>}
 */
function readClipboard() {
  if (PLATFORM === 'darwin') return readClipboardMac();
  if (PLATFORM === 'win32') return readClipboardWindows();
  return readClipboardNix();
}

module.exports = { writeClipboard, readClipboard };

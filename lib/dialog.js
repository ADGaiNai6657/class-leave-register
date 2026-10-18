'use strict';

/**
 * 跨平台原生文件选择窗口（只用于读取 CSV）。
 *
 * 浏览器出于安全限制，无法把 <input type="file"> 的默认目录指向任意路径；
 * 因此这里由本地服务调用各系统自带能力弹出原生窗口，并把“默认打开路径”
 * 设为导出目录（即 CSV 默认保存的位置）。
 *
 *   - macOS ：osascript 的 choose file
 *   - Windows：PowerShell + System.Windows.Forms.OpenFileDialog
 *   - 其他（Linux / BSD 等）：zenity 或 kdialog
 *
 * 只弹窗、只返回用户选中的路径；读取与解析由调用方负责。不联网。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const PLATFORM = process.platform;
const MAX_BUFFER = 4 * 1024 * 1024;

/** 默认目录不存在时退回用户主目录，避免部分平台直接报错 */
function normalizeDir(dir) {
  const candidate = dir ? path.resolve(String(dir)) : '';
  try {
    if (candidate && fs.statSync(candidate).isDirectory()) return candidate;
  } catch {
    /* 继续用主目录 */
  }
  return os.homedir();
}

function asAppleString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function asPowerShellString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// ---------------------------------------------------------------- macOS

function pickMac(initialDir, title) {
  return new Promise((resolve, reject) => {
    const script =
      `POSIX path of (choose file with prompt ${asAppleString(title)} ` +
      `default location (POSIX file ${asAppleString(initialDir)}))`;
    execFile('osascript', ['-e', script], { encoding: 'utf8', maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      if (err) {
        const message = String(stderr || err.message || '');
        // 用户取消时 osascript 返回 -128（User canceled）
        if (/User canceled|-128/i.test(message)) {
          resolve({ path: null });
          return;
        }
        reject(new Error(`打开文件选择窗口失败：${message.trim()}`));
        return;
      }
      const chosen = String(stdout === null || stdout === undefined ? '' : stdout).trim();
      resolve({ path: chosen || null });
    });
  });
}

// ---------------------------------------------------------------- Windows

function pickWindows(initialDir, title) {
  return new Promise((resolve, reject) => {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
      '$d = New-Object System.Windows.Forms.OpenFileDialog',
      `$d.Title = ${asPowerShellString(title)}`,
      '$d.InitialDirectory = $env:CLASS_LEAVE_DIALOG_DIR',
      "$d.Filter = 'CSV 文件 (*.csv)|*.csv|所有文件 (*.*)|*.*'",
      '$d.CheckFileExists = $true',
      '$d.Multiselect = $false',
      '$d.RestoreDirectory = $true',
      'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
      '  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      '  [Console]::Out.Write($d.FileName)',
      '}',
    ].join('; ');

    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
      {
        env: { ...process.env, CLASS_LEAVE_DIALOG_DIR: initialDir },
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: MAX_BUFFER,
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`打开文件选择窗口失败：${String(stderr || err.message || '').trim()}`));
          return;
        }
        const chosen = String(stdout === null || stdout === undefined ? '' : stdout).trim();
        resolve({ path: chosen || null });
      }
    );
  });
}

// ---------------------------------------------------------------- Linux / BSD

function pickNix(initialDir, title) {
  const dirWithSep = initialDir.endsWith(path.sep) ? initialDir : initialDir + path.sep;
  const commands = [
    {
      file: 'zenity',
      args: [
        '--file-selection',
        `--title=${title}`,
        `--filename=${dirWithSep}`,
        '--file-filter=CSV 文件 | *.csv',
        '--file-filter=所有文件 | *',
      ],
    },
    {
      file: 'kdialog',
      args: ['--title', title, '--getopenfilename', initialDir, 'CSV 文件 (*.csv)'],
    },
  ];

  return new Promise((resolve, reject) => {
    let index = 0;
    const attempt = () => {
      if (index >= commands.length) {
        reject(new Error('未找到可用的文件选择命令（请安装 zenity 或 kdialog）'));
        return;
      }
      const { file, args } = commands[index++];
      execFile(file, args, { encoding: 'utf8', maxBuffer: MAX_BUFFER }, (err, stdout) => {
        if (err) {
          if (err.code === 'ENOENT') {
            attempt();
            return;
          }
          // zenity / kdialog 在用户取消时返回非 0 且没有输出
          const chosen = String(stdout === null || stdout === undefined ? '' : stdout).trim();
          if (chosen === '') {
            resolve({ path: null });
            return;
          }
          reject(new Error(`打开文件选择窗口失败：${err.message}`));
          return;
        }
        const chosen = String(stdout === null || stdout === undefined ? '' : stdout).trim();
        resolve({ path: chosen || null });
      });
    };
    attempt();
  });
}

// ---------------------------------------------------------------- 对外接口

/**
 * 弹出原生“选择 CSV”窗口。
 * @param {{initialDir?:string, title?:string}} options
 * @returns {Promise<{path: string|null}>} path 为 null 表示用户取消
 */
function pickCsvFile(options = {}) {
  const initialDir = normalizeDir(options.initialDir);
  const title = String(options.title || '选择要读取的 CSV 文件');
  if (PLATFORM === 'darwin') return pickMac(initialDir, title);
  if (PLATFORM === 'win32') return pickWindows(initialDir, title);
  return pickNix(initialDir, title);
}

module.exports = { pickCsvFile, PLATFORM };

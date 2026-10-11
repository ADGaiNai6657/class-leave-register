'use strict';

/**
 * 跨平台系统集成：用系统默认程序打开网址、在文件管理器中定位文件。
 *
 * 只调用操作系统自带的命令，不依赖任何第三方库，也不联网：
 *   - macOS ：/usr/bin/open（-R 用于在访达中定位）
 *   - Windows：cmd 的 start（打开网址）、explorer 的 /select,（在资源管理器中定位）
 *   - 其他（Linux / BSD 等）：xdg-open
 *
 * 这些命令都是「分离进程」：启动后不等待、不占用控制台，程序退出时也不会被牵连。
 */

const path = require('path');
const { spawn } = require('child_process');

const PLATFORM = process.platform;

/**
 * 以「分离进程」方式启动命令：只要进程成功创建就 resolve 并解除引用。
 * 不等待命令退出（打开浏览器 / 文件管理器都不该阻塞程序）。
 */
function spawnDetached(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true, ...options });
    } catch (err) {
      reject(new Error(`无法启动命令 ${command}：${err.message}`));
      return;
    }
    let settled = false;
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      reject(new Error(`无法启动命令 ${command}：${err.message}`));
    });
    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve();
    });
  });
}

/**
 * 用系统默认浏览器打开网址。
 * @param {string} url
 * @returns {Promise<void>}
 */
function openUrl(url) {
  const target = String(url === null || url === undefined ? '' : url);
  if (target === '') return Promise.reject(new Error('打开界面失败：地址为空'));
  if (PLATFORM === 'darwin') return spawnDetached('/usr/bin/open', [target]);
  if (PLATFORM === 'win32') return spawnDetached('cmd', ['/c', 'start', '', target]);
  return spawnDetached('xdg-open', [target]);
}

/**
 * 在系统文件管理器中定位（高亮）文件。
 * Linux 等没有统一「定位」方式的平台，退化为打开其所在目录。
 * @param {string} filePath
 * @returns {Promise<void>}
 */
function revealPath(filePath) {
  const target = String(filePath === null || filePath === undefined ? '' : filePath);
  if (target === '') return Promise.reject(new Error('定位文件失败：路径为空'));
  if (PLATFORM === 'darwin') return spawnDetached('/usr/bin/open', ['-R', target]);
  if (PLATFORM === 'win32') return spawnDetached('explorer.exe', [`/select,${target}`]);
  return spawnDetached('xdg-open', [path.dirname(target)]);
}

module.exports = { openUrl, revealPath, PLATFORM };

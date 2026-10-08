'use strict';

/**
 * macOS 系统剪切板写入。
 * 使用 macOS 自带的 /usr/bin/pbcopy，不依赖任何第三方库，也不联网。
 */

const { spawn } = require('child_process');

const PBCOPY = '/usr/bin/pbcopy';

function writeClipboard(text) {
  return new Promise((resolve, reject) => {
    const payload = String(text === null || text === undefined ? '' : text);
    if (payload === '') {
      reject(new Error('剪切板内容为空，未执行复制'));
      return;
    }

    let child;
    try {
      child = spawn(PBCOPY, [], { stdio: ['pipe', 'ignore', 'pipe'] });
    } catch (err) {
      reject(new Error(`无法启动系统剪切板命令 pbcopy：${err.message}`));
      return;
    }

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      reject(new Error(`写入剪切板失败：${err.message}`));
    });
    child.on('close', (code) => {
      if (code === 0) resolve({ ok: true, bytes: Buffer.byteLength(payload, 'utf8') });
      else reject(new Error(`写入剪切板失败（pbcopy 退出码 ${code}）${stderr ? `：${stderr.trim()}` : ''}`));
    });

    child.stdin.on('error', () => {
      /* 进程提前退出时忽略 stdin 报错，由 close 事件统一处理 */
    });
    child.stdin.end(Buffer.from(payload, 'utf8'));
  });
}

module.exports = { writeClipboard };

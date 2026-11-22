'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const DEFAULT_SETTINGS = Object.freeze({
  theme: 'system', cardSize: 'medium', leaveScope: false, rosterScope: true,
  startPage: 'leave', rosterColumnCount: 2,
});

// 只允许界面偏好落盘，不接受学生信息或任意其他字段。
function normalizeSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('设置必须为对象');
  const result = { ...DEFAULT_SETTINGS };
  if (['system', 'light', 'dark'].includes(value.theme)) result.theme = value.theme;
  if (['small', 'medium', 'large'].includes(value.cardSize)) result.cardSize = value.cardSize;
  if (typeof value.leaveScope === 'boolean') result.leaveScope = value.leaveScope;
  if (typeof value.rosterScope === 'boolean') result.rosterScope = value.rosterScope;
  if (['leave', 'roster'].includes(value.startPage)) result.startPage = value.startPage;
  if ([1, 2, 3, 4].includes(value.rosterColumnCount)) result.rosterColumnCount = value.rosterColumnCount;
  return result;
}

function readSettings(file) {
  try {
    return normalizeSettings(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function writeSettings(file, value) {
  const settings = normalizeSettings(value);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return settings;
}

module.exports = { DEFAULT_SETTINGS, normalizeSettings, readSettings, writeSettings };

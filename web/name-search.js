'use strict';

// 拼音字典及姓氏识别复用 pinyin-pro；匹配仅允许从姓名开头开始。
(function (root) {
  const { pinyin } = typeof module === 'object' && module.exports
    ? require('./vendor/pinyin-pro/pinyin-pro.js') : root.pinyinPro;
  const cache = new Map();
  const normalize = (value) => String(value || '').normalize('NFKC').trim().toLowerCase();

  function matches(name, query) {
    const text = normalize(name);
    const term = normalize(query);
    if (!term || text.startsWith(term)) return true;
    if (!/^[a-z]+$/.test(term)) return false;
    if (!cache.has(text)) {
      cache.set(text, pinyin(text, {
        pattern: 'first', toneType: 'none', type: 'array', surname: 'head',
      }).join('').toLowerCase());
    }
    return cache.get(text).startsWith(term);
  }

  const api = { matches };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.nameSearch = api;
})(typeof window === 'object' ? window : globalThis);

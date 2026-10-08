'use strict';

/**
 * 班级请假登记 —— 前端逻辑（原生 JavaScript，无任何框架）
 *
 * 设计要点：
 *  - 数据（state.students）与界面分离：DOM 只用来展示，填写内容都保存在数据模型里；
 *  - 所有来自花名册的文字都用 textContent 写入，避免任何 HTML 注入；
 *  - 不做任何持久化：关闭窗口后本次填写的内容全部丢失（符合需求）。
 */

(function () {
  const state = {
    roster: null,
    error: null,
    errorDetails: null,
    students: [],
    cardSize: 'medium',
    lastCsvPath: null,
    exportDir: '',
    exportTitle: '',
    busy: false,
  };

  const els = {
    rosterInfo: document.getElementById('rosterInfo'),
    bannerArea: document.getElementById('bannerArea'),
    grid: document.getElementById('grid'),
    sizeGroup: document.getElementById('sizeGroup'),
    exportBtn: document.getElementById('exportBtn'),
    statLine: document.getElementById('statLine'),
    modalBackdrop: document.getElementById('modalBackdrop'),
    modalSummary: document.getElementById('modalSummary'),
    modalStatus: document.getElementById('modalStatus'),
    modalClose: document.getElementById('modalClose'),
    modalCloseBottom: document.getElementById('modalCloseBottom'),
    copyBtn: document.getElementById('copyBtn'),
    copyCsvBtn: document.getElementById('copyCsvBtn'),
    revealBtn: document.getElementById('revealBtn'),
  };

  const MAKEUP_LABEL = { true: '是', false: '否' };

  // ---------------------------------------------------------------- 工具

  function api(path, options) {
    return fetch(path, {
      method: (options && options.method) || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: options && options.body ? JSON.stringify(options.body) : undefined,
    }).then(async (res) => {
      let data = null;
      try {
        data = await res.json();
      } catch {
        throw new Error(`服务返回了无法解析的内容（HTTP ${res.status}）`);
      }
      if (!res.ok || data.ok === false) {
        throw new Error(data && data.error ? data.error : `请求失败（HTTP ${res.status}）`);
      }
      return data;
    });
  }

  function shortText(text, max) {
    const flat = String(text || '').replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max)}…` : flat;
  }

  function editedCount() {
    return state.students.filter((s) => s.edited).length;
  }

  function payloadRecords() {
    // 只提交“请假的人”（填了请假理由，或选择了是否补假）；服务端会再过滤一次
    return state.students
      .filter((s) => s.reason.trim() !== '' || s.makeup !== null)
      .map((s) => ({ name: s.name, reason: s.reason, makeup: s.makeup }));
  }

  // ---------------------------------------------------------------- 渲染

  function renderRosterInfo() {
    if (state.error || !state.roster) {
      els.rosterInfo.textContent = state.error ? '未能读取花名册' : '正在读取花名册……';
      return;
    }
    const r = state.roster;
    const columnNote = r.nameColumn.source === 'inferred' ? `，姓名列：${r.nameColumn.label}（自动识别）` : '';
    els.rosterInfo.textContent = `${r.fileName} · ${r.format} · 工作表「${r.sheetName}」 · ${r.studentCount} 名学生${columnNote}`;
  }

  function renderBanners() {
    els.bannerArea.replaceChildren();

    if (state.error) {
      const banner = document.createElement('div');
      banner.className = 'banner error';
      const title = document.createElement('div');
      title.className = 'banner-title';
      title.textContent = '读取花名册失败';
      const pre = document.createElement('pre');
      pre.textContent = state.error;
      banner.append(title, pre);

      const details = state.errorDetails || {};
      const candidates = details.candidates || [];

      const actions = document.createElement('div');
      actions.className = 'banner-actions';
      if (candidates.length > 1) {
        for (const cand of candidates) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'btn';
          btn.textContent = cand.studentCount
            ? `使用 ${cand.fileName}（${cand.studentCount} 人）`
            : `使用 ${cand.fileName}`;
          btn.addEventListener('click', () => reload(cand.path));
          actions.append(btn);
        }
      }
      const rescan = document.createElement('button');
      rescan.type = 'button';
      rescan.className = 'btn';
      rescan.textContent = '重新扫描花名册';
      rescan.addEventListener('click', () => reload(null));
      actions.append(rescan);
      banner.append(actions);
      els.bannerArea.append(banner);
      return;
    }

    if (state.roster && state.roster.warnings.length > 0) {
      const banner = document.createElement('div');
      banner.className = 'banner warn';
      const title = document.createElement('div');
      title.className = 'banner-title';
      title.textContent = '花名册提示';
      const list = document.createElement('ul');
      for (const warning of state.roster.warnings) {
        const li = document.createElement('li');
        li.textContent = warning;
        list.append(li);
      }
      banner.append(title, list);
      els.bannerArea.append(banner);
    }
  }

  function createCard(student, index) {
    const card = document.createElement('article');
    card.className = 'card';
    card.tabIndex = 0;
    card.dataset.index = String(index);
    card.title = '双击填写请假信息';

    const head = document.createElement('div');
    head.className = 'card-head';

    const name = document.createElement('div');
    name.className = 'card-name';
    name.textContent = student.name;

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = '已填写';
    badge.hidden = true;
    head.append(name, badge);

    const preview = document.createElement('div');
    preview.className = 'card-preview';
    preview.hidden = true;

    const editor = document.createElement('div');
    editor.className = 'card-editor';

    const reasonId = `reason-${index}`;
    const reasonLabel = document.createElement('label');
    reasonLabel.className = 'field-label';
    reasonLabel.htmlFor = reasonId;
    reasonLabel.textContent = '请假理由';

    const textarea = document.createElement('textarea');
    textarea.id = reasonId;
    textarea.rows = 3;
    textarea.placeholder = '请填入请假理由……';
    textarea.value = student.reason;

    const makeupGroup = document.createElement('div');
    makeupGroup.className = 'radio-row';
    makeupGroup.setAttribute('role', 'radiogroup');
    makeupGroup.setAttribute('aria-label', `${student.name} 是否补假`);

    const makeupTitle = document.createElement('div');
    makeupTitle.className = 'field-label';
    makeupTitle.textContent = '是否补假？';

    for (const [value, label] of [
      ['yes', '是'],
      ['no', '否'],
    ]) {
      const wrap = document.createElement('label');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = `makeup-${index}`;
      radio.value = value;
      radio.checked = student.makeup === (value === 'yes');
      radio.addEventListener('change', () => {
        if (!radio.checked) return;
        state.students[index].makeup = value === 'yes';
        updateCardVisual(index);
      });
      wrap.append(radio, document.createTextNode(label));
      makeupGroup.append(wrap);
    }

    const actions = document.createElement('div');
    actions.className = 'editor-actions';
    const collapse = document.createElement('button');
    collapse.type = 'button';
    collapse.className = 'link-btn';
    collapse.textContent = '收起';
    collapse.addEventListener('click', () => setExpanded(card, false));
    actions.append(collapse);

    editor.append(reasonLabel, textarea, makeupTitle, makeupGroup, actions);

    textarea.addEventListener('input', () => {
      state.students[index].reason = textarea.value;
      updateCardVisual(index);
    });

    card.append(head, preview, editor);

    card.addEventListener('dblclick', (event) => {
      if (event.target.closest('.card-editor')) return; // 编辑区里的双击不收起卡片
      const willExpand = !card.classList.contains('expanded');
      setExpanded(card, willExpand, true);
    });

    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.target === card) {
        event.preventDefault();
        setExpanded(card, !card.classList.contains('expanded'), true);
      }
    });

    updateCardVisualFor(card, index);
    return card;
  }

  function setExpanded(card, expanded, focus) {
    card.classList.toggle('expanded', expanded);
    if (expanded && focus) {
      const textarea = card.querySelector('textarea');
      if (textarea) textarea.focus();
    }
  }

  function updateCardVisual(index) {
    const card = els.grid.querySelector(`.card[data-index="${index}"]`);
    if (card) updateCardVisualFor(card, index);
    updateStatLine();
  }

  function updateCardVisualFor(card, index) {
    const student = state.students[index];
    if (!student) return;
    const hasReason = student.reason.trim() !== '';
    const hasMakeup = student.makeup !== null;
    student.edited = hasReason || hasMakeup;

    card.classList.toggle('edited', student.edited);
    card.querySelector('.badge').hidden = !student.edited;

    const preview = card.querySelector('.card-preview');
    const parts = [];
    if (hasReason) parts.push(shortText(student.reason, 42));
    if (hasMakeup) parts.push(`补假：${MAKEUP_LABEL[String(student.makeup)]}`);
    else if (hasReason) parts.push('补假未选');
    if (parts.length > 0) {
      preview.textContent = parts.join(' · ');
      preview.hidden = false;
    } else {
      preview.textContent = '';
      preview.hidden = true;
    }
  }

  function updateStatLine() {
    els.statLine.textContent = `已填写 ${editedCount()} / ${state.students.length}`;
  }

  function renderGrid() {
    els.grid.replaceChildren();
    if (state.error || state.students.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = state.error
        ? '花名册尚未成功读取，请按上方提示处理后重试。'
        : '花名册中没有学生。';
      els.grid.append(empty);
      updateStatLine();
      return;
    }
    const fragment = document.createDocumentFragment();
    state.students.forEach((student, index) => fragment.append(createCard(student, index)));
    els.grid.append(fragment);
    updateStatLine();
  }

  function applyCardSize(size) {
    state.cardSize = size;
    els.grid.dataset.size = size;
    for (const btn of els.sizeGroup.querySelectorAll('button')) {
      btn.classList.toggle('active', btn.dataset.size === size);
    }
  }

  // ---------------------------------------------------------------- 数据加载

  function applyRoster(roster) {
    state.roster = roster;
    state.students = roster
      ? roster.students.map((s) => ({ name: s.name, id: s.id || '', reason: '', makeup: null, edited: false }))
      : [];
  }

  function applyState(data) {
    state.error = data.error || null;
    state.errorDetails = data.errorDetails || null;
    state.exportDir = data.exportDir || '';
    state.exportTitle = data.exportTitle || '';
    applyRoster(data.roster);
    renderRosterInfo();
    renderBanners();
    renderGrid();
  }

  async function reload(path) {
    if (editedCount() > 0 && !window.confirm('重新读取花名册会清空当前已填写的内容，确定继续吗？')) return;
    const body = path ? { path } : {};
    try {
      const data = await api('/api/reload', { method: 'POST', body });
      applyState(data);
    } catch (err) {
      state.error = err.message;
      state.errorDetails = state.errorDetails || null;
      renderRosterInfo();
      renderBanners();
    }
  }

  async function loadState() {
    try {
      const data = await api('/api/state');
      applyState(data);
    } catch (err) {
      state.error = `无法连接到本地服务：${err.message}`;
      state.errorDetails = null;
      renderRosterInfo();
      renderBanners();
      renderGrid();
    }
  }

  // ---------------------------------------------------------------- 导出

  function openModal() {
    if (state.students.length === 0) {
      window.alert('当前没有可导出的学生数据，请先解决花名册读取问题。');
      return;
    }
    const total = state.students.length;
    const done = editedCount();
    const missingMakeup = state.students.filter((s) => s.reason.trim() !== '' && s.makeup === null).length;
    let summary = `共 ${total} 名学生，已填写 ${done} 名。导出只保留这 ${done} 名请假的学生的信息。首行标题：${state.exportTitle || '（未设置）'}。CSV 保存到：${state.exportDir || '项目根目录'}。`;
    if (done === 0) {
      summary += '目前还没有人填写请假信息，导出内容将只有标题和表头。';
    }
    if (missingMakeup > 0) {
      summary += `其中 ${missingMakeup} 名填写了理由但没有选择是否补假，导出时该字段为空。`;
    }
    els.modalSummary.textContent = summary;
    setStatus('', '');
    els.revealBtn.hidden = true;
    els.modalBackdrop.hidden = false;
    els.copyBtn.focus();
  }

  function closeModal() {
    els.modalBackdrop.hidden = true;
    setStatus('', '');
  }

  function setStatus(text, kind) {
    els.modalStatus.textContent = text;
    els.modalStatus.className = `modal-status${kind ? ` ${kind}` : ''}`;
  }

  function setBusy(busy) {
    state.busy = busy;
    els.copyBtn.disabled = busy;
    els.copyCsvBtn.disabled = busy;
  }

  async function doCopy() {
    if (state.busy) return;
    setBusy(true);
    setStatus('正在复制……', '');
    try {
      const data = await api('/api/clipboard', { method: 'POST', body: { records: payloadRecords() } });
      setStatus(`${data.message}。可以直接粘贴到聊天窗口或表格软件。`, 'success');
    } catch (err) {
      setStatus(`复制失败：${err.message}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function doCopyAndCsv() {
    if (state.busy) return;
    setBusy(true);
    setStatus('正在复制并写出 CSV……', '');
    try {
      const data = await api('/api/export', { method: 'POST', body: { records: payloadRecords() } });
      state.lastCsvPath = data.csv ? data.csv.path : null;
      const kind = data.clipboardWarning ? 'error' : 'success';
      setStatus(data.message, kind);
      els.revealBtn.hidden = !state.lastCsvPath;
    } catch (err) {
      setStatus(`导出失败：${err.message}`, 'error');
      els.revealBtn.hidden = true;
    } finally {
      setBusy(false);
    }
  }

  async function revealFile() {
    if (!state.lastCsvPath) return;
    try {
      await api('/api/reveal', { method: 'POST', body: { path: state.lastCsvPath } });
    } catch (err) {
      setStatus(`无法在访达中显示：${err.message}`, 'error');
    }
  }

  // ---------------------------------------------------------------- 事件绑定

  els.sizeGroup.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-size]');
    if (!btn) return;
    applyCardSize(btn.dataset.size);
  });

  els.exportBtn.addEventListener('click', openModal);
  els.modalClose.addEventListener('click', closeModal);
  els.modalCloseBottom.addEventListener('click', closeModal);
  els.copyBtn.addEventListener('click', doCopy);
  els.copyCsvBtn.addEventListener('click', doCopyAndCsv);
  els.revealBtn.addEventListener('click', revealFile);

  els.modalBackdrop.addEventListener('click', (event) => {
    if (event.target === els.modalBackdrop) closeModal();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !els.modalBackdrop.hidden) closeModal();
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'e') {
      event.preventDefault();
      if (els.modalBackdrop.hidden) openModal();
    }
  });

  window.addEventListener('DOMContentLoaded', () => {
    applyCardSize('medium');
    loadState();
  });

  if (document.readyState !== 'loading') {
    applyCardSize('medium');
    loadState();
  }
})();

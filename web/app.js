'use strict';

/**
 * 班级请假登记 —— 前端逻辑（原生 JavaScript，无任何框架）
 *
 * 设计要点：
 *  - 数据（state.students）与界面分离：DOM 只用来展示，填写内容都保存在数据模型里；
 *  - 所有来自花名册的文字都用 textContent 写入，避免任何 HTML 注入；
 *  - 填写内容由本机服务共享，关闭服务后丢失。
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
    importing: false,
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
    importBtn: document.getElementById('importBtn'),
    importBackdrop: document.getElementById('importBackdrop'),
    importClose: document.getElementById('importClose'),
    importCloseBottom: document.getElementById('importCloseBottom'),
    importStatus: document.getElementById('importStatus'),
    dropZone: document.getElementById('dropZone'),
    fileInput: document.getElementById('fileInput'),
  };

  const MAKEUP_LABEL = { true: '是', false: '否' };

  // ---------------------------------------------------------------- 工具

  function api(path, options) {
    return fetch(path, {
      method: (options && options.method) || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: options && options.body ? JSON.stringify(options.body) : undefined,
      keepalive: Boolean(options && options.keepalive),
    }).then(async (res) => {
      let data = null;
      try {
        data = await res.json();
      } catch {
        throw new Error(`服务返回了无法解析的内容（HTTP ${res.status}）`);
      }
      if (!res.ok || data.ok === false) {
        throw new Error(data?.error || data?.message || `请求失败（HTTP ${res.status}）`);
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

  const rosterGrid = document.getElementById('rosterGrid');
  const rosterColumns = document.getElementById('rosterColumns');
  const rosterTotal = document.getElementById('rosterTotal');
  const rosterFilledStat = document.getElementById('rosterFilledStat');
  const headerInputs = [...rosterGrid.querySelectorAll('[data-header]')];
  const includeUnfilled = document.getElementById('includeUnfilled');
  const menuBtn = document.getElementById('menuBtn');
  const pageDrawer = document.getElementById('pageDrawer');
  const nameSearchInput = document.getElementById('nameSearch');
  const clearSearch = document.getElementById('clearSearch');
  const searchStatus = document.getElementById('searchStatus');
  const settingsDialog = document.getElementById('settingsDialog');
  const themeSetting = document.getElementById('themeSetting');
  const cardSizeSetting = document.getElementById('cardSizeSetting');
  const startPageSetting = document.getElementById('startPageSetting');
  const rosterColumnSetting = document.getElementById('rosterColumnSetting');
  const leaveScopeSetting = document.getElementById('leaveScopeSetting');
  const rosterScopeSetting = document.getElementById('rosterScopeSetting');
  const settingsStatus = document.getElementById('settingsStatus');
  const settingsKey = 'class-leave-register.settings';
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  const settings = {
    theme: 'system', cardSize: 'medium', leaveScope: false, rosterScope: true,
    startPage: 'leave', rosterColumnCount: 2,
  };

  try {
    const saved = JSON.parse(localStorage.getItem(settingsKey));
    if (['system', 'light', 'dark'].includes(saved?.theme)) settings.theme = saved.theme;
    if (['small', 'medium', 'large'].includes(saved?.cardSize)) settings.cardSize = saved.cardSize;
    if (typeof saved?.leaveScope === 'boolean') settings.leaveScope = saved.leaveScope;
    if (typeof saved?.rosterScope === 'boolean') settings.rosterScope = saved.rosterScope;
    if (['leave', 'roster'].includes(saved?.startPage)) settings.startPage = saved.startPage;
    if ([1, 2, 3, 4].includes(saved?.rosterColumnCount)) settings.rosterColumnCount = saved.rosterColumnCount;
  } catch {
    // 设置无法读取时使用默认值。
  }

  function applyTheme() {
    const theme = settings.theme === 'system' ? (systemTheme.matches ? 'dark' : 'light') : settings.theme;
    document.documentElement.dataset.theme = theme;
    themeSetting.value = settings.theme;
  }

  let settingsSave = Promise.resolve();
  let settingsRevision = 0;
  let settingsReady = false;

  function cacheSettings() {
    try {
      localStorage.setItem(settingsKey, JSON.stringify(settings));
    } catch {
      // 本地文件为持久化来源，浏览器缓存不可用时仍可正常保存。
    }
  }

  function saveSettings() {
    cacheSettings();
    const snapshot = { ...settings };
    const revision = ++settingsRevision;
    settingsSave = settingsSave.catch(() => {}).then(() =>
      api('/api/settings', { method: 'POST', body: snapshot, keepalive: true })
    ).then(() => {
      if (revision === settingsRevision) settingsStatus.hidden = true;
    }).catch((error) => {
      if (revision !== settingsRevision) return;
      settingsStatus.textContent = `设置已生效，但未能保存到本机文件：${error.message}。请重新选择设置以重试。`;
      settingsStatus.hidden = false;
    });
    return settingsSave;
  }

  applyTheme();
  systemTheme.addEventListener('change', applyTheme);
  for (const button of document.querySelectorAll('[data-open-settings]')) {
    button.addEventListener('click', () => {
      cardSizeSetting.value = settings.cardSize;
      startPageSetting.value = settings.startPage;
      rosterColumnSetting.value = String(settings.rosterColumnCount);
      leaveScopeSetting.checked = settings.leaveScope;
      rosterScopeSetting.checked = settings.rosterScope;
      settingsDialog.showModal();
    });
  }
  settingsDialog.addEventListener('change', (event) => {
    if (!settingsReady) return;
    if (event.target === themeSetting) {
      settings.theme = themeSetting.value;
      applyTheme();
    } else if (event.target === startPageSetting) {
      settings.startPage = startPageSetting.value;
    } else if (event.target === rosterColumnSetting) {
      settings.rosterColumnCount = Number(rosterColumnSetting.value);
      renderRosterForm();
    } else {
      settings.cardSize = cardSizeSetting.value;
      settings.leaveScope = leaveScopeSetting.checked;
      settings.rosterScope = rosterScopeSetting.checked;
      applyCardSize(settings.cardSize);
    }
    saveSettings();
  });
  const workspace = document.querySelector('.workspace');
  const rosterForm = { headers: { text: '', choice: '' }, records: [] };
  let activePage = 'leave';
  let rosterVersion;
  let recordsRevision = -1;
  let writeQueue = Promise.resolve();
  let pendingWrites = 0;
  let writeSequence = 0;
  let syncError = '';
  let loadingRoster = false;
  let composing = false;

  workspace.addEventListener('compositionstart', () => { composing = true; });
  workspace.addEventListener('compositionend', () => { composing = false; });

  function saveRecords(page, updates) {
    const body = { rosterVersion, updates };
    writeSequence += 1;
    pendingWrites += 1;
    const request = writeQueue.then(() => api(`/api/ai/v1/records/${page}`, { method: 'PATCH', body }));
    writeQueue = request.then(() => {
      if (syncError) {
        syncError = '';
        renderBanners();
      }
    }, (error) => {
      syncError = `记录同步失败：${error.message}`;
      recordsRevision = -1;
      renderBanners();
    }).finally(() => { pendingWrites -= 1; });
    return request;
  }

  function matchesSearch(name) {
    return window.nameSearch.matches(name, nameSearchInput.value);
  }

  function updateSearchStatus() {
    const records = activePage === 'roster' ? rosterForm.records : state.students;
    const count = records.filter((record) => matchesSearch(record.name)).length;
    const searching = nameSearchInput.value.trim() !== '';
    clearSearch.hidden = nameSearchInput.value === '';
    searchStatus.hidden = !searching;
    searchStatus.textContent = searching
      ? (count ? `找到 ${count} / ${records.length} 名学生` : '没有匹配的学生，请尝试其他姓名或首字母。') : '';
  }

  function filterCards() {
    for (const card of els.grid.querySelectorAll('.card')) {
      card.hidden = !matchesSearch(state.students[Number(card.dataset.index)].name);
    }
    updateSearchStatus();
  }

  function applySearch() {
    filterCards();
    renderRosterForm();
    workspace.scrollTop = 0;
  }

  nameSearchInput.addEventListener('input', (event) => {
    if (!event.isComposing) applySearch();
  });
  nameSearchInput.addEventListener('compositionend', applySearch);
  clearSearch.addEventListener('click', () => {
    nameSearchInput.value = '';
    applySearch();
    nameSearchInput.focus();
  });

  // 名单来源和填写数据分开，后续可将 CSV 解析后的同形数据传入这里。
  function applyRosterForm({ records, headers = { text: '', choice: '' } }) {
    rosterForm.records = records;
    rosterForm.headers = headers;
    renderRosterForm();
  }

  function rosterFilledCount() {
    return rosterForm.records.filter(
      (record) => String(record.reason || '').trim() !== '' || record.makeup !== null
    ).length;
  }

  function updateRosterSummary() {
    const total = rosterForm.records.length;
    const filled = rosterFilledCount();
    rosterTotal.textContent = String(total);
    rosterFilledStat.textContent = `已填 ${filled} 条`;
    rosterFilledStat.classList.toggle('filled', filled > 0);
  }

  function syncRosterRecord(row, record, choiceButtons) {
    const filled = String(record.reason || '').trim() !== '' || record.makeup !== null;
    row.classList.toggle('is-filled', filled);
    for (const [value, button] of choiceButtons) {
      button.setAttribute('aria-pressed', String(record.makeup === value));
    }
  }

  /** 一行学生：姓名、请假理由输入框、是/否补假 */
  function createRosterRecord(record) {
    const row = document.createElement('div');
    row.className = 'roster-record';
    row.dataset.index = String(rosterForm.records.indexOf(record));

    const name = document.createElement('span');
    name.className = 'roster-name';
    name.title = record.name;

    const avatar = document.createElement('span');
    avatar.className = 'roster-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = Array.from(record.name)[0] || '·';

    const nameText = document.createElement('span');
    nameText.className = 'roster-name-text';
    nameText.textContent = record.name;
    name.append(avatar, nameText);

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'roster-input';
    input.maxLength = 20000;
    input.value = record.reason;
    input.placeholder = '请假理由';
    input.setAttribute('aria-label', `${record.name}的请假理由`);

    const choices = document.createElement('div');
    choices.className = 'choice-switch';
    choices.setAttribute('role', 'group');
    choices.setAttribute('aria-label', `${record.name}的补假选项：是或否`);

    const choiceField = document.createElement('div');
    choiceField.className = 'choice-field';
    const choiceLabel = document.createElement('span');
    choiceLabel.className = 'choice-label';
    choiceLabel.setAttribute('aria-hidden', 'true');
    choiceLabel.textContent = '补假';
    choiceField.append(choiceLabel, choices);

    const choiceButtons = [];
    for (const [value, label] of [[true, '是'], [false, '否']]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'choice-btn';
      button.textContent = label;
      button.setAttribute('aria-pressed', String(record.makeup === value));
      button.addEventListener('click', () => {
        record.makeup = record.makeup === value ? null : value;
        saveRecords('roster', [{ index: Number(row.dataset.index), makeup: record.makeup }]);
        syncRosterRecord(row, record, choiceButtons);
        updateRosterSummary();
      });
      choiceButtons.push([value, button]);
      choices.append(button);
    }

    input.addEventListener('input', () => {
      record.reason = input.value;
      saveRecords('roster', [{ index: Number(row.dataset.index), reason: record.reason }]);
      syncRosterRecord(row, record, choiceButtons);
      updateRosterSummary();
    });

    row.append(name, input, choiceField);
    syncRosterRecord(row, record, choiceButtons);
    return row;
  }

  function createRosterList(records) {
    const list = document.createElement('section');
    list.className = 'roster-list';

    const head = document.createElement('div');
    head.className = 'roster-list-head';
    for (const label of ['姓名', '请假理由', '补假']) {
      const cell = document.createElement('span');
      cell.textContent = label;
      head.append(cell);
    }
    list.append(head);

    for (const record of records) list.append(createRosterRecord(record));
    return list;
  }

  function effectiveRosterColumns() {
    const limit = Number(getComputedStyle(rosterColumns).getPropertyValue('--roster-column-limit')) || 1;
    return Math.min(settings.rosterColumnCount, limit);
  }

  function renderRosterForm() {
    const records = rosterForm.records.filter((record) => matchesSearch(record.name));
    const count = effectiveRosterColumns();
    const focused = document.activeElement;
    const focusedRow = focused?.closest('.roster-record');
    const focusIndex = focusedRow?.dataset.index;
    const focusControl = focusedRow ? [...focusedRow.querySelectorAll('input, button')].indexOf(focused) : -1;
    const selection = focused?.tagName === 'INPUT' ? [focused.selectionStart, focused.selectionEnd] : null;
    rosterColumns.dataset.columns = String(count);
    rosterColumns.style.setProperty('--roster-columns', String(count));
    rosterColumns.replaceChildren();

    if (records.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'roster-empty';
      empty.textContent = rosterForm.records.length ? '没有匹配的学生。' : '花名册中没有学生。';
      rosterColumns.append(empty);
    } else {
      // 按原名单顺序纵向分列，人数尽量均分，不生成空列。
      const columns = Math.min(count, records.length);
      let offset = 0;
      for (let column = 0; column < columns; column += 1) {
        const length = Math.floor(records.length / columns) + (column < records.length % columns ? 1 : 0);
        rosterColumns.append(createRosterList(records.slice(offset, offset + length)));
        offset += length;
      }
    }

    for (const input of headerInputs) input.value = rosterForm.headers[input.dataset.header] || '';
    updateRosterSummary();
    updateSearchStatus();
    if (focusIndex !== undefined && focusControl >= 0) {
      const row = rosterColumns.querySelector(`[data-index="${focusIndex}"]`);
      const control = row?.querySelectorAll('input, button')[focusControl];
      control?.focus({ preventScroll: true });
      if (control?.tagName === 'INPUT' && selection) control.setSelectionRange(...selection);
    }
  }

  new ResizeObserver(() => {
    if (Number(rosterColumns.dataset.columns) !== effectiveRosterColumns()) renderRosterForm();
  }).observe(workspace);

  for (const input of headerInputs) {
    input.addEventListener('input', () => {
      rosterForm.headers[input.dataset.header] = input.value;
    });
  }

  function setDrawer(open) {
    if (!open && pageDrawer.contains(document.activeElement)) menuBtn.focus();
    pageDrawer.inert = !open;
    pageDrawer.setAttribute('aria-hidden', String(!open));
    pageDrawer.classList.toggle('is-open', open);
    menuBtn.setAttribute('aria-expanded', String(open));
  }

  menuBtn.addEventListener('click', () => setDrawer(menuBtn.getAttribute('aria-expanded') !== 'true'));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !settingsDialog.open && menuBtn.getAttribute('aria-expanded') === 'true' && els.modalBackdrop.hidden && els.importBackdrop.hidden) {
      setDrawer(false);
      menuBtn.focus();
    }
  });
  pageDrawer.addEventListener('click', (event) => {
    const button = event.target.closest('[data-page]');
    if (!button) return;
    selectPage(button.dataset.page);
  });

  function selectPage(page) {
    activePage = page;
    const button = pageDrawer.querySelector(`[data-page="${page}"]`);
    updateSearchStatus();
    const isRoster = activePage === 'roster';
    const label = button.querySelector('.nav-label');
    document.getElementById('pageTitle').textContent = label ? label.textContent : button.textContent;
    workspace.scrollTop = 0;
    els.grid.hidden = isRoster;
    rosterGrid.hidden = !isRoster;
    els.sizeGroup.parentElement.hidden = isRoster;
    els.importBtn.hidden = isRoster;
    els.statLine.parentElement.hidden = isRoster;
    for (const item of pageDrawer.querySelectorAll('[data-page]')) {
      item.classList.toggle('primary', item === button);
      if (item === button) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    }
  }

  function exportRecords() {
    return activePage === 'roster' ? rosterForm.records : state.students;
  }

  function exportPayload() {
    const records = exportRecords().map(({ name, reason, makeup }) => ({ name, reason, makeup }));
    const payload = { records, includeUnfilled: includeUnfilled.checked };
    if (activePage === 'roster') {
      return { ...payload, mode: 'roster', headers: rosterForm.headers };
    }
    return payload;
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
    els.rosterInfo.title = els.rosterInfo.textContent;
  }

  function renderBanners() {
    els.bannerArea.replaceChildren();

    if (syncError) {
      const banner = document.createElement('div');
      banner.className = 'banner error';
      banner.setAttribute('role', 'alert');
      banner.textContent = syncError;
      els.bannerArea.append(banner);
    }

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
    makeupGroup.setAttribute('aria-label', `${student.name} 是否补假（可不选）`);

    const makeupTitle = document.createElement('div');
    makeupTitle.className = 'field-label';
    makeupTitle.append(document.createTextNode('是否补假？'));
    const optionalHint = document.createElement('span');
    optionalHint.className = 'field-hint';
    optionalHint.textContent = '（可不选）';
    makeupTitle.append(optionalHint);

    const clearMakeup = document.createElement('button');
    clearMakeup.type = 'button';
    clearMakeup.className = 'link-btn clear-makeup-btn';
    clearMakeup.textContent = '清除选择';
    clearMakeup.hidden = student.makeup === null;
    clearMakeup.addEventListener('click', () => {
      state.students[index].makeup = null;
      saveRecords('leave', [{ index, makeup: null }]);
      for (const radio of makeupGroup.querySelectorAll('input[type="radio"]')) radio.checked = false;
      clearMakeup.hidden = true;
      updateCardVisual(index);
    });
    makeupTitle.append(clearMakeup);

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
        saveRecords('leave', [{ index, makeup: state.students[index].makeup }]);
        clearMakeup.hidden = false;
        updateCardVisual(index);
      });
      wrap.append(radio, document.createTextNode(label));
      makeupGroup.append(wrap);
    }

    const actions = document.createElement('div');
    actions.className = 'editor-actions';
    const collapse = document.createElement('button');
    collapse.type = 'button';
    collapse.className = 'link-btn collapse-btn';
    collapse.textContent = '收起';
    collapse.addEventListener('click', () => setExpanded(card, false));
    actions.append(collapse);

    editor.append(reasonLabel, textarea, makeupTitle, makeupGroup, actions);

    textarea.addEventListener('input', () => {
      state.students[index].reason = textarea.value;
      saveRecords('leave', [{ index, reason: textarea.value }]);
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
      updateSearchStatus();
      return;
    }
    const fragment = document.createDocumentFragment();
    state.students.forEach((student, index) => fragment.append(createCard(student, index)));
    els.grid.append(fragment);
    filterCards();
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
    applyRosterForm({
      records: state.students.map(({ name }) => ({ name, reason: '', makeup: null })),
      headers: rosterForm.headers,
    });
  }

  function applyState(data) {
    rosterVersion = data.rosterVersion;
    state.error = data.error || null;
    state.errorDetails = data.errorDetails || null;
    state.exportDir = data.exportDir || '';
    state.exportTitle = data.exportTitle || '';
    applyRoster(data.roster);
    renderRosterInfo();
    renderBanners();
    renderGrid();
    applyRecordSnapshot(data);
  }

  function applyRecordSnapshot(data) {
    recordsRevision = data.recordsRevision;
    for (const [page, records] of [['leave', state.students], ['roster', rosterForm.records]]) {
      for (const { index, reason, makeup } of data.records[page]) {
        Object.assign(records[index], { reason, makeup, edited: reason.trim() !== '' || makeup !== null });
      }
    }
    for (const card of els.grid.querySelectorAll('.card')) {
      const index = Number(card.dataset.index);
      const { reason, makeup } = state.students[index];
      const textarea = card.querySelector('textarea');
      if (textarea.value !== reason) textarea.value = reason;
      for (const radio of card.querySelectorAll('input[type="radio"]')) radio.checked = makeup === (radio.value === 'yes');
      card.querySelector('.clear-makeup-btn').hidden = makeup === null;
      updateCardVisualFor(card, index);
    }
    for (const row of document.querySelectorAll('.roster-record')) {
      const record = rosterForm.records[Number(row.dataset.index)];
      const input = row.querySelector('.roster-input');
      if (input.value !== record.reason) input.value = record.reason;
      const [yes, no] = row.querySelectorAll('.choice-btn');
      syncRosterRecord(row, record, [[true, yes], [false, no]]);
    }
    updateStatLine();
    updateRosterSummary();
    if (!els.modalBackdrop.hidden) updateExportSummary();
  }

  async function syncRecords() {
    if (loadingRoster || pendingWrites || composing) return;
    const sequence = writeSequence;
    const version = rosterVersion;
    try {
      const data = await api('/api/state');
      if (loadingRoster || pendingWrites || composing || sequence !== writeSequence || version !== rosterVersion) return;
      if (data.rosterVersion !== rosterVersion) applyState(data);
      else if (data.recordsRevision !== recordsRevision) applyRecordSnapshot(data);
    } catch (error) {
      if (!syncError && !loadingRoster && sequence === writeSequence && version === rosterVersion) {
        syncError = `无法同步记录：${error.message}`;
        renderBanners();
      }
      return;
    }
    if (syncError) {
      syncError = '';
      renderBanners();
    }
  }

  async function reload(path) {
    if (loadingRoster) return;
    if ((editedCount() > 0 || rosterFilledCount() > 0) && !window.confirm('重新读取花名册会清空当前已填写的内容，确定继续吗？')) return;
    const body = path ? { path } : {};
    loadingRoster = true;
    try {
      await writeQueue;
      const data = await api('/api/reload', { method: 'POST', body });
      applyState(data);
    } catch (err) {
      state.error = err.message;
      state.errorDetails = state.errorDetails || null;
      renderRosterInfo();
      renderBanners();
    } finally {
      loadingRoster = false;
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

  function updateExportSummary() {
    const records = exportRecords();
    const filled = records.filter((record) => record.reason.trim() !== '' || record.makeup !== null).length;
    const count = includeUnfilled.checked ? records.length : filled;
    const title = activePage === 'roster' ? '花名册' : state.exportTitle || '（未设置）';
    let summary = `共 ${records.length} 名学生，已填写 ${filled} 名，本次导出 ${count} 名。首行标题：${title}。CSV 保存到：${state.exportDir || '项目根目录'}。`;
    if (count === 0) summary += '当前范围内没有记录，CSV 仅包含标题和表头。';
    els.modalSummary.textContent = summary;
  }

  function openModal() {
    if (exportRecords().length === 0) {
      window.alert('当前没有可导出的学生数据，请先解决花名册读取问题。');
      return;
    }
    includeUnfilled.checked = activePage === 'roster' ? settings.rosterScope : settings.leaveScope;
    updateExportSummary();
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
    includeUnfilled.disabled = busy;
  }

  async function doCopy() {
    if (state.busy) return;
    setBusy(true);
    setStatus('正在复制……', '');
    try {
      const data = await api('/api/clipboard', { method: 'POST', body: exportPayload() });
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
      const data = await api('/api/export', { method: 'POST', body: exportPayload() });
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
      setStatus(`无法在文件夹中显示：${err.message}`, 'error');
    }
  }

  // ---------------------------------------------------------------- 读取 CSV

  const IMPORT_MAX_BYTES = 8 * 1024 * 1024;

  function setImportStatus(text, kind) {
    els.importStatus.textContent = text;
    els.importStatus.className = `modal-status${kind ? ` ${kind}` : ''}`;
  }

  function setImportBusy(busy) {
    state.importing = busy;
    els.dropZone.setAttribute('aria-busy', busy ? 'true' : 'false');
    els.dropZone.classList.toggle('busy', busy);
  }

  function openImport() {
    if (state.importing) return;
    setImportStatus('', '');
    setImportBusy(false);
    els.fileInput.value = '';
    els.importBackdrop.hidden = false;
    els.dropZone.focus();
  }

  function closeImport() {
    els.importBackdrop.hidden = true;
    setImportStatus('', '');
    setImportBusy(false);
  }

  /** ArrayBuffer -> base64（分块转换，避免大文件时参数过多） */
  function toBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunk = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function csvFileProblem(file) {
    if (!file) return '没有选择文件。';
    if (!/\.csv$/i.test(file.name || '')) return '请选择 .csv 文件。';
    if (file.size > IMPORT_MAX_BYTES) return 'CSV 文件过大（超过 8 MB）。';
    return '';
  }

  /** 把服务端返回的匹配结果应用到卡片上（先清空，再按 CSV 恢复） */
  async function applyImportReport(data) {
    if (!data || !Array.isArray(data.matched)) {
      setImportStatus('服务返回的数据无法识别。', 'error');
      return;
    }
    if (data.rosterVersion !== rosterVersion) {
      setImportStatus('花名册已变化，请重新读取 CSV。', 'error');
      return;
    }
    if (data.matched.length === 0) {
      setImportStatus(
        data.message || `没有从「${data.fileName || 'CSV'}」中读到可导入的请假记录。`,
        'error'
      );
      return;
    }
    if (editedCount() > 0 && !window.confirm('读取 CSV 会覆盖当前已填写的内容，确定继续吗？')) {
      setImportStatus('已取消，当前填写内容未改变。', '');
      return;
    }

    state.students.forEach((student) => {
      student.reason = '';
      student.makeup = null;
      student.edited = false;
    });

    let applied = 0;
    for (const item of data.matched) {
      let index = Number.isInteger(item.index) ? item.index : -1;
      let student = state.students[index];
      // 极端情况下（花名册在弹窗期间被重新扫描）索引可能对不上，按姓名兜底
      if (!student || student.name !== item.name) {
        index = state.students.findIndex((s) => s.name === item.name && !s.edited);
        student = state.students[index];
      }
      if (!student) continue;
      student.reason = typeof item.reason === 'string' ? item.reason : '';
      student.makeup = item.makeup === true ? true : item.makeup === false ? false : null;
      student.edited = student.reason.trim() !== '' || student.makeup !== null;
      applied += 1;
    }

    renderGrid();
    await saveRecords('leave', state.students.map(({ reason, makeup }, index) => ({ index, reason, makeup })));

    const parts = [`已从「${data.fileName || 'CSV'}」恢复 ${applied} 条请假记录。`];
    if (data.unmatched && data.unmatched.length > 0) {
      parts.push(`有 ${data.unmatched.length} 条记录在花名册中找不到对应学生，已跳过。`);
    }
    if (data.warnings && data.warnings.length > 0) parts.push(...data.warnings);
    setImportStatus(parts.join(' '), data.unmatched && data.unmatched.length > 0 ? 'warn' : 'success');
  }

  /** 拖拽 / 浏览器文件选择：读取原始字节后上传，由服务端识别编码并解析 */
  async function importFileObject(file) {
    const problem = csvFileProblem(file);
    if (problem) {
      setImportStatus(problem, 'error');
      return;
    }
    setImportBusy(true);
    setImportStatus(`正在读取「${file.name}」……`, '');
    try {
      const buffer = await file.arrayBuffer();
      const data = await api('/api/import', {
        method: 'POST',
        body: { fileName: file.name, contentBase64: toBase64(buffer) },
      });
      await applyImportReport(data);
    } catch (err) {
      setImportStatus(`读取失败：${err.message}`, 'error');
    } finally {
      setImportBusy(false);
    }
  }

  /** 点击拖拽区：优先弹本机原生文件选择窗口（默认路径为导出目录），失败则退回浏览器选择 */
  async function pickCsvViaServer() {
    if (state.importing) return;
    setImportBusy(true);
    setImportStatus('正在打开文件选择窗口……', '');
    let fallback = false;
    try {
      const data = await api('/api/pick-csv', { method: 'POST' });
      if (data.canceled) {
        setImportStatus('已取消。', '');
      } else {
        await applyImportReport(data);
      }
    } catch (err) {
      fallback = true;
      setImportStatus(`无法打开系统文件选择窗口（${err.message}），已改用浏览器选择。`, 'error');
    } finally {
      setImportBusy(false);
    }
    if (fallback) els.fileInput.click();
  }

  // ---------------------------------------------------------------- 事件绑定

  els.sizeGroup.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-size]');
    if (!btn) return;
    settings.cardSize = btn.dataset.size;
    applyCardSize(settings.cardSize);
    saveSettings();
  });

  els.exportBtn.addEventListener('click', openModal);
  includeUnfilled.addEventListener('change', updateExportSummary);
  els.modalClose.addEventListener('click', closeModal);
  els.modalCloseBottom.addEventListener('click', closeModal);
  els.copyBtn.addEventListener('click', doCopy);
  els.copyCsvBtn.addEventListener('click', doCopyAndCsv);
  els.revealBtn.addEventListener('click', revealFile);

  // —— 读取 CSV ——
  els.importBtn.addEventListener('click', openImport);
  els.importClose.addEventListener('click', closeImport);
  els.importCloseBottom.addEventListener('click', closeImport);
  els.importBackdrop.addEventListener('click', (event) => {
    if (event.target === els.importBackdrop) closeImport();
  });
  els.dropZone.addEventListener('click', pickCsvViaServer);
  els.dropZone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      pickCsvViaServer();
    }
  });
  els.fileInput.addEventListener('change', () => {
    const file = els.fileInput.files && els.fileInput.files[0];
    els.fileInput.value = '';
    if (file) importFileObject(file);
  });

  for (const type of ['dragenter', 'dragover']) {
    els.dropZone.addEventListener(type, (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!state.importing) els.dropZone.classList.add('dragover');
    });
  }
  for (const type of ['dragleave', 'dragend']) {
    els.dropZone.addEventListener(type, (event) => {
      event.preventDefault();
      event.stopPropagation();
      els.dropZone.classList.remove('dragover');
    });
  }
  els.dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    event.stopPropagation();
    els.dropZone.classList.remove('dragover');
    if (state.importing) return;
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (!file) {
      setImportStatus('没有检测到拖入的文件。', 'error');
      return;
    }
    importFileObject(file);
  });

  // 避免拖拽落点偏离拖拽区时，浏览器直接打开被拖入的文件
  for (const type of ['dragover', 'drop']) {
    window.addEventListener(type, (event) => {
      if (event.dataTransfer && Array.from(event.dataTransfer.types || []).includes('Files')) {
        event.preventDefault();
      }
    });
  }

  els.modalBackdrop.addEventListener('click', (event) => {
    if (event.target === els.modalBackdrop) closeModal();
  });

  document.addEventListener('keydown', (event) => {
    if (settingsDialog.open) return;
    if (event.key === 'Escape') {
      if (!els.modalBackdrop.hidden) closeModal();
      if (!els.importBackdrop.hidden) closeImport();
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'e') {
      event.preventDefault();
      if (els.modalBackdrop.hidden) openModal();
    }
  });

  async function initialize() {
    const controls = [...settingsDialog.querySelectorAll('select, input'), ...els.sizeGroup.querySelectorAll('button')];
    for (const control of controls) control.disabled = true;
    try {
      const data = await api('/api/settings');
      if (data.settings) {
        Object.assign(settings, data.settings);
        cacheSettings();
      } else if (localStorage.getItem(settingsKey)) {
        // 迁移当前端口下旧版浏览器设置；文件存在时始终以文件为准。
        await saveSettings();
      }
    } catch (error) {
      settingsStatus.textContent = `无法读取本机设置：${error.message}。当前使用浏览器缓存或默认设置。`;
      settingsStatus.hidden = false;
    }
    settingsReady = true;
    for (const control of controls) control.disabled = false;
    applyTheme();
    applyCardSize(settings.cardSize);
    selectPage(settings.startPage);
    await loadState();
    async function pollRecords() {
      await syncRecords();
      window.setTimeout(pollRecords, 1000);
    }
    window.setTimeout(pollRecords, 1000);
  }

  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();

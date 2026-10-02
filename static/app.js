/* nav-py 前端逻辑 — 对齐 React 版全部行为
 * 分区: utils / api / icons / ping / theme / router / render / editor / feedback / keyboard / init
 * 安全约定: 用户数据一律 esc() 后拼 HTML；仅单色 SVG 经 sanitize 后 innerHTML。
 */
'use strict';

/* ============================== utils ============================== */

const $ = window.jQuery;

function esc(s) {
  return $('<i>').text(s == null ? '' : String(s)).html();
}

function newId() {
  return Math.random().toString(36).slice(2, 10);
}

const ALL_TAB = 'all';
const EDITOR_UNLOCKED = true; // Python 版自带写接口，后台按钮始终可用

const state = {
  config: null,
  tab: ALL_TAB,          // 分组 id | ALL_TAB
  subgroup: null,        // 子分组 id | null
  query: '',
  editMode: false,
  firstRoute: true,
};

/* ============================== api ============================== */

const api = {
  getConfig: () => $.getJSON('/api/config'),
  putConfig: (cfg) => $.ajax({
    url: '/api/config', method: 'PUT',
    contentType: 'application/json', data: JSON.stringify(cfg),
  }),
  getFeedback: (status) => $.getJSON('/api/feedback?status=' + encodeURIComponent(status || 'all')),
  postFeedback: (payload) => $.ajax({
    url: '/api/feedback', method: 'POST',
    contentType: 'application/json', data: JSON.stringify(payload),
  }),
  patchFeedback: (id, payload) => $.ajax({
    url: '/api/feedback/' + id, method: 'PATCH',
    contentType: 'application/json', data: JSON.stringify(payload),
  }),
};

function apiErrorText(xhr) {
  try {
    const body = JSON.parse(xhr.responseText);
    if (body && body.error) return body.error.msg || body.error.code;
  } catch (e) { /* ignore */ }
  return 'HTTP ' + xhr.status;
}

/* ============================== icons ============================== */

const COLOR_ATTR_RE = /\b(fill|stroke|color|stop-color|flood-color|lighting-color)\s*=\s*(["'])([^"']+)\2/gi;
const GRAY_NAMED = ['black', 'white', 'gray', 'grey', 'silver', 'dimgray', 'dimgrey'];

function isSvgMarkup(v) {
  const t = String(v || '').trim();
  return t.startsWith('<') && t.includes('<svg');
}

function isGrayscale(color) {
  const c = String(color || '').trim().toLowerCase();
  if (['none', 'currentcolor', 'transparent', 'inherit'].includes(c)) return true;
  if (GRAY_NAMED.includes(c)) return true;
  if (!c.startsWith('#')) return false;
  const hex = c.slice(1);
  let r, g, b;
  if (hex.length === 3) {
    r = parseInt(hex[0] + hex[0], 16); g = parseInt(hex[1] + hex[1], 16); b = parseInt(hex[2] + hex[2], 16);
  } else if (hex.length === 6) {
    r = parseInt(hex.slice(0, 2), 16); g = parseInt(hex.slice(2, 4), 16); b = parseInt(hex.slice(4, 6), 16);
  } else return false;
  if ([r, g, b].some(Number.isNaN)) return false;
  return Math.max(r, g, b) - Math.min(r, g, b) < 16;
}

function isMonochromeSvg(svg) {
  const matches = [...svg.matchAll(COLOR_ATTR_RE)];
  if (matches.length === 0) return false;
  return matches.every((m) => isGrayscale(m[3]));
}

function adaptSvgToCurrentColor(svg) {
  return svg.replace(COLOR_ATTR_RE, (full, attr, q, color) => {
    const lower = color.trim().toLowerCase();
    if (['none', 'currentcolor', 'transparent', 'inherit'].includes(lower)) return full;
    return isGrayscale(color) ? attr + '=' + q + 'currentColor' + q : full;
  });
}

function sanitizeSvg(svg) {
  return svg
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '');
}

function asDataUri(svg) {
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg.trim());
}

function defaultProbeUrl(siteUrl) {
  try { return new URL(siteUrl).origin + '/favicon.ico'; } catch (e) { return siteUrl; }
}

/* 渲染 32px 图标盒；site.icon 可为空 → 目标站 favicon 兜底 → 首字母 */
function renderIcon(site) {
  const fallback = esc(site.name.slice(0, 1));
  const raw = site.icon || defaultProbeUrl(site.url);
  const box = $('<div class="icon-box" aria-hidden="true">');
  const trimmed = String(raw || '').trim();
  if (isSvgMarkup(trimmed) && isMonochromeSvg(trimmed)) {
    box.addClass('mono').html(sanitizeSvg(adaptSvgToCurrentColor(trimmed)));
    box.children('svg').addClass('inline');
  } else if (trimmed) {
    const src = isSvgMarkup(trimmed) ? asDataUri(trimmed) : raw;
    const img = $('<img alt="" loading="lazy">').attr('src', src)
      .on('error', function () { box.empty().html(fallback); });
    box.append(img);
  } else {
    box.html(fallback);
  }
  return box;
}

/* ============================== ping ============================== */

const pingCache = new Map(); // probeUrl -> {status, ts}
const PING_TTL = 60_000, PING_TIMEOUT = 5_000;

function probeImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    let done = false;
    const finish = (ok) => { if (!done) { done = true; img.onload = img.onerror = null; resolve(ok); } };
    const timer = setTimeout(() => finish(false), PING_TIMEOUT);
    img.onload = () => { clearTimeout(timer); finish(true); };
    img.onerror = () => { clearTimeout(timer); finish(false); };
    img.src = url + (url.includes('?') ? '&' : '?') + '_=' + Date.now();
  });
}

function probeConnect(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PING_TIMEOUT);
  return fetch(url, { method: 'HEAD', mode: 'no-cors', cache: 'no-store', signal: ctrl.signal })
    .then(() => { clearTimeout(timer); return true; })
    .catch(() => { clearTimeout(timer); return false; });
}

async function probe(url) {
  const c = pingCache.get(url);
  if (c && Date.now() - c.ts < PING_TTL) return c.status;
  const ok = (await probeImage(url)) || (await probeConnect(url));
  const status = ok ? 'online' : 'offline';
  pingCache.set(url, { status, ts: Date.now() });
  return status;
}

function clearPingCache() { pingCache.clear(); }

/* ============================== theme ============================== */

function getTheme() {
  const saved = localStorage.getItem('nav:theme');
  if (saved) return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(t) {
  document.documentElement.classList.toggle('dark', t === 'dark');
  $('#btn-theme').text(t === 'dark' ? '☀' : '☾');
}

function initTheme() {
  applyTheme(getTheme());
  $('#btn-theme').on('click', () => {
    const next = getTheme() === 'dark' ? 'light' : 'dark';
    localStorage.setItem('nav:theme', next);
    applyTheme(next);
  });
}

/* ============================== router ============================== */

function groupOf(id) { return state.config.groups.find((g) => g.id === id); }

function tabStateFromHash(hash) {
  const raw = decodeURIComponent(hash.replace(/^#/, '')).trim();
  if (!raw || raw === 'all' || raw === '全部') return { tab: ALL_TAB, subgroup: null };
  const [gp, sp] = raw.split('/');
  const group = state.config.groups.find((g) => g.name === gp || g.id === gp);
  if (!group) return { tab: ALL_TAB, subgroup: null };
  if (!sp) return { tab: group.id, subgroup: null };
  const sub = (group.subgroups || []).find((s) => s.name === sp || s.id === sp);
  return { tab: group.id, subgroup: sub ? sub.id : null };
}

function hashFromTabState(st) {
  if (st.tab === ALL_TAB) return '';
  const group = groupOf(st.tab);
  if (!group) return '';
  let h = '#' + encodeURIComponent(group.name);
  if (st.subgroup) {
    const sub = (group.subgroups || []).find((s) => s.id === st.subgroup);
    if (sub) h += '/' + encodeURIComponent(sub.name);
  }
  return h;
}

function syncHash() {
  const next = hashFromTabState(state);
  if (window.location.hash !== next) {
    history.replaceState(null, '', next || window.location.pathname + window.location.search);
  }
}

function initRouter() {
  // 首次：hash > settings.defaultTab > 全部
  const fromHash = tabStateFromHash(window.location.hash);
  if (fromHash.tab !== ALL_TAB) {
    Object.assign(state, fromHash);
  } else {
    const dft = state.config.settings && state.config.settings.defaultTab;
    if (dft && groupOf(dft)) state.tab = dft;
  }
  window.addEventListener('hashchange', () => {
    Object.assign(state, tabStateFromHash(window.location.hash));
    render();
  });
}

/* 配置变化后校验 tab/subgroup 是否仍存在，失效则回落 */
function normalizeTabState() {
  if (state.tab === ALL_TAB) return;
  const group = groupOf(state.tab);
  if (!group) { state.tab = ALL_TAB; state.subgroup = null; return; }
  if (state.subgroup && !(group.subgroups || []).some((s) => s.id === state.subgroup)) {
    state.subgroup = null;
  }
}

/* ============================== view filter ============================== */

function visibleGroups() {
  const q = state.query.trim().toLowerCase();
  const isSearching = !!q;
  let groups = state.config.groups;
  if (isSearching) {
    groups = groups
      .map((g) => ({
        ...g,
        sites: g.sites.filter((s) =>
          s.name.toLowerCase().includes(q) ||
          (s.description || '').toLowerCase().includes(q) ||
          s.url.toLowerCase().includes(q)),
      }))
      .filter((g) => g.sites.length > 0 || g.name.toLowerCase().includes(q));
  } else if (state.tab !== ALL_TAB) {
    groups = groups.filter((g) => g.id === state.tab);
    if (state.subgroup) {
      groups = groups.map((g) => ({
        ...g,
        sites: g.sites.filter((s) => (s.subgroupIds || []).includes(state.subgroup)),
      }));
    }
  }
  return { groups, isSearching };
}

/* ============================== render ============================== */

function render() {
  if (!state.config) return;
  normalizeTabState();
  syncHash();
  $('#page-title').text(state.config.title || '导航');
  document.title = state.config.title || '导航';
  renderTabs();
  renderMain();
  $('#btn-feedback-admin').prop('hidden', !state.editMode);
}

function renderTabs() {
  const q = state.query.trim();
  const $tabs = $('#tabs').empty();
  state.config.groups.forEach((g) => {
    $tabs.append(
      `<button type="button" class="tab ${!q && state.tab === g.id ? 'active' : ''}" data-tab="${esc(g.id)}">` +
      `<span class="dot" style="background:${esc(g.color || '#71717a')}"></span>` +
      `${esc(g.name)}<span class="count">${g.sites.length}</span></button>`
    );
  });
  $tabs.append(
    `<button type="button" class="tab ${!q && state.tab === ALL_TAB ? 'active' : ''}" data-tab="all">全部</button>`
  );
  if (q) $tabs.append('<span class="sub-head" style="margin:0;align-self:center;">搜索中：跨所有分组</span>');

  // 子分组 pills
  const current = groupOf(state.tab);
  const showPills = !q && state.tab !== ALL_TAB && (current && (current.subgroups || []).length > 0);
  const $pills = $('#pills').prop('hidden', !showPills).empty();
  if (showPills) {
    $pills.append(`<button type="button" class="pill ${!state.subgroup ? 'active' : ''}" data-pill="">全部</button>`);
    current.subgroups.forEach((sg) => {
      $pills.append(`<button type="button" class="pill ${state.subgroup === sg.id ? 'active' : ''}" data-pill="${esc(sg.id)}">${esc(sg.name)}</button>`);
    });
  }
}

function opsBtn(action, label, extra = '') {
  return `<button type="button" data-action="${action}" ${extra}>${label}</button>`;
}

function cardHtml(site, group) {
  const inner =
    `<div class="card-inner">` +
    renderIcon(site).prop('outerHTML') +
    `<div class="card-text">` +
    `<div class="card-name">${esc(site.name)}</div>` +
    (site.description ? `<div class="card-desc">${esc(site.description)}</div>` : '') +
    `</div></div>`;
  const ops = state.editMode
    ? `<div class="card-ops">` +
      opsBtn('site-up', '↑', `data-gid="${esc(group.id)}" data-sid="${esc(site.id)}" title="上移"`) +
      opsBtn('site-down', '↓', `data-gid="${esc(group.id)}" data-sid="${esc(site.id)}" title="下移"`) +
      opsBtn('site-edit', '✎', `data-gid="${esc(group.id)}" data-sid="${esc(site.id)}" title="编辑"`) +
      opsBtn('site-copy', '⧉', `data-gid="${esc(group.id)}" data-sid="${esc(site.id)}" title="复制"`) +
      opsBtn('site-del', '🗑', `data-gid="${esc(group.id)}" data-sid="${esc(site.id)}" title="删除"`) +
      `</div>`
    : '';
  const pingTag = (state.config.settings || {}).enablePing
    ? `<span class="ping" data-probe="${esc(site.probeUrl || defaultProbeUrl(site.url))}"><span class="dot" title="检测中"></span></span>`
    : '';
  const editTag = state.editMode
    ? `<div class="card">${inner}${pingTag}${ops}</div>`
    : (() => {
        const newTab = site.openInNewTab !== false;
        return `<a class="card" href="${esc(site.url)}" target="${newTab ? '_blank' : '_self'}"` +
          (newTab ? ' rel="noopener noreferrer"' : '') + `>${inner}${pingTag}</a>`;
      })();
  return editTag;
}

function gridHtml(sites, group) {
  return `<div class="grid">` + sites.map((s) => cardHtml(s, group)).join('') + `</div>`;
}

function groupSectionHtml(g, opts) {
  const { showHead, showSubHeads } = opts;
  const subgroups = g.subgroups || [];
  const subIdSet = new Set(subgroups.map((s) => s.id));
  const orphans = g.sites.filter((s) => !(s.subgroupIds || []).some((id) => subIdSet.has(id)));
  const parts = [];

  if (showHead) {
    parts.push(
      `<div class="group-head"><span class="bar" style="background:${esc(g.color || '#71717a')}"></span>` +
      `<h2>${esc(g.name)}</h2><span class="count">${g.sites.length}</span>` +
      (state.editMode
        ? `<span class="ops">` +
          opsBtn('group-up', '↑', `data-gid="${esc(g.id)}" title="上移分组"`) +
          opsBtn('group-down', '↓', `data-gid="${esc(g.id)}" title="下移分组"`) +
          opsBtn('group-edit', '✎', `data-gid="${esc(g.id)}" title="编辑分组"`) +
          opsBtn('group-add-site', '+ 链接', `data-gid="${esc(g.id)}" title="新链接"`) +
          opsBtn('group-del', '🗑', `data-gid="${esc(g.id)}" title="删除分组"`) +
          `</span>`
        : '') +
      `</div>`
    );
  } else if (state.editMode) {
    parts.push(
      `<div class="group-head"><span class="ops">` +
      opsBtn('group-edit', '✎ 编辑分组', `data-gid="${esc(g.id)}"`) +
      opsBtn('group-add-site', '+ 链接', `data-gid="${esc(g.id)}"`) +
      `</span></div>`
    );
  }

  const useSubLayout = showSubHeads && subgroups.length > 0;
  if (useSubLayout) {
    if (orphans.length) parts.push(gridHtml(orphans, g));
    subgroups.forEach((sg) => {
      const sites = g.sites.filter((s) => (s.subgroupIds || []).includes(sg.id));
      if (!sites.length) return;
      parts.push(`<div class="sub-head">${esc(sg.name)}<span class="count">${sites.length}</span></div>`);
      parts.push(gridHtml(sites, g));
    });
    if (!orphans.length && subgroups.every((sg) => !g.sites.some((s) => (s.subgroupIds || []).includes(sg.id))) && !state.editMode) {
      parts.push('<div class="empty">该分组暂无内容</div>');
    }
  } else {
    parts.push(gridHtml(g.sites, g));
    if (!g.sites.length && !state.editMode) parts.push('<div class="empty">该分组暂无内容</div>');
  }
  return `<section data-gid="${esc(g.id)}">` + parts.join('') + `</section>`;
}

function renderMain() {
  const { groups, isSearching } = visibleGroups();
  const $main = $('#main').empty();
  const showAllLayout = isSearching || state.tab === ALL_TAB;
  const showSubHeads = !state.subgroup;
  if (!groups.length) {
    $main.html(`<div class="empty">${isSearching ? '没有匹配的内容' : '该分组暂无内容'}</div>`);
    return;
  }
  $main.html(groups.map((g) => groupSectionHtml(g, { showHead: showAllLayout, showSubHeads })).join(''));
  schedulePings();
}

/* 渲染后异步探测，逐个更新指示灯 */
function schedulePings() {
  if (!(state.config.settings || {}).enablePing) return;
  $('.ping[data-probe]').each(function () {
    const $el = $(this);
    const url = $el.attr('data-probe');
    probe(url).then((status) => {
      const $dot = $el.find('.dot, .x');
      if (status === 'online') {
        $el.html('<span class="dot online" title="可访问"></span>');
      } else {
        $el.html('<span class="x" title="不可访问">✕</span>');
      }
    });
  });
}

/* ============================== modal ============================== */

let modalOpen = false;

function openModal(title, bodyHtml) {
  $('#modal-title').text(title);
  $('#modal-body').html(bodyHtml);
  $('#modal-root').prop('hidden', false);
  modalOpen = true;
}

function closeModal() {
  $('#modal-root').prop('hidden', true);
  $('#modal-body').empty();
  modalOpen = false;
}

/* ============================== editor ============================== */

function validateConfigLocal(cfg) {
  if (!cfg || typeof cfg !== 'object') return '顶层必须是对象';
  if (typeof cfg.title !== 'string' || !cfg.title) return 'title 必须是非空字符串';
  if (!Array.isArray(cfg.groups)) return 'groups 必须是数组';
  for (const g of cfg.groups) {
    if (!g || typeof g.id !== 'string' || typeof g.name !== 'string' || !Array.isArray(g.sites))
      return '分组结构不完整';
    for (const s of g.sites) {
      if (!s || typeof s.id !== 'string' || typeof s.name !== 'string' || typeof s.url !== 'string')
        return '站点缺少 id/name/url';
    }
  }
  return null;
}

async function saveConfig() {
  const err = validateConfigLocal(state.config);
  if (err) { alert('校验失败: ' + err); return false; }
  try {
    await api.putConfig(state.config);
    return true;
  } catch (xhr) {
    alert('保存失败: ' + apiErrorText(xhr));
    await reloadConfig(); // 回滚到服务端状态
    return false;
  }
}

async function reloadConfig() {
  state.config = await api.getConfig();
  render();
}

function withConfig(fn) {
  const clone = JSON.parse(JSON.stringify(state.config));
  fn(clone);
  state.config = clone;
  saveConfig().then(render);
}

/* ---- 站点编辑弹窗 ---- */

function siteModal(group, site /* null=新增 */) {
  const isNew = !site;
  const subs = group.subgroups || [];
  const s = site || { name: '', url: '', description: '', icon: '', openInNewTab: true, subgroupIds: [] };
  const subChecks = subs.length
    ? `<div class="form-row"><label>所属子分组（可多选）</label>` +
      subs.map((sg) =>
        `<div class="check-row"><input type="checkbox" name="sub" value="${esc(sg.id)}" ` +
        `${(s.subgroupIds || []).includes(sg.id) ? 'checked' : ''}><label>${esc(sg.name)}</label></div>`
      ).join('') + `</div>`
    : '';
  openModal(isNew ? '新增链接' : '编辑链接', `
    <div class="form-row"><label>名称 *</label><input name="name" value="${esc(s.name)}"></div>
    <div class="form-row"><label>URL *</label><input name="url" value="${esc(s.url)}" placeholder="https://…"></div>
    <div class="form-row"><label>描述</label><input name="description" value="${esc(s.description || '')}"></div>
    <div class="form-row"><label>图标（URL 或 SVG 字符串，留空用站点 favicon）</label><input name="icon" value="${esc(s.icon || '')}"></div>
    <div class="form-row"><label>连通性探测地址（留空用 favicon.ico）</label><input name="probeUrl" value="${esc(s.probeUrl || '')}"></div>
    <div class="form-row check-row"><input type="checkbox" name="newtab" id="f-newtab" ${s.openInNewTab !== false ? 'checked' : ''}><label for="f-newtab">在新标签页打开</label></div>
    ${subChecks}
    <div class="form-error" id="form-err"></div>
    <div class="form-actions"><button type="button" id="f-cancel">取消</button><button type="button" class="primary" id="f-save">保存</button></div>
  `);
  $('#f-cancel').on('click', closeModal);
  $('#f-save').on('click', async () => {
    const name = $('[name=name]').val().trim();
    const url = $('[name=url]').val().trim();
    if (!name || !url) { $('#form-err').text('名称与 URL 必填'); return; }
    const obj = {
      id: site ? site.id : newId(),
      name, url,
      description: $('[name=description]').val().trim() || undefined,
      icon: $('[name=icon]').val().trim() || undefined,
      probeUrl: $('[name=probeUrl]').val().trim() || undefined,
      openInNewTab: $('#f-newtab').prop('checked'),
      subgroupIds: $('[name=sub]:checked').map((_, el) => el.value).get(),
    };
    withConfig((cfg) => {
      const g = cfg.groups.find((x) => x.id === group.id);
      const i = g.sites.findIndex((x) => x.id === obj.id);
      if (i >= 0) g.sites[i] = obj; else g.sites.push(obj);
    });
    closeModal();
  });
}

/* ---- 分组编辑弹窗（含子分组管理）---- */

function groupModal(group /* null=新增 */) {
  const isNew = !group;
  const g = group || { name: '', color: '', subgroups: [] };
  openModal(isNew ? '新建分组' : '编辑分组', `
    <div class="form-row"><label>名称 *</label><input name="name" value="${esc(g.name)}"></div>
    <div class="form-row"><label>颜色（十六进制，标签圆点）</label><input name="color" value="${esc(g.color || '')}" placeholder="#3b82f6"></div>
    <div class="form-row"><label>子分组</label><div id="sub-list"></div>
      <div style="margin-top:6px;"><button type="button" id="sub-add">＋ 添加子分组</button></div>
    </div>
    <div class="form-error" id="form-err"></div>
    <div class="form-actions"><button type="button" id="f-cancel">取消</button><button type="button" class="primary" id="f-save">保存</button></div>
  `);

  function renderSubList() {
    const list = JSON.parse($('#sub-data').val() || '[]');
    $('#sub-list').html(list.length ? list.map((sg, i) =>
      `<div style="display:flex;gap:6px;margin-bottom:4px;" data-i="${i}">` +
      `<input class="sub-name" value="${esc(sg.name)}" style="flex:1;">` +
      `<button type="button" class="sub-up">↑</button><button type="button" class="sub-down">↓</button>` +
      `<button type="button" class="sub-del">✕</button></div>`
    ).join('') : '<div class="hint">暂无子分组</div>');
  }
  // 用隐藏 input 持有子分组数据，弹窗内即时编辑
  $('#modal-body').append('<input type="hidden" id="sub-data" value="' + esc(JSON.stringify(g.subgroups || [])) + '">');
  renderSubList();
  $('#sub-add').on('click', () => {
    const list = JSON.parse($('#sub-data').val() || '[]');
    list.push({ id: newId(), name: '新子分组' });
    $('#sub-data').val(JSON.stringify(list));
    renderSubList();
  });
  $('#sub-list').on('click', '.sub-del', (e) => {
    const i = +$(e.target).closest('[data-i]').attr('data-i');
    const list = JSON.parse($('#sub-data').val() || '[]');
    list.splice(i, 1); $('#sub-data').val(JSON.stringify(list)); renderSubList();
  }).on('click', '.sub-up', (e) => {
    const i = +$(e.target).closest('[data-i]').attr('data-i');
    const list = JSON.parse($('#sub-data').val() || '[]');
    if (i > 0) { [list[i - 1], list[i]] = [list[i], list[i - 1]]; $('#sub-data').val(JSON.stringify(list)); renderSubList(); }
  }).on('click', '.sub-down', (e) => {
    const i = +$(e.target).closest('[data-i]').attr('data-i');
    const list = JSON.parse($('#sub-data').val() || '[]');
    if (i < list.length - 1) { [list[i], list[i + 1]] = [list[i + 1], list[i]]; $('#sub-data').val(JSON.stringify(list)); renderSubList(); }
  }).on('input', '.sub-name', (e) => {
    const i = +$(e.target).closest('[data-i]').attr('data-i');
    const list = JSON.parse($('#sub-data').val() || '[]');
    if (list[i]) { list[i].name = $(e.target).val(); $('#sub-data').val(JSON.stringify(list)); }
  });

  $('#f-cancel').on('click', closeModal);
  $('#f-save').on('click', async () => {
    const name = $('[name=name]').val().trim();
    if (!name) { $('#form-err').text('名称必填'); return; }
    const subs = JSON.parse($('#sub-data').val() || '[]');
    const color = $('[name=color]').val().trim() || undefined;
    withConfig((cfg) => {
      if (isNew) {
        cfg.groups.push({ id: newId(), name, color, sites: [], subgroups: subs.length ? subs : undefined });
      } else {
        const target = cfg.groups.find((x) => x.id === group.id);
        target.name = name; target.color = color;
        // 子分组被删除时，站点上的引用清掉（避免孤儿引用堆积）
        const keep = new Set(subs.map((s) => s.id));
        target.subgroups = subs.length ? subs : undefined;
        target.sites.forEach((s) => {
          if (s.subgroupIds) s.subgroupIds = s.subgroupIds.filter((id) => keep.has(id));
        });
      }
    });
    closeModal();
  });
}

/* ---- 站点设置弹窗 ---- */

function settingsModal() {
  const st = state.config.settings || {};
  const options = [`<option value="">全部（默认）</option>`]
    .concat(state.config.groups.map((g) =>
      `<option value="${esc(g.id)}" ${st.defaultTab === g.id ? 'selected' : ''}>${esc(g.name)}</option>`))
    .join('');
  openModal('站点设置', `
    <div class="form-row"><label>标题</label><input name="title" value="${esc(state.config.title)}"></div>
    <div class="form-row"><label>favicon（URL 或 SVG，留空用内置）</label><input name="favicon" value="${esc(st.favicon || '')}"></div>
    <div class="form-row"><label>默认分组（无 hash 时生效）</label><select name="defaultTab">${options}</select></div>
    <div class="form-row check-row"><input type="checkbox" id="f-ping" ${st.enablePing ? 'checked' : ''}><label for="f-ping">启用连通性检测（绿点/红✕）</label></div>
    <div class="form-actions"><button type="button" id="f-cancel">取消</button><button type="button" class="primary" id="f-save">保存</button></div>
  `);
  $('#f-cancel').on('click', closeModal);
  $('#f-save').on('click', async () => {
    const title = $('[name=title]').val().trim();
    if (!title) { alert('标题必填'); return; }
    const favicon = $('[name=favicon]').val().trim();
    const dft = $('[name=defaultTab]').val();
    const enablePing = $('#f-ping').prop('checked');
    const oldPing = (state.config.settings || {}).enablePing;
    withConfig((cfg) => {
      cfg.title = title;
      cfg.settings = {
        ...(favicon ? { favicon } : {}),
        ...(dft ? { defaultTab: dft } : {}),
        enablePing,
      };
    });
    if (oldPing !== enablePing) clearPingCache();
    closeModal();
  });
}

/* ---- 编辑动作分发 ---- */

function moveItem(arr, i, dir) {
  const j = i + dir;
  if (i < 0 || j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
}

function handleEditAction(action, $el) {
  const gid = $el.attr('data-gid');
  const sid = $el.attr('data-sid');
  const group = groupOf(gid);

  switch (action) {
    case 'site-edit': siteModal(group, group.sites.find((s) => s.id === sid)); break;
    case 'site-del':
      if (!confirm('删除该链接？')) return;
      withConfig((cfg) => {
        const g = cfg.groups.find((x) => x.id === gid);
        g.sites = g.sites.filter((s) => s.id !== sid);
      });
      break;
    case 'site-copy':
      withConfig((cfg) => {
        const g = cfg.groups.find((x) => x.id === gid);
        const i = g.sites.findIndex((s) => s.id === sid);
        if (i < 0) return;
        const copy = { ...g.sites[i], id: newId(), name: g.sites[i].name + ' 副本' };
        g.sites.splice(i + 1, 0, copy);
      });
      break;
    case 'site-up': withConfig((cfg) => { const g = cfg.groups.find((x) => x.id === gid); moveItem(g.sites, g.sites.findIndex((s) => s.id === sid), -1); }); break;
    case 'site-down': withConfig((cfg) => { const g = cfg.groups.find((x) => x.id === gid); moveItem(g.sites, g.sites.findIndex((s) => s.id === sid), 1); }); break;
    case 'group-add-site': siteModal(group, null); break;
    case 'group-edit': groupModal(group); break;
    case 'group-del':
      if (!confirm(`删除分组「${group.name}」及其 ${group.sites.length} 个链接？`)) return;
      withConfig((cfg) => { cfg.groups = cfg.groups.filter((x) => x.id !== gid); });
      break;
    case 'group-up': withConfig((cfg) => moveItem(cfg.groups, cfg.groups.findIndex((x) => x.id === gid), -1)); break;
    case 'group-down': withConfig((cfg) => moveItem(cfg.groups, cfg.groups.findIndex((x) => x.id === gid), 1)); break;
  }
}

function initEditor() {
  $('#btn-admin').on('click', () => {
    state.editMode = !state.editMode;
    $('#btn-admin').toggleClass('active', state.editMode);
    $('#editbar').prop('hidden', !state.editMode);
    render();
  });
  $('#eb-new-group').on('click', () => groupModal(null));
  $('#eb-settings').on('click', settingsModal);
  $('#eb-export').on('click', () => {
    const blob = new Blob([JSON.stringify(state.config, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'config.json';
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $('#eb-import').on('click', () => $('#import-file').trigger('click'));
  $('#import-file').on('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const cfg = JSON.parse(reader.result);
        const err = validateConfigLocal(cfg);
        if (err) { alert('校验失败: ' + err); return; }
        state.config = cfg;
        if (await saveConfig()) { clearPingCache(); render(); alert('导入成功'); }
      } catch (ex) { alert('JSON 解析失败'); }
    };
    reader.readAsText(file);
    e.target.value = '';
  });
  $('#eb-reset').on('click', async () => {
    if (!confirm('放弃本地未同步的改动，重新加载服务端配置？')) return;
    await reloadConfig();
  });

  // 事件委托：tab / pill / 卡片与分组操作
  $('#tabs').on('click', '.tab', (e) => {
    state.tab = $(e.target).closest('.tab').attr('data-tab');
    state.subgroup = null;
    render();
  });
  $('#pills').on('click', '.pill', (e) => {
    state.subgroup = $(e.target).closest('.pill').attr('data-pill') || null;
    render();
  });
  $('#main').on('click', '[data-action]', (e) => {
    e.preventDefault(); e.stopPropagation();
    handleEditAction($(e.target).closest('[data-action]').attr('data-action'), $(e.target).closest('[data-action]'));
  });
}

/* ============================== feedback ============================== */

function feedbackModal() {
  openModal('提交反馈', `
    <div class="form-row"><label>内容 *</label><textarea name="content" placeholder="建议、问题或想补充的链接…"></textarea></div>
    <div class="form-row"><label>称呼（可选）</label><input name="author"></div>
    <div class="form-row"><label>联系方式（可选）</label><input name="contact" placeholder="邮箱 / 微信…"></div>
    <div class="hint">提交时自动附带当前页面位置。反馈在「后台 → 跟进」里处理。</div>
    <div class="form-error" id="form-err"></div>
    <div class="form-actions"><button type="button" id="f-cancel">取消</button><button type="button" class="primary" id="f-send">提交</button></div>
  `);
  $('#f-cancel').on('click', closeModal);
  $('#f-send').on('click', async () => {
    const content = $('[name=content]').val().trim();
    if (!content) { $('#form-err').text('内容不能为空'); return; }
    try {
      await api.postFeedback({
        content,
        author: $('[name=author]').val().trim() || null,
        contact: $('[name=contact]').val().trim() || null,
        context: window.location.hash || '(首页)',
      });
      closeModal();
      alert('已提交，感谢反馈');
    } catch (xhr) {
      $('#form-err').text('提交失败: ' + apiErrorText(xhr));
    }
  });
}

function feedbackAdminModal() {
  openModal('反馈跟进', `
    <div class="fb-filters">
      <button type="button" class="pill active" data-fb="all">全部</button>
      <button type="button" class="pill" data-fb="open">未处理</button>
      <button type="button" class="pill" data-fb="resolved">已解决</button>
    </div>
    <div id="fb-counts" class="hint" style="margin-bottom:10px;"></div>
    <div id="fb-list"></div>
  `);

  function fbItemHtml(f) {
    const open = f.status === 'open';
    return `<div class="fb-item" data-id="${f.id}">
      <div class="fb-meta">
        <span class="fb-badge ${f.status}">${open ? '未处理' : '已解决'}</span>
        <span>#${f.id}</span>
        ${f.author ? `<span>${esc(f.author)}</span>` : ''}
        ${f.contact ? `<span>联系: ${esc(f.contact)}</span>` : ''}
        <span>${esc(f.created_at)}</span>
        ${f.context ? `<span>位置: ${esc(f.context)}</span>` : ''}
      </div>
      <div class="fb-content">${esc(f.content)}</div>
      ${f.reply ? `<div class="fb-reply"><div class="label">回复</div>${esc(f.reply)}</div>` : ''}
      <div class="fb-actions">
        ${open ? `<input type="text" placeholder="回复内容（可选）" data-reply-input>` : ''}
        ${open
          ? `<button type="button" data-fb-act="reply">回复</button><button type="button" data-fb-act="resolve" class="primary">标记解决</button>`
          : `<button type="button" data-fb-act="reopen">重新打开</button>`}
      </div>
    </div>`;
  }

  async function load(status) {
    try {
      const res = await api.getFeedback(status);
      $('#fb-counts').text(`未处理 ${res.counts.open} / 共 ${res.counts.total}`);
      $('#fb-list').html(res.items.length
        ? res.items.map(fbItemHtml).join('')
        : '<div class="fb-empty">暂无反馈</div>');
    } catch (xhr) {
      $('#fb-list').html(`<div class="fb-empty">加载失败: ${esc(apiErrorText(xhr))}</div>`);
    }
  }

  $('#modal-body').on('click', '.fb-filters .pill', (e) => {
    $('.fb-filters .pill').removeClass('active');
    $(e.target).addClass('active');
    load($(e.target).attr('data-fb'));
  }).on('click', '[data-fb-act]', async (e) => {
    const $btn = $(e.target);
    const $item = $btn.closest('.fb-item');
    const id = $item.attr('data-id');
    const act = $btn.attr('data-fb-act');
    try {
      if (act === 'resolve') await api.patchFeedback(id, { status: 'resolved' });
      else if (act === 'reopen') await api.patchFeedback(id, { status: 'open' });
      else if (act === 'reply') {
        const reply = $item.find('[data-reply-input]').val().trim();
        if (!reply) { alert('回复内容为空'); return; }
        await api.patchFeedback(id, { reply });
      }
      load($('.fb-filters .pill.active').attr('data-fb'));
    } catch (xhr) { alert('操作失败: ' + apiErrorText(xhr)); }
  });

  load('all');
}

function initFeedback() {
  $('#btn-feedback').on('click', feedbackModal);
  $('#btn-feedback-admin').on('click', feedbackAdminModal);
}

/* ============================== keyboard ============================== */

function initKeyboard() {
  $(document).on('keydown', (e) => {
    const tag = (e.target.tagName || '').toUpperCase();
    if (e.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA') {
      e.preventDefault();
      $('#search').trigger('focus');
    } else if (e.key === 'Escape') {
      if (modalOpen) closeModal();
      else if (document.activeElement === $('#search')[0]) {
        $('#search').trigger('blur').val('');
        state.query = '';
        render();
      }
    }
  });
}

/* ============================== init ============================== */

async function init() {
  initTheme();
  initKeyboard();
  initFeedback();
  initEditor();

  $('#search').on('input', function () {
    state.query = $(this).val();
    render();
  });

  state.config = await api.getConfig();
  initRouter();
  render();
}

init().catch((err) => {
  $('#main').html(`<div class="empty">加载失败: ${esc(err.message || err)}<br>请确认 nav_web.py 正在运行。</div>`);
});

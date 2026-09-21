(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const session = {
    get(key) { try { return sessionStorage.getItem(`nexa.${key}`) || ''; } catch { return ''; } },
    set(key, value) { try { sessionStorage.setItem(`nexa.${key}`, value); } catch { /* A restricted browser can still use this session in memory. */ } }
  };
  const state = {
    view: 'search', mode: 'ask', sourceType: 'folder',
    base: session.get('base'), apiKey: session.get('apiKey'), adminKey: session.get('adminKey'),
    sources: [], jobs: [], health: null, meta: null, sourcesLoaded: false, sourcesError: null,
    queryController: null, querySequence: 0, previewController: null,
    deletingSource: null, polling: false, connectionSequence: 0,
    sourceSequence: 0, jobsSequence: 0, sourceBusy: false,
  };

  function el(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined && value !== null) node.textContent = String(value);
    return node;
  }

  function icon(name, className = '') {
    const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    node.setAttribute('class', `icon ${className}`.trim());
    node.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    node.append(use);
    return node;
  }

  function button(label, className, action, iconName) {
    const node = el('button', className);
    node.type = 'button';
    if (iconName) node.append(icon(iconName));
    node.append(document.createTextNode(label));
    node.addEventListener('click', action);
    return node;
  }

  function show(node, visible = true) { node.classList.toggle('hidden', !visible); }
  function count(value) { return Number.isFinite(Number(value)) ? Number(value).toLocaleString('ko-KR') : '—'; }
  function date(value) {
    if (!value) return '아직 색인하지 않음';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? String(value) : new Intl.DateTimeFormat('ko-KR', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
    }).format(parsed);
  }
  function badge(value, type = '') { return el('span', `badge ${type}`.trim(), value); }

  async function api(path, { method = 'GET', body, admin = false, signal } = {}) {
    const headers = new Headers({ Accept: 'application/json' });
    if (state.apiKey) headers.set('Authorization', `Bearer ${state.apiKey}`);
    if (admin && state.adminKey) headers.set('X-Nexa-Admin-Key', state.adminKey);
    let payload = body;
    if (body !== undefined && !(body instanceof FormData)) {
      headers.set('Content-Type', 'application/json');
      payload = JSON.stringify(body);
    }
    let response;
    try {
      response = await fetch(`${state.base}${path}`, { method, headers, body: payload, signal, credentials: 'omit', cache: 'no-store' });
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      throw new Error('API 서버에 연결할 수 없습니다. 서버 실행 상태와 연결 설정을 확인해 주세요.');
    }
    let data;
    try { data = await response.json(); }
    catch { throw new Error(`서버가 올바른 JSON 응답을 반환하지 않았습니다. (HTTP ${response.status})`); }
    if (!response.ok) {
      const error = new Error(data?.error?.message || `요청을 처리하지 못했습니다. (HTTP ${response.status})`);
      error.code = data?.error?.code;
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function toast(message, isError = false) {
    const node = el('div', `toast${isError ? ' error' : ''}`, message);
    const close = button('×', '', () => node.remove());
    close.setAttribute('aria-label', '알림 닫기');
    node.append(close);
    $('#toast-container').append(node);
    setTimeout(() => node.remove(), isError ? 10000 : 6000);
  }

  function emptyState(title, description, iconName = 'folder', action) {
    const node = el('div', 'empty-state');
    node.append(icon(iconName), el('h3', '', title), el('p', '', description));
    if (action) node.append(action);
    return node;
  }

  function errorState(error, retry) {
    const node = emptyState('불러오지 못했습니다', error.message, 'pulse', button('다시 시도', 'button button-secondary', retry, 'refresh'));
    node.classList.add('error-state');
    return node;
  }

  function setView(view, updateHash = true) {
    if (!['search', 'sources', 'jobs'].includes(view)) view = 'search';
    state.view = view;
    $$('.view').forEach(node => show(node, node.id === `view-${view}`));
    $$('.nav-item[data-view]').forEach(node => {
      const current = node.dataset.view === view;
      node.classList.toggle('active', current);
      if (current) node.setAttribute('aria-current', 'page');
      else node.removeAttribute('aria-current');
    });
    const label = { search: '지식 검색', sources: '자료 관리', jobs: '색인 작업' }[view];
    $('#breadcrumb-current').textContent = label;
    document.title = `${label} · Nexa`;
    if (updateHash && location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
    if (view === 'sources') void refreshSources();
    if (view === 'jobs') void refreshJobs();
    window.NexaKnowledge?.viewChanged(view);
  }

  function setMode(mode) {
    state.mode = mode;
    $$('.segment[data-mode]').forEach(node => {
      const active = node.dataset.mode === mode;
      node.classList.toggle('active', active);
      node.setAttribute('aria-pressed', String(active));
    });
    $('#search-mode-hint').textContent = mode === 'ask' ? '검색한 자료를 바탕으로 답변합니다' : '관련 코드와 문서를 직접 찾아봅니다';
    $('#submit-query span').textContent = mode === 'ask' ? '질문하기' : '검색하기';
  }

  function updateHealth(data) {
    state.health = data;
    const values = data?.counts || {};
    $('#stat-sources').textContent = count(values.sources);
    $('#stat-documents').textContent = count(values.documents);
    $('#stat-chunks').textContent = count(values.chunks);
    $('#nav-source-count').textContent = count(values.sources);
    show($('#empty-library'), Number(values.sources) === 0);
    const queue = data?.queue || {};
    const pending = Number(queue.queued || 0) + Number(queue.running || 0);
    $('#nav-job-count').textContent = count(pending);
    show($('#nav-job-count'), pending > 0);
    for (const service of ['generation', 'embedding', 'vector']) {
      const chip = $(`#service-${service}`);
      const ok = data?.services?.[service]?.ok === true;
      chip.classList.toggle('ok', ok);
      chip.classList.toggle('error', !ok);
      $('span', chip).textContent = ok ? '연결됨' : '연결 필요';
    }
    const allOk = ['generation', 'embedding', 'vector'].every(name => data?.services?.[name]?.ok === true);
    const connection = $('#server-state');
    connection.className = `connection-pill ${allOk ? 'ok' : ''}`;
    connection.replaceChildren(el('span', `tiny-dot ${allOk ? 'ok' : 'warning'}`), document.createTextNode(allOk ? '모든 서비스 연결됨' : '일부 서비스 연결 필요'));
    $('#connection-dot').className = `tiny-dot ${allOk ? 'ok' : 'warning'}`;
    $('#connection-label').textContent = allOk ? '워크스페이스 연결됨' : 'API 서버 연결됨';
    $('#runtime-mode').textContent = data?.mode === 'keyword' ? '키워드 검색 모드' : ['hybrid', 'full'].includes(data?.mode) ? '하이브리드 검색 모드' : '';
  }

  function healthUnavailable() {
    state.health = null;
    $('#server-state').className = 'connection-pill error';
    $('#server-state').replaceChildren(el('span', 'tiny-dot error'), document.createTextNode('서버 연결 필요'));
    $('#connection-dot').className = 'tiny-dot error';
    $('#connection-label').textContent = '서버 연결 필요';
    for (const service of ['generation', 'embedding', 'vector']) {
      const chip = $(`#service-${service}`);
      chip.classList.remove('ok');
      chip.classList.add('error');
      $('span', chip).textContent = '확인 불가';
    }
    for (const id of ['stat-sources', 'stat-documents', 'stat-chunks', 'nav-source-count']) $(`#${id}`).textContent = '—';
    $('#runtime-mode').textContent = '';
    show($('#empty-library'), false);
  }

  async function refreshHealth() {
    const version = state.connectionSequence;
    try {
      const data = await api('/api/v1/health', { signal: AbortSignal.timeout(15000) });
      if (version === state.connectionSequence) updateHealth(data);
    } catch {
      if (version === state.connectionSequence) healthUnavailable();
    }
  }

  function setOptions(select, values, defaultLabel) {
    const previous = select.value;
    select.replaceChildren(new Option(defaultLabel, ''));
    [...new Set(values.filter(value => typeof value === 'string' && value))].sort((a, b) => a.localeCompare(b)).forEach(value => select.append(new Option(value, value)));
    if ([...select.options].some(option => option.value === previous)) select.value = previous;
  }

  async function refreshMeta() {
    const version = state.connectionSequence;
    try {
      const data = await api('/api/v1/meta', { signal: AbortSignal.timeout(15000) });
      if (version !== state.connectionSequence) return;
      if (JSON.stringify(state.meta) === JSON.stringify(data)) return;
      state.meta = data;
      setOptions($('#board-filter'), data.boards || [], '전체 보드');
      setOptions($('#revision-filter'), data.revisions || [], '전체 리비전');
      for (const [id, values] of [['board-options', data.boards], ['revision-options', data.revisions]]) {
        $(`#${id}`).replaceChildren(...(values || []).map(value => new Option(value, value)));
      }
      $('#auth-info').textContent = `${data.auth?.required ? '이 서버는 API 인증을 사용합니다.' : '이 서버는 일반 조회에 API 키를 요구하지 않습니다.'} ${data.auth?.adminConfigured ? '관리자 기능에는 관리자 키가 필요합니다.' : '관리자 키 설정 여부는 서버 운영 설정을 확인하세요.'}`;
    } catch (error) {
      if (version !== state.connectionSequence) return;
      state.meta = null;
      $('#auth-info').textContent = error.status === 401 || error.status === 403 ? '서버 인증이 필요합니다. API 키를 입력해 주세요.' : '연결 후 서버의 인증 설정을 확인할 수 있습니다.';
    }
  }

  function statusBadge(status) {
    const labels = { queued: ['대기 중', 'warning'], running: ['처리 중', 'blue'], indexing: ['색인 중', 'blue'], ready: ['검색 가능', 'ok'], indexed: ['검색 가능', 'ok'], completed: ['완료', 'ok'], failed: ['실패', 'error'], error: ['오류', 'error'], warning: ['진단 확인', 'warning'], pending: ['대기 중', 'warning'], empty: ['자료 없음', ''], partial: ['일부 완료', 'warning'], disabled: ['비활성', ''] };
    const [label, type] = labels[status] || [status || '상태 미확인', ''];
    return badge(label, type);
  }

  function renderSources() {
    if (window.NexaKnowledge?.renderSources()) return;
    const container = $('#sources-list');
    $('#source-list-count').textContent = count(state.sources.length);
    if (!state.sources.length) {
      container.replaceChildren(emptyState('아직 연결된 자료가 없습니다', '서버 폴더를 등록하거나 파일을 업로드하면 Nexa가 개발 지식을 색인합니다.', 'folder', button('첫 자료 연결하기', 'button button-primary', openSourceDialog, 'plus')));
      return;
    }
    container.replaceChildren(...state.sources.map(source => {
      const node = el('article', 'source-card');
      const sourceIcon = el('div', 'source-card-icon');
      sourceIcon.append(icon(source.kind === 'upload' ? 'upload' : 'folder'));
      const content = el('div', 'source-content');
      const titleRow = el('div', 'source-title-row');
      titleRow.append(el('h3', '', source.name || '이름 없는 자료'), statusBadge(source.status));
      content.append(titleRow, el('p', 'source-path', source.path || (source.kind === 'upload' ? '업로드 자료' : '')));
      const details = el('div', 'source-details');
      const tags = el('span', 'source-tags');
      if (source.board) tags.append(badge(source.board, 'blue'));
      if (source.revision) tags.append(badge(source.revision));
      if (tags.childElementCount) details.append(tags);
      details.append(el('span', '', `문서 ${count(source.documentCount)}`), el('span', '', `지식 조각 ${count(source.chunkCount)}`), el('span', '', `최근 색인 · ${date(source.lastIndexedAt)}`));
      content.append(details);
      if (source.lastError) content.append(el('p', 'source-error', source.lastError));
      const actions = el('div', 'source-actions');
      const reindex = button('재색인', 'button button-secondary', async () => {
        reindex.disabled = true;
        try {
          await api(`/api/v1/sources/${encodeURIComponent(source.id)}/reindex`, { method: 'POST', admin: true });
          toast('재색인 작업을 등록했습니다. 색인 작업에서 진행 상황을 확인하세요.');
          await Promise.allSettled([refreshJobs(), refreshSources(), refreshHealth()]);
        } catch (error) { toast(error.message, true); }
        finally { reindex.disabled = false; }
      }, 'refresh');
      reindex.setAttribute('aria-label', `${source.name || '자료'} 재색인`);
      const remove = button('삭제', 'button button-secondary delete-button', () => openDeleteDialog(source));
      remove.setAttribute('aria-label', `${source.name || '자료'} 삭제`);
      actions.append(reindex, remove);
      node.append(sourceIcon, content, actions);
      return node;
    }));
  }

  async function refreshSources({ quiet = false } = {}) {
    const version = state.connectionSequence;
    const sequence = ++state.sourceSequence;
    try {
      const data = await api('/api/v1/sources', { signal: AbortSignal.timeout(15000) });
      if (version !== state.connectionSequence || sequence !== state.sourceSequence) return;
      const sources = Array.isArray(data.sources) ? data.sources : [];
      state.sourcesLoaded = true;
      state.sourcesError = null;
      const changed = JSON.stringify(state.sources) !== JSON.stringify(sources);
      state.sources = sources;
      if (changed || !quiet || $('#sources-list .error-state')) renderSources();
    } catch (error) {
      if (version === state.connectionSequence && sequence === state.sourceSequence) state.sourcesError = error;
      if (!quiet && version === state.connectionSequence && sequence === state.sourceSequence) $('#sources-list').replaceChildren(errorState(error, () => void refreshSources()));
    }
  }

  function renderJobs() {
    const container = $('#jobs-list');
    const jobs = window.NexaKnowledge?.filterJobs(state.jobs) || state.jobs;
    if (!jobs.length) {
      container.replaceChildren(emptyState('아직 색인 작업이 없습니다', '자료를 연결하면 분석과 색인 작업이 이곳에 표시됩니다.', 'pulse', button('자료 연결하기', 'button button-secondary', openSourceDialog, 'plus')));
      return;
    }
    const expanded = new Set($$('.job-card', container).filter(card => $('details[open]', card)).map(card => card.dataset.id));
    container.replaceChildren(...jobs.map(job => {
      const card = el('article', 'job-card');
      card.dataset.id = job.id;
      const heading = el('div', 'job-heading');
      const source = state.sources.find(value => value.id === job.sourceId);
      heading.append(el('h3', '', `${job.kind === 'version' ? 'SW 버전 보존 · ' : ''}${source?.name || `자료 ${job.sourceId || job.id}`}`), statusBadge(job.status));
      card.append(heading, el('p', 'job-message', job.message || { queued: '작업 시작을 기다리는 중입니다.', running: '자료를 분석하고 있습니다.', completed: '색인 작업이 완료되었습니다.', failed: '색인 중 오류가 발생했습니다.' }[job.status] || ''));
      const progress = el('div', `job-progress${job.status === 'completed' ? ' complete' : ''}`);
      const processed = Math.max(0, Number(job.processed) || 0);
      const total = Math.max(0, Number(job.total) || 0);
      const percent = total > 0 ? Math.min(100, processed / total * 100) : job.status === 'completed' ? 100 : 0;
      const bar = el('span');
      bar.style.width = `${percent}%`;
      progress.setAttribute('role', 'progressbar');
      progress.setAttribute('aria-label', '색인 진행률');
      progress.setAttribute('aria-valuemin', '0');
      progress.setAttribute('aria-valuemax', '100');
      if (total > 0 || job.status === 'completed') progress.setAttribute('aria-valuenow', String(Math.round(percent)));
      progress.append(bar);
      const meta = el('div', 'job-meta');
      meta.append(el('span', '', total > 0 ? `${count(processed)} / ${count(total)} 처리` : `${count(processed)} 처리`), el('span', '', `${date(job.createdAt)}${job.finishedAt ? ` → ${date(job.finishedAt)}` : ''}`));
      card.append(progress, meta);
      if (job.errors?.length) {
        const details = el('details', 'job-errors');
        details.open = expanded.has(job.id);
        const list = el('ul');
        list.append(...job.errors.map(error => el('li', '', error)));
        details.append(el('summary', '', `처리 오류 ${job.errors.length}개 보기`), list);
        card.append(details);
      }
      return card;
    }));
  }

  async function refreshJobs({ quiet = false } = {}) {
    const version = state.connectionSequence;
    const sequence = ++state.jobsSequence;
    try {
      const data = await api('/api/v1/jobs', { signal: AbortSignal.timeout(15000) });
      if (version !== state.connectionSequence || sequence !== state.jobsSequence) return;
      const oldJobs = state.jobs;
      state.jobs = Array.isArray(data.jobs) ? data.jobs : [];
      state.jobs.sort((a, b) => (new Date(b.createdAt).getTime() || 0) - (new Date(a.createdAt).getTime() || 0));
      if (JSON.stringify(oldJobs) !== JSON.stringify(state.jobs) || !quiet || $('#jobs-list .error-state')) renderJobs();
      const changed = state.jobs.some(job => ['completed', 'failed'].includes(job.status) && oldJobs.some(old => old.id === job.id && old.status !== job.status));
      if (changed) await Promise.allSettled([refreshSources({ quiet: true }), refreshMeta(), refreshHealth()]);
    } catch (error) {
      if (!quiet && version === state.connectionSequence && sequence === state.jobsSequence) $('#jobs-list').replaceChildren(errorState(error, () => void refreshJobs()));
    }
  }

  function locationLabel(hit) {
    const labels = [];
    if (hit.page) labels.push(`${hit.page}페이지`);
    if (hit.startLine) labels.push(hit.endLine && hit.endLine !== hit.startLine ? `${hit.startLine}–${hit.endLine}행` : `${hit.startLine}행`);
    return labels.join(' · ') || '문서 보기';
  }

  function citationCard(hit, index) {
    const card = button('', 'citation-card', () => void openPreview(hit));
    card.setAttribute('aria-label', `${index + 1}. ${hit.title || hit.path || '근거 문서'}, ${locationLabel(hit)} 미리보기`);
    const title = el('div', 'citation-title');
    title.append(el('span', 'citation-number', index + 1), el('span', '', hit.title || hit.path || '근거 문서'));
    const excerpt = el('div', 'citation-excerpt', hit.text || '');
    const footer = el('div', 'citation-footer');
    if (hit.board) footer.append(el('span', '', hit.board));
    if (hit.revision) footer.append(el('span', '', hit.revision));
    if (state.mode === 'search' && Array.isArray(hit.channels) && hit.channels.length) {
      footer.append(el('span', '', hit.channels.map(channel => ({ keyword: '키워드', vector: '벡터', semantic: '의미 검색', fts: '키워드' }[channel] || channel)).join(' + ')));
    }
    const location = el('span', 'citation-location', locationLabel(hit));
    location.append(icon('arrow'));
    footer.append(location);
    card.append(title, excerpt, footer);
    if (hit.path) card.title = hit.path;
    return card;
  }

  function renderResults(data, mode) {
    const area = $('#results-area');
    area.replaceChildren();
    show(area);
    show($('#overview'), false);
    const hits = mode === 'ask' ? data.citations || [] : data.hits || [];
    const toolbar = el('div', 'results-toolbar');
    toolbar.append(el('h2', '', mode === 'ask' ? '질문에 대한 답변' : `검색 결과 ${count(hits.length)}개`));
    const timing = Number.isFinite(data.timingMs) ? ` · ${(data.timingMs / 1000).toFixed(1)}초` : '';
    toolbar.append(el('span', 'result-mode', `${data.mode === 'keyword' ? '키워드 검색' : data.mode === 'hybrid' ? '하이브리드 검색' : '자료 검색'}${timing}`));
    area.append(toolbar);
    if (Array.isArray(data.warnings) && data.warnings.length) {
      const warnings = el('div', 'warning-list');
      warnings.setAttribute('role', 'note');
      warnings.append(...data.warnings.map(warning => el('div', 'warning-item', warning)));
      area.append(warnings);
    }
    if (mode === 'ask') {
      const card = el('article', 'answer-card');
      const heading = el('div', 'answer-heading');
      const label = el('span', 'answer-heading-label');
      label.append(icon('spark'), document.createTextNode(data.answerable === false ? '자료에서 확인하기 어려운 질문입니다' : 'Nexa의 답변'));
      const copy = button('', 'icon-button', async () => {
        try {
          await navigator.clipboard.writeText(data.answer || '');
          toast('답변을 복사했습니다.');
        } catch { toast('복사 권한이 없습니다. 답변을 직접 선택해 복사해 주세요.', true); }
      }, 'copy');
      copy.title = '답변 복사';
      copy.setAttribute('aria-label', '답변 복사');
      heading.append(label, copy);
      const text = el('div', 'answer-text', data.answer || '서버가 답변 내용을 반환하지 않았습니다.');
      const note = el('div', 'answer-note');
      note.append(icon('shield'), document.createTextNode('자동 생성된 답변입니다. 아래 자료에서 구현과 사양을 확인하세요.'));
      card.append(heading, text, note);
      area.append(card);
      if (hits.length) {
        const heading = el('h3', 'citations-heading');
        heading.append(icon('doc'), document.createTextNode(`답변의 근거 · ${hits.length}개 자료`));
        const grid = el('div', 'citation-grid');
        grid.append(...hits.map(citationCard));
        area.append(heading, grid);
      } else {
        area.append(el('p', 'form-note', '이번 답변에 연결된 근거 자료가 없습니다. 자료 등록 상태와 검색 조건을 확인해 주세요.'));
      }
    } else if (hits.length) {
      const list = el('div', 'result-list');
      list.append(...hits.map(citationCard));
      area.append(list);
    } else {
      area.append(emptyState('일치하는 자료를 찾지 못했습니다', '다른 표현으로 검색하거나 보드·리비전 필터를 넓혀 보세요. 필요한 자료가 색인되어 있는지도 확인해 주세요.', 'search'));
    }
  }

  function queryStatus(message, { loading = false, error = false } = {}) {
    const node = $('#query-status');
    node.replaceChildren();
    node.className = `query-status${error ? ' error' : ''}`;
    if (loading) node.append(el('span', 'status-spinner'));
    node.append(el('span', '', message));
  }

  function setQueryBusy(busy) {
    $('#submit-query').disabled = busy;
    $$('.segment[data-mode]').forEach(node => { node.disabled = busy; });
    $$('[data-question]').forEach(node => { node.disabled = busy; });
    $('#query').readOnly = busy;
    $('#board-filter').disabled = busy;
    $('#revision-filter').disabled = busy;
    show($('#cancel-query'), busy);
    $('#search-form').setAttribute('aria-busy', String(busy));
    window.NexaKnowledge?.setQueryBusy(busy);
  }

  async function submitQuery(event) {
    event?.preventDefault();
    if (state.mode === 'ask' && window.NexaKnowledge) return window.NexaKnowledge.submitQuery();
    const query = $('#query').value.trim();
    if (!query || state.queryController) return;
    if (query.length > 1200) { queryStatus('질문은 1,200자 이하로 입력해 주세요.', { error: true }); return; }
    const sequence = ++state.querySequence;
    const mode = state.mode;
    const controller = new AbortController();
    state.queryController = controller;
    setQueryBusy(true);
    show($('#results-area'), false);
    show($('#overview'), false);
    queryStatus(mode === 'ask' ? '관련 자료를 검색하고 답변을 생성하고 있습니다…' : '관련 코드와 문서를 검색하고 있습니다…', { loading: true });
    const started = performance.now();
    const slowTimer = setInterval(() => {
      if (sequence !== state.querySequence) return;
      const elapsed = Math.floor((performance.now() - started) / 1000);
      if (elapsed >= 15) queryStatus(`${mode === 'ask' ? '답변 생성' : '검색'}이 진행 중입니다. ${elapsed}초 경과${mode === 'ask' ? ' · 모델 준비나 대기열에 따라 시간이 걸릴 수 있습니다.' : ''}`, { loading: true });
    }, 5000);
    try {
      const body = { query, limit: 6 };
      Object.assign(body, window.NexaKnowledge?.searchScope() || {});
      if ($('#board-filter').value) body.board = $('#board-filter').value;
      if ($('#revision-filter').value) body.revision = $('#revision-filter').value;
      const data = await api(`/api/v1/${mode}`, { method: 'POST', body, signal: controller.signal });
      if (sequence !== state.querySequence) return;
      show($('#query-status'), false);
      renderResults(data, mode);
      window.NexaKnowledge?.decorateResults(data, body);
    } catch (error) {
      if (sequence !== state.querySequence) return;
      if (error.name === 'AbortError') {
        queryStatus('요청을 취소했습니다. 다른 질문을 입력할 수 있습니다.');
      } else {
        const authNote = error.status === 401 || error.status === 403 ? ' 연결 설정에서 API 키를 확인해 주세요.' : '';
        queryStatus(`${error.message}${authNote}`, { error: true });
      }
    } finally {
      clearInterval(slowTimer);
      if (sequence === state.querySequence) {
        state.queryController = null;
        setQueryBusy(false);
      }
    }
  }

  async function openPreview(hit) {
    if (state.previewController) state.previewController.abort();
    const controller = new AbortController();
    state.previewController = controller;
    $('#preview-title').textContent = hit.title || '문서 미리보기';
    $('#preview-meta').textContent = [hit.path, [hit.board, hit.revision, locationLabel(hit)].filter(Boolean).join(' · ')].filter(Boolean).join('\n');
    $('#preview-body').replaceChildren(el('div', 'preview-message', '문서를 불러오는 중입니다…'));
    if (!$('#preview-dialog').open) $('#preview-dialog').showModal();
    try {
      const data = await api(`/api/v1/documents/${encodeURIComponent(hit.documentId)}`, { signal: controller.signal });
      if (state.previewController !== controller) return;
      $('#preview-title').textContent = data.title || hit.title || '문서 미리보기';
      const lines = String(data.text || '').split('\n');
      const pageSize = 600;
      let offset = !hit.page && hit.startLine ? Math.floor((hit.startLine - 1) / pageSize) * pageSize : 0;
      function renderLines(focusHit = false) {
        const pre = el('pre', 'document-lines');
        pre.style.counterReset = `document-lines ${offset}`;
        const fragment = document.createDocumentFragment();
        let firstHighlight;
        lines.slice(offset, offset + pageSize).forEach((text, index) => {
          const lineNumber = offset + index + 1;
          const highlight = !hit.page && hit.startLine && lineNumber >= hit.startLine && lineNumber <= (hit.endLine || hit.startLine);
          const line = el('span', `document-line${highlight ? ' highlight' : ''}`, text.replace(/\r$/, '') || ' ');
          if (highlight && !firstHighlight) firstHighlight = line;
          fragment.append(line);
        });
        pre.append(fragment);
        const body = $('#preview-body');
        body.replaceChildren(pre);
        if (hit.page) body.prepend(el('div', 'preview-message', `검색 근거는 ${hit.page}페이지입니다. 아래 내용은 추출한 텍스트이며 원본 페이지 레이아웃과 다를 수 있습니다.`));
        if (lines.length > pageSize) {
          const navigation = el('div', 'preview-pagination');
          const previous = button('이전 구간', 'button button-secondary', () => { offset = Math.max(0, offset - pageSize); renderLines(); });
          const next = button('다음 구간', 'button button-secondary', () => { offset += pageSize; renderLines(); });
          previous.disabled = offset === 0;
          next.disabled = offset + pageSize >= lines.length;
          navigation.append(previous, el('span', '', `${count(offset + 1)}–${count(Math.min(offset + pageSize, lines.length))} / ${count(lines.length)}행`), next);
          body.prepend(navigation);
        }
        body.scrollTop = 0;
        if (focusHit && firstHighlight) requestAnimationFrame(() => { body.scrollTop = Math.max(0, firstHighlight.offsetTop - pre.offsetTop - 60); });
      }
      renderLines(true);
    } catch (error) {
      if (error.name !== 'AbortError' && state.previewController === controller) $('#preview-body').replaceChildren(el('div', 'preview-message', error.message));
    }
  }

  function setSourceType(type) {
    state.sourceType = type;
    $$('.segment[data-source-type]').forEach(node => {
      const active = node.dataset.sourceType === type;
      node.classList.toggle('active', active);
      node.setAttribute('aria-pressed', String(active));
    });
    show($('#folder-field'), type === 'folder');
    show($('#upload-field'), type === 'upload');
    $('#source-path').disabled = type !== 'folder';
    $('#source-path').required = type === 'folder';
    $('#source-files').disabled = type !== 'upload';
    $('#source-files').required = type === 'upload';
    window.NexaKnowledge?.setSourceType(type);
  }

  function openSourceDialog() {
    window.NexaKnowledge?.prepareSourceDialog();
    show($('#source-error'), false);
    if (!$('#source-dialog').open) $('#source-dialog').showModal();
  }

  async function submitSource(event) {
    event.preventDefault();
    if (state.sourceBusy) return;
    const type = state.sourceType;
    const name = $('#source-name').value.trim();
    const board = $('#source-board').value.trim();
    const revision = $('#source-revision').value.trim();
    let body;
    if (type === 'git') {
      body = { url: $('#git-url').value.trim(), branch: $('#git-branch').value.trim() || 'main', tagPattern: $('#git-tags').value.trim() || '*' };
      if (name) body.name = name;
    } else if (type === 'folder') {
      body = { path: $('#source-path').value.trim() };
      if (!body.path) { $('#source-path').focus(); return; }
      if (name) body.name = name;
      if (board) body.board = board;
      if (revision) body.revision = revision;
    } else {
      body = new FormData();
      const files = [...$('#source-files').files];
      if (!files.length) return;
      files.forEach(file => body.append('files', file));
      if (name) body.append('name', name);
      if (board) body.append('board', board);
      if (revision) body.append('revision', revision);
    }
    const extra = window.NexaKnowledge?.sourceFields() || {};
    if (body instanceof FormData) for (const [key, value] of Object.entries(extra)) body.append(key, value);
    else Object.assign(body, extra);
    state.sourceBusy = true;
    $('#submit-source').disabled = true;
    $('#submit-source').textContent = type === 'upload' ? '업로드 중…' : '자료 연결 중…';
    show($('#source-error'), false);
    try {
      await api(`/api/v1/sources/${type}`, { method: 'POST', body, admin: true });
      $('#source-dialog').close();
      $('#source-form').reset();
      setSourceType('folder');
      toast('자료를 연결했습니다. 색인 작업이 시작됩니다.');
      setView('sources');
      await Promise.allSettled([refreshSources(), refreshJobs(), refreshHealth(), refreshMeta()]);
    } catch (error) {
      $('#source-error').textContent = error.message;
      show($('#source-error'));
    } finally {
      state.sourceBusy = false;
      $('#submit-source').disabled = false;
      $('#submit-source').textContent = '연결하고 색인하기';
    }
  }

  function openDeleteDialog(source) {
    state.deletingSource = source;
    $('#confirm-description').textContent = `“${source.name || '이 자료'}”의 연결과 검색 색인을 삭제합니다. ${source.kind === 'upload' ? '서버에 업로드한 파일도 함께 삭제됩니다.' : '등록한 원본 폴더의 파일은 유지됩니다.'}`;
    show($('#delete-error'), false);
    $('#confirm-dialog').showModal();
  }

  async function deleteSource() {
    const source = state.deletingSource;
    if (!source) return;
    $('#confirm-delete').disabled = true;
    show($('#delete-error'), false);
    try {
      await api(`/api/v1/sources/${encodeURIComponent(source.id)}`, { method: 'DELETE', admin: true });
      $('#confirm-dialog').close();
      state.deletingSource = null;
      toast('자료 연결과 검색 색인을 삭제했습니다.');
      await Promise.allSettled([refreshSources(), refreshJobs(), refreshHealth(), refreshMeta()]);
    } catch (error) {
      $('#delete-error').textContent = error.message;
      show($('#delete-error'));
    } finally { $('#confirm-delete').disabled = false; }
  }

  function openSettings() {
    $('#setting-base').value = state.base;
    $('#setting-api-key').value = state.apiKey;
    $('#setting-admin-key').value = state.adminKey;
    $('#settings-dialog').showModal();
  }

  async function saveSettings(event) {
    event.preventDefault();
    let base = $('#setting-base').value.trim().replace(/\/+$/, '');
    if (base) {
      try {
        const url = new URL(base);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
        base = url.href.replace(/\/+$/, '');
      } catch {
        $('#setting-base').setCustomValidity('사용자 정보, 쿼리, 해시가 없는 http 또는 https 주소를 입력하세요.');
        $('#setting-base').reportValidity();
        return;
      }
    }
    state.queryController?.abort();
    state.previewController?.abort();
    state.connectionSequence += 1;
    state.base = base;
    state.apiKey = $('#setting-api-key').value.trim();
    state.adminKey = $('#setting-admin-key').value.trim();
    for (const key of ['base', 'apiKey', 'adminKey']) session.set(key, state[key]);
    state.sources = [];
    state.sourcesLoaded = false;
    state.sourcesError = null;
    state.jobs = [];
    setOptions($('#board-filter'), [], '전체 보드');
    setOptions($('#revision-filter'), [], '전체 리비전');
    show($('#results-area'), false);
    show($('#overview'));
    $('#settings-dialog').close();
    toast('연결 설정을 저장했습니다. 서버 상태를 확인합니다.');
    await Promise.allSettled([refreshHealth(), refreshMeta(), refreshSources(), refreshJobs(), window.NexaKnowledge?.connectionChanged()]);
  }

  async function poll() {
    if (state.polling || document.hidden) return;
    state.polling = true;
    try {
      const tasks = [refreshHealth(), refreshMeta(), refreshJobs({ quiet: true })];
      if (state.view === 'sources') tasks.push(refreshSources({ quiet: true }));
      await Promise.allSettled(tasks);
    } finally { state.polling = false; }
  }

  $$('.nav-item[data-view]').forEach(node => {
    node.setAttribute('aria-label', { search: '지식 검색', sources: '자료 관리', jobs: '색인 작업' }[node.dataset.view]);
    node.addEventListener('click', () => setView(node.dataset.view));
  });
  $$('[data-navigate]').forEach(node => node.addEventListener('click', () => setView(node.dataset.navigate)));
  $$('.segment[data-mode]').forEach(node => node.addEventListener('click', () => setMode(node.dataset.mode)));
  $$('.segment[data-source-type]').forEach(node => node.addEventListener('click', () => setSourceType(node.dataset.sourceType)));
  $$('[data-question]').forEach(node => node.addEventListener('click', () => { $('#query').value = node.dataset.question; $('#query').focus(); }));
  $$('[data-close]').forEach(node => node.addEventListener('click', () => $(`#${node.dataset.close}`).close()));
  $$('dialog').forEach(dialog => dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  }));
  $('#preview-dialog').addEventListener('close', () => { state.previewController?.abort(); state.previewController = null; });
  $('#search-form').addEventListener('submit', submitQuery);
  $('#cancel-query').addEventListener('click', () => { state.queryController?.abort(); void window.NexaKnowledge?.cancelQuery(); });
  $('#query').addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); $('#search-form').requestSubmit(); }
    if (event.key === 'Escape' && state.queryController) { event.preventDefault(); state.queryController.abort(); }
  });
  $('#add-source').addEventListener('click', openSourceDialog);
  $('#source-form').addEventListener('submit', submitSource);
  $('#refresh-sources').addEventListener('click', () => void refreshSources());
  $('#refresh-jobs').addEventListener('click', () => void refreshJobs());
  $('#confirm-delete').addEventListener('click', deleteSource);
  $('#open-settings').addEventListener('click', openSettings);
  $('#open-settings').setAttribute('aria-label', '연결 설정');
  $('#settings-form').addEventListener('submit', saveSettings);
  $('#board-filter').setAttribute('aria-label', '보드');
  $('#revision-filter').setAttribute('aria-label', '리비전');
  for (const [id, label] of [['settings-dialog', '연결 설정'], ['source-dialog', '자료 연결'], ['preview-dialog', '문서 미리보기'], ['confirm-dialog', '자료 삭제 확인']]) $(`#${id}`).setAttribute('aria-label', label);
  $('#setting-base').addEventListener('input', () => $('#setting-base').setCustomValidity(''));
  window.addEventListener('hashchange', () => setView(location.hash.slice(1), false));
  document.addEventListener('keydown', event => {
    if (event.key === '/' && !event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && !document.activeElement.isContentEditable && !$$('dialog[open]').length) {
      event.preventDefault(); setView('search'); $('#query').focus();
    }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void poll(); });
  window.Nexa = { $, $$, state, api, el, icon, button, show, count, date, badge, toast, emptyState, errorState, statusBadge, setOptions, setView, setMode, setQueryBusy, queryStatus, renderResults, citationCard, openPreview, openSourceDialog, openDeleteDialog, refreshSources, refreshJobs, refreshHealth, refreshMeta };
  setView(location.hash.slice(1) || 'search', false);
  void Promise.allSettled([refreshHealth(), refreshMeta(), refreshSources(), refreshJobs()]);
  setInterval(poll, 8000);
})();

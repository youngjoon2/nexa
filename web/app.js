(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const session = {
    get(key) { try { return sessionStorage.getItem(`nexa.${key}`) || ''; } catch { return ''; } },
    set(key, value) { try { sessionStorage.setItem(`nexa.${key}`, value); } catch { /* A restricted browser can still use this session in memory. */ } }
  };
  const state = {
    view: 'search', mode: 'ask', modeChosen: false, sourceType: 'folder',
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
  function count(value) { return Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-US') : '—'; }
  function date(value) {
    if (!value) return 'Not indexed yet';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? String(value) : new Intl.DateTimeFormat('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
    }).format(parsed);
  }
  function badge(value, type = '') { return el('span', `badge ${type}`.trim(), value); }

  async function api(path, { method = 'GET', body, admin = false, signal } = {}) {
    // Queries expose cancellation; reads and management dialogs have a deadline.
    const timeoutMs = method === 'GET' ? 15000 : /^\/api\/v1\/(ask|query|search)$/.test(path) ? 0 : 120000;
    if (timeoutMs) {
      const timeout = AbortSignal.timeout(timeoutMs);
      signal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    }
    const timeoutError = () => new Error(method === 'GET' ? 'The server took too long to respond. Try again shortly.' : 'The server took too long to respond. Check Sources and Indexing before retrying; the request may have been processed.');
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
      if (error.name === 'TimeoutError') throw timeoutError();
      throw new Error('Cannot reach the API server. Check that it is running and review your connection settings.');
    }
    let data;
    try { data = await response.json(); }
    catch (error) {
      if (signal?.reason?.name === 'TimeoutError' || error.name === 'TimeoutError') throw timeoutError();
      if (error.name === 'AbortError') throw error;
      throw new Error(`The server returned an invalid JSON response. (HTTP ${response.status})`);
    }
    if (!response.ok) {
      const error = new Error(data?.error?.message || `The request could not be processed. (HTTP ${response.status})`);
      error.code = data?.error?.code;
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function toast(message, isError = false) {
    const node = el('div', `toast${isError ? ' error' : ''}`, message);
    const close = button('×', '', () => node.remove());
    close.setAttribute('aria-label', 'Dismiss notification');
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
    const node = emptyState('Could not load data', error.message, 'pulse', button('Try again', 'button button-secondary', retry, 'refresh'));
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
    const label = { search: 'Search', sources: 'Sources', jobs: 'Indexing' }[view];
    $('#breadcrumb-current').textContent = label;
    document.title = `${label} · Nexa`;
    if (updateHash && location.hash !== `#${view}`) history.pushState(null, '', `#${view}`);
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
    $('#search-mode-hint').textContent = mode === 'ask' ? 'Get an answer based on your sources' : 'Find relevant code and documents';
    $('#submit-query span').textContent = mode === 'ask' ? 'Ask' : 'Search';
    window.NexaKnowledge?.modeChanged();
  }

  function updateHealth(data) {
    state.health = data;
    const keywordOnly = data?.mode === 'keyword';
    if (keywordOnly && !state.modeChosen && !state.queryController && $('#search-form').getAttribute('aria-busy') !== 'true') setMode('search');
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
      chip.classList.toggle('ok', !keywordOnly && ok);
      chip.classList.toggle('error', !keywordOnly && !ok);
      const providerNames = { local: 'Local', openai: 'OpenAI', anthropic: 'Claude', 'github-copilot': 'Copilot' };
      const provider = providerNames[data?.generationProvider] || 'External';
      $('span', chip).textContent = keywordOnly ? 'Disabled' : service === 'generation' && ok ? `${provider} connected` : ok ? 'Connected' : 'Disconnected';
    }
    const allOk = keywordOnly || ['generation', 'embedding', 'vector'].every(name => data?.services?.[name]?.ok === true);
    const connection = $('#server-state');
    connection.className = `connection-pill ${allOk ? 'ok' : ''}`;
    connection.replaceChildren(el('span', `tiny-dot ${allOk ? 'ok' : 'warning'}`), document.createTextNode(keywordOnly ? 'Keyword search available' : allOk ? 'All services connected' : 'Some services disconnected'));
    $('#connection-dot').className = `tiny-dot ${allOk ? 'ok' : 'warning'}`;
    $('#connection-label').textContent = allOk ? 'Workspace connected' : 'API server connected';
    $('#runtime-mode').textContent = keywordOnly ? 'Keyword search mode · AI answers disabled' : ['hybrid', 'full'].includes(data?.mode) ? 'Hybrid search mode' : '';
  }

  function healthUnavailable() {
    state.health = null;
    $('#server-state').className = 'connection-pill error';
    $('#server-state').replaceChildren(el('span', 'tiny-dot error'), document.createTextNode('Server disconnected'));
    $('#connection-dot').className = 'tiny-dot error';
    $('#connection-label').textContent = 'Server disconnected';
    for (const service of ['generation', 'embedding', 'vector']) {
      const chip = $(`#service-${service}`);
      chip.classList.remove('ok');
      chip.classList.add('error');
      $('span', chip).textContent = 'Unknown';
    }
    for (const id of ['stat-sources', 'stat-documents', 'stat-chunks', 'nav-source-count']) $(`#${id}`).textContent = '—';
    show($('#nav-job-count'), false);
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
      setOptions($('#board-filter'), data.boards || [], 'All boards');
      setOptions($('#revision-filter'), data.revisions || [], 'All revisions');
      for (const [id, values] of [['board-options', data.boards], ['revision-options', data.revisions]]) {
        $(`#${id}`).replaceChildren(...(values || []).map(value => new Option(value, value)));
      }
      $('#auth-info').textContent = `${data.auth?.required ? 'This server requires an API key.' : 'This server allows read access without an API key.'} ${data.auth?.adminConfigured ? 'Management actions require an admin key.' : 'Check the server configuration for admin key requirements.'}`;
    } catch (error) {
      if (version !== state.connectionSequence) return;
      state.meta = null;
      $('#auth-info').textContent = error.status === 401 || error.status === 403 ? 'Authentication required. Enter your API key.' : 'Connect to view the server’s authentication settings.';
    }
  }

  function statusBadge(status) {
    const labels = { queued: ['Queued', 'warning'], running: ['Processing', 'blue'], indexing: ['Indexing', 'blue'], ready: ['Ready', 'ok'], indexed: ['Ready', 'ok'], completed: ['Completed', 'ok'], failed: ['Failed', 'error'], cancelled: ['Cancelled', ''], error: ['Error', 'error'], warning: ['Review diagnostics', 'warning'], pending: ['Pending', 'warning'], empty: ['Empty', ''], partial: ['Partially complete', 'warning'], disabled: ['Disabled', ''] };
    const [label, type] = labels[status] || [status || 'Unknown', ''];
    return badge(label, type);
  }

  function renderSources() {
    if (window.NexaKnowledge?.renderSources()) return;
    const container = $('#sources-list');
    $('#source-list-count').textContent = count(state.sources.length);
    if (!state.sources.length) {
      container.replaceChildren(emptyState('No sources yet', 'Add a server folder or upload files to make them searchable.', 'folder', button('Add source', 'button button-primary', openSourceDialog, 'plus')));
      return;
    }
    container.replaceChildren(...state.sources.map(source => {
      const node = el('article', 'source-card');
      const sourceIcon = el('div', 'source-card-icon');
      sourceIcon.append(icon(source.kind === 'upload' ? 'upload' : 'folder'));
      const content = el('div', 'source-content');
      const titleRow = el('div', 'source-title-row');
      titleRow.append(el('h3', '', source.name || 'Unnamed source'), statusBadge(source.status));
      content.append(titleRow, el('p', 'source-path', source.path || (source.kind === 'upload' ? 'Uploaded files' : '')));
      const details = el('div', 'source-details');
      const tags = el('span', 'source-tags');
      if (source.board) tags.append(badge(source.board, 'blue'));
      if (source.revision) tags.append(badge(source.revision));
      if (tags.childElementCount) details.append(tags);
      details.append(el('span', '', `Source documents: ${count(source.documentCount)}`), el('span', '', `Indexed chunks: ${count(source.chunkCount)}`), el('span', '', `Last indexed · ${date(source.lastIndexedAt)}`));
      content.append(details);
      if (source.lastError) content.append(el('p', 'source-error', source.lastError));
      const actions = el('div', 'source-actions');
      const reindex = button('Reindex', 'button button-secondary', async () => {
        reindex.disabled = true;
        try {
          await api(`/api/v1/sources/${encodeURIComponent(source.id)}/reindex`, { method: 'POST', admin: true });
          toast('Reindexing queued. View progress in Indexing.');
          await Promise.allSettled([refreshJobs(), refreshSources(), refreshHealth()]);
        } catch (error) { toast(error.message, true); }
        finally { reindex.disabled = false; }
      }, 'refresh');
      reindex.setAttribute('aria-label', `Reindex ${source.name || 'source'}`);
      const remove = button('Delete', 'button button-secondary delete-button', () => openDeleteDialog(source));
      remove.setAttribute('aria-label', `Delete ${source.name || 'source'}`);
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
      container.replaceChildren(emptyState('No indexing jobs yet', 'Add a source to see its indexing progress here.', 'pulse', button('Add source', 'button button-secondary', openSourceDialog, 'plus')));
      return;
    }
    const expanded = new Set($$('.job-card', container).filter(card => $('details[open]', card)).map(card => card.dataset.id));
    container.replaceChildren(...jobs.map(job => {
      const card = el('article', 'job-card');
      card.dataset.id = job.id;
      const heading = el('div', 'job-heading');
      const source = state.sources.find(value => value.id === job.sourceId);
      heading.append(el('h3', '', `${job.kind === 'version' ? 'Version snapshot · ' : ''}${source?.name || `Source ${job.sourceId || job.id}`}`), statusBadge(job.status));
      card.append(heading, el('p', 'job-message', job.message || { queued: 'Waiting to start.', running: 'Processing source files.', completed: 'Indexing complete.', failed: 'Indexing failed.' }[job.status] || ''));
      const progress = el('div', `job-progress${job.status === 'completed' ? ' complete' : ''}`);
      const processed = Math.max(0, Number(job.processed) || 0);
      const total = Math.max(0, Number(job.total) || 0);
      const percent = total > 0 ? Math.min(100, processed / total * 100) : job.status === 'completed' ? 100 : 0;
      const bar = el('span');
      bar.style.width = `${percent}%`;
      progress.setAttribute('role', 'progressbar');
      progress.setAttribute('aria-label', 'Indexing progress');
      progress.setAttribute('aria-valuemin', '0');
      progress.setAttribute('aria-valuemax', '100');
      if (total > 0 || job.status === 'completed') progress.setAttribute('aria-valuenow', String(Math.round(percent)));
      progress.append(bar);
      const meta = el('div', 'job-meta');
      meta.append(el('span', '', total > 0 ? `${count(processed)} / ${count(total)} processed` : `${count(processed)} processed`), el('span', '', `${date(job.createdAt)}${job.finishedAt ? ` → ${date(job.finishedAt)}` : ''}`));
      card.append(progress, meta);
      if (job.errors?.length) {
        const details = el('details', 'job-errors');
        details.open = expanded.has(job.id);
        const list = el('ul');
        list.append(...job.errors.map(error => el('li', '', error)));
        details.append(el('summary', '', `View errors (${count(job.errors.length)})`), list);
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
    if (hit.page) labels.push(`Page ${hit.page}`);
    if (hit.startLine) labels.push(hit.endLine && hit.endLine !== hit.startLine ? `Lines ${hit.startLine}–${hit.endLine}` : `Line ${hit.startLine}`);
    return labels.join(' · ') || 'View document';
  }

  function citationCard(hit, index) {
    const card = button('', 'citation-card', () => void openPreview(hit));
    card.setAttribute('aria-label', `${index + 1}. Preview ${hit.title || hit.path || 'source document'}, ${locationLabel(hit)}`);
    const title = el('div', 'citation-title');
    title.append(el('span', 'citation-number', index + 1), el('span', '', hit.title || hit.path || 'Source document'));
    const excerpt = el('div', 'citation-excerpt', hit.text || '');
    const footer = el('div', 'citation-footer');
    if (hit.board) footer.append(el('span', '', hit.board));
    if (hit.revision) footer.append(el('span', '', hit.revision));
    if (state.mode === 'search' && Array.isArray(hit.channels) && hit.channels.length) {
      footer.append(el('span', '', hit.channels.map(channel => ({ keyword: 'Keyword', vector: 'Vector', semantic: 'Semantic', fts: 'Keyword' }[channel] || channel)).join(' + ')));
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
    toolbar.append(el('h2', '', mode === 'ask' ? 'Answer' : `Search results (${count(hits.length)})`));
    const timing = Number.isFinite(data.timingMs) ? ` · ${(data.timingMs / 1000).toFixed(1)}s` : '';
    toolbar.append(el('span', 'result-mode', `${data.mode === 'keyword' ? 'Keyword search' : data.mode === 'hybrid' ? 'Hybrid search' : 'Source search'}${timing}`));
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
      label.append(icon('spark'), document.createTextNode(data.answerable === false ? 'Not enough information in your sources' : 'Nexa answer'));
      const copy = button('', 'icon-button', async () => {
        try {
          await navigator.clipboard.writeText(data.answer || '');
          toast('Answer copied.');
        } catch { toast('Clipboard access was denied. Select the answer text to copy it manually.', true); }
      }, 'copy');
      copy.title = 'Copy answer';
      copy.setAttribute('aria-label', 'Copy answer');
      heading.append(label, copy);
      const text = el('div', 'answer-text', data.answer || 'The server returned no answer.');
      const note = el('div', 'answer-note');
      note.append(icon('shield'), document.createTextNode('AI-generated answer. Check the source documents below for implementation details and specifications.'));
      card.append(heading, text, note);
      area.append(card);
      if (hits.length) {
        const heading = el('h3', 'citations-heading');
        heading.append(icon('doc'), document.createTextNode(`Source documents (${count(hits.length)})`));
        const grid = el('div', 'citation-grid');
        grid.append(...hits.map(citationCard));
        area.append(heading, grid);
      } else {
        area.append(el('p', 'form-note', 'No source documents were linked to this answer. Check your sources and search filters.'));
      }
    } else if (hits.length) {
      const list = el('div', 'result-list');
      list.append(...hits.map(citationCard));
      area.append(list);
    } else {
      area.append(emptyState('No matching sources', 'Try different search terms or broaden the board and revision filters. Check that the sources you need have been indexed.', 'search'));
    }
  }

  function queryStatus(message, { loading = false, error = false } = {}) {
    const node = $('#query-status');
    node.replaceChildren();
    node.className = `query-status${error ? ' error' : ''}`;
    if (loading) node.append(el('span', 'status-spinner'));
    node.append(el('span', '', message));
  }

  function resetQuery() {
    state.querySequence += 1;
    state.queryController?.abort();
    state.queryController = null;
    setQueryBusy(false);
    $('#results-area').replaceChildren();
    show($('#results-area'), false);
    show($('#query-status'), false);
    show($('#overview'));
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
    if (!query) { queryStatus('Enter a question or search term.', { error: true }); $('#query').focus(); return; }
    if (state.queryController) return;
    if (query.length > 1200) { queryStatus('Use 1,200 characters or fewer.', { error: true }); return; }
    const sequence = ++state.querySequence;
    const mode = state.mode;
    const controller = new AbortController();
    state.queryController = controller;
    setQueryBusy(true);
    show($('#results-area'), false);
    show($('#overview'), false);
    queryStatus(mode === 'ask' ? 'Searching sources and generating an answer…' : 'Searching code and documents…', { loading: true });
    const started = performance.now();
    const slowTimer = setInterval(() => {
      if (sequence !== state.querySequence) return;
      const elapsed = Math.floor((performance.now() - started) / 1000);
      if (elapsed >= 15) queryStatus(`${mode === 'ask' ? 'Generating an answer' : 'Searching'} · ${elapsed}s elapsed${mode === 'ask' ? ' · Model startup and queued requests may take a little longer.' : ''}`, { loading: true });
    }, 5000);
    try {
      const body = { query, limit: 6 };
      Object.assign(body, window.NexaKnowledge?.searchScope() || {});
      if ($('#board-filter').value) body.board = $('#board-filter').value;
      if ($('#revision-filter').value) body.revision = $('#revision-filter').value;
      const data = await api(`/api/v1/${mode}`, { method: 'POST', body, signal: controller.signal });
      if (sequence !== state.querySequence) return;
      renderResults(data, mode);
      queryStatus(mode === 'ask' ? 'Answer ready.' : `Search complete. Results: ${count(data.hits?.length || 0)}.`);
      window.NexaKnowledge?.decorateResults(data, body);
    } catch (error) {
      if (sequence !== state.querySequence) return;
      if (error.name === 'AbortError') {
        queryStatus('Request cancelled. You can enter another question.');
      } else {
        const authNote = error.status === 401 || error.status === 403 ? ' Check your API key in Connection settings.' : '';
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
    $('#preview-title').textContent = hit.title || 'Document preview';
    $('#preview-meta').textContent = [hit.path, [hit.board, hit.revision, locationLabel(hit)].filter(Boolean).join(' · ')].filter(Boolean).join('\n');
    $('#preview-body').replaceChildren(el('div', 'preview-message', 'Loading document…'));
    if (!$('#preview-dialog').open) $('#preview-dialog').showModal();
    try {
      const data = await api(`/api/v1/documents/${encodeURIComponent(hit.documentId)}`, { signal: controller.signal });
      if (state.previewController !== controller) return;
      $('#preview-title').textContent = data.title || hit.title || 'Document preview';
      const lines = String(data.text || '').split('\n');
      const pageSize = 600;
      let offset = !hit.page && hit.startLine ? Math.floor(Math.max(0, Math.min(hit.startLine - 1, lines.length - 1)) / pageSize) * pageSize : 0;
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
        if (hit.page) body.prepend(el('div', 'preview-message', `The search result is on page ${hit.page}. The extracted text below may differ from the original page layout.`));
        if (lines.length > pageSize) {
          const navigation = el('div', 'preview-pagination');
          const previous = button('Previous', 'button button-secondary', () => { offset = Math.max(0, offset - pageSize); renderLines(); });
          const next = button('Next', 'button button-secondary', () => { offset += pageSize; renderLines(); });
          previous.disabled = offset === 0;
          next.disabled = offset + pageSize >= lines.length;
          navigation.append(previous, el('span', '', `Lines ${count(offset + 1)}–${count(Math.min(offset + pageSize, lines.length))} of ${count(lines.length)}`), next);
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

  const busyDialogs = new WeakMap();
  function setDialogBusy(dialog, busy) {
    dialog.setAttribute('aria-busy', String(busy));
    if (busy) {
      if (busyDialogs.has(dialog)) return;
      const controls = $$('button,input,select,textarea', dialog).map(node => [node, node.disabled]);
      busyDialogs.set(dialog, controls);
      controls.forEach(([node]) => { node.disabled = true; });
    } else {
      busyDialogs.get(dialog)?.forEach(([node, disabled]) => { node.disabled = disabled; });
      busyDialogs.delete(dialog);
    }
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
    setDialogBusy($('#source-dialog'), true);
    $('#submit-source').textContent = type === 'upload' ? 'Uploading…' : 'Adding source…';
    show($('#source-error'), false);
    try {
      await api(`/api/v1/sources/${type}`, { method: 'POST', body, admin: true });
      if (extra.projectId) await window.NexaKnowledge?.switchProject(extra.projectId);
      setDialogBusy($('#source-dialog'), false);
      $('#source-dialog').close();
      $('#source-form').reset();
      setSourceType('folder');
      toast('Source added. Indexing will start shortly.');
      setView('sources');
      void Promise.allSettled([refreshSources(), refreshJobs(), refreshHealth(), refreshMeta()]);
    } catch (error) {
      $('#source-error').textContent = error.message;
      show($('#source-error'));
    } finally {
      state.sourceBusy = false;
      setDialogBusy($('#source-dialog'), false);
      $('#submit-source').textContent = 'Add and index';
    }
  }

  function openDeleteDialog(source) {
    state.deletingSource = source;
    $('#confirm-description').textContent = `Delete “${source.name || 'this source'}” and its search index? ${source.kind === 'upload' ? 'Files uploaded to the server will also be deleted.' : 'Files in the original source folder will be kept.'}`;
    show($('#delete-error'), false);
    $('#confirm-dialog').showModal();
  }

  async function deleteSource() {
    const source = state.deletingSource;
    if (!source || $('#confirm-delete').disabled) return;
    setDialogBusy($('#confirm-dialog'), true);
    show($('#delete-error'), false);
    try {
      await api(`/api/v1/sources/${encodeURIComponent(source.id)}`, { method: 'DELETE', admin: true });
      $('#confirm-dialog').close();
      state.deletingSource = null;
      toast('Source and search index deleted.');
      void Promise.allSettled([refreshSources(), refreshJobs(), refreshHealth(), refreshMeta()]);
    } catch (error) {
      $('#delete-error').textContent = error.message;
      show($('#delete-error'));
    } finally { setDialogBusy($('#confirm-dialog'), false); }
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
        $('#setting-base').setCustomValidity('Enter an HTTP or HTTPS URL without credentials, a query string, or a fragment.');
        $('#setting-base').reportValidity();
        return;
      }
    }
    resetQuery();
    state.previewController?.abort();
    state.connectionSequence += 1;
    state.base = base;
    state.modeChosen = false;
    state.apiKey = $('#setting-api-key').value.trim();
    state.adminKey = $('#setting-admin-key').value.trim();
    for (const key of ['base', 'apiKey', 'adminKey']) session.set(key, state[key]);
    state.sources = [];
    state.sourcesLoaded = false;
    state.sourcesError = null;
    state.jobs = [];
    state.meta = null;
    healthUnavailable();
    setOptions($('#board-filter'), [], 'All boards');
    setOptions($('#revision-filter'), [], 'All revisions');
    $('#board-options').replaceChildren();
    $('#revision-options').replaceChildren();
    show($('#results-area'), false);
    show($('#overview'));
    $('#settings-dialog').close();
    toast('Connection settings saved. Checking server status.');
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
    node.setAttribute('aria-label', { search: 'Search', sources: 'Sources', jobs: 'Indexing' }[node.dataset.view]);
    node.addEventListener('click', () => setView(node.dataset.view));
  });
  $$('[data-navigate]').forEach(node => node.addEventListener('click', () => setView(node.dataset.navigate)));
  $$('.segment[data-mode]').forEach(node => node.addEventListener('click', () => { state.modeChosen = true; setMode(node.dataset.mode); }));
  $$('.segment[data-source-type]').forEach(node => node.addEventListener('click', () => setSourceType(node.dataset.sourceType)));
  $$('[data-question]').forEach(node => node.addEventListener('click', () => { $('#query').value = node.dataset.question; $('#query').focus(); }));
  $$('[data-close]').forEach(node => node.addEventListener('click', () => {
    const dialog = $(`#${node.dataset.close}`);
    if (dialog.getAttribute('aria-busy') !== 'true') dialog.close();
  }));
  $$('dialog').forEach(dialog => dialog.addEventListener('click', event => {
    if (event.target !== dialog || dialog.getAttribute('aria-busy') === 'true') return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  }));
  document.addEventListener('cancel', event => {
    if (event.target.getAttribute?.('aria-busy') === 'true') event.preventDefault();
  }, true);
  $('#preview-dialog').addEventListener('close', () => { state.previewController?.abort(); state.previewController = null; });
  $('#search-form').addEventListener('submit', submitQuery);
  $('#cancel-query').addEventListener('click', () => { state.queryController?.abort(); void window.NexaKnowledge?.cancelQuery(); });
  $('#query').addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.isComposing) { event.preventDefault(); $('#search-form').requestSubmit(); }
    if (event.key === 'Escape' && state.queryController) { event.preventDefault(); state.queryController.abort(); }
  });
  $('#add-source').addEventListener('click', openSourceDialog);
  $('#source-form').addEventListener('submit', submitSource);
  $('#refresh-sources').addEventListener('click', () => void refreshSources());
  $('#refresh-jobs').addEventListener('click', () => void refreshJobs());
  $('#confirm-delete').addEventListener('click', deleteSource);
  $('#open-settings').addEventListener('click', openSettings);
  $('#open-settings').setAttribute('aria-label', 'Connection settings');
  $('#settings-form').addEventListener('submit', saveSettings);
  $('#board-filter').setAttribute('aria-label', 'Board');
  $('#revision-filter').setAttribute('aria-label', 'Revision');
  for (const [id, label] of [['settings-dialog', 'Connection settings'], ['source-dialog', 'Add source'], ['preview-dialog', 'Document preview'], ['confirm-dialog', 'Confirm source deletion']]) $(`#${id}`).setAttribute('aria-label', label);
  $('#setting-base').addEventListener('input', () => $('#setting-base').setCustomValidity(''));
  window.addEventListener('hashchange', () => setView(location.hash.slice(1), false));
  document.addEventListener('keydown', event => {
    if (event.key === '/' && !event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && !document.activeElement.isContentEditable && !$$('dialog[open]').length) {
      event.preventDefault(); setView('search'); $('#query').focus();
    }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void poll(); });
  window.Nexa = { $, $$, state, api, el, icon, button, show, count, date, badge, toast, emptyState, errorState, statusBadge, setOptions, setView, setMode, setQueryBusy, resetQuery, setDialogBusy, queryStatus, renderResults, citationCard, openPreview, openSourceDialog, openDeleteDialog, refreshSources, refreshJobs, refreshHealth, refreshMeta };
  setView(location.hash.slice(1) || 'search', false);
  void Promise.allSettled([refreshHealth(), refreshMeta(), refreshSources(), refreshJobs()]);
  setInterval(poll, 8000);
})();

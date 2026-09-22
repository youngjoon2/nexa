(() => {
  'use strict';
  const N = window.Nexa;
  const { $, $$, el, button, show, api, toast, badge, date, count } = N;
  const projectSessionKey = () => `nexa.project.${N.state.base || location.origin}`;
  function savedProject() { try { return sessionStorage.getItem(projectSessionKey()) || ''; } catch { return ''; } }
  function saveProject() { try { sessionStorage.setItem(projectSessionKey(), K.projectId); } catch { /* Restricted storage still permits the current in-memory selection. */ } }
  const K = { projects: [], projectId: savedProject(), modules: [], versions: [], candidates: [], analyses: [], epoch: 0, refreshing: false, refreshDone: null, refreshController: null, analysisId: null, querying: false, queryEpoch: 0, queryController: null, queryInput: null };
  const roles = { code: 'Source code', spec: 'Specifications and docs', reference: 'Build and reference files' };
  const path = value => encodeURIComponent(value);
  const projectSources = () => N.state.sources.filter(s => (s.projectId || 'default') === K.projectId);
  const versionName = id => K.versions.find(v => v.id === id)?.name || id;
  const projectName = () => K.projects.find(p => p.id === K.projectId)?.name || 'Project';
  const active = job => ['queued', 'running'].includes(job?.status);
  function note(text) { return el('p', 'form-note', text); }
  function field(label, control, help) { const node = el('label', 'field'); node.append(document.createTextNode(label), control); if (help) node.append(el('span', '', help)); return node; }
  function input(id, placeholder, required = false) { const node = el('input'); node.id = id; node.placeholder = placeholder || ''; node.required = required; node.maxLength = 120; return node; }
  function select(id, values = [], first) { const node = el('select'); node.id = id; options(node, values, first); return node; }
  function options(node, values, first) {
    const entries = [...(first ? [{value:first[0],label:first[1]}] : []), ...values.map(value => ({value:String(value.id),label:value.label ?? value.name}))];
    if (node.options.length === entries.length && entries.every((entry, index) => node.options[index].value === entry.value && node.options[index].textContent === entry.label)) return;
    const previous = node.value;
    node.replaceChildren();
    if (first) node.append(new Option(first[1], first[0]));
    values.forEach(value => node.append(new Option(value.label ?? value.name, value.id)));
    if ([...node.options].some(o => o.value === previous)) node.value = previous;
  }
  function warningList(values, container) {
    if (!values?.length) return;
    const list = el('div', 'warning-list');
    [...new Set(values.map(x => typeof x === 'string' ? x : JSON.stringify(x)))].forEach(value => list.append(el('div', 'warning-item', value)));
    container.append(list);
  }
  function evidence(hits, container) {
    if (!hits?.length) { container.append(note('No linked evidence.')); return; }
    const list = el('div', 'kb-evidence');
    hits.forEach((hit, i) => {
      const card = N.citationCard(hit, i);
      const context = [hit.versionId && versionName(hit.versionId), hit.role && roles[hit.role], hit.table && `Table ${hit.table}`, hit.paragraph && `Paragraph ${hit.paragraph}`].filter(Boolean).join(' · ');
      if (context) card.append(note(context));
      list.append(card);
    });
    container.append(list);
  }
  function dialog(id, title) {
    const node = el('dialog', 'dialog kb-dialog'); node.id = id; node.setAttribute('aria-label', title);
    const heading = el('div', 'dialog-heading'); heading.append(el('h2', '', title), button('Close', 'text-button', () => { if (node.getAttribute('aria-busy') !== 'true') node.close(); }));
    const body = el('div', 'kb-dialog-body'); node.append(heading, body); document.body.append(node);
    return { node, body };
  }
  function formError(form, error) {
    let node = $('.form-error', form);
    if (!node) { node = el('div', 'form-error'); node.setAttribute('role', 'alert'); form.append(node); }
    node.textContent = error.message || String(error); show(node);
  }
  async function action(control, task) {
    control.disabled = true;
    try { await task(); } catch (error) { toast(error.message, true); } finally { control.disabled = false; }
  }
  function submitButton(form, label, task) {
    const submit = el('button', 'button button-primary', label); submit.type = 'submit';
    const actions = el('div', 'dialog-actions'); actions.append(submit); form.append(actions);
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (submit.disabled) return;
      const modal = form.closest('dialog');
      const old = submit.textContent; submit.textContent = 'Working…';
      if (modal) N.setDialogBusy(modal, true); else submit.disabled = true;
      if ($('.form-error', form)) show($('.form-error', form), false);
      try { await task(); } catch (error) { formError(form, error); } finally { if (modal) N.setDialogBusy(modal, false); else submit.disabled = false; submit.textContent = old; }
    });
    return submit;
  }

  // Persistent project context shared by search, connections, versions and analyses.
  const scope = el('div', 'kb-project-bar');
  const projectSelect = select('kb-project', [], ['', 'Loading projects…']);
  projectSelect.setAttribute('aria-label', 'Project');
  const projectStatus = el('span', 'kb-freshness', 'Checking sources…');
  const addProject = button('Add project', 'text-button', openProject);
  scope.append(field('Project', projectSelect), addProject, projectStatus);
  $('#main').prepend(scope);
  const queryScope = el('div', 'kb-query-scope');
  const queryMode = select('kb-query-mode', [{id:'auto',label:'Detect from question'},{id:'general',label:'General question'},{id:'feature',label:'Feature by version'},{id:'compare',label:'Compare specifications'}]);
  const moduleSelect = select('kb-module', [], ['', 'All modules']);
  const versionA = select('kb-version-a', [], ['', 'Current sources']);
  const versionB = select('kb-version-b', [], ['', 'Select version B']);
  const modeField = field('Question type', queryMode);
  const versionAField = field('Base version', versionA);
  const versionBField = field('Compare with version B', versionB);
  const featureVersions = el('div', 'kb-version-checks hidden'); featureVersions.id = 'kb-feature-versions';
  queryScope.append(modeField, field('Module', moduleSelect), versionAField, versionBField, featureVersions);
  $('.search-panel-top').after(queryScope);
  const scopeNote = note('Current sources update automatically. Saved versions use preserved copies of your files.'); scopeNote.classList.add('kb-scope-note'); queryScope.after(scopeNote);
  const oldFilters = $('.filter-group');
  oldFilters.title = 'Board and hardware revision filters';
  const maintenance = el('div', 'kb-maintenance');
  $('#view-sources .page-heading').after(maintenance);
  const versionSection = el('details', 'kb-panel'); versionSection.open = true;
  versionSection.append(el('summary', '', 'Versions and tags'));
  const versionBody = el('div', 'kb-panel-body'); versionSection.append(versionBody);
  const moduleSection = el('details', 'kb-panel'); moduleSection.append(el('summary', '', 'Module path rules'));
  const moduleBody = el('div', 'kb-panel-body'); moduleSection.append(moduleBody);
  maintenance.append(versionSection, moduleSection);
  const analysisSection = el('section', 'kb-analysis-history');
  analysisSection.append(el('h2', '', 'Analysis jobs'));
  const analysisList = el('div', 'jobs-list'); analysisSection.append(analysisList); $('#jobs-list').after(analysisSection);

  // Reuse the existing source form and session-scoped authentication.
  const gitTab = button('Git repository', 'segment', () => {
    N.state.sourceType = 'git';
    $$('[data-source-type]').forEach(node => { const yes = node.dataset.sourceType === 'git'; node.classList.toggle('active', yes); node.setAttribute('aria-pressed', String(yes)); });
    show($('#folder-field'), false); show($('#upload-field'), false);
    $('#source-path').disabled = true; $('#source-path').required = false;
    $('#source-files').disabled = true; $('#source-files').required = false;
    setSourceType('git');
  });
  gitTab.dataset.sourceType = 'git'; gitTab.setAttribute('aria-pressed', 'false'); $('.source-type-control').append(gitTab);
  const sourceProject = select('kb-source-project'); sourceProject.required = true;
  const sourceRole = select('kb-source-role', Object.entries(roles).map(([id,label]) => ({id,label}))); sourceRole.value = 'spec';
  $('.source-type-control').before(field('Project', sourceProject), field('Source role', sourceRole, 'Identifies whether files describe a specification, implement it, or include it in a build.'));
  const gitFields = el('div', 'hidden'); gitFields.id = 'kb-git-fields';
  const gitUrl = input('git-url', 'https://github.com/team/firmware.git'); gitUrl.maxLength = 2048;
  const gitBranch = input('git-branch', 'main'); gitBranch.value = 'main';
  const gitTags = input('git-tags', 'v*'); gitTags.value = '*';
  gitFields.append(field('Git repository URL', gitUrl, 'Enter an HTTPS or SSH URL. Private repositories use the server’s Git credentials.'), field('Branch to track', gitBranch), field('Tag pattern', gitTags, '* matches all tags. New tags appear here for review as version candidates.'));
  $('.source-type-control').after(gitFields);
  $('#upload-field > span').textContent = 'Supports source code, DOCX, plain text, Markdown, and PDFs with selectable text.';
  $('#sources-title').nextElementSibling.textContent = 'Manage Git repositories and document folders, review new versions, and resolve indexing errors.';
  function setSourceType(type) {
    show(gitFields, type === 'git');
    [gitUrl,gitBranch,gitTags].forEach(node => { node.disabled = type !== 'git'; }); gitUrl.required = type === 'git';
    sourceRole.value = type === 'git' ? 'code' : 'spec';
  }
  setSourceType('folder');
  function prepareSourceDialog() { options(sourceProject, K.projects); sourceProject.value = K.projectId; }
  function sourceFields() { return {projectId:sourceProject.value || K.projectId,role:sourceRole.value}; }

  function modeChanged() {
    const asking = N.state.mode === 'ask';
    const mode = asking ? queryMode.value : 'general';
    show(modeField, asking);
    show(versionAField, !asking || mode !== 'feature'); show(versionBField, asking && mode === 'compare'); show(featureVersions, asking && mode === 'feature');
    show(oldFilters, !asking || mode === 'auto' || mode === 'general');
    const first = versionA.options[0]; if (first) first.textContent = mode === 'compare' ? 'Select version A' : 'Current sources';
    scopeNote.textContent = mode === 'feature' ? 'Leave versions unselected to check all saved versions. Results distinguish specifications, code, and build evidence. Missing evidence is marked as unknown.' : mode === 'compare' ? 'Compare the selected module’s specifications from version A to B, including source text, tables, and values.' : 'Current sources update automatically. Saved versions use preserved copies of your files.';
  }
  queryMode.addEventListener('change', modeChanged); modeChanged();
  function updateSelectors() {
    options(projectSelect, K.projects, K.projects.length ? null : ['', 'Add a project']); projectSelect.value = K.projectId;
    options(sourceProject, K.projects);
    if (!$('#source-dialog').open) sourceProject.value = K.projectId;
    options(moduleSelect, K.modules, ['', 'All modules']);
    options(versionA, K.versions, ['', N.state.mode === 'ask' && queryMode.value === 'compare' ? 'Select version A' : 'Current sources']); options(versionB, K.versions, ['', 'Select version B']);
    const signature = JSON.stringify(K.versions.map(version => [version.id, version.name]));
    if (featureVersions.dataset.versions !== signature) {
      featureVersions.dataset.versions = signature;
      const selected = new Set($$('input:checked', featureVersions).map(n => n.value)); featureVersions.replaceChildren(el('span', 'form-note', 'Saved versions to check (all if none selected)'));
      K.versions.forEach(version => { const check = el('input'); check.type = 'checkbox'; check.value = version.id; check.checked = selected.has(version.id); const label = el('label', 'kb-check'); label.append(check, document.createTextNode(version.name)); featureVersions.append(label); });
      if (!K.versions.length) featureVersions.append(note('No saved versions. Create one in Sources.'));
    }
    modeChanged();
    setQueryBusy(K.querying || !!N.state.queryController);
  }
  async function refresh(quiet = false) {
    if (K.refreshing) { if (quiet) return; await K.refreshDone; return refresh(quiet); }
    K.refreshing = true;
    let finished; K.refreshDone = new Promise(resolve => { finished = resolve; });
    const controller = new AbortController(); K.refreshController = controller;
    const epoch = K.epoch, connection = N.state.connectionSequence;
    try {
      const data = await api('/api/v1/projects', {signal:controller.signal});
      if (epoch !== K.epoch || connection !== N.state.connectionSequence) return;
      K.projects = data.projects || [];
      if (!K.projects.some(p => p.id === K.projectId)) K.projectId = K.projects[0]?.id || '';
      saveProject();
      if (!K.projectId) { K.modules=[]; K.versions=[]; K.candidates=[]; K.analyses=[]; }
      else {
        const id = K.projectId;
        const results = await Promise.allSettled([api(`/api/v1/projects/${path(id)}/modules`, {signal:controller.signal}), api(`/api/v1/projects/${path(id)}/versions`, {signal:controller.signal}), api(`/api/v1/analyses?projectId=${path(id)}`, {signal:controller.signal})]);
        if (epoch !== K.epoch || connection !== N.state.connectionSequence || id !== K.projectId) return;
        if (results[0].status === 'fulfilled') K.modules=results[0].value.modules || [];
        if (results[1].status === 'fulfilled') { K.versions=results[1].value.versions || []; K.candidates=results[1].value.candidates || []; }
        if (results[2].status === 'fulfilled') K.analyses=results[2].value.jobs || [];
        const failure=results.find(r=>r.status==='rejected'); if(failure)throw failure.reason;
      }
      updateSelectors();
      // Preserve keyboard focus and expanded controls when a poll changes nothing.
      const signature = JSON.stringify([K.projectId,K.projects,K.modules,K.versions,K.candidates,K.analyses,N.state.sources,N.state.sourcesLoaded,Boolean(N.state.sourcesError)]);
      if (!quiet || K.rendered !== signature) { renderSources(); renderVersions(); renderModules(); renderAnalyses(); K.rendered = signature; }
    } catch(error) { if(epoch !== K.epoch || connection !== N.state.connectionSequence || error.name === 'AbortError')return; K.rendered=null; projectStatus.textContent='Could not load project details'; if(!quiet){versionBody.replaceChildren(N.errorState(error,()=>void refresh()));toast(error.message,true);} }
    finally { K.refreshing=false; K.refreshController=null; finished(); }
  }
  async function switchProject(id) {
    if(id===K.projectId)return;
    if (K.querying && !await cancelQuery()) { projectSelect.value = K.projectId; return; }
    N.resetQuery(); K.epoch++; K.refreshController?.abort(); K.projectId=id; saveProject(); K.modules=[]; K.versions=[]; K.candidates=[]; K.analyses=[];
    versionA.value='';versionB.value='';moduleSelect.value='';$('#board-filter').value='';$('#revision-filter').value='';
    updateSelectors(); renderSources(); renderVersions(); renderModules(); renderAnalyses();
    await Promise.allSettled([refresh(),N.refreshJobs()]);
  }
  projectSelect.addEventListener('change', () => void switchProject(projectSelect.value));
  function openProject() {
    const d=dialog('kb-project-dialog','Add project'); const form=el('form');const name=input('kb-project-name','e.g. Nexa SDK',true);
    form.append(field('Project name',name),note('Group related Git repositories and document folders in one project.'));
    submitButton(form,'Create project',async()=>{const result=await api('/api/v1/projects',{method:'POST',admin:true,body:{name:name.value.trim()}});K.projects.push(result.project);d.node.close();await switchProject(result.project.id);toast('Project created. Add a source to get started.');});
    d.body.append(form);d.node.addEventListener('close',()=>d.node.remove());d.node.showModal();
  }
  function renderSources() {
    const sources=projectSources(), container=$('#sources-list'); $('#source-list-count').textContent=count(sources.length);
    const freezeButton=$('#kb-create-version');if(freezeButton){freezeButton.disabled=!N.state.sourcesLoaded;freezeButton.textContent=N.state.sourcesLoaded?'Save current sources as a version':'Loading sources…';}
    if(!N.state.sourcesLoaded){projectStatus.textContent=N.state.sourcesError?'Could not load sources':'Loading sources…';container.replaceChildren(N.state.sourcesError?N.errorState(N.state.sourcesError,()=>void N.refreshSources()):N.emptyState('Loading sources','Fetching sources for this project.','clock'));return true;}
    const failures=sources.filter(s=>s.errors?.length||s.lastError||s.unavailable).length;
    const pending=sources.filter(s=>['queued','indexing'].includes(s.status)).length;
    const latest=sources.map(s=>s.lastCheckedAt).filter(Boolean).sort().pop();
    projectStatus.textContent=`Sources: ${sources.length} · ${N.state.sourcesError ? 'Refresh failed · Showing previous list' : failures ? `${failures} need attention` : pending ? `${pending} updating` : 'Sources checked'}${latest ? ` · Last checked ${date(latest)}` : ''}`;
    if(!sources.length){container.replaceChildren(N.emptyState('Add a source to this project','Add Git repositories and specification folders to index file changes automatically.','folder',button('Add source','button button-primary',N.openSourceDialog)));return true;}
    container.replaceChildren(...sources.map(source=>{
      const card=el('article','source-card kb-source-card'),content=el('div','source-content'),heading=el('div','source-title-row');
      heading.append(el('h3','',source.name||'Source'),N.statusBadge(source.status),badge(source.paused?'Auto-update paused':source.kind==='upload'?'Uploaded files':'Auto-update',source.paused?'warning':'blue'));
      content.append(heading,el('p','source-path',source.git?.url||source.path||''));
      const details=el('div','source-details');details.append(badge(roles[source.role]||'Specifications and docs'),el('span','',`Documents: ${count(source.documentCount)}`),el('span','',`Indexed ${date(source.lastIndexedAt)}`));
      if(source.lastCheckedAt)details.append(el('span','',`Checked ${date(source.lastCheckedAt)}`));
      if(source.git)details.append(el('span','',`Branch ${source.git.branch} · Tags ${source.git.tagPattern||'*'}`));
      content.append(details);warningList([...(source.errors||[]),...(source.lastError?[source.lastError]:[])],content);
      if(source.unavailable)content.append(note('Cannot read this source. Check which files are available in its saved snapshots.'));
      const actions=el('div','source-actions');
      for(const [label,route] of [['Sync now','sync'],['Retry failed files','retry']]){
        const control=button(label,'button button-secondary',()=>action(control,async()=>{await api(`/api/v1/sources/${path(source.id)}/${route}`,{method:'POST',admin:true});toast('Job queued.');await Promise.allSettled([N.refreshSources(),N.refreshJobs()]);}));
        if(route==='retry'&&!source.errors?.length&&!source.lastError)control.disabled=true;
        actions.append(control);
      }
      if(source.kind!=='upload'){
        const pause=button(source.paused?'Resume auto-update':'Pause','button button-secondary',()=>action(pause,async()=>{await api(`/api/v1/sources/${path(source.id)}/settings`,{method:'POST',admin:true,body:{paused:!source.paused}});await N.refreshSources();}));actions.append(pause);
      }
      actions.append(button('View files and tags','button button-secondary',()=>void openSourcePreview(source)),button('Delete','button button-secondary delete-button',()=>N.openDeleteDialog(source)));
      card.append(content,actions);return card;
    }));return true;
  }
  async function openSourcePreview(source) {
    const d=dialog('kb-source-preview',`${source.name} · Source details`);d.body.append(note('Loading files and tags…'));d.node.addEventListener('close',()=>d.node.remove());d.node.showModal();
    try{
      const data=await api(`/api/v1/sources/${path(source.id)}/preview`);if(!d.node.open)return;d.body.replaceChildren();warningList(data.errors,d.body);
      if(source.kind==='git'){
        d.body.append(el('h3','','Create a version from a tag'),note('For older tags, select the specification snapshots that match that release.'));
        const tags=select('kb-historical-tag',(data.tags||[]).map(t=>({id:t.name,label:`${t.name} · ${t.commit.slice(0,12)}`})),['','Select a tag']);
        const propose=button('Review tag','button button-secondary',()=>action(propose,async()=>{if(!tags.value)throw new Error('Select a tag.');const result=await api(`/api/v1/sources/${path(source.id)}/candidates`,{method:'POST',admin:true,body:{tag:tags.value}});await refresh();d.node.close();void openFreeze(result.candidate);}));
        const row=el('div','kb-inline');row.append(tags,propose);d.body.append(row);if(!data.tags?.length)d.body.append(note('No tags found. Sync the source or check its tag pattern.'));
      }
      d.body.append(el('h3','',`Current files (${count(data.total??data.documents?.length??0)})`));
      const list=el('div','kb-file-list');(data.documents||[]).forEach(doc=>{const item=button(doc.path||doc.title,'kb-file-button',()=>void N.openPreview({...doc,documentId:doc.id}));item.append(badge(roles[doc.role]||doc.role||'Source'),el('span','',K.modules.find(m=>m.id===doc.moduleId)?.name||'No module assigned'));list.append(item);});d.body.append(list);
      if(!data.documents?.length)d.body.append(note('No indexed files yet. Check Indexing for progress and errors.'));
      if(data.truncated)d.body.append(note(`Showing the first ${data.documents.length} files. All indexed files are searchable.`));
      const settings=el('details','kb-diff');settings.append(el('summary','','Source role and renamed documents'));
      const settingsForm=el('form'),role=select('',Object.entries(roles).map(([id,label])=>({id,label})));role.value=source.role||'spec';
      settingsForm.append(field('Source role',role),note('Map a renamed or moved document to its previous path so future version comparisons can match it. Saved versions stay unchanged.'));
      const links=el('div','kb-document-links');settingsForm.append(links);
      function addLink(current='',previous=''){
        const row=el('div','kb-document-link');const from=input('','current/document.docx'),to=input('','previous/document.docx');from.maxLength=1024;to.maxLength=1024;from.value=current;to.value=previous;from.setAttribute('aria-label','Current document path');to.setAttribute('aria-label','Previous document path');
        row.append(from,el('span','','→'),to,button('Delete','text-button',()=>row.remove()));links.append(row);
      }
      Object.entries(source.documentLinks||data.documentLinks||{}).forEach(([current,previous])=>addLink(current,previous));
      settingsForm.append(button('Add document path mapping','text-button',()=>addLink()));
      submitButton(settingsForm,'Save mappings',async()=>{
        const documentLinks={};for(const row of links.children){const [from,to]=$$('input',row);if(!from.value.trim()||!to.value.trim())throw new Error('Enter both paths or remove the empty mapping.');if(Object.hasOwn(documentLinks,from.value.trim()))throw new Error('Each current path can appear only once.');documentLinks[from.value.trim()]=to.value.trim();}
        await api(`/api/v1/sources/${path(source.id)}/settings`,{method:'POST',admin:true,body:{role:role.value,documentLinks}});toast('Source role and document mappings saved.');await N.refreshSources();
      });settings.append(settingsForm);d.body.append(settings);
      d.body.append(el('h3','',`Saved snapshots (${count(data.snapshots?.length||0)})`));
      (data.snapshots||[]).forEach(s=>{const row=el('div','kb-row');row.append(el('span','',`${date(s.createdAt)}${s.commit?` · ${s.commit.slice(0,12)}`:''}`),badge(s.complete?'Available':'Incomplete',s.complete?'ok':'warning'));d.body.append(row);});
    }catch(error){d.body.replaceChildren(N.errorState(error,()=>{d.node.close();void openSourcePreview(source);}));}
  }
  function renderModules() {
    const bar=el('div','kb-inline');bar.append(note('Path rules assign files to modules during future syncs and version creation.'),button('Add module rule','button button-secondary',()=>openModule()));moduleBody.replaceChildren(bar);
    if(!K.modules.length)moduleBody.append(note('No module rules yet. You can still search the entire project.'));
    K.modules.forEach(module=>{const row=el('div','kb-module-row');const heading=el('div','kb-inline');heading.append(el('strong','',module.name),button('Edit rules','text-button',()=>openModule(module)));row.append(heading);module.rules.forEach(rule=>row.append(el('code','',`${N.state.sources.find(s=>s.id===rule.sourceId)?.name||'All sources'}: ${rule.pattern}${rule.role?` · ${roles[rule.role]}`:''}`)));moduleBody.append(row);});
  }
  function openModule(module) {
    const d=dialog('kb-module-dialog','Module path rules');const form=el('form');const name=input('kb-module-name','e.g. UART',true);form.append(field('Module name',name),note('* matches one path segment; ** matches all subpaths. Examples: src/uart/**, docs/uart.docx. If rules overlap, the first registered module takes precedence.'));
    const rules=el('div','kb-rule-list');form.append(rules);
    function addRule(rule={}){const row=el('div','kb-rule-row');const source=select('',projectSources(),['','All sources']);source.setAttribute('aria-label','Source for this rule');source.value=rule.sourceId||'';const pattern=input('','src/module/**',true);pattern.maxLength=512;pattern.value=rule.pattern||'';pattern.setAttribute('aria-label','Module path rules');const role=select('',Object.entries(roles).map(([id,label])=>({id,label})),['','Use source role']);role.value=rule.role||'';role.setAttribute('aria-label','Source role');row.append(source,pattern,role,button('Delete','text-button',()=>{if(rules.children.length>1)row.remove();}));rules.append(row);}
    name.value=module?.name||'';if(module?.rules?.length)module.rules.forEach(addRule);else addRule();form.append(button('Add path rule','text-button',()=>addRule()));
    submitButton(form,'Save rules',async()=>{const body={name:name.value.trim(),rules:[...rules.children].map(row=>{const controls=$$('select,input',row);return {pattern:controls[1].value.trim(),...(controls[0].value?{sourceId:controls[0].value}:{}),...(controls[2].value?{role:controls[2].value}:{})};})};await api(`/api/v1/projects/${path(K.projectId)}/modules${module?`/${path(module.id)}`:''}`,{method:'POST',admin:true,body});d.node.close();await refresh();toast('Rules saved. They apply from the next sync; saved versions stay unchanged.');});
    d.body.append(form);d.node.addEventListener('close',()=>d.node.remove());d.node.showModal();
  }
  function renderVersions() {
    const bar=el('div','kb-inline');const pending=K.candidates.filter(c=>c.status==='pending');
    const create=button(N.state.sourcesLoaded?'Save current sources as a version':'Loading sources…','button button-secondary',()=>void openFreeze());create.id='kb-create-version';create.disabled=!N.state.sourcesLoaded;
    bar.append(note(`Saved versions: ${K.versions.length} · Tags to review: ${pending.length}`),create);versionBody.replaceChildren(bar);
    if(!K.versions.length&&!pending.length)versionBody.append(note('New tags appear here for review. To use an existing tag, open View files and tags on its source.'));
    pending.forEach(candidate=>{const row=el('div','kb-row');const info=el('div');info.append(el('strong','',candidate.name),note(`${candidate.automatic?'New tag':'Manually selected tag'} · ${candidate.commit.slice(0,12)} · ${date(candidate.createdAt)}`));warningList(candidate.warnings,info);row.append(info,button('Review and save version','button button-secondary',()=>void openFreeze(candidate)));versionBody.append(row);});
    K.versions.slice().reverse().forEach(version=>{const row=el('div','kb-row');const info=el('div');info.append(el('strong','',version.name),note(`Saved sources: ${Object.keys(version.snapshots||{}).length} · ${date(version.createdAt)}${version.parentVersionId?` · Revision of ${versionName(version.parentVersionId)}`:''}`));const reindex=button('Reindex saved files','text-button',()=>action(reindex,async()=>{await api(`/api/v1/versions/${path(version.id)}/reindex`,{method:'POST',admin:true});toast('Reindexing saved files. Check Indexing for progress.');await N.refreshJobs();}));row.append(info,button('View saved files','text-button',()=>void openVersion(version)),reindex);versionBody.append(row);});
  }
  async function openFreeze(candidate, parent) {
    const d=dialog('kb-freeze-dialog',candidate?'Review tag and specifications':'Save version');d.body.append(note('Loading sources and snapshots…'));d.node.addEventListener('close',()=>d.node.remove());d.node.showModal();
    const projectId=K.projectId;
    try{
      if(!N.state.sourcesLoaded){await N.refreshSources();if(!N.state.sourcesLoaded)throw new Error('Could not load sources. Check the server connection and try again.');}
      const sources=projectSources();if(!sources.length)throw new Error('Add a source to this project first.');
      const previews=await Promise.all(sources.map(async source=>({source,data:await api(`/api/v1/sources/${path(source.id)}/preview`)})));if(!d.node.open)return;
      const form=el('form'),name=input('kb-version-name','e.g. v1.2.0',true);name.value=candidate?.name||(parent?`${parent.name}-docs-2`:'');form.append(field('Version name',name));
      const parentSelect=select('kb-version-parent',K.versions,['','New version (no parent)']);if(parent)parentSelect.value=parent.id;form.append(field('Parent version',parentSelect,'For updated specifications of the same software release, select the original version. The original is preserved.'));
      if(candidate){form.append(note(`Git tag ${candidate.name} · Commit ${candidate.commit}`));warningList(candidate.warnings,form);}
      form.append(note(candidate?.automatic===false?'Current specifications are not automatically linked to older tags. Choose a snapshot from that release for each source, or exclude it.':'This version saves copies of the selected code and documents. Later source changes will not affect it.'));
      const mappings=[];
      previews.forEach(({source,data})=>{
        if(candidate&&source.id===candidate.sourceId){form.append(field(source.name,el('div','kb-fixed-value',`Pinned to tag commit ${candidate.commit.slice(0,12)}`)));return;}
        const currentLegacy=(data.snapshots||[]).some(s=>s.id===source.snapshotId&&s.legacy);
        const choices=(data.snapshots||[]).map(s=>({id:s.id,label:`${date(s.createdAt)}${s.commit?` · ${s.commit.slice(0,12)}`:''}${s.legacy?' · Source resync required':s.complete?'':' · Has errors'}`}));
        if(!candidate)choices.unshift({id:'@current',label:currentLegacy?'Current sources · Resync required':'Save currently indexed files (at submission)'});
        choices.push({id:'@exclude',label:'Exclude from this version'});
        const control=select('',choices,['','Select a snapshot']);control.required=true;control.setAttribute('aria-label',`${source.name} snapshot`);
        for(const snapshot of data.snapshots||[])if(!snapshot.complete||snapshot.legacy){const option=[...control.options].find(o=>o.value===snapshot.id);if(option)option.disabled=true;}
        if(currentLegacy){const current=[...control.options].find(o=>o.value==='@current');if(current)current.disabled=true;}
        const proposed=candidate?.snapshots?.[source.id]||parent?.snapshots?.[source.id];if(proposed&&[...control.options].some(o=>o.value===proposed&&!o.disabled))control.value=proposed;else if(!candidate&&!currentLegacy)control.value='@current';
        form.append(field(`${source.name} · ${roles[source.role]||'Source'}`,control));mappings.push({source,control});
      });
      submitButton(form,'Save version',async()=>{
        const sourceIds=candidate?[candidate.sourceId]:[],snapshots={};
        mappings.forEach(({source,control})=>{if(control.value==='@exclude')return;if(!control.value)throw new Error(`Select a snapshot for ${source.name}.`);sourceIds.push(source.id);if(control.value!=='@current')snapshots[source.id]=control.value;});
        if(!sourceIds.length)throw new Error('Select at least one source to save.');
        const body={name:name.value.trim(),sourceIds,snapshots,...(candidate?{candidateId:candidate.id}:{}),...(parentSelect.value?{parentVersionId:parentSelect.value}:{})};
        await api(`/api/v1/projects/${path(projectId)}/versions`,{method:'POST',admin:true,body});d.node.close();toast('Saving version. Check Indexing for progress.');N.setView('jobs');await Promise.allSettled([N.refreshJobs(),refresh()]);
      });d.body.replaceChildren(form);
    }catch(error){d.body.replaceChildren(N.errorState(error,()=>{d.node.close();void openFreeze(candidate,parent);}));}
  }
  async function openVersion(version) {
    const d=dialog('kb-version-dialog',`${version.name} · Saved files`);d.body.append(note('Loading saved documents…'));d.node.addEventListener('close',()=>d.node.remove());d.node.showModal();
    try{
      const data=await api(`/api/v1/versions/${path(version.id)}`);if(!d.node.open)return;d.body.replaceChildren(note(`Saved ${date(version.createdAt)} · Sources: ${Object.keys(version.snapshots||{}).length}`));
      const controls=el('div','kb-inline');controls.append(button('Create revision','button button-secondary',()=>{d.node.close();void openFreeze(null,version);}));
      const remove=button('Delete version','button button-secondary delete-button',()=>{
        const confirm=el('div','kb-confirm-inline');confirm.append(note(`Delete the saved version “${version.name}”? Connected sources will be kept.`));
        const yes=button('Delete version','button button-danger',()=>action(yes,async()=>{await api(`/api/v1/versions/${path(version.id)}`,{method:'DELETE',admin:true});d.node.close();await refresh();toast('Saved version deleted.');}));confirm.append(yes,button('Cancel','text-button',()=>confirm.remove()));controls.replaceChildren(confirm);
      });controls.append(remove);d.body.append(controls);
      const docs=data.documents||[];d.body.append(el('h3','',`Saved documents (${count(docs.length)})`));const list=el('div','kb-file-list');docs.forEach(doc=>list.append(button(doc.path||doc.title,'kb-file-button',()=>void N.openPreview({...doc,documentId:doc.id,versionId:version.id}))));d.body.append(list);if(!docs.length)d.body.append(note('No saved documents.'));
    }catch(error){d.body.replaceChildren(N.errorState(error,()=>{d.node.close();void openVersion(version);}));}
  }

  function searchScope() { return {...(K.projectId?{projectId:K.projectId}:{}),...(versionA.value?{versionId:versionA.value}:{}),...(moduleSelect.value?{moduleId:moduleSelect.value}:{})}; }
  function setQueryBusy(busy) { $$('#kb-query-mode,#kb-module,#kb-version-a,#kb-version-b,#kb-feature-versions input,#kb-project').forEach(node=>{node.disabled=busy;}); addProject.disabled=busy; }
  function queryBody() {
    const mode=queryMode.value;let versionIds;
    if(mode==='compare'){if(!versionA.value||!versionB.value||versionA.value===versionB.value)throw new Error('Select two different saved versions for A and B.');versionIds=[versionA.value,versionB.value];}
    else if(mode==='feature'){const selected=$$('input:checked',featureVersions).map(n=>n.value);if(selected.length)versionIds=selected;}
    else if(versionA.value)versionIds=[versionA.value];
    return {query:$('#query').value.trim(),projectId:K.projectId,mode,...(versionIds?{versionIds}:{}),...(moduleSelect.value?{moduleId:moduleSelect.value}:{}),...(['auto','general'].includes(mode)&&$('#board-filter').value?{board:$('#board-filter').value}:{}),...(['auto','general'].includes(mode)&&$('#revision-filter').value?{revision:$('#revision-filter').value}:{})};
  }
  async function submitQuery(override) {
    if(K.querying||N.state.queryController)return;
    let body;try{body=override||queryBody();if(!body.query){$('#query').focus();throw new Error('Enter a search or question.');}if(!body.projectId)throw new Error('Select a project.');if(body.query.length>1200)throw new Error('Keep your question to 1,200 characters or fewer.');}catch(error){N.queryStatus(error.message,{error:true});return;}
    const epoch=++K.queryEpoch;K.querying=true;K.analysisId=null;K.queryInput=body;K.queryController=new AbortController();N.setQueryBusy(true);show($('#results-area'),false);show($('#overview'),false);N.queryStatus('Checking sources and processing your question…',{loading:true});
    try{
      const data=await api('/api/v1/query',{method:'POST',body,signal:K.queryController.signal});if(epoch!==K.queryEpoch)return;
      if(data.type==='clarification'){renderClarification(data,body);show($('#query-status'),false);}
      else if(data.type==='analysis'){K.analysisId=data.job.id;await watchAnalysis(data.job,epoch);}
      else{N.renderResults(data,'ask');prependScope(body,data.scope,data.coverage);N.queryStatus('Answer ready.');}
    }catch(error){if(epoch===K.queryEpoch)N.queryStatus(error.name==='AbortError'?'Request cancelled.':error.message,{error:error.name!=='AbortError'});}
    finally{if(epoch===K.queryEpoch){K.querying=false;K.queryController=null;K.analysisId=null;N.setQueryBusy(false);}}
  }
  function prependScope(body,resolved,coverage) {
    const versions=(resolved?.versionId?[resolved.versionId]:(body.versionIds||(body.versionId?[body.versionId]:[]))).map(versionName).join(' → ')||'Current sources';
    const moduleId=resolved?.moduleId||body.moduleId;
    const sourceCoverage=coverage?` · Documents: ${count(coverage.documents)}${coverage.failed?` · ${count(coverage.failed)} failed`:''}`:'';
    $('#results-area').prepend(el('div','kb-result-scope',`${projectName()} · ${K.modules.find(m=>m.id===moduleId)?.name||'All modules'} · ${versions}${sourceCoverage}`));
  }
  function renderClarification(data,body) {
    const area=$('#results-area');area.replaceChildren(el('h2','',data.message));show(area);const choices=el('div','kb-clarification');area.append(choices);
    if(!data.choices?.length){area.append(button('Manage sources and versions','button button-secondary',()=>N.setView('sources')));return;}
    const selected=[];
    data.choices.forEach(choice=>{
      const control=button(choice.label,'button button-secondary',async()=>{
        const next={...body};
        if(choice.kind==='project'){await switchProject(choice.id);next.projectId=choice.id;delete next.versionIds;delete next.moduleId;void submitQuery(next);return;}
        if(choice.kind==='module'){next.moduleId=choice.id;moduleSelect.value=choice.id;void submitQuery(next);return;}
        if(choice.kind==='version'){
          const compare=body.mode==='compare'||/two versions|in order|두 버전|순서대로/i.test(data.message);
          if(compare){if(selected.includes(choice.id))return;selected.push(choice.id);control.disabled=true;control.textContent=`${selected.length===1?'A':'B'} · ${choice.label}`;if(selected.length<2)return;next.mode='compare';next.versionIds=[...selected];queryMode.value='compare';versionA.value=selected[0];versionB.value=selected[1];modeChanged();}
          else{next.versionIds=[choice.id];versionA.value=choice.id;}
          void submitQuery(next);
        }
      });choices.append(control);
    });
  }
  async function cancelQuery() {
    if(!K.querying)return true;const id=K.analysisId, epoch=K.queryEpoch;
    if(id){try{await api(`/api/v1/analyses/${path(id)}/cancel`,{method:'POST',signal:AbortSignal.timeout(15000)});}catch(error){if(epoch===K.queryEpoch)toast(`Could not cancel analysis: ${error.message}`,true);return false;}}
    if(epoch!==K.queryEpoch)return false;
    K.queryEpoch++;K.queryController?.abort();K.querying=false;K.analysisId=null;K.queryController=null;N.setQueryBusy(false);N.queryStatus(id?'Cancellation requested. Analysis will stop when the current model step finishes.':'Request cancelled.');void refresh(true);
    return true;
  }
  async function watchAnalysis(initial,epoch) {
    let job=initial;
    while(epoch===K.queryEpoch){
      N.queryStatus(`${job.message||'Analyzing'} · ${count(job.processed)} / ${count(job.total)}`,{loading:active(job)});
      if(job.result){renderAnalysis(job);if(active(job))$('#results-area').prepend(note('Partial results are available. Analysis of the remaining files is in progress.'));}
      if(!active(job)){
        if(job.status==='failed')throw new Error(job.error||job.message||'Analysis failed.');
        if(job.status==='cancelled')N.queryStatus(job.message||'Analysis cancelled.');else N.queryStatus('Analysis complete. Results and evidence are shown below.');
        void refresh(true);return;
      }
      await new Promise(resolve=>setTimeout(resolve,2000));if(epoch!==K.queryEpoch)return;
      const result=await api(`/api/v1/analyses/${path(job.id)}`,{signal:K.queryController?.signal});job=result.job;
    }
  }
  const states={supported:['Supported','ok'],absent:['Explicitly unsupported','warning'],unknown:['Unknown',''],conflict:['Conflicting evidence','error']};
  function findingCell(finding) {
    const cell=el('td');const [label,type]=states[finding?.state]||states.unknown;cell.append(badge(label,type),note(finding?.summary||'Not confirmed in the available sources.'));
    if(finding?.citations?.length||finding?.evidence?.length){const details=el('details','kb-finding');details.append(el('summary','',`View evidence (${finding.citations?.length||finding.evidence.length})`));(finding.evidence||[]).forEach(item=>{const quote=el('blockquote','',item.quote);quote.append(note(item.support==='absent'?'Explicitly states exclusion or lack of support':'Explicitly states inclusion or support'));details.append(quote);});evidence(finding.citations,details);cell.append(details);}warningList(finding?.warnings,cell);return cell;
  }
  function renderAnalysis(job) {
    const area=$('#results-area');area.replaceChildren();show(area);show($('#overview'),false);
    const heading=el('div','results-toolbar');heading.append(el('h2','',job.mode==='feature'?'Feature evidence by version':'Compare specifications'),N.statusBadge(job.status));area.append(heading);prependScope(job);
    area.append(note(job.query));const result=job.result;if(!result){area.append(note('No analysis results yet.'));return;}warningList(result.warnings,area);
    if(job.mode==='feature'){
      const wrapper=el('div','kb-table-wrap'),table=el('table','kb-feature-table'),head=el('tr');['Version','Specification','Implementation','Build inclusion','Coverage'].forEach(title=>head.append(el('th','',title)));const thead=el('thead');thead.append(head);table.append(thead);const tbody=el('tbody');
      (result.rows||[]).forEach(row=>{const tr=el('tr');tr.append(el('th','',row.versionName),findingCell(row.spec),findingCell(row.code),findingCell(row.build));const coverage=el('td');coverage.append(note(`Documents: ${count(row.coverage?.documents)} · Failed: ${count(row.coverage?.failed||0)}`));warningList(row.warnings,coverage);tr.append(coverage);tbody.append(tr);});table.append(tbody);wrapper.append(table);area.append(wrapper);if(!result.rows?.length)area.append(note('No completed version analyses yet.'));if(result.firstVersionNote)area.append(note(result.firstVersionNote));
    }else{
      const names=(job.versionIds||[]).map(versionName);area.append(note(`A: ${names[0]||'Version A'} · Documents: ${count(result.coverage?.before?.documents)} / B: ${names[1]||'Version B'} · Documents: ${count(result.coverage?.after?.documents)}`));
      const documents=result.documents||[];area.append(note(`Documents: ${documents.length} · ${documents.filter(d=>d.status==='modified').length} modified · ${documents.filter(d=>d.status==='added').length} added · ${documents.filter(d=>d.status==='removed').length} removed`));
      if(!documents.length)area.append(N.emptyState('No specifications to compare','Check that the selected versions and module include sources with the specifications role.','doc'));
      documents.forEach(doc=>area.append(comparisonCard(doc,names)));
    }
  }
  function comparisonCard(doc,names) {
    const details=el('details','kb-comparison');details.open=doc.status!=='unchanged';const title=el('summary');const labels={added:'Added',removed:'Removed',modified:'Modified',unchanged:'Unchanged',ambiguous:'Match needs review'};title.append(badge(labels[doc.status]||doc.status,doc.status==='ambiguous'?'warning':'blue'),document.createTextNode(doc.after?.path||doc.before?.path||doc.key));details.append(title);const body=el('div','kb-comparison-body');details.append(body);warningList(doc.warnings,body);
    (doc.summaries||[]).forEach(summary=>{const text=el('div','answer-text',summary.answer);body.append(text);evidence(summary.citations,body);});
    const bilateral=el('div','kb-bilateral');
    for(const side of ['before','after']){const block=el('div');block.append(el('h3','',`${side==='before'?'A':'B'} · ${names[side==='before'?0:1]||''}`));if(doc[side]){const link=button(doc[side].path,'text-button',()=>void N.openPreview({...doc[side],documentId:doc[side].id}));block.append(link);}else block.append(note('No matching document in this version.'));evidence(doc[`${side}Citations`],block);bilateral.append(block);}body.append(bilateral);
    (doc.hunks||[]).forEach(hunk=>{const chunk=el('details','kb-diff');chunk.open=true;chunk.append(el('summary','',`Text changes · A line ${hunk.beforeStart} / B line ${hunk.afterStart}`));const columns=el('div','kb-bilateral');for(const [side,lines] of [['before',hunk.removed],['after',hunk.added]]){const cell=el('div');cell.append(el('strong','',side==='before'?'A · Before':'B · After'),el('pre',side==='before'?'kb-diff-removed':'kb-diff-added',(lines||[]).join('\n')||'(none)'));if(hunk.numbers?.[side]?.length)cell.append(note(`Values and units: ${hunk.numbers[side].join(' · ')}`));columns.append(cell);}chunk.append(columns);body.append(chunk);});
    if(doc.tables?.before?.length||doc.tables?.after?.length){const tables=el('details','kb-diff');tables.append(el('summary','','Extracted source tables'));const columns=el('div','kb-bilateral');for(const side of ['before','after']){const cell=el('div');cell.append(el('h3','',side==='before'?'A tables':'B tables'));(doc.tables?.[side]||[]).forEach(table=>{cell.append(note(`Table ${table.table}`),el('pre','',table.text));});columns.append(cell);}tables.append(columns);body.append(tables);}
    return details;
  }
  function renderAnalyses() {
    if(!K.analyses.length){analysisList.replaceChildren(note('No feature analyses or specification comparisons yet.'));return;}
    analysisList.replaceChildren(...K.analyses.map(job=>{const card=el('article','job-card');const heading=el('div','job-heading');heading.append(el('h3','',job.query),N.statusBadge(job.status));card.append(heading,el('p','job-message',job.message||''),note(`${job.mode==='feature'?'Feature by version':'Specification comparison'} · ${date(job.createdAt)} · ${count(job.processed)} / ${count(job.total)}`));
      const controls=el('div','kb-inline');const open=button(active(job)?'View progress':'View results','button button-secondary',()=>void openAnalysis(job));controls.append(open);
      if(active(job)){const cancel=button('Cancel analysis','button button-secondary',()=>action(cancel,async()=>{await api(`/api/v1/analyses/${path(job.id)}/cancel`,{method:'POST'});await refresh();}));controls.append(cancel);}
      if(['failed','cancelled'].includes(job.status))controls.append(button('Run again','button button-secondary',()=>{
        if(K.querying||N.state.queryController){toast('Wait for the current question to finish or cancel it before running another analysis.');return;}
        applyAnalysisScope(job);void submitQuery({projectId:job.projectId,query:job.query,mode:job.mode,versionIds:job.versionIds,...(job.moduleId?{moduleId:job.moduleId}:{})});
      }));card.append(controls);if(job.error)warningList([job.error],card);return card;}));
  }
  function applyAnalysisScope(job) {
    N.setView('search');N.setMode('ask');N.state.modeChosen=true;queryMode.value=job.mode;moduleSelect.value=job.moduleId||'';versionA.value=job.versionIds?.[0]||'';versionB.value=job.versionIds?.[1]||'';
    $$('input',featureVersions).forEach(control=>{control.checked=(job.versionIds||[]).includes(control.value);});
    $('#board-filter').value='';$('#revision-filter').value='';modeChanged();$('#query').value=job.query;
  }
  async function openAnalysis(previous) {
    if(K.querying||N.state.queryController){toast('Wait for the current question to finish or cancel it before opening analysis results.');return;}
    applyAnalysisScope(previous);show($('#results-area'),false);show($('#overview'),false);N.queryStatus('Loading analysis results…',{loading:true});const epoch=++K.queryEpoch;K.querying=true;K.analysisId=previous.id;K.queryController=new AbortController();N.setQueryBusy(true);
    try{const data=await api(`/api/v1/analyses/${path(previous.id)}`,{signal:K.queryController.signal});if(epoch!==K.queryEpoch)return;renderAnalysis(data.job);await watchAnalysis(data.job,epoch);}catch(error){if(epoch===K.queryEpoch)N.queryStatus(error.message,{error:true});}finally{if(epoch===K.queryEpoch){K.querying=false;K.analysisId=null;K.queryController=null;N.setQueryBusy(false);}}
  }
  async function connectionChanged() {
    K.queryEpoch++;K.queryController?.abort();K.querying=false;K.analysisId=null;K.epoch++;K.refreshController?.abort();K.projectId=savedProject();K.projects=[];K.modules=[];K.versions=[];K.candidates=[];K.analyses=[];N.setQueryBusy(false);
    updateSelectors();renderSources();renderVersions();renderModules();renderAnalyses();await refresh();
  }
  function viewChanged(view){if(view==='sources'||view==='jobs')void refresh(true);}
  window.NexaKnowledge={renderSources,prepareSourceDialog,sourceFields,setSourceType,searchScope,setQueryBusy,modeChanged,submitQuery,cancelQuery,switchProject,connectionChanged,viewChanged,filterJobs:jobs=>jobs.filter(job=>(job.projectId||N.state.sources.find(source=>source.id===job.sourceId)?.projectId||'default')===K.projectId),decorateResults:(data,body)=>prependScope(body,data.scope,data.coverage)};
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&K.querying&&!$$('dialog[open]').length)void cancelQuery();});
  void refresh();setInterval(()=>{if(!document.hidden)void refresh(true);},8000);
})();

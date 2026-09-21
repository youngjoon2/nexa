(() => {
  'use strict';
  const N = window.Nexa;
  const { $, $$, el, button, show, api, toast, badge, date, count } = N;
  const projectSessionKey = () => `nexa.project.${N.state.base || location.origin}`;
  function savedProject() { try { return sessionStorage.getItem(projectSessionKey()) || ''; } catch { return ''; } }
  function saveProject() { try { sessionStorage.setItem(projectSessionKey(), K.projectId); } catch { /* Restricted storage still permits the current in-memory selection. */ } }
  const K = { projects: [], projectId: savedProject(), modules: [], versions: [], candidates: [], analyses: [], epoch: 0, refreshing: false, analysisId: null, querying: false, queryEpoch: 0, queryController: null, queryInput: null };
  const roles = { code: '소스코드', spec: '사양·개발 문서', reference: '빌드·참고 자료' };
  const path = value => encodeURIComponent(value);
  const projectSources = () => N.state.sources.filter(s => (s.projectId || 'default') === K.projectId);
  const versionName = id => K.versions.find(v => v.id === id)?.name || id;
  const projectName = () => K.projects.find(p => p.id === K.projectId)?.name || '프로젝트';
  const active = job => ['queued', 'running'].includes(job?.status);
  function note(text) { return el('p', 'form-note', text); }
  function field(label, control, help) { const node = el('label', 'field'); node.append(document.createTextNode(label), control); if (help) node.append(el('span', '', help)); return node; }
  function input(id, placeholder, required = false) { const node = el('input'); node.id = id; node.placeholder = placeholder || ''; node.required = required; node.maxLength = 120; return node; }
  function select(id, values = [], first) { const node = el('select'); node.id = id; options(node, values, first); return node; }
  function options(node, values, first) {
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
    if (!hits?.length) { container.append(note('연결된 근거가 없습니다.')); return; }
    const list = el('div', 'kb-evidence');
    hits.forEach((hit, i) => {
      const card = N.citationCard(hit, i);
      const context = [hit.versionId && versionName(hit.versionId), hit.role && roles[hit.role], hit.table && `표 ${hit.table}`, hit.paragraph && `문단 ${hit.paragraph}`].filter(Boolean).join(' · ');
      if (context) card.append(note(context));
      list.append(card);
    });
    container.append(list);
  }
  function dialog(id, title) {
    const node = el('dialog', 'dialog kb-dialog'); node.id = id; node.setAttribute('aria-label', title);
    const heading = el('div', 'dialog-heading'); heading.append(el('h2', '', title), button('닫기', 'text-button', () => node.close()));
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
      submit.disabled = true; const old = submit.textContent; submit.textContent = '처리 중…';
      if ($('.form-error', form)) show($('.form-error', form), false);
      try { await task(); } catch (error) { formError(form, error); } finally { submit.disabled = false; submit.textContent = old; }
    });
    return submit;
  }

  // Persistent project context shared by search, connections, versions and analyses.
  const scope = el('div', 'kb-project-bar');
  const projectSelect = select('kb-project', [], ['', '프로젝트 불러오는 중']);
  projectSelect.setAttribute('aria-label', '프로젝트');
  const projectStatus = el('span', 'kb-freshness', '자료 상태 확인 중');
  scope.append(field('프로젝트', projectSelect), button('프로젝트 추가', 'text-button', openProject), projectStatus);
  $('#main').prepend(scope);
  const queryScope = el('div', 'kb-query-scope');
  const queryMode = select('kb-query-mode', [{id:'auto',label:'질문에서 자동 선택'},{id:'general',label:'일반 질문'},{id:'feature',label:'기능이 포함된 버전'},{id:'compare',label:'두 버전 사양 비교'}]);
  const moduleSelect = select('kb-module', [], ['', '전체 모듈']);
  const versionA = select('kb-version-a', [], ['', '현재 작업 자료']);
  const versionB = select('kb-version-b', [], ['', '버전 B 선택']);
  const modeField = field('질문 유형', queryMode);
  const versionAField = field('기준 버전', versionA);
  const versionBField = field('비교 버전 B', versionB);
  const featureVersions = el('div', 'kb-version-checks hidden'); featureVersions.id = 'kb-feature-versions';
  queryScope.append(modeField, field('모듈', moduleSelect), versionAField, versionBField, featureVersions);
  $('.search-panel-top').after(queryScope);
  const scopeNote = note('현재 작업 자료는 자동 갱신됩니다. 확정 버전은 보존된 자료를 검색합니다.'); scopeNote.classList.add('kb-scope-note'); queryScope.after(scopeNote);
  const oldFilters = $('.filter-group');
  oldFilters.title = '기존 보드·하드웨어 리비전 필터';
  const maintenance = el('div', 'kb-maintenance');
  $('#view-sources .page-heading').after(maintenance);
  const versionSection = el('details', 'kb-panel'); versionSection.open = true;
  versionSection.append(el('summary', '', 'SW 버전 · 태그 검토'));
  const versionBody = el('div', 'kb-panel-body'); versionSection.append(versionBody);
  const moduleSection = el('details', 'kb-panel'); moduleSection.append(el('summary', '', '모듈 경로 규칙'));
  const moduleBody = el('div', 'kb-panel-body'); moduleSection.append(moduleBody);
  maintenance.append(versionSection, moduleSection);
  const analysisSection = el('section', 'kb-analysis-history');
  analysisSection.append(el('h2', '', '질문·비교 분석 작업'));
  const analysisList = el('div', 'jobs-list'); analysisSection.append(analysisList); $('#jobs-list').after(analysisSection);

  // Reuse the existing source form and session-scoped authentication.
  const gitTab = button('Git 원격 저장소', 'segment', () => {
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
  $('.source-type-control').before(field('프로젝트', sourceProject), field('자료 역할', sourceRole, '사양 명시·코드 구현·빌드 포함 근거를 구분하는 데 사용합니다.'));
  const gitFields = el('div', 'hidden'); gitFields.id = 'kb-git-fields';
  const gitUrl = input('git-url', 'https://github.com/team/firmware.git'); gitUrl.maxLength = 2048;
  const gitBranch = input('git-branch', 'main'); gitBranch.value = 'main';
  const gitTags = input('git-tags', 'v*'); gitTags.value = '*';
  gitFields.append(field('GitHub / Bitbucket 저장소 주소', gitUrl, 'HTTPS 또는 SSH 주소. 비공개 저장소 인증은 서버의 Git 인증 설정을 사용합니다.'), field('추적 브랜치', gitBranch), field('추적할 태그', gitTags, '*는 모든 태그입니다. 연결 이후 발견한 새 태그를 버전 후보로 제안합니다.'));
  $('.source-type-control').after(gitFields);
  $('#upload-field > span').textContent = '소스코드, DOCX, 텍스트, Markdown, 텍스트 PDF를 지원합니다.';
  $('#sources-title').nextElementSibling.textContent = 'Git과 문서 폴더를 한 번 연결하고, 새 버전과 오류 항목을 확인하세요.';
  function setSourceType(type) {
    show(gitFields, type === 'git');
    [gitUrl,gitBranch,gitTags].forEach(node => { node.disabled = type !== 'git'; }); gitUrl.required = type === 'git';
    sourceRole.value = type === 'git' ? 'code' : 'spec';
  }
  setSourceType('folder');
  function prepareSourceDialog() { options(sourceProject, K.projects); sourceProject.value = K.projectId; }
  function sourceFields() { return {projectId:sourceProject.value || K.projectId,role:sourceRole.value}; }

  function modeChanged() {
    const mode = queryMode.value;
    const asking = N.state.mode === 'ask';
    show(modeField, asking);
    show(versionAField, !asking || mode !== 'feature'); show(versionBField, asking && mode === 'compare'); show(featureVersions, asking && mode === 'feature');
    show(oldFilters, !asking || mode === 'auto' || mode === 'general');
    const first = versionA.options[0]; if (first) first.textContent = mode === 'compare' ? '버전 A 선택' : '현재 작업 자료';
    scopeNote.textContent = mode === 'feature' ? '선택하지 않으면 모든 확정 버전을 조사합니다. 사양 명시·코드 구현·빌드 포함을 따로 확인하며, 근거가 없으면 미확인으로 표시합니다.' : mode === 'compare' ? 'A → B 순서로 선택한 모듈의 전체 사양 문서를 비교합니다. 양쪽 원문·표·수치의 근거를 함께 확인하세요.' : '현재 작업 자료는 자동 갱신됩니다. 확정 버전은 보존된 자료를 검색합니다.';
  }
  queryMode.addEventListener('change', modeChanged); modeChanged();
  $$('[data-mode]').forEach(control=>control.addEventListener('click',modeChanged));
  function updateSelectors() {
    options(projectSelect, K.projects, K.projects.length ? null : ['', '프로젝트를 추가하세요']); projectSelect.value = K.projectId;
    options(sourceProject, K.projects); sourceProject.value = K.projectId;
    options(moduleSelect, K.modules, ['', '전체 모듈']);
    options(versionA, K.versions, ['', queryMode.value === 'compare' ? '버전 A 선택' : '현재 작업 자료']); options(versionB, K.versions, ['', '버전 B 선택']);
    const selected = new Set($$('input:checked', featureVersions).map(n => n.value)); featureVersions.replaceChildren(el('span', 'form-note', '조사할 확정 버전 (미선택 시 전체)'));
    K.versions.forEach(version => { const check = el('input'); check.type = 'checkbox'; check.value = version.id; check.checked = selected.has(version.id); const label = el('label', 'kb-check'); label.append(check, document.createTextNode(version.name)); featureVersions.append(label); });
    if (!K.versions.length) featureVersions.append(note('확정 버전이 없습니다. 자료 관리에서 버전을 보존하세요.'));
    setQueryBusy(K.querying || !!N.state.queryController);
  }
  async function refresh(quiet = false) {
    if (K.refreshing) return; K.refreshing = true;
    const epoch = K.epoch, connection = N.state.connectionSequence;
    try {
      const data = await api('/api/v1/projects', {signal:AbortSignal.timeout(15000)});
      if (epoch !== K.epoch || connection !== N.state.connectionSequence) return;
      K.projects = data.projects || [];
      if (!K.projects.some(p => p.id === K.projectId)) K.projectId = K.projects[0]?.id || '';
      saveProject();
      if (!K.projectId) { K.modules=[]; K.versions=[]; K.candidates=[]; K.analyses=[]; }
      else {
        const id = K.projectId;
        const results = await Promise.allSettled([api(`/api/v1/projects/${path(id)}/modules`), api(`/api/v1/projects/${path(id)}/versions`), api(`/api/v1/analyses?projectId=${path(id)}`)]);
        if (epoch !== K.epoch || connection !== N.state.connectionSequence || id !== K.projectId) return;
        if (results[0].status === 'fulfilled') K.modules=results[0].value.modules || [];
        if (results[1].status === 'fulfilled') { K.versions=results[1].value.versions || []; K.candidates=results[1].value.candidates || []; }
        if (results[2].status === 'fulfilled') K.analyses=results[2].value.jobs || [];
        const failure=results.find(r=>r.status==='rejected'); if(failure)throw failure.reason;
      }
      updateSelectors(); renderSources(); renderVersions(); renderModules(); renderAnalyses();
    } catch(error) { if(epoch !== K.epoch)return; projectStatus.textContent='프로젝트 정보를 불러오지 못했습니다'; if(!quiet){versionBody.replaceChildren(N.errorState(error,()=>void refresh()));toast(error.message,true);} }
    finally { K.refreshing=false; }
  }
  async function switchProject(id) {
    if(id===K.projectId)return; await cancelQuery(); K.epoch++; K.projectId=id; saveProject(); K.modules=[]; K.versions=[]; K.candidates=[]; K.analyses=[];
    versionA.value='';versionB.value='';moduleSelect.value=''; show($('#results-area'),false); show($('#overview'));
    updateSelectors(); renderSources(); renderVersions(); renderModules(); renderAnalyses();
    while(K.refreshing)await new Promise(resolve=>setTimeout(resolve,30)); await Promise.allSettled([refresh(),N.refreshJobs()]);
  }
  projectSelect.addEventListener('change', () => void switchProject(projectSelect.value));
  function openProject() {
    const d=dialog('kb-project-dialog','프로젝트 추가'); const form=el('form');const name=input('kb-project-name','예: Nexa SDK',true);
    form.append(field('프로젝트 이름',name),note('Git 저장소와 문서 폴더를 같은 프로젝트에 연결합니다.'));
    submitButton(form,'프로젝트 만들기',async()=>{const result=await api('/api/v1/projects',{method:'POST',admin:true,body:{name:name.value.trim()}});K.projectId=result.project.id;saveProject();d.node.close();await refresh();toast('프로젝트를 만들었습니다. 자료를 연결하세요.');});
    d.body.append(form);d.node.addEventListener('close',()=>d.node.remove());d.node.showModal();
  }
  function renderSources() {
    const sources=projectSources(), container=$('#sources-list'); $('#source-list-count').textContent=count(sources.length);
    const freezeButton=$('#kb-create-version');if(freezeButton){freezeButton.disabled=!N.state.sourcesLoaded;freezeButton.textContent=N.state.sourcesLoaded?'현재 자료로 버전 만들기':'자료 목록 불러오는 중…';}
    if(!N.state.sourcesLoaded){projectStatus.textContent=N.state.sourcesError?'연결 자료 목록 확인 필요':'연결 자료 목록을 불러오는 중';container.replaceChildren(N.state.sourcesError?N.errorState(N.state.sourcesError,()=>void N.refreshSources()):N.emptyState('연결 자료를 불러오는 중입니다','현재 프로젝트의 자료 목록을 확인하고 있습니다.','clock'));return true;}
    const failures=sources.filter(s=>s.errors?.length||s.lastError||s.unavailable).length;
    const pending=sources.filter(s=>['queued','indexing'].includes(s.status)).length;
    const latest=sources.map(s=>s.lastCheckedAt).filter(Boolean).sort().pop();
    projectStatus.textContent=`${sources.length}개 연결 · ${failures ? `확인 필요 ${failures}개` : pending ? `${pending}개 반영 중` : '자료 상태 확인됨'}${latest ? ` · 최근 확인 ${date(latest)}` : ''}`;
    if(!sources.length){container.replaceChildren(N.emptyState('프로젝트에 자료를 연결하세요','Git 저장소와 사양 문서 폴더를 등록하면 변경된 파일을 자동 반영합니다.','folder',button('자료 연결','button button-primary',N.openSourceDialog)));return true;}
    container.replaceChildren(...sources.map(source=>{
      const card=el('article','source-card kb-source-card'),content=el('div','source-content'),heading=el('div','source-title-row');
      heading.append(el('h3','',source.name||'자료'),N.statusBadge(source.status),badge(source.paused?'자동 갱신 일시 중지':source.kind==='upload'?'업로드 보관':'자동 갱신',source.paused?'warning':'blue'));
      content.append(heading,el('p','source-path',source.git?.url||source.path||''));
      const details=el('div','source-details');details.append(badge(roles[source.role]||'사양·개발 문서'),el('span','',`문서 ${count(source.documentCount)}`),el('span','',`색인 ${date(source.lastIndexedAt)}`));
      if(source.lastCheckedAt)details.append(el('span','',`변경 확인 ${date(source.lastCheckedAt)}`));
      if(source.git)details.append(el('span','',`브랜치 ${source.git.branch} · 태그 ${source.git.tagPattern||'*'}`));
      content.append(details);warningList([...(source.errors||[]),...(source.lastError?[source.lastError]:[])],content);
      if(source.unavailable)content.append(note('연결 원본을 읽을 수 없습니다. 보존된 이전 자료의 범위를 확인하세요.'));
      const actions=el('div','source-actions');
      for(const [label,route] of [['지금 갱신','sync'],['실패만 재시도','retry']]){
        const control=button(label,'button button-secondary',()=>action(control,async()=>{await api(`/api/v1/sources/${path(source.id)}/${route}`,{method:'POST',admin:true});toast(`${label} 작업을 등록했습니다.`);await Promise.allSettled([N.refreshSources(),N.refreshJobs()]);}));
        if(route==='retry'&&!source.errors?.length&&!source.lastError)control.disabled=true;
        actions.append(control);
      }
      if(source.kind!=='upload'){
        const pause=button(source.paused?'자동 갱신 재개':'일시 중지','button button-secondary',()=>action(pause,async()=>{await api(`/api/v1/sources/${path(source.id)}/settings`,{method:'POST',admin:true,body:{paused:!source.paused}});await N.refreshSources();}));actions.append(pause);
      }
      actions.append(button('파일·태그 확인','button button-secondary',()=>void openSourcePreview(source)),button('삭제','button button-secondary delete-button',()=>N.openDeleteDialog(source)));
      card.append(content,actions);return card;
    }));return true;
  }
  async function openSourcePreview(source) {
    const d=dialog('kb-source-preview',`${source.name} · 연결 자료`);d.body.append(note('파일과 태그를 불러오는 중…'));d.node.addEventListener('close',()=>d.node.remove());d.node.showModal();
    try{
      const data=await api(`/api/v1/sources/${path(source.id)}/preview`);if(!d.node.open)return;d.body.replaceChildren();warningList(data.errors,d.body);
      if(source.kind==='git'){
        d.body.append(el('h3','','태그에서 버전 후보 만들기'),note('과거 태그의 사양서는 당시 저장된 스냅샷을 직접 선택해야 합니다.'));
        const tags=select('kb-historical-tag',(data.tags||[]).map(t=>({id:t.name,label:`${t.name} · ${t.commit.slice(0,12)}`})),['','태그 선택']);
        const propose=button('선택한 태그 검토','button button-secondary',()=>action(propose,async()=>{if(!tags.value)throw new Error('태그를 선택하세요.');const result=await api(`/api/v1/sources/${path(source.id)}/candidates`,{method:'POST',admin:true,body:{tag:tags.value}});await refresh();d.node.close();void openFreeze(result.candidate);}));
        const row=el('div','kb-inline');row.append(tags,propose);d.body.append(row);if(!data.tags?.length)d.body.append(note('발견한 태그가 없습니다. 연결을 갱신하거나 태그 규칙을 확인하세요.'));
      }
      d.body.append(el('h3','',`현재 파일 ${count(data.total??data.documents?.length??0)}개`));
      const list=el('div','kb-file-list');(data.documents||[]).forEach(doc=>{const item=button(doc.path||doc.title,'kb-file-button',()=>void N.openPreview({...doc,documentId:doc.id}));item.append(badge(roles[doc.role]||doc.role||'자료'),el('span','',K.modules.find(m=>m.id===doc.moduleId)?.name||'모듈 미지정'));list.append(item);});d.body.append(list);
      if(!data.documents?.length)d.body.append(note('아직 검색에 반영된 파일이 없습니다. 색인 작업과 오류를 확인하세요.'));
      if(data.truncated)d.body.append(note(`처음 ${data.documents.length}개 파일을 표시합니다. 나머지 파일도 검색에 포함됩니다.`));
      const settings=el('details','kb-diff');settings.append(el('summary','','자료 역할·문서 이름 변경 규칙'));
      const settingsForm=el('form'),role=select('',Object.entries(roles).map(([id,label])=>({id,label})));role.value=source.role||'spec';
      settingsForm.append(field('자료 역할',role),note('같은 문서의 이름이나 경로가 바뀌면 현재 경로를 이전 경로에 연결합니다. 이후 버전의 비교에 재사용하며 이전 확정 버전은 유지됩니다.'));
      const links=el('div','kb-document-links');settingsForm.append(links);
      function addLink(current='',previous=''){
        const row=el('div','kb-document-link');const from=input('','현재/문서.docx'),to=input('','이전/문서.docx');from.maxLength=1024;to.maxLength=1024;from.value=current;to.value=previous;from.setAttribute('aria-label','현재 문서 경로');to.setAttribute('aria-label','이전 문서 경로');
        row.append(from,el('span','','→'),to,button('삭제','text-button',()=>row.remove()));links.append(row);
      }
      Object.entries(source.documentLinks||data.documentLinks||{}).forEach(([current,previous])=>addLink(current,previous));
      settingsForm.append(button('문서 경로 연결 추가','text-button',()=>addLink()));
      submitButton(settingsForm,'연결 규칙 저장',async()=>{
        const documentLinks={};for(const row of links.children){const [from,to]=$$('input',row);if(!from.value.trim()||!to.value.trim())throw new Error('현재 경로와 이전 경로를 모두 입력하거나 빈 규칙을 삭제하세요.');if(Object.hasOwn(documentLinks,from.value.trim()))throw new Error('같은 현재 경로가 중복되었습니다.');documentLinks[from.value.trim()]=to.value.trim();}
        await api(`/api/v1/sources/${path(source.id)}/settings`,{method:'POST',admin:true,body:{role:role.value,documentLinks}});toast('자료 역할과 문서 연결 규칙을 저장했습니다.');await N.refreshSources();
      });settings.append(settingsForm);d.body.append(settings);
      d.body.append(el('h3','',`보존된 스냅샷 ${count(data.snapshots?.length||0)}개`));
      (data.snapshots||[]).forEach(s=>{const row=el('div','kb-row');row.append(el('span','',`${date(s.createdAt)}${s.commit?` · ${s.commit.slice(0,12)}`:''}`),badge(s.complete?'사용 가능':'불완전',s.complete?'ok':'warning'));d.body.append(row);});
    }catch(error){d.body.replaceChildren(N.errorState(error,()=>{d.node.close();void openSourcePreview(source);}));}
  }
  function renderModules() {
    const bar=el('div','kb-inline');bar.append(note('경로 규칙을 한 번 저장하면 이후 동기화와 새 버전에 재사용합니다.'),button('모듈 규칙 추가','button button-secondary',()=>openModule()));moduleBody.replaceChildren(bar);
    if(!K.modules.length)moduleBody.append(note('등록된 규칙이 없습니다. 전체 프로젝트 검색은 그대로 사용할 수 있습니다.'));
    K.modules.forEach(module=>{const row=el('div','kb-module-row');const heading=el('div','kb-inline');heading.append(el('strong','',module.name),button('규칙 수정','text-button',()=>openModule(module)));row.append(heading);module.rules.forEach(rule=>row.append(el('code','',`${N.state.sources.find(s=>s.id===rule.sourceId)?.name||'전체 연결'}: ${rule.pattern}${rule.role?` · ${roles[rule.role]}`:''}`)));moduleBody.append(row);});
  }
  function openModule(module) {
    const d=dialog('kb-module-dialog','모듈 경로 규칙');const form=el('form');const name=input('kb-module-name','예: UART',true);form.append(field('모듈 이름',name),note('*는 한 경로 구간, **는 하위 경로 전체입니다. 예: src/uart/**, docs/uart.docx. 여러 규칙이 겹치면 먼저 등록된 모듈을 적용합니다.'));
    const rules=el('div','kb-rule-list');form.append(rules);
    function addRule(rule={}){const row=el('div','kb-rule-row');const source=select('',projectSources(),['','모든 연결']);source.setAttribute('aria-label','규칙에 적용할 연결');source.value=rule.sourceId||'';const pattern=input('','src/module/**',true);pattern.maxLength=512;pattern.value=rule.pattern||'';pattern.setAttribute('aria-label','모듈 경로 규칙');const role=select('',Object.entries(roles).map(([id,label])=>({id,label})),['','연결의 역할 사용']);role.value=rule.role||'';role.setAttribute('aria-label','자료 역할');row.append(source,pattern,role,button('삭제','text-button',()=>{if(rules.children.length>1)row.remove();}));rules.append(row);}
    name.value=module?.name||'';if(module?.rules?.length)module.rules.forEach(addRule);else addRule();form.append(button('경로 규칙 추가','text-button',()=>addRule()));
    submitButton(form,'규칙 저장',async()=>{const body={name:name.value.trim(),rules:[...rules.children].map(row=>{const controls=$$('select,input',row);return {pattern:controls[1].value.trim(),...(controls[0].value?{sourceId:controls[0].value}:{}),...(controls[2].value?{role:controls[2].value}:{})};})};await api(`/api/v1/projects/${path(K.projectId)}/modules${module?`/${path(module.id)}`:''}`,{method:'POST',admin:true,body});d.node.close();await refresh();toast('규칙을 저장했습니다. 다음 갱신부터 적용되며 이전 확정 버전은 유지됩니다.');});
    d.body.append(form);d.node.addEventListener('close',()=>d.node.remove());d.node.showModal();
  }
  function renderVersions() {
    const bar=el('div','kb-inline');const pending=K.candidates.filter(c=>c.status==='pending');
    const create=button(N.state.sourcesLoaded?'현재 자료로 버전 만들기':'자료 목록 불러오는 중…','button button-secondary',()=>void openFreeze());create.id='kb-create-version';create.disabled=!N.state.sourcesLoaded;
    bar.append(note(`확정 ${K.versions.length}개 · 검토할 태그 ${pending.length}개`),create);versionBody.replaceChildren(bar);
    if(!K.versions.length&&!pending.length)versionBody.append(note('새 태그를 발견하면 이곳에 후보를 제안합니다. 기존 태그는 연결의 파일·태그 확인에서 선택하세요.'));
    pending.forEach(candidate=>{const row=el('div','kb-row');const info=el('div');info.append(el('strong','',candidate.name),note(`${candidate.automatic?'새 태그':'직접 선택한 태그'} · ${candidate.commit.slice(0,12)} · ${date(candidate.createdAt)}`));warningList(candidate.warnings,info);row.append(info,button('연결 사양 검토·확정','button button-secondary',()=>void openFreeze(candidate)));versionBody.append(row);});
    K.versions.slice().reverse().forEach(version=>{const row=el('div','kb-row');const info=el('div');info.append(el('strong','',version.name),note(`${Object.keys(version.snapshots||{}).length}개 연결 보존 · ${date(version.createdAt)}${version.parentVersionId?` · ${versionName(version.parentVersionId)}의 자료 개정본`:''}`));const reindex=button('보존 자료 재색인','text-button',()=>action(reindex,async()=>{await api(`/api/v1/versions/${path(version.id)}/reindex`,{method:'POST',admin:true});toast('보존된 원문으로 새 색인을 만듭니다. 색인 작업에서 확인하세요.');await N.refreshJobs();}));row.append(info,button('보존 자료 보기','text-button',()=>void openVersion(version)),reindex);versionBody.append(row);});
  }
  async function openFreeze(candidate, parent) {
    const d=dialog('kb-freeze-dialog',candidate?'태그와 연결 사양 검토':'SW 버전 보존');d.body.append(note('보존할 연결과 스냅샷을 불러오는 중…'));d.node.addEventListener('close',()=>d.node.remove());d.node.showModal();
    const projectId=K.projectId;
    try{
      if(!N.state.sourcesLoaded){await N.refreshSources();if(!N.state.sourcesLoaded)throw new Error('연결 자료 목록을 불러오지 못했습니다. 서버 연결을 확인하고 다시 시도하세요.');}
      const sources=projectSources();if(!sources.length)throw new Error('먼저 프로젝트에 자료를 연결하세요.');
      const previews=await Promise.all(sources.map(async source=>({source,data:await api(`/api/v1/sources/${path(source.id)}/preview`)})));if(!d.node.open)return;
      const form=el('form'),name=input('kb-version-name','예: v1.2.0',true);name.value=candidate?.name||(parent?`${parent.name}-docs-2`:'');form.append(field('SW 버전 이름',name));
      const parentSelect=select('kb-version-parent',K.versions,['','새 버전 (개정 관계 없음)']);if(parent)parentSelect.value=parent.id;form.append(field('이전 자료 개정본',parentSelect,'동일 SW 버전의 사양 보완본이면 원래 버전을 지정합니다. 기존 버전은 보존됩니다.'));
      if(candidate){form.append(note(`Git 태그 ${candidate.name} · 커밋 ${candidate.commit}`));warningList(candidate.warnings,form);}
      form.append(note(candidate?.automatic===false?'과거 태그에는 현재 사양서를 자동 연결하지 않습니다. 각 자료의 당시 스냅샷을 선택하거나 명시적으로 제외하세요.':'버전에는 선택한 코드와 문서 내용을 함께 보존합니다. 이후 원본 변경은 이 버전을 바꾸지 않습니다.'));
      const mappings=[];
      previews.forEach(({source,data})=>{
        if(candidate&&source.id===candidate.sourceId){form.append(field(source.name,el('div','kb-fixed-value',`태그 커밋 ${candidate.commit.slice(0,12)} 고정`)));return;}
        const currentLegacy=(data.snapshots||[]).some(s=>s.id===source.snapshotId&&s.legacy);
        const choices=(data.snapshots||[]).map(s=>({id:s.id,label:`${date(s.createdAt)}${s.commit?` · ${s.commit.slice(0,12)}`:''}${s.legacy?' · 원문 재동기화 필요':s.complete?'':' · 오류 있음'}`}));
        if(!candidate)choices.unshift({id:'@current',label:currentLegacy?'현재 자료 · 원문 재동기화 필요':'현재 색인된 자료 보존 (확정 요청 시점)'});
        choices.push({id:'@exclude',label:'이 버전에서 제외'});
        const control=select('',choices,['','보존할 자료 시점 선택']);control.required=true;control.setAttribute('aria-label',`${source.name} 스냅샷`);
        for(const snapshot of data.snapshots||[])if(!snapshot.complete||snapshot.legacy){const option=[...control.options].find(o=>o.value===snapshot.id);if(option)option.disabled=true;}
        if(currentLegacy){const current=[...control.options].find(o=>o.value==='@current');if(current)current.disabled=true;}
        const proposed=candidate?.snapshots?.[source.id]||parent?.snapshots?.[source.id];if(proposed&&[...control.options].some(o=>o.value===proposed&&!o.disabled))control.value=proposed;else if(!candidate&&!currentLegacy)control.value='@current';
        form.append(field(`${source.name} · ${roles[source.role]||'자료'}`,control));mappings.push({source,control});
      });
      submitButton(form,'선택한 자료로 버전 확정',async()=>{
        const sourceIds=candidate?[candidate.sourceId]:[],snapshots={};
        mappings.forEach(({source,control})=>{if(control.value==='@exclude')return;if(!control.value)throw new Error(`${source.name}의 스냅샷을 선택하세요.`);sourceIds.push(source.id);if(control.value!=='@current')snapshots[source.id]=control.value;});
        if(!sourceIds.length)throw new Error('보존할 자료를 하나 이상 선택하세요.');
        const body={name:name.value.trim(),sourceIds,snapshots,...(candidate?{candidateId:candidate.id}:{}),...(parentSelect.value?{parentVersionId:parentSelect.value}:{})};
        await api(`/api/v1/projects/${path(projectId)}/versions`,{method:'POST',admin:true,body});d.node.close();toast('버전 보존 작업을 시작했습니다. 색인 작업에서 결과를 확인하세요.');N.setView('jobs');await Promise.allSettled([N.refreshJobs(),refresh()]);
      });d.body.replaceChildren(form);
    }catch(error){d.body.replaceChildren(N.errorState(error,()=>{d.node.close();void openFreeze(candidate,parent);}));}
  }
  async function openVersion(version) {
    const d=dialog('kb-version-dialog',`${version.name} · 보존 자료`);d.body.append(note('보존된 문서를 불러오는 중…'));d.node.addEventListener('close',()=>d.node.remove());d.node.showModal();
    try{
      const data=await api(`/api/v1/versions/${path(version.id)}`);if(!d.node.open)return;d.body.replaceChildren(note(`${date(version.createdAt)} 확정 · ${Object.keys(version.snapshots||{}).length}개 연결`));
      const controls=el('div','kb-inline');controls.append(button('자료 개정본 만들기','button button-secondary',()=>{d.node.close();void openFreeze(null,version);}));
      const remove=button('이 버전 삭제','button button-secondary delete-button',()=>{
        const confirm=el('div','kb-confirm-inline');confirm.append(note(`“${version.name}”의 보존 버전을 삭제합니다. 연결 원본은 유지됩니다.`));
        const yes=button('삭제 확정','button button-danger',()=>action(yes,async()=>{await api(`/api/v1/versions/${path(version.id)}`,{method:'DELETE',admin:true});d.node.close();await refresh();toast('보존 버전을 삭제했습니다.');}));confirm.append(yes,button('취소','text-button',()=>confirm.remove()));controls.replaceChildren(confirm);
      });controls.append(remove);d.body.append(controls);
      const docs=data.documents||[];d.body.append(el('h3','',`보존된 문서 ${count(docs.length)}개`));const list=el('div','kb-file-list');docs.forEach(doc=>list.append(button(doc.path||doc.title,'kb-file-button',()=>void N.openPreview({...doc,documentId:doc.id,versionId:version.id}))));d.body.append(list);if(!docs.length)d.body.append(note('보존된 문서가 없습니다.'));
    }catch(error){d.body.replaceChildren(N.errorState(error,()=>{d.node.close();void openVersion(version);}));}
  }

  function searchScope() { return {...(K.projectId?{projectId:K.projectId}:{}),...(versionA.value?{versionId:versionA.value}:{}),...(moduleSelect.value?{moduleId:moduleSelect.value}:{})}; }
  function setQueryBusy(busy) { $$('#kb-query-mode,#kb-module,#kb-version-a,#kb-version-b,#kb-feature-versions input,#kb-project').forEach(node=>{node.disabled=busy;}); }
  function queryBody() {
    const mode=queryMode.value;let versionIds;
    if(mode==='compare'){if(!versionA.value||!versionB.value||versionA.value===versionB.value)throw new Error('서로 다른 확정 버전 A와 B를 선택하세요.');versionIds=[versionA.value,versionB.value];}
    else if(mode==='feature'){const selected=$$('input:checked',featureVersions).map(n=>n.value);if(selected.length)versionIds=selected;}
    else if(versionA.value)versionIds=[versionA.value];
    return {query:$('#query').value.trim(),projectId:K.projectId,mode,...(versionIds?{versionIds}:{}),...(moduleSelect.value?{moduleId:moduleSelect.value}:{}),...(['auto','general'].includes(mode)&&$('#board-filter').value?{board:$('#board-filter').value}:{}),...(['auto','general'].includes(mode)&&$('#revision-filter').value?{revision:$('#revision-filter').value}:{})};
  }
  async function submitQuery(override) {
    if(K.querying||N.state.queryController)return;
    let body;try{body=override||queryBody();if(!body.query)return;if(!body.projectId)throw new Error('프로젝트를 선택하세요.');if(body.query.length>1200)throw new Error('질문은 1,200자 이하로 입력하세요.');}catch(error){N.queryStatus(error.message,{error:true});return;}
    const epoch=++K.queryEpoch;K.querying=true;K.analysisId=null;K.queryInput=body;K.queryController=new AbortController();N.setQueryBusy(true);show($('#results-area'),false);show($('#overview'),false);N.queryStatus('자료 범위를 확인하고 질문을 처리하고 있습니다…',{loading:true});
    try{
      const data=await api('/api/v1/query',{method:'POST',body,signal:K.queryController.signal});if(epoch!==K.queryEpoch)return;
      if(data.type==='clarification'){renderClarification(data,body);show($('#query-status'),false);}
      else if(data.type==='analysis'){K.analysisId=data.job.id;await watchAnalysis(data.job,epoch);}
      else{show($('#query-status'),false);N.renderResults(data,'ask');prependScope(body,data.scope,data.coverage);}
    }catch(error){if(epoch===K.queryEpoch)N.queryStatus(error.name==='AbortError'?'요청을 취소했습니다.':error.message,{error:error.name!=='AbortError'});}
    finally{if(epoch===K.queryEpoch){K.querying=false;K.queryController=null;K.analysisId=null;N.setQueryBusy(false);}}
  }
  function prependScope(body,resolved,coverage) {
    const versions=(resolved?.versionId?[resolved.versionId]:(body.versionIds||(body.versionId?[body.versionId]:[]))).map(versionName).join(' → ')||'현재 작업 자료';
    const moduleId=resolved?.moduleId||body.moduleId;
    const sourceCoverage=coverage?` · 문서 ${count(coverage.documents)}개${coverage.failed?` · 실패 ${count(coverage.failed)}개`:''}`:'';
    $('#results-area').prepend(el('div','kb-result-scope',`${projectName()} · ${K.modules.find(m=>m.id===moduleId)?.name||'전체 모듈'} · ${versions}${sourceCoverage}`));
  }
  function renderClarification(data,body) {
    const area=$('#results-area');area.replaceChildren(el('h2','',data.message));show(area);const choices=el('div','kb-clarification');area.append(choices);
    if(!data.choices?.length){area.append(button('자료·버전 관리','button button-secondary',()=>N.setView('sources')));return;}
    const selected=[];
    data.choices.forEach(choice=>{
      const control=button(choice.label,'button button-secondary',async()=>{
        const next={...body};
        if(choice.kind==='project'){await switchProject(choice.id);next.projectId=choice.id;delete next.versionIds;delete next.moduleId;void submitQuery(next);return;}
        if(choice.kind==='module'){next.moduleId=choice.id;moduleSelect.value=choice.id;void submitQuery(next);return;}
        if(choice.kind==='version'){
          const compare=body.mode==='compare'||/두 버전|순서대로/.test(data.message);
          if(compare){if(selected.includes(choice.id))return;selected.push(choice.id);control.disabled=true;control.textContent=`${selected.length===1?'A':'B'} · ${choice.label}`;if(selected.length<2)return;next.mode='compare';next.versionIds=[...selected];queryMode.value='compare';versionA.value=selected[0];versionB.value=selected[1];modeChanged();}
          else{next.versionIds=[choice.id];versionA.value=choice.id;}
          void submitQuery(next);
        }
      });choices.append(control);
    });
  }
  async function cancelQuery() {
    if(!K.querying)return;const id=K.analysisId;
    if(id){try{await api(`/api/v1/analyses/${path(id)}/cancel`,{method:'POST'});}catch(error){toast(`분석 취소 실패: ${error.message}`,true);return;}}
    K.queryEpoch++;K.queryController?.abort();K.querying=false;K.analysisId=null;K.queryController=null;N.setQueryBusy(false);N.queryStatus(id?'분석 취소를 요청했습니다. 실행 중인 모델 단계가 끝나면 중단합니다.':'요청을 취소했습니다.');void refresh(true);
  }
  async function watchAnalysis(initial,epoch) {
    let job=initial;
    while(epoch===K.queryEpoch){
      N.queryStatus(`${job.message||'분석 중'} · ${count(job.processed)} / ${count(job.total)}`,{loading:active(job)});
      if(job.result){renderAnalysis(job);if(active(job))$('#results-area').prepend(note('현재까지 완료된 부분 결과입니다. 나머지 자료를 분석하고 있습니다.'));}
      if(!active(job)){
        if(job.status==='failed')throw new Error(job.error||job.message||'분석에 실패했습니다.');
        if(job.status==='cancelled')N.queryStatus(job.message||'분석이 취소되었습니다.');else show($('#query-status'),false);
        void refresh(true);return;
      }
      await new Promise(resolve=>setTimeout(resolve,2000));if(epoch!==K.queryEpoch)return;
      const result=await api(`/api/v1/analyses/${path(job.id)}`,{signal:K.queryController?.signal});job=result.job;
    }
  }
  const states={supported:['근거 확인','ok'],absent:['명시적 미지원','warning'],unknown:['미확인',''],conflict:['근거 충돌','error']};
  function findingCell(finding) {
    const cell=el('td');const [label,type]=states[finding?.state]||states.unknown;cell.append(badge(label,type),note(finding?.summary||'자료에서 확인하지 못했습니다.'));
    if(finding?.citations?.length||finding?.evidence?.length){const details=el('details','kb-finding');details.append(el('summary','',`근거 ${finding.citations?.length||finding.evidence.length}개 확인`));(finding.evidence||[]).forEach(item=>{const quote=el('blockquote','',item.quote);quote.append(note(item.support==='absent'?'미지원·제외를 명시한 구절':'포함·지원을 명시한 구절'));details.append(quote);});evidence(finding.citations,details);cell.append(details);}warningList(finding?.warnings,cell);return cell;
  }
  function renderAnalysis(job) {
    const area=$('#results-area');area.replaceChildren();show(area);show($('#overview'),false);
    const heading=el('div','results-toolbar');heading.append(el('h2','',job.mode==='feature'?'기능의 버전별 근거':'두 버전 사양 비교'),N.statusBadge(job.status));area.append(heading);prependScope(job);
    area.append(note(job.query));const result=job.result;if(!result){area.append(note('분석 결과가 아직 없습니다.'));return;}warningList(result.warnings,area);
    if(job.mode==='feature'){
      const wrapper=el('div','kb-table-wrap'),table=el('table','kb-feature-table'),head=el('tr');['SW 버전','사양 명시','코드 구현','빌드 포함','자료 범위'].forEach(title=>head.append(el('th','',title)));const thead=el('thead');thead.append(head);table.append(thead);const tbody=el('tbody');
      (result.rows||[]).forEach(row=>{const tr=el('tr');tr.append(el('th','',row.versionName),findingCell(row.spec),findingCell(row.code),findingCell(row.build));const coverage=el('td');coverage.append(note(`문서 ${count(row.coverage?.documents)}개 · 실패 ${count(row.coverage?.failed||0)}개`));warningList(row.warnings,coverage);tr.append(coverage);tbody.append(tr);});table.append(tbody);wrapper.append(table);area.append(wrapper);if(!result.rows?.length)area.append(note('완료된 버전 분석이 없습니다.'));if(result.firstVersionNote)area.append(note(result.firstVersionNote));
    }else{
      const names=(job.versionIds||[]).map(versionName);area.append(note(`A: ${names[0]||'버전 A'} · 문서 ${count(result.coverage?.before?.documents)}개 / B: ${names[1]||'버전 B'} · 문서 ${count(result.coverage?.after?.documents)}개`));
      const documents=result.documents||[];area.append(note(`전체 ${documents.length}개 · 변경 ${documents.filter(d=>d.status==='modified').length} · 추가 ${documents.filter(d=>d.status==='added').length} · 삭제 ${documents.filter(d=>d.status==='removed').length}`));
      if(!documents.length)area.append(N.emptyState('비교할 사양 문서가 없습니다','선택한 버전과 모듈에 사양 역할의 자료가 포함되어 있는지 확인하세요.','doc'));
      documents.forEach(doc=>area.append(comparisonCard(doc,names)));
    }
  }
  function comparisonCard(doc,names) {
    const details=el('details','kb-comparison');details.open=doc.status!=='unchanged';const title=el('summary');const labels={added:'추가',removed:'삭제',modified:'변경',unchanged:'동일',ambiguous:'대응 확인 필요'};title.append(badge(labels[doc.status]||doc.status,doc.status==='ambiguous'?'warning':'blue'),document.createTextNode(doc.after?.path||doc.before?.path||doc.key));details.append(title);const body=el('div','kb-comparison-body');details.append(body);warningList(doc.warnings,body);
    (doc.summaries||[]).forEach(summary=>{const text=el('div','answer-text',summary.answer);body.append(text);evidence(summary.citations,body);});
    const bilateral=el('div','kb-bilateral');
    for(const side of ['before','after']){const block=el('div');block.append(el('h3','',`${side==='before'?'A':'B'} · ${names[side==='before'?0:1]||''}`));if(doc[side]){const link=button(doc[side].path,'text-button',()=>void N.openPreview({...doc[side],documentId:doc[side].id}));block.append(link);}else block.append(note('이쪽 버전에는 대응 문서가 없습니다.'));evidence(doc[`${side}Citations`],block);bilateral.append(block);}body.append(bilateral);
    (doc.hunks||[]).forEach(hunk=>{const chunk=el('details','kb-diff');chunk.open=true;chunk.append(el('summary','',`원문 차이 · A ${hunk.beforeStart}행 / B ${hunk.afterStart}행`));const columns=el('div','kb-bilateral');for(const [side,lines] of [['before',hunk.removed],['after',hunk.added]]){const cell=el('div');cell.append(el('strong','',side==='before'?'A · 변경 전':'B · 변경 후'),el('pre',side==='before'?'kb-diff-removed':'kb-diff-added',(lines||[]).join('\n')||'(없음)'));if(hunk.numbers?.[side]?.length)cell.append(note(`수치·단위: ${hunk.numbers[side].join(' · ')}`));columns.append(cell);}chunk.append(columns);body.append(chunk);});
    if(doc.tables?.before?.length||doc.tables?.after?.length){const tables=el('details','kb-diff');tables.append(el('summary','','추출한 원문 표'));const columns=el('div','kb-bilateral');for(const side of ['before','after']){const cell=el('div');cell.append(el('h3','',side==='before'?'A 표':'B 표'));(doc.tables?.[side]||[]).forEach(table=>{cell.append(note(`표 ${table.table}`),el('pre','',table.text));});columns.append(cell);}tables.append(columns);body.append(tables);}
    return details;
  }
  function renderAnalyses() {
    if(!K.analyses.length){analysisList.replaceChildren(note('아직 실행한 기능 분석·사양 비교가 없습니다.'));return;}
    analysisList.replaceChildren(...K.analyses.map(job=>{const card=el('article','job-card');const heading=el('div','job-heading');heading.append(el('h3','',job.query),N.statusBadge(job.status));card.append(heading,el('p','job-message',job.message||''),note(`${job.mode==='feature'?'기능 버전 탐색':'사양 비교'} · ${date(job.createdAt)} · ${count(job.processed)} / ${count(job.total)}`));
      const controls=el('div','kb-inline');const open=button(active(job)?'진행 상황 보기':'결과 보기','button button-secondary',()=>void openAnalysis(job));controls.append(open);
      if(active(job)){const cancel=button('분석 취소','button button-secondary',()=>action(cancel,async()=>{await api(`/api/v1/analyses/${path(job.id)}/cancel`,{method:'POST'});await refresh();}));controls.append(cancel);}
      if(['failed','cancelled'].includes(job.status))controls.append(button('다시 분석','button button-secondary',()=>{N.setView('search');$('#query').value=job.query;void submitQuery({projectId:job.projectId,query:job.query,mode:job.mode,versionIds:job.versionIds,...(job.moduleId?{moduleId:job.moduleId}:{})});}));card.append(controls);if(job.error)warningList([job.error],card);return card;}));
  }
  async function openAnalysis(previous) {
    if(K.querying){toast('현재 질문이 끝나거나 취소한 후 분석 결과를 열어주세요.');return;}
    N.setView('search');N.setMode('ask');queryMode.value=previous.mode;moduleSelect.value=previous.moduleId||'';versionA.value=previous.versionIds?.[0]||'';versionB.value=previous.versionIds?.[1]||'';modeChanged();$('#query').value=previous.query;const epoch=++K.queryEpoch;K.querying=true;K.analysisId=previous.id;K.queryController=new AbortController();N.setQueryBusy(true);
    try{const data=await api(`/api/v1/analyses/${path(previous.id)}`);if(epoch!==K.queryEpoch)return;renderAnalysis(data.job);await watchAnalysis(data.job,epoch);}catch(error){if(epoch===K.queryEpoch)N.queryStatus(error.message,{error:true});}finally{if(epoch===K.queryEpoch){K.querying=false;K.analysisId=null;K.queryController=null;N.setQueryBusy(false);}}
  }
  async function connectionChanged() {
    K.queryEpoch++;K.queryController?.abort();K.querying=false;K.analysisId=null;K.epoch++;K.projectId=savedProject();K.projects=[];K.modules=[];K.versions=[];K.candidates=[];K.analyses=[];N.setQueryBusy(false);
    while(K.refreshing)await new Promise(resolve=>setTimeout(resolve,30));await refresh();
  }
  function viewChanged(view){if(view==='sources'||view==='jobs')void refresh(true);}
  window.NexaKnowledge={renderSources,prepareSourceDialog,sourceFields,setSourceType,searchScope,setQueryBusy,submitQuery,cancelQuery,connectionChanged,viewChanged,filterJobs:jobs=>jobs.filter(job=>(job.projectId||N.state.sources.find(source=>source.id===job.sourceId)?.projectId||'default')===K.projectId),decorateResults:(data,body)=>prependScope(body,data.scope,data.coverage)};
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&K.querying&&!$$('dialog[open]').length)void cancelQuery();});
  void refresh();setInterval(()=>{if(!document.hidden)void refresh(true);},8000);
})();

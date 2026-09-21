# Nexa HTTP API v1

기본 URL은 `http://127.0.0.1:8787/api/v1`입니다. UTF-8 JSON을 사용합니다. `/search`·`/ask`는 한 요청으로 결과를 반환하고 `/query`는 일반 답변·범위 확인·비동기 분석 중 하나를 반환합니다. 스트리밍·대화 세션 API는 없습니다.

## 인증과 공통 규칙

`NEXA_API_KEY`가 설정되면 health/meta를 포함한 모든 API에 `Authorization: Bearer <key>`가 필요합니다. LAN 바인딩에는 24자 이상 팀 키가 필수입니다. localhost에서 키를 생략하면 읽기·질문·검색은 인증 없이 사용할 수 있습니다.

`/sources`, `/projects`, `/versions` 아래 POST·DELETE는 `X-Nexa-Admin-Key: <admin-key>`도 필요합니다. 관리자 키는 `NEXA_ADMIN_KEY` 또는 `data/admin-key.txt`에서 가져오며 팀 키를 대체하지 않습니다. 분석 조회·취소는 팀 키만 사용합니다. 개인별 자료·분석 소유권은 없습니다.

다른 출처의 웹 UI는 `NEXA_ALLOWED_ORIGINS`에 출처를 등록합니다. 허용된 OPTIONS는 204입니다. 쿠키 인증은 사용하지 않으며 키를 URL에 넣지 않습니다. JSON 본문은 `Content-Type: application/json`, 최대 64 KiB의 객체입니다. 배열·null·문자열 등 객체가 아닌 본문은 INVALID_BODY로 400을 반환합니다. 업로드 전체 요청은 100 MiB까지입니다. 응답에 추가 필드가 생겨도 클라이언트가 허용해야 합니다.

오류는 `{"error":{"code":"INVALID_QUERY","message":"질문을 1~1,200자로 입력하세요."}}` 형태입니다. 주요 HTTP 상태는 입력 오류 400, 팀 인증 401, 관리자·출처 제한 403, 없음 404, 중복·처리 중·범위 변경 409, 크기 초과 413, Content-Type 415, 모델 문맥 초과 422, 대기열 초과 429, 응답 검증 실패 502, 서비스·Git 원격 사용 불가 503입니다. 비동기 처리 중 오류는 최초 HTTP 응답 대신 Job의 errors/error에 기록됩니다.

## 프로젝트와 모듈

| 요청 | 응답 |
| --- | --- |
| `GET /projects` | 200 `{"projects":[Project]}` |
| `POST /projects` | `{"name":"Firmware"}` → 201 `{"project":Project}` |
| `GET /projects/:id/modules` | 200 `{"modules":[Module]}` |
| `POST /projects/:id/modules` | 아래 본문 → 201 `{"module":Module}` |
| `POST /projects/:id/modules/:moduleId` | 아래 본문 → 200 `{"module":Module}`, 이름·규칙 수정 |

Project는 `{id,name,createdAt}`입니다. 기본 프로젝트 ID는 `default`이며 기존 자료도 이 프로젝트로 이관합니다. 프로젝트·모듈 이름은 1~120자이고 같은 범위에서 중복을 허용하지 않습니다.

```json
{"name":"UART","rules":[{"sourceId":"code-source-id","pattern":"src/uart/**","role":"code"},{"sourceId":"docs-source-id","pattern":"specs/uart/**","role":"spec"}]}
```

Module은 `{id,projectId,name,rules}`입니다. rules는 1~100개, pattern은 1~512자입니다. 소스 기준 상대 경로에서 `*`는 한 경로 구간, `**`는 하위 경로를 포함해 일치하며 대소문자를 구분하지 않습니다. sourceId 생략 시 프로젝트 전체 연결, role 생략 시 연결 기본 역할을 사용합니다. 등록 순서상 첫 일치 모듈·규칙을 적용하며 미일치 파일은 모듈 미지정 자료로 남습니다. 모듈 등록·수정 후 일시정지하지 않은 연결에 재동기화를 요청합니다. 수정은 name과 rules 전체를 보내며 기존 확정 버전 매핑은 바뀌지 않습니다. 프로젝트 수정·삭제와 모듈 삭제 API는 없습니다.

## 자료 연결

`GET /sources` → 200 `{"sources":[Source]}`.

```json
{"id":"source-id","name":"Firmware","kind":"folder","path":"D:\\work\\firmware","board":"ATLAS","revision":"A","projectId":"default","role":"code","paused":false,"status":"ready","snapshotId":"snapshot-id","lastCheckedAt":"2026-09-21T08:00:00.000Z","lastIndexedAt":"2026-09-21T08:00:00.000Z","errors":[],"unavailable":false,"documentCount":10,"chunkCount":42}
```

kind는 folder/upload/git, role은 code/spec/reference, status는 queued/indexing/ready/warning/error입니다. Git 소스에는 `git:{url,branch,tagPattern}`이 추가되고 path는 관리 bare 캐시입니다. 등록 직후 일부 메타데이터·집계가 없을 수 있으므로 `/sources`를 다시 조회하세요. 서버 경로는 브라우저가 읽는 URL이 아닙니다.

### 폴더·업로드

`POST /sources/folder` → 201 `{"source":Source,"job":Job}`:

```json
{"path":"D:\\docs\\uart","name":"UART 사양","projectId":"default","role":"spec","board":"ATLAS","revision":"A"}
```

path는 읽을 수 있는 일반 폴더의 절대 경로, 최대 1,024자입니다. 링크·junction·Nexa 내부 경로와 같은 실제 폴더 중복 등록을 거부합니다. name/board/revision은 각 최대 120자이며 기본 이름은 폴더명, 보드·리비전은 빈 문자열입니다. projectId 기본값은 default, 폴더·업로드 role 기본값은 spec입니다.

`POST /sources/upload` → 201 `{"source":Source,"job":Job}`. multipart/form-data 필드:

| 필드 | 설명 |
| --- | --- |
| files | 같은 이름으로 File 1~100개, 파일당 20 MiB 이하, 전체 요청 100 MiB 이하 |
| name, board, revision | 선택 문자열, 각 최대 120자 |
| projectId, role | 선택, 기본 default/spec |

파일은 `data/uploads/<source-id>`에 순번을 붙여 저장합니다. 빈 파일, 지원하지 않는 확장자, 경로 구분자·Windows 예약 이름을 거부합니다. FormData의 Content-Type은 브라우저가 경계 문자열과 함께 설정하게 두세요.

지원 자료는 C/C++, Python/JS/TS/Rust/Go/Java/C# 등의 코드, DTS, Markdown, 텍스트·로그, JSON/YAML/TOML/XML 등의 설정, 쉘/PowerShell/배치, Makefile/CMake, 텍스트 PDF와 DOCX입니다. 텍스트는 UTF-8 또는 BOM UTF-16을 사용합니다. OCR, 구형 .doc, Excel·PowerPoint, 일반 압축파일은 지원하지 않습니다. DOCX는 변경추적 삽입을 반영하고 삭제를 제외합니다. C/C++ AST 실패는 진단과 줄 기준 파싱으로 처리합니다.

### Git 원격

`POST /sources/git` → 201 `{"source":Source,"job":Job}`:

```json
{"url":"https://github.com/team/firmware.git","branch":"main","tagPattern":"v*","name":"Firmware Git","projectId":"default","role":"code"}
```

branch 기본값은 main, tagPattern은 `*`, role은 code입니다. 태그 패턴은 1~200자이며 `*`, `?`를 지원합니다. 같은 프로젝트 내 같은 정규화 URL·브랜치는 중복 등록하지 않습니다.

`github.com`·`bitbucket.org`의 HTTPS 또는 git 사용자 SSH 주소만 허용합니다. `git@github.com:team/repo.git`도 가능합니다. HTTPS 사용자명·비밀번호·토큰, URL query/fragment, 별도 포트, 로컬 경로와 사내 GitHub Enterprise/Bitbucket Server 호스트는 지원하지 않습니다. HTTPS 인증은 서버 계정의 Git Credential Manager, SSH는 키·known_hosts를 미리 준비하세요. 비대화식 작업 실패는 Git 원문 오류나 credential helper 출력을 노출하지 않는 진단을 반환합니다.

사용자 작업 트리를 바꾸지 않고 관리 bare 캐시에 fetch한 커밋 객체를 읽습니다. LFS 포인터·submodule·심볼릭 링크는 진단과 함께 제외합니다. 파일당 20 MiB·100,000개와 별도로 한 번의 Git 수집은 총 256 MiB, 태그 목록은 일치하는 1,000개까지입니다. 제한을 포함한 수집·추출 진단은 버전 확정 전에 해결해야 합니다. 커밋 전 작업본은 별도 폴더 소스로 연결하세요.

### 상태·동기화·미리보기

| 요청 | 응답 및 동작 |
| --- | --- |
| `POST /sources/:id/sync` | 202 `{"job":Job}`, 즉시 동기화 요청 |
| `POST /sources/:id/retry` | sync와 동일, 성공한 추출 재사용·실패 파일 재처리 |
| `POST /sources/:id/reindex` | 기존 클라이언트 호환 경로, sync와 동일 |
| `POST /sources/:id/settings` | `{"paused":true,"role":"spec"}` → 200 `{"source":Source}`, 지정한 필드만 변경 |
| `GET /sources/:id/preview` | 200 `{"documents":[...],"total":10,"truncated":false,"errors":[],"tags":[{"name":"v1","commit":"..."}],"snapshots":[Snapshot]}` |
| `DELETE /sources/:id` | 200 `{"deleted":true}` |

재색인은 본문이 필요 없습니다. 같은 소스가 대기·실행 중이면 409입니다. 기본 자동 감지는 폴더 이벤트 2초 및 Git·폴더 정기 대조 5분입니다. 일시정지는 자동 수집을 막고 수동 sync는 허용합니다. 업로드는 최초 색인 뒤 수동 동기화합니다. 실행 중 자동 변경 알림은 후속 작업으로 합칩니다.

settings에는 `documentLinks:{"specs/new-name.docx":"specs/old-name.docx"}`도 지정할 수 있습니다. 같은 소스 안에서 현재 상대 경로를 이전 문서 경로에 연결하며, 지정 시 매핑 전체를 교체합니다. 키·값은 각 최대 1,024자이며 제어 문자를 허용하지 않습니다. 다음 동기화부터 문서 계보에 적용하고 기존 확정 버전을 다시 쓰지 않습니다. 빈 객체로 수동 매핑을 제거할 수 있습니다.

preview documents는 현재 스냅샷의 id/path/title/sourceId/moduleId/role/snapshotId 메타데이터를 경로순 최대 200개 제공합니다. total은 전체 문서 수, truncated는 잘림 여부입니다. 추출 원문은 `/documents/:id`에서 읽습니다. snapshots는 최근 최대 100개이며 `{id,sourceId,projectId,createdAt,commit?,errors,excluded,complete,legacy?}`입니다. complete는 수집·추출 진단 기준이며 벡터 준비와 별개입니다.

연결 삭제는 최신 연결·작업 자료를 제거하지만 확정 버전 참조 자료는 보존합니다. 업로드 파일은 지우고 외부 폴더·원격 저장소는 변경하지 않습니다. 관리 bare 캐시는 이 API에서 지우지 않습니다. 대기·실행 작업이 있으면 삭제는 409입니다.

`GET /jobs`는 200 `{"jobs":[Job]}`로 색인 작업 최대 200개와 버전 작업 최대 100개를 합쳐 반환합니다.

```json
{"id":"job-id","kind":"index","sourceId":"source-id","projectId":"default","status":"running","processed":3,"total":10,"message":"3/10 · 변경 2 · 재사용 1","errors":[],"createdAt":"2026-09-21T08:00:00.000Z"}
```

kind는 index/version, status는 queued/running/completed/failed입니다. 종료 후 finishedAt, 버전 확정 성공 시 versionId가 추가됩니다. completed여도 errors에 일부 파일·벡터 진단이 있을 수 있습니다. 색인·버전은 직렬 큐를 공유하며 대기 상한은 100개입니다. 재시작 시 중단 작업을 다시 시작합니다. `/query` 분석은 별도 `/analyses`에서 조회합니다.

## SW 버전 보존

`GET /projects/:id/versions` → 200 `{"versions":[SoftwareVersion],"candidates":[Candidate]}`.

SoftwareVersion은 `{id,projectId,name,createdAt,status:"confirmed",snapshots:{sourceId:snapshotId},parentVersionId?,notes?}`입니다. parentVersionId는 같은 프로젝트의 이전 자료 개정본이며 자동 SemVer 순서는 계산하지 않습니다.

`POST /projects/:id/versions` → 202 `{"job":Job}`:

```json
{"name":"v1.0.0","sourceIds":["code-source-id","docs-source-id"],"notes":"릴리스 검증 자료"}
```

sourceIds 생략 시 접근 가능한 프로젝트 연결들의 현재 활성 스냅샷을 사용합니다. 명시적으로 `snapshots:{"source-id":"snapshot-id"}`를 보낼 수도 있습니다. 중복 이름, 빈 범위, 다른 프로젝트·소스 또는 불완전 스냅샷은 확정하지 않습니다. 202 이후 실패는 `/jobs`에서 확인하세요.

`GET /versions/:id` → 200 `{"version":SoftwareVersion,"documents":[...]}`. 문서 객체 필드는 id/path/sourceId/moduleId/role/snapshotId이며 id를 `/documents/:id`에 사용합니다. `DELETE /versions/:id` → 200 `{"deleted":true}`. 대기·실행 중인 분석, 재색인 또는 후속 개정본 보존 작업이 사용하면 VERSION_BUSY, 확정된 후속 개정본이 참조하면 VERSION_REFERENCED로 409입니다.

`POST /versions/:id/reindex` → 202 `{"job":Job}`. 본문 없이 요청하고 `/jobs`로 완료를 확인합니다. 보존한 원문 bytes를 현재 파서로 다시 처리해 별도 검색 색인을 만든 뒤 해당 버전의 검색·분석에서 사용합니다. 원격 fetch나 현재 문서 폴더 읽기는 하지 않습니다. 확정 버전의 원래 snapshots 연결과 `/versions/:id` 문서 목록은 유지하므로 재색인 후 검색 인용의 snapshotId/documentId는 원래 목록과 다를 수 있습니다. 전체 원문 재처리가 성공해야 새 색인을 적용합니다. 원문이 없는 legacy 스냅샷은 LEGACY_ORIGINAL, 파싱 진단이 남으면 REPARSE_WARNING으로 작업이 실패하고 기존 색인을 유지합니다.

### 태그 후보와 과거 사양

첫 동기화에서 존재하던 태그는 known tags로 저장하고 자동 후보를 만들지 않습니다. 이후 새로 생기거나 이동한 태그는 automatic:true 후보와 감지 당시 다른 연결의 활성 스냅샷을 제안합니다. 확정 버전은 태그 이동으로 바뀌지 않습니다.

`POST /sources/:id/candidates`에 `{"tag":"v1.0.0"}`를 보내 과거 태그 후보를 만듭니다. 201 `{"candidate":Candidate}`를 반환합니다. Candidate는 `{id,projectId,sourceId,name,commit,createdAt,status:"pending"|"confirmed",snapshots,warnings,automatic,versionId?}`입니다.

과거 후보를 확정하려면 `/projects/:id/versions`에 당시 사양서 스냅샷을 지정합니다:

```json
{"name":"v1.0.0","candidateId":"candidate-id","snapshots":{"docs-source-id":"historical-docs-snapshot-id"}}
```

Git은 후보의 고정 commit에서 읽고 최신 연결을 바꾸지 않습니다. automatic:false에 snapshots를 생략하면 작업에서 SPEC_SELECTION_REQUIRED로 실패합니다. 자동 후보도 제안된 문서가 실제 릴리스 사양인지 확인해야 합니다. 이름·수정시각만으로 대응을 추정하지 않습니다.

원문 bytes와 추출 결과는 공유합니다. 작업 스냅샷은 소스별 최근 30개와 확정 버전·후보가 참조하는 자료를 보존합니다. 기존 추출 텍스트 이관 자료는 legacy:true이며 원문 재동기화 전에는 원래 DOCX/PDF 재현을 보장하지 않습니다.

## 검색과 단일 질문

`POST /search`, `POST /ask` 요청:

```json
{"query":"UART 속도는?","projectId":"default","versionId":"version-id","moduleId":"module-id","role":"spec","board":"ATLAS","revision":"A","limit":8}
```

query는 필수 1~1,200자입니다. projectId 생략 시 선택 버전의 프로젝트, 버전도 없으면 default입니다. versionId 생략 시 최신 활성 자료를 검색합니다. moduleId, role(code/spec/reference), board, revision은 선택 범위이며 서로 일치해야 합니다. revision은 보드 리비전이고 SW 버전과 별개입니다. limit은 정수 1~30, 기본 8이며 `/ask`는 별도 근거 한도를 사용합니다. 이 두 경로는 자연어에서 범위를 자동 추출하지 않습니다.

`POST /search` → 200:

```json
{"hits":[{"id":"chunk-id","documentId":"snapshot-document-id","sourceId":"source-id","title":"UART 사양","path":"uart.md","text":"UART baud is 115200.","projectId":"default","snapshotId":"snapshot-id","versionId":"version-id","moduleId":"module-id","role":"spec","board":"ATLAS","revision":"A","startLine":10,"endLine":10,"score":0.0327,"channels":["keyword","vector"]}],"mode":"hybrid","warnings":[],"coverage":{"documents":5,"failed":0},"scope":{"projectId":"default","snapshotIds":["snapshot-id"],"versionId":"version-id","moduleId":"module-id"}}
```

score는 순위 결합 점수이며 정답 확률이 아닙니다. 동일 청크가 여러 스냅샷에 있으므로 합칠 때는 `(documentId,id)`를 사용합니다. coverage.documents는 프로젝트·버전·모듈·역할·보드·리비전 필터를 적용한 문서 수이며 검색어 일치 결과 수와는 다릅니다. coverage.failed는 진단 수이며 실패 파일 수와 다를 수 있습니다. scope는 실제 검색 범위입니다. 접근불가 연결은 최신 검색에서 제외하고 경고를 표시하지만 확정 버전은 보존 자료를 사용합니다.

인용 위치는 코드·텍스트의 1부터 시작하는 startLine/endLine, PDF의 page, DOCX의 headingPath(제목 배열)·blockId(블록 위치)·table(표 번호)입니다. DOCX에 Word 페이지 번호를 부여하지 않습니다. C/C++ 함수에는 symbol이 추가될 수 있습니다.

`POST /ask` → 200: answerable/answer/citations(Hit 배열)/mode/warnings/coverage/scope/timingMs. 근거가 없으면 `answerable:false`, `answer:"자료에서 확인할 수 없습니다."`, `citations:[]`입니다. 생성 중 최신 자료 범위가 바뀌면 SOURCE_CHANGED로 409입니다.

생성은 한 번에 1개, 실행 중 포함 최대 12개이며 timingMs에는 대기가 포함됩니다. 벡터 장애는 mode:keyword와 warnings로 알리고 키워드 검색을 제공합니다. keyword 실행 모드에서 모델이 필요한 답변은 KEYWORD_MODE로 503입니다. 근거 자체가 없으면 모델 없이 답변 불가 결과를 줄 수 있습니다.

## 질문 라우팅과 비동기 분석

`POST /query` 요청:

```json
{"query":"UART 기능이 포함된 버전은?","projectId":"default","moduleId":"module-id","mode":"feature","versionIds":["version-a-id","version-b-id"]}
```

mode는 auto(또는 생략)/general/feature/compare입니다. auto는 질문 표현과 등록 명칭을 규칙으로 해석하고 존재하지 않는 버전을 만들지 않습니다. versionIds 또는 단일 versionId에는 등록 ID·이름을 사용할 수 있지만 ID를 권장합니다. compare는 순서대로 정확히 두 버전, general은 최대 한 버전, feature는 생략 시 모든 확정 버전입니다.

| 응답 | 처리 |
| --- | --- |
| 200 `{"type":"answer",...}` | 일반 질문 완료, ask와 같은 결과 필드 |
| 200 `{"type":"clarification","message":"범위를 선택하세요.","choices":[{"kind":"version","id":"...","label":"v1"}]}` | project/version/module 선택 후 같은 질문을 명시적 범위로 재요청 |
| 202 `{"type":"analysis","job":AnalysisJob}` | `/analyses/:id` 폴링 |

`GET /analyses?projectId=<id>` → 200 `{"jobs":[AnalysisJob]}`, 최근 최대 200개. `GET /analyses/:id` → 200 `{"job":AnalysisJob}`. `POST /analyses/:id/cancel` → 200 `{"job":AnalysisJob}`이며 본문은 필요 없습니다.

AnalysisJob은 `{id,projectId,mode,query,versionIds,moduleId?,status,processed,total,message,createdAt,startedAt?,finishedAt?,result?,error?}`입니다. 상태는 queued/running/completed/failed/cancelled이며 진행 중 result에 일부 완료 결과가 있을 수 있습니다. 분석 대기 상한은 20개이고 한 번에 하나를 처리하며 모델 단계는 일반 질문과 생성 큐를 공유합니다. 취소는 상태를 먼저 바꾸고 실행 중 모델 단계가 끝나면 후속 처리를 중단합니다. 재시작은 중단 분석을 처음부터 재개합니다.

### 기능 버전 탐색

result는 mode:feature/versionIds/rows/warnings/firstConfirmedVersionId:null/firstVersionNote입니다. row는 versionId/versionName/state/spec/code/build/coverage/warnings입니다. spec/code/build는 각각 사양 명시·코드 구현·빌드 포함의 `{state,summary,citations,evidence,warnings}`이며 evidence는 원문 quote, support(present/absent), hit를 포함합니다.

state는 supported/absent/unknown/conflict입니다. 원문 구절과 인용을 검증하며 미검색을 absent로 바꾸지 않습니다. row 전체 state는 충돌이 있으면 conflict, 그 외에는 build 상태입니다. 코드가 있어도 빌드 근거가 없으면 전체 unknown일 수 있습니다. 최초 도입 버전은 자동 확정하지 않습니다. keyword 모드에서는 후보 인용을 남기고 모델 분류는 unknown으로 처리합니다.

### A/B 사양 비교

result는 `{mode:"compare",versionIds,coverage:{before,after},documents,warnings}`입니다. 두 버전에서 선택한 모듈의 전체 spec 문서를 비교하며 질문 관련 검색 상위 몇 개만 비교하지 않습니다.

문서 결과는 key/status/before·after({id,path,title})/hunks/method/beforeCitations/afterCitations/tables({before,after})/summaries/warnings입니다. status는 added/removed/modified/unchanged/ambiguous입니다. hunk는 `{beforeStart,afterStart,removed:string[],added:string[],numbers:{before:string[],after:string[]}}`이며 시작 위치는 추출 텍스트 줄입니다. DOCX 원문 탐색에는 별도 인용 블록 위치를 사용합니다.

동일 문서 계보·소스 경로를 대응하고 유일한 동일 원문 이동은 동기화 때 계보를 재사용할 수 있습니다. 이름과 내용이 함께 바뀐 경우 sources settings의 documentLinks로 다음 동기화에 수동 대응을 지정할 수 있습니다. 모호한 대응은 확정하지 않습니다. 큰 diff는 method:bounded_replace로 전체 변경 구간을 유지합니다. 숫자·단위를 원문대로 보존하며 단위 환산이나 실제 동작 변화로 추론하지 않습니다. 모델 요약은 양쪽 근거가 있을 때 부가하고 실패하거나 keyword 모드여도 원문 diff는 유지합니다.

## 문서·메타데이터·상태

`GET /documents/:id`는 Hit.documentId의 추출 원문입니다. `{id,sourceId,path,title,text,board,revision,projectId?,snapshotId?,moduleId?,role?,commit?,createdAt?,chunks?,legacy?}`이며 원본 파일 다운로드 API는 아닙니다. PDF text에는 `\f`가 있을 수 있습니다. DOCX 위치는 chunks에서 확인합니다.

`GET /meta` → `{"boards":[...],"revisions":[...],"auth":{"required":true,"adminConfigured":true}}`. 보드별 리비전 계층은 제공하지 않습니다. 프로젝트·모듈·SW 버전은 각 목록 API를 사용합니다.

`GET /health` → 200:

```json
{"status":"ok","services":{"embedding":{"ok":true},"generation":{"ok":true},"vector":{"ok":true}},"counts":{"sources":2,"documents":10,"chunks":42},"queue":{"queued":0,"running":0},"generationQueue":{"queued":0,"running":0},"analysisQueue":{"queued":0,"running":0},"mode":"full","pendingEmbeddings":0}
```

일부 서비스가 준비되지 않아도 HTTP 200을 유지하고 status:degraded를 반환합니다. 실행 모드 full/keyword와 검색 모드 hybrid/keyword는 별개입니다. counts는 최신 작업 색인의 집계이며 보존 버전 총합이 아닙니다. pendingEmbeddings는 원문 스냅샷에서 참조하지만 벡터 기록이 없는 고유 청크 수이며, 구버전에서 이관한 추출 텍스트 전용 스냅샷은 제외합니다. 관리자 키와 모델 경로 등의 비밀 설정은 노출하지 않습니다.

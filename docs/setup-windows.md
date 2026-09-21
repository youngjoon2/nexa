# Windows 설치 및 실행

Nexa는 Windows x64에서 Bun, llama.cpp CUDA, Qdrant, Poppler, Pandoc, MinGit를 프로젝트 폴더 안에 설치합니다. npm, PyPI, Hugging Face, Ollama, Docker를 사용하지 않습니다. 설치된 모델로 답변 생성과 임베딩을 모두 로컬에서 실행합니다. Git 원격 연결을 등록하면 자료 동기화에 해당 GitHub/Bitbucket 서버와 통신합니다.

## 1. 환경 확인

- Windows 10/11 x64, PowerShell 5.1 이상, Windows 기본 `tar.exe`가 필요합니다.
- 전체 설치에 약 12 GiB의 여유 공간을 확보합니다. 실제 색인 자료 및 검색 데이터 공간은 별도입니다.
- NVIDIA GPU와 CUDA 12.4 호환 드라이버, Microsoft Visual C++ 2015–2022 x64 런타임이 필요합니다. 이 스크립트는 드라이버·시스템 런타임 설치, 관리자 권한 변경, 방화벽 변경을 수행하지 않습니다.
- 기술 검증은 RTX 4060 Ti 8GB에서 수행했습니다. RTX A4000 16GB 회사 PC의 동시 사용자 처리량과 회사망 다운로드는 별도 확인 대상입니다.
- `config/artifacts.json`에 버전, SHA256, 원본 URL, 제3자 모델 출처가 고정되어 있습니다. 모델 이용 조건은 `THIRD_PARTY_NOTICES.md`에 있습니다.

프로젝트 루트의 PowerShell에서 실행합니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1 -CheckOnly
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start.ps1 -CheckOnly
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start.ps1
```

브라우저에서 `http://127.0.0.1:8787`을 엽니다. 설치는 검증된 로컬 캐시를 우선 사용하고, 부족한 파일만 GitHub에서 받습니다. 다운로드 후 SHA256이 일치하지 않으면 설치하지 않습니다. 모델 파트는 파일 번호 순서로 연결하고 완성 모델의 해시도 확인합니다. 설치 기록은 `.runtime/installed.json`에 저장합니다.

`-ExecutionPolicy Bypass`는 위 PowerShell 프로세스에만 적용됩니다. 회사의 실행 정책은 조직 규칙을 따릅니다.

## 2. GitHub와 오프라인 캐시

설치기가 허용하는 HTTPS 호스트는 `github.com`, `api.github.com`, `raw.githubusercontent.com`, `media.githubusercontent.com`, `codeload.github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`, `github-releases.githubusercontent.com`입니다. 리다이렉트의 목적지도 접속 전에 검사합니다. 회사망에서는 실제 Release 및 대용량 Git LFS 다운로드 도메인까지 접근 가능해야 합니다.

기본 캐시 위치는 `%LOCALAPPDATA%\Temp\nexa-feasibility-20260921`입니다. 다른 PC에서는 `config/artifacts.json`의 각 항목에 있는 `cache` 상대 경로에 따라 파일을 배치하고 지정합니다.

```powershell
.\scripts\setup.ps1 -CachePath D:\NexaArtifacts -Offline
```

`-Offline`에서는 네트워크로 다운로드하지 않습니다. 검증된 `.runtime/downloads` 파일도 재사용합니다. 아카이브 안의 절대 경로, 상위 경로 접근, 심볼릭 링크·하드 링크는 거부합니다. 캐시 파일이 손상되었거나 누락되면 파일명을 표시하고 종료합니다. 설치 도중 종료된 다운로드는 가능한 경우 재개하며, 최대 3회 재시도합니다.

DOCX와 Git 기능에 필요한 추가 캐시 파일은 `pandoc-3.11-windows-x86_64.zip`과 `MinGit-2.55.0.5-64-bit.zip`입니다. 둘 다 공식 GitHub 릴리스와 SHA256이 manifest에 고정되어 있으며 `-NoModels` 설치에도 포함됩니다. Pandoc은 `.runtime/pandoc/pandoc.exe`, Git은 `.runtime/git/cmd/git.exe`를 사용합니다. 기존 설치를 갱신할 때도 먼저 Nexa를 중지한 뒤 setup을 실행하세요. 오프라인 **설치** 옵션은 이후 Git 원격 동기화의 네트워크 사용을 비활성화하지 않습니다.

## 3. 자료와 팀 접속

기본 데이터 디렉터리는 `data`이고, `-DataDirectory D:\NexaData` 또는 `NEXA_DATA_DIR`로 바꿀 수 있습니다. 바꾼 경우 시작·중지에 같은 디렉터리를 사용합니다. 이 안에 SQLite, 원문 객체(`objects`), Git bare 캐시(`git-cache`), 업로드, Qdrant 저장소, 관리자 키, 실행 기록, 로그가 보관됩니다. 프로그램 파일을 덮어쓸 때는 먼저 중지합니다. 설치기는 이전 검증용 Qdrant 저장소나 테스트 자료를 복사하지 않습니다.

관리자 키는 첫 API 실행 때 `data/admin-key.txt`에 생성됩니다. 기존 `NEXA_ADMIN_KEY`와 `NEXA_API_KEY` 환경 변수는 자식 프로세스에 전달하고 키를 명령줄이나 로그에 출력하지 않습니다. 팀 접속은 공유 검색 키를 환경 변수로 설정한 뒤 실행합니다.

```powershell
$env:NEXA_API_KEY = 'replace-with-a-long-random-team-key'
.\scripts\start.ps1 -ListenAddress 0.0.0.0 -Port 8787
```

팀원은 `http://서버IP:8787`에 접속합니다. 모델 서버와 Qdrant는 항상 `127.0.0.1`에만 바인딩됩니다. 팀 서비스 공개 범위 및 HTTPS는 회사 내부 프록시·네트워크 구성으로 정합니다. 서로 다른 출처의 UI를 사용하는 경우 API의 `NEXA_ALLOWED_ORIGINS`에 허용할 출처를 명시합니다. 기본 제공 UI는 API와 같은 출처입니다.

| 프로세스 | 로컬 주소 | 실행 설정 |
| --- | --- | --- |
| Nexa API/UI | `127.0.0.1:8787` | Bun `--no-install`, API 준비 확인 `/api/v1/health` |
| 생성 모델 | `127.0.0.1:18181` | Qwen3.5 4B Q4_K_M, context 4096, slot 1, GPU 99 layers, offline |
| 임베딩 모델 | `127.0.0.1:18182` | EmbeddingGemma Q8_0, context/batch/ubatch 2048, mean pooling, offline |
| Qdrant | `127.0.0.1:16333`, gRPC `16334` | telemetry disabled, `data/qdrant` 저장소 |

## 4. 자료 연결과 자동 갱신

프로젝트별로 코드 Git 저장소와 별도 문서 폴더를 연결합니다. 자료 역할은 `code`, `spec`, `reference`이며 모듈의 경로 규칙을 저장하면 이후 파일도 같은 규칙으로 분류합니다. `src/uart/**`, `specs/uart/**`처럼 소스 기준 상대 경로를 사용합니다. 규칙은 등록 순서대로 첫 일치 항목이 적용되며, 미일치 파일도 프로젝트의 자료로 검색할 수 있습니다. 규칙 변경 후 현재 자료를 다시 동기화하면 새 작업 스냅샷에 반영됩니다.

모듈 수정 API는 이름과 규칙을 교체하고 자동 동기화를 요청합니다. 사양서 이름·내용이 함께 바뀌어 자동 대응할 수 없으면 자료 settings의 `documentLinks:{"현재/경로.docx":"이전/경로.docx"}`를 설정한 뒤 동기화합니다. 같은 소스 안의 문서 계보에만 적용하며 과거 버전은 바꾸지 않습니다. 자세한 요청 형식은 [API 문서](api.md)에 있습니다.

폴더는 파일 저장 이벤트를 기본 2초 동안 모아 동기화하고, Git과 폴더는 시작 시 및 기본 5분마다 전체 상태를 다시 확인합니다. 이벤트가 유실되거나 공유폴더 감시가 불가능해도 정기 대조로 재시도합니다. 업로드는 최초 색인 후 정기 대조 대상에서 빠지며 필요할 때 수동 재색인합니다. 자동 갱신을 일시정지한 연결은 정기·이벤트 수집에서 제외됩니다.

| 환경 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `NEXA_SYNC_INTERVAL_MS` | `300000` | Git·폴더 정기 대조 간격, 최소 1,000ms |
| `NEXA_DEBOUNCE_MS` | `2000` | 폴더 저장 이벤트 대기 시간, 최소 20ms |
| `NEXA_PANDOC_PATH` | 프로젝트 내 Pandoc | 파서 실행파일 재정의 |
| `NEXA_GIT_PATH` | 프로젝트 내 MinGit | Git 실행파일 재정의 |

실행파일 경로를 재정의해도 시작 스크립트는 기본 번들의 설치 여부를 확인합니다. 기본 고정 버전을 사용하는 것이 검증 환경과 일치합니다. 감지 주기는 완료 보장이 아니며, 큰 파일·대기 중 작업·임베딩 처리 시간에 따라 검색 반영이 늦어질 수 있습니다.

### Git 원격 인증

지원 주소는 `https://github.com/조직/저장소.git`, `https://bitbucket.org/워크스페이스/저장소.git`, `git@github.com:조직/저장소.git`, `ssh://git@bitbucket.org/워크스페이스/저장소.git` 형태입니다. HTTPS는 기본 443, SSH는 기본 22 포트를 사용합니다. 사내 Bitbucket Server·GitHub Enterprise의 별도 호스트는 아직 지원하지 않습니다.

HTTPS URL에 사용자명·비밀번호·토큰을 넣지 않습니다. Nexa를 실행하는 Windows 계정에서 Git Credential Manager의 인증을 먼저 준비하세요. SSH는 같은 계정의 키·에이전트 및 신뢰한 `known_hosts`가 필요합니다. Nexa의 동기화는 대화형 로그인과 호스트 키 확인 창을 띄우지 않으며, 준비되지 않은 인증은 작업 진단으로 반환합니다. Git 작업은 전역 Git 설정을 읽지 않고 Windows HTTPS 인증에는 `manager` helper를 지정합니다. 사내 프록시·인증 정책과 실제 비공개 저장소 접속은 해당 환경에서 별도 확인해야 합니다.

동기화는 `data/git-cache/<source-id>.git`만 갱신하고 개발자의 작업 폴더를 checkout/pull/reset하지 않습니다. 선택한 브랜치의 커밋과 태그를 읽으며 커밋되지 않은 작업 파일은 포함하지 않습니다. 작업본까지 자동 반영하려면 그 로컬 폴더를 별도로 연결하세요. LFS 원문과 submodule은 자동으로 내려받지 않고 진단을 남깁니다. 한 번의 Git 수집 한도는 256 MiB, 일치 태그 목록은 1,000개입니다.

### SW 버전과 보존 자료

SW 버전을 확정하면 코드 커밋과 선택한 문서 스냅샷을 묶어 저장합니다. 최초 동기화에서 발견한 기존 태그는 자동으로 현재 사양서와 연결하지 않습니다. 과거 태그를 후보로 선택한 뒤 해당 시점의 사양서 스냅샷을 지정하세요. 이후 새로 감지한 태그에는 감지 당시 문서 연결을 제안하며, 확정 전 대응 관계와 진단을 확인합니다.

소스별 최신 작업 스냅샷 30개와 확정 버전·후보가 참조하는 스냅샷을 유지합니다. 같은 원문과 추출 결과는 공유하므로 동일 파일을 버전 수만큼 중복 저장하지 않습니다. 구버전 데이터 최초 이관 시 기존 문서가 있으면 `data/backups/before-knowledge-*.sqlite`를 생성합니다. 이관된 과거 자료는 추출 텍스트이며 원본 bytes 보존은 재동기화부터 시작합니다.

파서 개선 후에는 `POST /api/v1/versions/:id/reindex`로 보존 원문을 재처리할 수 있습니다. Git 원격이나 현재 폴더를 다시 읽지 않고 별도 검색 색인을 생성하며, 확정 당시 원문과 스냅샷 연결은 유지합니다. 작업 실패 시 기존 검색 색인을 계속 사용합니다. 실행 중인 서비스를 중지하고 먼저 `data`를 백업한 뒤 프로그램과 파서를 함께 갱신하세요.

폴더나 원격 저장소에 접근하지 못하면 기존 보존 자료를 유지하고 최신 검색에서 해당 연결을 제외합니다. 실패 진단을 해결한 후 재동기화하세요. 확정 버전은 과거 스냅샷을 계속 참조합니다. 서비스 중지 후 `data` 전체를 함께 백업하고, 외부 폴더 및 원격 Git 저장소의 백업은 별도로 관리합니다.

DOCX는 Pandoc sandbox로 제목·문단·목록·표의 텍스트를 추출합니다. 변경추적은 삽입을 반영하고 삭제를 제외합니다. Word 페이지 레이아웃이나 이미지 OCR은 제공하지 않으며, 인용에는 제목 경로와 블록·표 위치를 사용합니다.

## 5. 중지와 문제 확인

```powershell
.\scripts\stop.ps1
Get-Content .\data\logs\api.stderr.log -Tail 50
Get-Content .\data\logs\generation.stderr.log -Tail 50
```

시작 스크립트는 프로세스별 준비 상태를 확인하며 기본 제한 시간은 180초입니다. `-StartupTimeoutSeconds 300`으로 늘릴 수 있습니다. 동일 세션이 실행 중이면 중복 실행하지 않습니다. 다른 프로세스가 필요한 포트를 사용 중이면 해당 프로세스를 종료하지 않고 중단합니다. 시작 실패 시 이번 실행에서 새로 만든 프로세스만 정리합니다. 중지 스크립트는 기록된 PID, 실행 파일 절대 경로, 프로세스 시작 시간이 모두 일치하는 프로젝트 프로세스만 종료합니다. 데이터와 로그는 지우지 않습니다.

모델 없이 업로드·색인·키워드 검색을 점검하려면 아래 명령을 사용합니다. 이 모드에서는 모델 생성 답변과 벡터 검색을 사용할 수 없습니다.

```powershell
.\scripts\setup.ps1 -NoModels
.\scripts\start.ps1 -NoModels
```

`-NoModels`는 API에 `NEXA_MODE=keyword`를 전달하고 모델/Qdrant 프로세스를 시작하지 않습니다. Git·폴더·DOCX 수집과 원문 사양 diff는 사용할 수 있지만 모델 답변·비교 요약은 제공하지 않습니다. 기능 분석은 후보 근거를 표시하더라도 모델 판정을 수행하지 않아 미확인으로 남깁니다. 전체 모드로 전환할 때는 중지 후 모델 설치를 완료하고 `start.ps1`을 다시 실행합니다. 두 모드의 자료 디렉터리는 같습니다.

프로젝트와 데이터 폴더는 쓰기 가능한 로컬 디스크에 두는 것이 기본입니다. 런타임 버전 변경은 manifest의 출처 및 해시를 검토하고 검증한 뒤 중지된 상태에서 설치합니다. `.runtime`, `.models`, `vendor`, `data`는 Git에 올리지 않으며 별도의 배포 캐시와 데이터 백업 대상으로 관리합니다.

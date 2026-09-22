# 외부 LLM 연결

Nexa는 외부 LLM을 **답변 생성과 기능 분석 단계**에 사용할 수 있습니다. 문서를 읽고 검색하는 RAG 경로는 기존처럼 로컬 EmbeddingGemma와 Qdrant를 사용하므로, 외부 provider를 선택해도 색인을 다시 만들 필요가 없습니다.

API 키는 웹 화면이나 요청 본문에 넣지 말고 Nexa를 실행하는 PowerShell 프로세스의 환경 변수에 넣습니다. 서버가 키를 읽어 외부 provider에 전달하며, 브라우저로 반환하지 않습니다.

## 공통 설정

provider를 바꾸기 전에 실행 중인 Nexa를 중지합니다.

```powershell
.\scripts\stop.ps1
```

`NEXA_LLM_API_KEY`를 사용하면 provider별 변수보다 우선합니다. provider별 기본 변수는 다음과 같습니다.

| provider | `NEXA_LLM_PROVIDER` | API 키 변수 | 기본 모델 |
| --- | --- | --- | --- |
| OpenAI | `openai` | `OPENAI_API_KEY` | `gpt-5-mini` |
| Claude | `anthropic` | `ANTHROPIC_API_KEY` | `claude-sonnet-4-5-20250929` |
| GitHub Copilot | `github-copilot` | `COPILOT_GITHUB_TOKEN` → `GH_TOKEN` → `GITHUB_TOKEN` | `gpt-5.4` |

## OpenAI

```powershell
$env:NEXA_LLM_PROVIDER = 'openai'
$env:OPENAI_API_KEY = 'sk-발급받은-키'
$env:NEXA_LLM_MODEL = 'gpt-5-mini'

# 처음 설치하거나 Qwen 로컬 생성 모델을 받지 않을 때
.\scripts\setup.ps1 -ExternalLLM
.\scripts\start.ps1
```

OpenAI 요청은 `/v1/chat/completions`로 전송하고 JSON Schema 응답 형식을 사용합니다. OpenAI 호환 서버를 사용한다면 `NEXA_LLM_BASE_URL`로 `/v1`까지 포함한 주소를 지정할 수 있습니다.

## Claude

```powershell
$env:NEXA_LLM_PROVIDER = 'anthropic'
$env:ANTHROPIC_API_KEY = 'sk-ant-발급받은-키'
$env:NEXA_LLM_MODEL = 'claude-sonnet-4-5-20250929'

.\scripts\setup.ps1 -ExternalLLM
.\scripts\start.ps1
```

Claude 요청은 Anthropic Messages API로 전송합니다. Claude API에는 provider가 이해할 JSON Schema를 system 지침에도 함께 전달해 Nexa의 인용 검증을 유지합니다.

## GitHub Copilot

GitHub Copilot은 일반 OpenAI URL에 키를 직접 붙이지 않고 공식 Copilot SDK를 통해 호출합니다. 이 저장소에는 `@github/copilot-sdk` 의존성이 들어 있으므로 한 번 설치합니다.

```powershell
.\.runtime\bun\bun.exe install

$env:NEXA_LLM_PROVIDER = 'github-copilot'
$env:COPILOT_GITHUB_TOKEN = 'gho_또는_조직에서_발급한_Copilot_토큰'
$env:NEXA_LLM_MODEL = 'gpt-5.4'

.\scripts\setup.ps1 -ExternalLLM
.\scripts\start.ps1
```

GitHub Copilot SDK가 제공하는 bundled runtime을 사용하므로 별도로 `copilot` 실행 파일을 설치할 필요는 없습니다. `COPILOT_CLI_PATH`를 지정하면 설치된 Copilot CLI 경로를 직접 사용할 수 있습니다. 토큰에는 해당 계정 또는 조직에서 Copilot 요청을 사용할 권한이 있어야 하고, 선택한 모델은 Copilot 정책에서 허용되어야 합니다.

## 설치와 실행에서 유지되는 것

`-ExternalLLM`은 Qwen 생성 모델만 생략합니다. 외부 provider에서도 다음 구성 요소는 필요합니다.

- `llama.cpp`의 EmbeddingGemma 서버: 문서와 질문을 벡터로 변환
- Qdrant: 벡터 색인과 검색
- Bun/Hono API: 외부 LLM 호출과 인용 검증

따라서 외부 provider를 사용할 때 `start.ps1 -NoModels`를 함께 사용하면 안 됩니다. `-NoModels`는 임베딩과 Qdrant까지 끄는 키워드 모드입니다.

실행 후 `/api/v1/health`의 `generationProvider`에서 선택된 provider를 확인할 수 있습니다. `embedding`과 `vector`가 정상이어야 문서 검색이 가능하고, `generation.ok`가 정상이어야 답변 생성이 가능합니다.

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/v1/health
```

외부 provider를 선택하면 질문 답변, 기능 지원 여부 분석, 버전 비교 요약이 해당 provider로 전송됩니다. 문서 원문과 검색 근거가 외부 provider에 전달되므로 provider의 계정 정책과 데이터 처리 정책을 함께 확인해야 합니다.

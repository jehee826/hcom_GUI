# hcom_gui 구현 계획

[아키텍처](../design/architecture.md)를 기준으로 현재까지 완료된 단계와 다음 작업(**GUI 속도·토큰·웹 테스트 워크플로 개선 + Codex Desktop 스타일 UI 전면 개편**) 계획을 정리한다. 진행 결과는 [인계 문서](../HANDOFF.md)와 [개발 기록](../DEVLOG.md)에 남긴다.

## 1. 완료된 마일스톤

| 단계 | 내용 | 상태 | 근거 |
| --- | --- | --- | --- |
| 1단계 · 세션 왕복 | Codex App Server ↔ `hcom` ↔ `agy` 실환경 왕복, 세션 격리, 동일 ID 재개 | 완료 | PR #1 (`2397f5b`) |
| 2단계 · 프로젝트 격리 | Git 공용 디렉터리·SQLite 영속 저장·슬롯 잠금·추가 워커·worktree 대조·재시작 복구 | 완료 | PR #2 (`5f78d86`) |
| 3단계 · 서버·GUI·설치형 앱 | 루프백 Express HTTP/SSE, 라이트 모노크롬 UI, Electron 트레이/업데이터, 커스텀 NSIS `.exe` | 완료 | PR #3~#4 (`6c661c5`) |
| 실물 버그픽스 & 오케스트레이션 | `trustedWorkspaces` 자동 동기화, 멀티라운드 검수·재지시 루프, `ask_user`, 일반 폴더, 워커 직접 전송 | 완료 | PR #5~#6 (`aa2e169`) |
| 모델·권한·로그·최적화 | Codex/`agy` 모델·추론·권한 제어, 실시간 추론 로그, `waiting_approval` 원격 복구, 이벤트 기반·렌더 최적화 | 완료 | PR #7~#8 (`a1aed21`) |

## 2. 다음 작업: 성능·토큰·개발 워크플로 개선 & Codex Desktop 스타일 UI 전면 개편

매번 `.exe`를 설치하지 않고 빠르게 개발·검증할 수 있도록 **성능·토큰·`dev:web` 기반 개선을 먼저 정리**하고, 같은 흐름에서 **Codex Desktop 스타일 4-Zone UI**로 개편한다.

### Phase 0 · GUI 속도 · 토큰 반복 입력 축소 · `dev:web` 개발 워크플로 (최우선)

1. **GUI 속도 · 바뀐 부분만 갱신 + 최근 이력 우선 로드**
   - **대상:** [`src/store/index.ts`](../../src/store/index.ts), [`src/server/index.ts`](../../src/server/index.ts), [`src/runtime/index.ts`](../../src/runtime/index.ts), [`src/web/app.ts`](../../src/web/app.ts)
   - `GET /api/projects/:id`가 전체 이력을 매번 읽지 않도록 기본 최근 이력(`?limit=30`, `hasMore`, `beforeCreatedAt`/`beforeId`)만 반환하고, 필요 시 `이전 대화 더 불러오기`로 추가 조회한다.
   - 구조적 SSE 이벤트(`request.*`, `worker.*`, `codex.*`, `handoff.updated`)에 변경된 엔티티 스냅샷을 함께 실어 보내고, 프론트엔드는 전체 재조회(`refreshActiveProject`)·전체 재렌더(`renderAll`) 대신 **바뀐 요청 카드·워커 카드·헤더 슬롯만 부분 패치**한다.
2. **GUI 속도 · CLI 진단을 초기 화면에서 분리 (비동기 + 캐시)**
   - **대상:** [`src/server/diagnostics.ts`](../../src/server/diagnostics.ts), [`src/server/index.ts`](../../src/server/index.ts), [`src/web/app.ts`](../../src/web/app.ts)
   - `where`와 `--version` 호출을 동기(`execFileSync`)에서 비동기(`execFile`) + 인메모리 TTL 캐시(`?refresh=1` 수동 갱신 지원)로 전환한다.
   - 초기 부팅 시 프로젝트 목록과 최근 대화를 먼저 표시하고, CLI 진단은 백그라운드 비동기 조회가 끝난 뒤 상태 점·모달만 업데이트한다.
3. **토큰 · 반복 입력 축소 및 사용자 지침 기반 유연 제어**
   - **대상:** [`src/runtime/index.ts`](../../src/runtime/index.ts), [`src/store/index.ts`](../../src/store/index.ts), [`src/server/index.ts`](../../src/server/index.ts)
   - 코드가 라운드마다 강제로 붙이던 반복 검수 문구(`buildReviewTurnInput`의 `[검수 지침]` 블록)를 제거하고, 워커 회신 요약만 간결하게 전달한다.
   - `list_workers` JSON에서 중복·`null` 필드를 제거해 경량화하고, 위임 직후 불필요한 확인성 텍스트 입력을 최소화한다.
   - **강제 검수 대신 사용자 지침으로 제어:** 검수 여부·강도·위임 스타일은 앱 코드가 강제하지 않고, 사용자가 원할 때 작성·수정할 수 있는 **프로젝트별 선택 지침**(`customInstructions`, 기본 비어 있음 → 0토큰)으로 유연하게 컨트롤한다.
4. **테스트용 웹 서버 스크립트 (`npm run dev:web`) 추가**
   - **대상:** `scripts/dev-web.ts`, [`package.json`](../../package.json)
   - Electron 없이 Express API·SSE·정적 웹 UI를 `127.0.0.1`에 바로 띄우고 토큰 포함 접속 URL을 출력하는 `npm run dev:web`을 추가한다.

### Phase A · Codex Desktop 스타일 4-Zone 셸 & 디자인 토큰

- **대상:** [`src/web/index.html`](../../src/web/index.html), [`src/web/styles.css`](../../src/web/styles.css)
- **디자인 토큰:** 순백 캔버스(`#FFFFFF`), 초경량 연회색 사이드바(`#F9F9FA`), 헤어라인 테두리(`#EBEBEF`), 부드러운 pill(`#F2F2F4` / `#ECECEF`), 그림자 최소화.
- **좌측 아이콘 레일 (`48px`):** 상단 `hcom_gui` 다크 엠블럼, 중단 프로젝트 사이드바 토글·CLI 진단·인계 기록·hcom 로그, 하단 버전/업데이트 + CLI 상태 점.
- **좌측 프로젝트 사이드바 (`~232px`, 접이식):** 상단 `hcom_gui` 헤더·프로젝트 검색 토글, `+ 새 프로젝트 등록` 경량 행 버튼, 폴더 아이콘+프로젝트명+상태 점+브랜치 요약 리스트(활성 항목 soft pill).
- **미니멀 중앙 상단 헤더 (`44px`):** 좌측 폴더 아이콘·프로젝트명·브랜치/격리 뱃지, 우측 `시작 / 재개`·`중지`·우측 패널 토글 아이콘. 기존 2줄짜리 `#projectBar`를 제거해 대화 공간을 넓힌다.

### Phase B · 플랫 대화 캔버스 & 하단 플로팅 컴포저 통합

- **대상:** [`src/web/index.html`](../../src/web/index.html), [`src/web/styles.css`](../../src/web/styles.css), [`src/web/app.ts`](../../src/web/app.ts)
- **사용자 메시지:** 우측 정렬 연회색 말풍선(`#F3F3F5`, `border-radius: 18px`, 테두리 없음).
- **AI 응답 플랫화:**
  - 외곽 `.assistant-card` 테두리·그림자 제거 → 순백 캔버스에 본문이 바로 흐르는 레이아웃.
  - **경량 XSS-safe 마크다운/코드 블록 렌더러 (`textContent` 기반 DOM, `innerHTML` 0건):** 제목·굵게·목록·인라인 코드·펜스 코드 블록(언어 라벨 + `복사` 버튼 포함, Codex의 `</> 일반 텍스트` 카드 스타일).
  - **1줄 추론 요약 & 상세 로그:** 응답 상단 펄스 점 + 최신 요약 + `▾` 토글로 `ProgressLogEntry` 타임라인 펼침.
  - **응답 하단 액션 바:** 복사, 완료 시각(`오후 1:17`), 위임/단계 배지, 실행 중 `취소` 버튼.
  - **인라인 액션 카드:** `waiting_user`(질문·선택지·답변 입력)와 `waiting_approval`(명령 상세·`승인하고 계속`/`거절`)만 옅은 회색 카드로 강조 표시.
  - **좌측 턴 미니맵:** 중앙 왼쪽 여백에 요청별 얇은 틱 마크를 표시해 클릭 시 해당 턴으로 이동.
- **하단 플로팅 컴포저 (`max-width: 740px`, `border-radius: 20px`):**
  - 좌측 툴바: `+` 대상 전환(`Codex` ↔ 개별 워커 직접 전송) + **Codex 권한 셀렉터**(보더리스 인라인 드롭다운: `작업폴더 쓰기` · `읽기 전용` · `전체 허용`).
  - 우측 툴바: **Codex 모델 + 추론 속도 셀렉터**(보더리스 인라인 드롭다운 + 새로고침) + **원형 다크 전송/중지 버튼**(`32×32`).

### Phase C · 우측 플로팅 워커 인스펙터 카드

- **대상:** [`src/web/index.html`](../../src/web/index.html), [`src/web/styles.css`](../../src/web/styles.css), [`src/web/app.ts`](../../src/web/app.ts)
- 기존 고정 우측 사이드바를 **여백이 있는 둥근 플로팅 카드(`border-radius: 16px`, `1px solid #EBEBEF`)**로 전환하고 Codex 우측 패널의 3섹션 리듬을 우리 앱에 맞춰 구성:
  1. **워커 (`워커` + 우측 `+` 추가 버튼)** — Codex `결과물` 위치:
     - 기본 접힘: 1줄 컴팩트 행(상태 점 · 워커명 · 모델/권한 요약 · `▾`), 작업 중 1줄 라이브 진행 표시.
     - `▾` 펼침: 모델·추론·권한 설정, `시작/재개`·`중지`·`설정 재적용`, 온디맨드 **생각·도구 로그**(`hcom transcript` + 라이브 이벤트), **워커 전용 직접 대화 입력창**.
  2. **실행 활동 (`hcom`)** — Codex `하위 에이전트` 위치:
     - 활성 워커 수 · 완료된 위임 수 · 최근 `hcom` 메시지 요약 및 접이식 메시지 스트림.
  3. **프로젝트 · 인계 · 사용자 지침** — Codex `소스` 위치:
     - 브랜치 · 커밋 · `HCOM_DIR` 격리 상태, 접이식 인계 기록 편집, 프로젝트별 **사용자 지침(선택)** 편집.

### Phase D · 3단계 테스트 워크플로 & 최종 패키징

매번 `.exe`를 설치하지 않고 아래 순서로 검증한다.

1. **1차 검증 — 웹 브라우저 (`npm run dev:web`):**
   - 구현 완료 후 에이전트가 `npm run dev:web` 서버를 띄우고 **브라우저 테스트 체크리스트**를 제공.
   - 사용자가 브라우저에서 레이아웃, 프로젝트 전환, SSE 부분 갱신, 모델·권한 변경, 접이식 워커(로그·직접 대화), 사용자 지침을 직접 확인하고 피드백 공유.
2. **2차 검증 — Electron 개발 실행 (`npm run build && npx --no-install electron .`):**
   - 설치 없이 트레이 상주, 네이티브 폴더 선택 다이얼로그 등 Electron 전용 동작 확인.
3. **최종 패키징 — NSIS 설치 파일 (`npm run dist`):**
   - 모든 UI·동작 확인이 끝난 마지막 단계에서만 `release/hcom_gui-1.0.0-x64-setup.exe`를 빌드해 설치·업데이트 검증 후 PR 병합 및 브랜치 삭제.

### 통과 기준

- 초기 진입 시 CLI 진단을 기다리지 않고 프로젝트 목록과 최근 이력이 즉시 표시된다.
- 요청·워커 상태 변경 SSE가 도착해도 전체 이력 재조회 없이 변경된 요청/워커 DOM 슬롯만 갱신된다.
- 반복 검수 보일러플레이트가 제거되고, 사용자 지침이 비어 있을 때 추가 지침 토큰이 주입되지 않으며, 사용자가 입력한 지침이 유연하게 반영된다.
- 업로드된 Codex Desktop 화면과 동일한 4-Zone 비율, 플랫 대화 피드, 하단 통합 컴포저, 우측 플로팅 워커 카드 구조를 갖춘다.
- 모든 응답·코드 블록·로그가 `textContent` 기반 XSS-safe DOM으로 렌더링되며 `npm run typecheck`, `npm test`가 모두 통과한다.
- `npm run dev:web`으로 브라우저에서 전체 화면·API·SSE를 설치 없이 테스트할 수 있다.

## 3. 이후 로드맵

1. **폰 원격 접속 (Tailscale Serve):** Windows 루프백 서버에 Tailscale Serve HTTPS + 일회용 페어링 + 세션 쿠키를 연결해 승인된 폰에서 동일 UI로 모니터링·지시 수행(로컬 경로 등록 제외).
2. **첫 정식 릴리즈:** 사용자 버전 지시 시 버전 브랜치(`1.0.0` 등)에서 `main` PR 병합 및 GitHub Actions Windows 설치 파일 릴리즈 파이프라인 구성.

# Ascentum Notion Cron

Notion + Discord + GCS Pulse 자동화 서버. 현재 운영 기준은 `Railway 단일 서비스`다.

`node:sqlite`를 사용하므로 런타임은 `Node 24+`가 필요하다.

## 운영 상태

- `2026-04-24` 기준 GitHub `main`은 Railway 프로덕션에 자동 배포되는 상태다.
- 프로덕션 URL은 `https://notion-cron-production.up.railway.app` 이다.
- `/healthz`가 `200 OK`로 응답하는 것까지 확인했다.
- 남은 수동 cutover 작업은 `Discord Interactions Endpoint URL`을 Railway의 `/discord-interact`로 변경하는 것이다.
- 위 전환 후 Discord 버튼, `/snippet`, 30분 자동 게시를 실운영에서 확인하면 Vercel 프로젝트는 제거해도 된다.

## 자동화 흐름

### 1. 데일리/주간 스니펫

- Railway always-on 서비스가 KST 날짜를 기준으로 매일 데일리 스니펫 생성 여부를 판단한다.
- 완료된 업무를 Notion에서 읽고 사람별로 정리한 뒤 GPT로 스니펫을 생성한다.
- Discord 채널에 버튼 메시지를 보내고, 각 메시지는 SQLite에 `pending` 상태로 저장된다.
- 30분 내 응답이 없으면 scheduler가 `due_at`이 지난 `pending` 레코드를 찾아 자동 게시한다.
- 월요일에는 주간 스니펫도 함께 생성한다.

### 2. Discord 상호작용

- `POST /discord-interact`가 Discord 버튼과 모달을 처리한다.
- 지원 동작은 `그대로 게시`, `헬스체크 입력`, `수정하기`, `건너뛰기`다.
- 게시 완료 후 GCS Pulse AI 채점(`/daily-snippets/feedback`, `/weekly-snippets/feedback`)을 비동기로 트리거한다.

### 3. 주간 미팅 리포트

- Railway scheduler가 매주 목요일 KST 기준으로 주간 리포트를 생성한다.
- 레거시 업무 DB와 최신 업무 DB를 같이 조회해 Notion 미팅 기록 페이지를 채운다.

## 환경변수

`.env.local` 또는 Railway Variables에 아래 값을 입력한다.

```env
PORT=3000
SQLITE_DB_PATH=./data/automation.sqlite
INTERNAL_ADMIN_TOKEN=
ENABLE_SCHEDULER=false
AUTO_POST_DELAY_MINUTES=30
SCHEDULER_TICK_SECONDS=60
APP_BASE_URL=

NOTION_API_KEY=
OPENAI_API_KEY=
NOTION_WORK_DB_ID=
NOTION_LEGACY_WORK_DB_ID=
NOTION_WORK_DB_CUTOFF_DATE=2026-04-01
NOTION_MEETING_DB_ID=
NOTION_MEETING_DATA_SOURCE_ID=
NOTION_TEMPLATE_ID=
NOTION_USER_YOUNGMIN=
NOTION_USER_SEYEON=

DISCORD_BOT_TOKEN=
DISCORD_APP_ID=
DISCORD_APP_PUBLIC_KEY=
DISCORD_CHANNEL_ID=

GCS_API_TOKEN_YOUNGMIN=
GCS_API_TOKEN_SEYEON=
```

운영 기본값:

- Railway production에서는 `ENABLE_SCHEDULER=true`
- Volume mount path는 `/app/data`
- Railway production에서는 `SQLITE_DB_PATH=/app/data/automation.sqlite`
- `APP_BASE_URL=https://notion-cron-production.up.railway.app`

## 로컬 실행

```bash
npm ci
cp .env.example .env.local
npm run dev
```

프로덕션 빌드:

```bash
npm run build
npm start
```

Discord slash command 등록:

```bash
npm run register:commands
```

## 내부 엔드포인트

모든 `/internal/*` 엔드포인트는 `Authorization: Bearer $INTERNAL_ADMIN_TOKEN` 헤더가 필요하다.

- `POST /internal/snippets/send-daily`
- `POST /internal/snippets/sweep-timeouts`
- `POST /internal/reports/run-weekly`
- `POST /internal/snippets/retry/:id`
- `GET /healthz`

예시:

```bash
curl -X POST \
  -H "Authorization: Bearer $INTERNAL_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"person":"youngmin","force":true}' \
  http://localhost:3000/internal/snippets/send-daily
```

## 테스트

```bash
npm run build
npm run test:task-hierarchy
npm run test:work-queries
npm run test:automation-state
npm run test:load-env
```

## 배포 메모

- Railway project name: `Ascentum Notion Cron`
- Railway service name: `notion-cron`
- GitHub repository: `ascentum/Ascentum-Notion-Cron`
- Railway는 `main` 브랜치 기준 auto deploy로 동작한다.
- Railway deploy/runtime 설정은 루트의 `railway.toml`로 함께 관리한다.
- start command는 `node dist/src/server.js`로 직접 지정해, 롤링 배포 시 `npm run start`의 `SIGTERM` 오탐 알림을 줄인다.

## Discord Cutover 체크리스트

1. Discord Developer Portal에서 Interactions Endpoint URL을 `https://notion-cron-production.up.railway.app/discord-interact`로 변경한다.
2. `/snippet` slash command가 정상 응답하는지 확인한다.
3. 버튼 클릭, 수정, 헬스체크 입력, 건너뛰기가 모두 정상 동작하는지 확인한다.
4. 30분 미응답 자동 게시가 정상 동작하는지 확인한다.
5. 확인이 끝나면 Vercel Git 연결을 해제하고, 최종적으로 Vercel 프로젝트를 삭제한다.

## 프로젝트 구조

```text
src/
  server.ts                    # Express 엔트리포인트
  scheduler.ts                 # 1분 tick 스케줄러
  database.ts                  # SQLite 저장소
  discord-handler.ts           # Discord interaction 처리
  services/
    daily-snippet-service.ts   # 데일리/주간 스니펫 생성
    dispatch-service.ts        # pending/posted/skipped 상태 전이
    weekly-report-service.ts   # Notion 주간 리포트
lib/
  notion.ts
  openai.ts
  discord.ts
  gcs.ts
```

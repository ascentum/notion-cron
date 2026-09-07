# Ascentum Notion Cron

Notion + Discord + GCS Pulse 자동화 서버. 현재 운영 기준은 `Oracle Cloud VM + Docker Compose`다.

`node:sqlite`를 사용하므로 런타임은 `Node 24+`가 필요하다.

## 운영 구성

- Oracle Cloud: Express 서버, Discord interaction endpoint, 내부 scheduler, SQLite 상태 저장을 담당한다.
- Caddy: Oracle VM에서 HTTPS 인증서 발급/갱신과 reverse proxy를 담당한다.
- GitHub Actions: Notion 반복 템플릿으로 생성된 업무 캘린더 페이지의 링크드 DB 뷰 필터를 보정한다.
- Notion: 업무 DB, 업무 캘린더 DB, 미팅 기록 DB를 데이터 소스로 사용한다.
- Discord: 스니펫 확인/수정/건너뛰기 상호작용을 받는다.
- GCS Pulse: 게시된 데일리/주간 스니펫 피드백 채점을 받는다.

## 운영 상태

- `2026-05-17` 기준 Oracle `/healthz`가 `200 OK`로 응답하고, scheduler는 enabled 상태다.
- 프로덕션 URL은 `https://notion-cron.168.110.123.188.sslip.io` 이다.
- Discord `Interactions Endpoint URL`은 `https://notion-cron.168.110.123.188.sslip.io/discord-interact`로 전환됐다.
- Railway production deployment는 내려갔고, Railway Variables의 `ENABLE_SCHEDULER=false`가 설정돼 있다.
- Oracle A1 Flex 신규 VM은 `Out of host capacity`로 생성하지 못해, 기존 Always Free 후보 VM인 `archy-ops-cron`에서 운영한다.

## 자동화 흐름

### 1. 데일리/주간 스니펫

- Oracle scheduler가 KST 날짜 변경을 기준으로 매일 한 번 실행한다.
- 데일리 스니펫은 KST 기준 실행일의 전날 업무를 대상으로 한다.
- 완료된 업무를 Notion에서 읽고 사람별로 정리한 뒤 OpenAI로 스니펫을 생성한다.
- Discord 채널에 버튼 메시지를 보내고, 각 메시지는 SQLite에 `pending` 상태로 저장된다.
- 30분 내 응답이 없으면 scheduler가 `due_at`이 지난 `pending` 레코드를 찾아 자동 게시한다.
- 월요일에는 지난 7일 범위의 주간 스니펫도 함께 생성한다.

### 2. Discord 상호작용

- `POST /discord-interact`가 Discord 버튼과 모달을 처리한다.
- 지원 동작은 `그대로 게시`, `헬스체크 입력`, `수정하기`, `건너뛰기`다.
- 게시 완료 후 GCS Pulse AI 채점(`/daily-snippets/feedback`, `/weekly-snippets/feedback`)을 비동기로 트리거한다.

### 3. 주간 미팅 리포트

- Oracle scheduler가 매주 목요일 KST 기준으로 주간 리포트를 생성한다.
- 레거시 업무 DB와 최신 업무 DB를 같이 조회해 Notion 미팅 기록 페이지를 채운다.
- `ENABLE_MEETING_PAGE_AUTO_CREATE=false`이면 해당 날짜의 `이민섭교수님` 미팅 페이지가 없을 때 새 페이지를 만들지 않고 스킵한다. 이미 만들어진 페이지가 있으면 기존처럼 내용을 채운다.

### 4. 업무 캘린더 링크드 뷰 필터 보정

- GitHub Actions가 KST 평일 03:00에 `어센텀 업무 ...` 캘린더 페이지를 스캔한다.
- 각 페이지의 첫 번째 콜아웃 안에 있는 `어센텀 업무 DB` 링크드 뷰에서 `완료일 = today` 필터를 해당 페이지의 `일정` 날짜로 바꾼다.
- 콜아웃 밖의 링크드 DB 뷰는 건드리지 않는다.
- 이미 날짜가 고정된 `완료일` 필터는 기본적으로 다시 바꾸지 않는다.
- 기본 스캔 범위는 KST 오늘 기준 2일 전부터 오늘까지다.
- 수동 실행은 GitHub Actions의 `Fix Notion linked view filters` workflow에서 `target_date`를 지정해 실행한다.

### 5. 주간 업무 시간 리포트

- KST 월요일 00:00에 스케줄러가 지난주(월~일) 구글 캘린더 일정을 집계한다.
- 대상 캘린더는 `ym5373@gachon.ac.kr`이고, 제목에 `영민 근무`가 포함된 **시간 지정 일정**만 근무로 인정한다. (종일 일정은 시간 산정이 불가해 제외)
- 누적 평균은 별도 저장 없이 매번 캘린더에서 과거 기록을 다시 조회해 계산한다. 캘린더가 항상 단일 진실 소스라 과거 일정을 수정해도 평균이 자동 교정된다.
- 평균의 분모는 첫 근무 기록이 있는 주부터 지난주까지의 모든 주이며, 근무가 0시간인 주도 포함한다.
- 주차 표기(`N월 N째주`)는 그 주의 목요일이 속한 달을 기준으로 한다.
- 마지막 한 줄 멘트는 OpenAI가 매주 생성하고, 실패하면 성과 구간별 대체 멘트로 폴백한다.
- 결과는 Discord mgmt 채널(`1483333112686579774`)에 일반 텍스트로 전송된다.

## 환경변수

`.env.local` 또는 `ops/oracle/notion-cron.env`에 아래 값을 입력한다.

```env
PORT=3000
SQLITE_DB_PATH=./data/automation.sqlite
INTERNAL_ADMIN_TOKEN=
ENABLE_SCHEDULER=false
ENABLE_MEETING_PAGE_AUTO_CREATE=false
AUTO_POST_DELAY_MINUTES=30
SCHEDULER_TICK_SECONDS=60
APP_BASE_URL=

NOTION_API_KEY=
OPENAI_API_KEY=
NOTION_WORK_DB_ID=
NOTION_WORK_CALENDAR_DB_ID=
NOTION_WORK_CALENDAR_TITLE_PREFIX=어센텀 업무
NOTION_WORK_CALENDAR_DATE_PROPERTY_NAME=일정
NOTION_LINKED_VIEW_DATE_PROPERTY_NAME=완료일
NOTION_WORK_CALENDAR_LOOKBACK_DAYS=2
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

- Oracle production에서는 `ENABLE_SCHEDULER=true`
- Oracle production에서는 `ENABLE_MEETING_PAGE_AUTO_CREATE=false`
- Volume mount path는 `/app/data`
- Oracle production에서는 `SQLITE_DB_PATH=/app/data/automation.sqlite`
- Oracle VM host data path는 `/opt/notion-cron/data`
- `APP_BASE_URL=https://notion-cron.168.110.123.188.sslip.io`

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

업무 캘린더 링크드 뷰 필터 보정:

```bash
DRY_RUN=true npm run notion:fix-work-calendar-views
DRY_RUN=true TARGET_DATE=2026-05-16 npm run notion:fix-work-calendar-views
npm run notion:fix-work-calendar-views
```

GitHub Actions repository secrets:

- `NOTION_API_KEY`
- `NOTION_WORK_DB_ID`
- `NOTION_WORK_CALENDAR_DB_ID`

GitHub Actions repository variables는 선택값이다. 기본값과 다르게 운영할 때만 설정한다.

- `NOTION_WORK_CALENDAR_TITLE_PREFIX`
- `NOTION_WORK_CALENDAR_DATE_PROPERTY_NAME`
- `NOTION_LINKED_VIEW_DATE_PROPERTY_NAME`
- `NOTION_WORK_CALENDAR_LOOKBACK_DAYS`

## 구글 캘린더 연동 (최초 1회)

1. GCP 프로젝트에서 **Google Calendar API**를 사용 설정한다. (프로젝트는 `ym5373@gachon.ac.kr` 계정 소유, OAuth 동의 화면 게시 상태는 `내부`)
2. OAuth 클라이언트를 만들고 `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`을 `.env.local`에 넣는다.
   현재 클라이언트는 **웹 애플리케이션** 유형이라 승인된 리디렉션 URI에 `http://localhost:5555/oauth2callback`가 등록되어 있어야 토큰 재발급이 된다. (데스크톱 앱 유형으로 만들면 루프백 URI가 자동 허용된다.)
3. 리프레시 토큰을 발급받는다. 출력된 URL을 브라우저에서 열고 `ym5373@gachon.ac.kr`로 동의하면 `.env.local`에 자동 저장된다.

```bash
npm run work-hours:oauth-setup
```

4. 발송 없이 집계만 확인한다.

```bash
npm run work-hours:send -- --dry-run --env ops/oracle/notion-cron.env
```

5. 실제 발송 (특정 주를 지정하려면 `--week <해당 주 월요일>`).

```bash
npm run work-hours:send -- --env ops/oracle/notion-cron.env
```

`GOOGLE_CALENDAR_ID`는 기본값이 `primary`이며, `영민 근무` 일정이 보조 캘린더에 있다면 해당 캘린더 ID로 바꾼다.

## 내부 엔드포인트

모든 `/internal/*` 엔드포인트는 `Authorization: Bearer $INTERNAL_ADMIN_TOKEN` 헤더가 필요하다.

- `POST /internal/snippets/send-daily`
- `POST /internal/snippets/sweep-timeouts`
- `POST /internal/reports/run-weekly`
- `POST /internal/reports/run-work-hours` (`{"dryRun":true}`, `{"targetWeekStart":"2026-08-31"}` 옵션)
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
npm run test:work-calendar-view-filters
npm run test:work-hours
```

## 장애 대응

- Oracle 상태 확인: `curl https://notion-cron.168.110.123.188.sslip.io/healthz`
- Oracle 컨테이너 확인: `ssh ubuntu@168.110.123.188 'cd /opt/notion-cron/app && docker compose --env-file ops/oracle/notion-cron.env -f ops/oracle/docker-compose.yml ps'`
- Discord interaction 장애: Discord application의 Interactions Endpoint URL이 `https://notion-cron.168.110.123.188.sslip.io/discord-interact`인지 확인한다.
- 데일리/주간 스니펫 누락: `/healthz`의 `recentJobs`와 Oracle Docker logs를 확인하고, 필요하면 `/internal/snippets/send-daily` 또는 `/internal/reports/run-weekly`를 내부 토큰으로 수동 호출한다.
- 업무 캘린더 링크드 뷰 필터 누락: GitHub Actions `Fix Notion linked view filters`를 `target_date=YYYY-MM-DD`로 수동 실행한다.
- Notion API 실패: 통합 토큰이 대상 DB와 생성된 페이지에 접근 권한이 있는지, `NOTION_WORK_DB_ID`/`NOTION_WORK_CALENDAR_DB_ID`가 맞는지 확인한다.

## 배포 메모

- Oracle VM: `archy-ops-cron`
- Oracle app path: `/opt/notion-cron/app`
- Oracle data path: `/opt/notion-cron/data/automation.sqlite`
- Oracle deploy command: `docker compose --env-file ops/oracle/notion-cron.env -f ops/oracle/docker-compose.yml up -d --build`
- GitHub repository: `ascentum/Ascentum-Notion-Cron`
- Railway project name: `Ascentum Notion Cron`
- Railway service name: `notion-cron`
- Railway 설정은 rollback 참고용으로 `railway.toml`에 남겨둔다.
- 비용 0원 운영 제약 때문에 reserved public IP, load balancer, 유료 DNS는 사용하지 않는다. VM 재생성 시 public IP와 `sslip.io` hostname이 바뀔 수 있다.

## Discord Cutover 체크리스트

1. Discord application의 Interactions Endpoint URL이 `https://notion-cron.168.110.123.188.sslip.io/discord-interact`인지 확인한다.
2. `/snippet` slash command가 정상 응답하는지 확인한다.
3. 버튼 클릭, 수정, 헬스체크 입력, 건너뛰기가 모두 정상 동작하는지 확인한다.
4. 30분 미응답 자동 게시가 정상 동작하는지 확인한다.
5. 안정화 확인 후 Railway Hobby plan 구독을 해지한다.

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
    work-hours-service.ts      # 구글 캘린더 주간 업무 시간 리포트
lib/
  notion.ts
  openai.ts
  discord.ts
  gcs.ts
  google-calendar.ts           # OAuth 토큰 갱신 + 캘린더 조회
  work-hours.ts                # 근무 시간 집계/포맷 (순수 함수)
```

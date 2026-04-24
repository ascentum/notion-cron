# Ascentum Notion Cron PRD

업데이트 기준일: `2026-04-24`

이 문서는 현재 운영 중인 `Railway 단일 런타임` 구조를 기준으로 정리한 제품/운영 문서다. 예전 `Vercel Cron + Next.js API route` 설계는 더 이상 사용하지 않는다.

## 목표

- Discord 데일리/주간 스니펫 자동화를 안정적으로 운영한다.
- 30분 내 버튼 클릭이 없으면 누락 없이 자동 게시한다.
- 매주 목요일 Notion 미팅 페이지를 자동으로 생성하고 내용을 채운다.
- 배포, 스케줄링, 상태 저장을 하나의 Railway 서비스 안에서 관리한다.

## 현재 아키텍처

### 런타임

- 플랫폼: Railway
- 앱 타입: always-on Node.js service
- 서버: Express
- 스케줄러: 프로세스 내부 1분 tick scheduler
- 저장소: SQLite on Railway Volume

### 공개 엔드포인트

- `POST /discord-interact`
- `GET /healthz`

### 내부 엔드포인트

- `POST /internal/snippets/send-daily`
- `POST /internal/snippets/sweep-timeouts`
- `POST /internal/reports/run-weekly`
- `POST /internal/snippets/retry/:id`

## 핵심 동작

### 1. 데일리/주간 스니펫

- KST 기준으로 스케줄러가 날짜를 판단한다.
- 대상 일자의 Notion 업무를 조회한다.
- OpenAI로 사람별 스니펫을 생성한다.
- Discord에 버튼 메시지를 보낸다.
- 메시지 메타데이터를 SQLite `snippet_dispatches` 테이블에 `pending`으로 저장한다.
- 월요일에는 주간 스니펫도 함께 생성한다.

### 2. 30분 자동 게시

- 각 dispatch는 생성 시 `due_at = created_at + 30 minutes`를 저장한다.
- 스케줄러는 1분마다 `due_at <= now AND status = pending` 조건으로 대상을 찾는다.
- 자동 게시 시 기본 헬스체크 점수 `5`를 붙인다.
- 처리 흐름은 `pending -> posting -> posted/skipped/failed` 상태 전이로 관리한다.
- 이 방식으로 Discord 최근 메시지 스캔 없이 timeout 자동 게시를 안정적으로 처리한다.

### 3. Discord 상호작용

- Discord 버튼과 모달은 `POST /discord-interact`에서 처리한다.
- 지원 동작:
- 그대로 게시
- 헬스체크 입력
- 수정 후 게시
- 건너뛰기
- slash command `/snippet`도 같은 런타임에서 처리한다.

### 4. 주간 미팅 리포트

- 매주 목요일 KST 기준으로 지난 주 업무를 집계한다.
- 레거시 DB와 최신 DB를 함께 읽는다.
- OpenAI로 요약을 생성한다.
- Notion 미팅 기록 DB에서 해당 날짜 페이지를 찾거나 새로 만든다.
- 페이지에 요약, 토글, 사람별 column 블록을 채운다.

## 저장소 설계

### `snippet_dispatches`

- Discord 메시지와 게시 상태를 저장한다.
- 주요 필드:
- `discord_message_id`
- `person`
- `snippet_type`
- `date_label`
- `content`
- `status`
- `health_score`
- `completion_source`
- `due_at`
- `posted_at`
- `last_error`

### `scheduler_state`

- 스케줄러의 일자 기준 실행 상태를 저장한다.
- 현재 사용 키:
- `last_daily_send_trigger_date`
- `last_weekly_report_trigger_date`

### `job_runs`

- 스케줄러 작업 실행 이력을 저장한다.
- `/healthz`에서 최근 실행 결과를 확인할 수 있다.

## 운영 설정

### Railway

- project name: `Ascentum Notion Cron`
- service name: `notion-cron`
- production domain: `https://notion-cron-production.up.railway.app`
- GitHub auto deploy branch: `main`
- volume mount path: `/app/data`
- sqlite path: `/app/data/automation.sqlite`
- deploy/runtime config file: `railway.toml`
- direct start command: `node dist/src/server.js`
- healthcheck path: `/healthz`

### GitHub

- repository: `ascentum/Ascentum-Notion-Cron`

### 필수 프로덕션 변수

- `ENABLE_SCHEDULER=true`
- `APP_BASE_URL=https://notion-cron-production.up.railway.app`
- `SQLITE_DB_PATH=/app/data/automation.sqlite`
- `INTERNAL_ADMIN_TOKEN`
- Notion/OpenAI/Discord/GCS 관련 운영 변수 일체

## 배포 및 검증 상태

`2026-04-24` 기준으로 아래까지 확인했다.

- `main` 머지 완료
- Railway auto deploy 성공
- 앱 런타임이 `node dist/src/server.js`로 기동되는 것 확인
- `GET /healthz`가 `200 OK`로 응답하는 것 확인
- scheduler enabled 상태 확인
- 이전 배포가 교체될 때 `npm run start`가 `SIGTERM`을 에러처럼 남기던 패턴을 확인했고, 이를 줄이기 위해 `railway.toml`로 direct start command를 고정했다

아직 남아 있는 수동 cutover 작업:

1. Discord Interactions Endpoint URL을 Railway `/discord-interact`로 변경
2. 버튼 클릭, `/snippet`, timeout 자동 게시 실운영 검증
3. 검증 후 Vercel Git 연결 해제 및 Vercel 프로젝트 삭제

## 로컬 개발

```bash
npm ci
cp .env.example .env.local
npm run dev
```

테스트:

```bash
npm run build
npm run test:task-hierarchy
npm run test:work-queries
npm run test:automation-state
npm run test:load-env
```

## 비목표

- 더 이상 Vercel Cron을 운영 기준으로 사용하지 않는다.
- 더 이상 Discord 최근 메시지 스캔으로 timeout 대상을 찾지 않는다.
- 더 이상 Next.js API route를 배포 엔트리포인트로 사용하지 않는다.

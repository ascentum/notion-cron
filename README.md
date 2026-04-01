# notion-cron

Notion + Discord + GCS Pulse 연동 자동화 서버 (Vercel Cron 기반)

---

## 자동화 흐름

### 1. 데일리/주간 스니펫 (`/api/daily-snippet`)

매일 **00:00 KST (자정)** Vercel Cron이 트리거.

```
어센텀 업무 DB (완료일=오늘 & 완료=체크된 업무)
    ↓
사람별 업무 그룹핑 (PIC 속성 기준, 카테고리 태그 + 계층 구조 포함)
    ↓
GPT-4o → 데일리 스니펫 생성 (박영민 / 조세연)
    ↓
Discord 채널에 검토 요청 (버튼 포함)
    ↓
[그대로 게시 / 헬스체크 입력 / 수정하기] 중 선택
    ↓
GCS Pulse 게시 → AI 채점 자동 트리거
```

**00:30 KST** 두 번째 Cron 실행 (외부 cron-job 서비스) — 30분 이내 무응답 메시지는 자동 게시 후 AI 채점.

**월요일**에는 지난 7일 데이터를 모아 주간 스니펫도 함께 생성.

---

### 2. Discord 상호작용 (`/api/discord-interact`)

Discord 버튼 클릭 시 처리:

| 버튼 | 동작 |
|------|------|
| 그대로 게시 ✅ | 헬스체크 5점 기본값으로 즉시 게시 |
| 헬스체크 입력 🔢 | 점수 입력 모달 → 게시 |
| 수정하기 ✏️ | 내용 + 점수 수정 모달 → 게시 |

게시 완료 후 GCS Pulse AI 채점(`/daily-snippets/feedback`, `/weekly-snippets/feedback`) 자동 호출.

---

### 3. 주간 미팅 리포트 (`/api/weekly-report`)

매주 **목요일 15:50 KST** Vercel Cron이 트리거.

```
어센텀 업무 DB (지난 7일간 완료된 업무, 카테고리 태그 포함)
    ↓
GPT-4o → 핵심 흐름 3축 총평 생성
    ↓
Notion 미팅 기록 DB에 신규 페이지 생성
```

---

## 환경변수

`.env.local` 파일에 아래 값을 모두 입력:

```env
# Vercel Cron 인증
CRON_SECRET=

# Notion
NOTION_API_KEY=
NOTION_WORK_DB_ID=          # 어센텀 업무 DB
NOTION_MEETING_DB_ID=
NOTION_TEMPLATE_ID=
NOTION_USER_YOUNGMIN=
NOTION_USER_SEYEON=

# OpenAI (스니펫/리포트 생성)
OPENAI_API_KEY=

# Discord
DISCORD_BOT_TOKEN=
DISCORD_CHANNEL_ID=
DISCORD_APP_PUBLIC_KEY=

# GCS Pulse API
GCS_API_TOKEN_YOUNGMIN=
GCS_API_TOKEN_SEYEON=
```

---

## Discord 설정

1. [Discord Developer Portal](https://discord.com/developers/applications)에서 Bot 생성
2. Bot Token → `DISCORD_BOT_TOKEN`
3. General Information → Public Key → `DISCORD_APP_PUBLIC_KEY`
4. Interactions Endpoint URL → `https://<your-domain>/api/discord-interact`

---

## Vercel 배포

```bash
# 1. 의존성 설치
npm ci

# 2. 환경변수 설정 (.env.local)
cp .env.example .env.local
# 에디터에서 값 입력

# 3. 로컬 테스트
npm run dev
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/daily-snippet

# 4. Vercel 배포
# GitHub 레포 연결 후 환경변수 입력 → Deploy
```

Vercel Cron 스케줄 (`vercel.json` 참고):

| 경로 | 스케줄 (UTC) | KST |
|------|-------------|-----|
| `/api/daily-snippet` | `0 15 * * *` | 매일 00:00 (자정) |
| `/api/daily-snippet?action=timeout` | `30 15 * * *` | 매일 00:30 (외부 cron-job) |
| `/api/weekly-report` | `50 6 * * 4` | 매주 목요일 15:50 |

---

## 프로젝트 구조

```
notion-cron/
├── app/api/
│   ├── daily-snippet/route.ts    # 스니펫 생성 & 타임아웃 처리
│   ├── discord-interact/route.ts # Discord 버튼/모달 처리
│   └── weekly-report/route.ts   # 주간 미팅 리포트
├── lib/
│   ├── notion.ts    # Notion API 헬퍼
│   ├── openai.ts    # GPT-4o 스니펫/리포트 생성
│   ├── discord.ts   # Discord Bot API + 서명 검증
│   └── gcs.ts       # GCS Pulse API (게시 + AI 채점)
└── vercel.json      # Cron 스케줄 설정
```

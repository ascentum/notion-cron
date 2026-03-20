# PRD: 주간 미팅 리포트 자동화 (Notion Cron)

> **목표**: 매주 목요일 15:50 KST, 지난 7일간 업무 DB의 완료 task를 자동으로 요약해  
> "미팅 기록" DB에 신규 페이지로 생성한다.

---

## 1. 개요

| 항목 | 내용 |
|---|---|
| 실행 주기 | 매주 목요일 15:50 KST (= 06:50 UTC) |
| 트리거 방식 | Vercel Cron Job |
| 데이터 소스 | Notion 업무 DB |
| 출력 대상 | Notion 미팅 기록 DB (이민섭교수님 미팅 템플릿 적용) |
| AI 요약 모델 | GPT-4o (OpenAI API) |

---

## 2. 사전 준비 — API 키 및 ID 정리

`.env.local`에 아래 값들을 직접 입력하면 된다.

```env
# Notion Internal Integration Token
# https://www.notion.so/my-integrations 에서 발급
NOTION_API_KEY=secret_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Anthropic API Key
# https://console.anthropic.com 에서 발급
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxx

# Vercel Cron 보안용 시크릿 (임의로 생성해도 됨, 예: openssl rand -hex 32)
CRON_SECRET=your_random_secret_string

# ─── 아래는 코드에 하드코딩해도 되지만 env로 관리 권장 ───

# 업무 DB Collection ID
NOTION_WORK_DB_ID=26abd55c-4778-80a6-b4c3-000b1976e9d8

# 미팅 기록 DB Data Source ID (collection://)
NOTION_MEETING_DB_ID=325bd55c-4778-8140-bec1-000bbfd3c7ad

# 이민섭교수님 미팅 템플릿 ID
NOTION_TEMPLATE_ID=328bd55c-4778-8064-9f0d-e89ba4226750

# 팀원 User ID
NOTION_USER_YOUNGMIN=7ea05b23-6a71-4a66-992a-5683f75e4145
NOTION_USER_SEYEON=176d872b-594c-813e-beca-00027ae51315
```

### Notion Integration 설정

1. [notion.so/my-integrations](https://www.notion.so/my-integrations) 접속
2. **"새 통합 만들기"** → 이름: `Ascentum Cron`
3. 권한: **읽기 + 업데이트 + 삽입** 체크
4. 생성 후 **시크릿 토큰** 복사 → `NOTION_API_KEY`에 입력
5. **업무 DB** 페이지 → 우측 `···` → **연결 → Ascentum Cron 추가**
6. **미팅 기록 DB** 페이지도 동일하게 연결

---

## 3. 레포지토리 구조

```
notion-cron/
├── app/
│   └── api/
│       └── weekly-report/
│           └── route.ts          ← 핵심 로직
├── lib/
│   ├── notion.ts                 ← Notion API 헬퍼
│   └── claude.ts                 ← Claude API 헬퍼
├── .env.local                    ← 로컬 환경변수 (gitignore)
├── .env.example                  ← 템플릿 (커밋용)
├── .gitignore
├── vercel.json                   ← Cron 스케줄 설정
├── next.config.ts
├── package.json
└── tsconfig.json
```

---

## 4. 파일별 전체 코드

### 4-1. `vercel.json`

```json
{
  "crons": [
    {
      "path": "/api/weekly-report",
      "schedule": "50 6 * * 4"
    }
  ]
}
```

> `50 6 * * 4` = 매주 목요일(4) 06:50 UTC = 15:50 KST

---

### 4-2. `package.json`

```json
{
  "name": "notion-cron",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start"
  },
  "dependencies": {
    "@notionhq/client": "^2.2.15",
    "@anthropic-ai/sdk": "^0.24.3",
    "next": "^14.2.0",
    "react": "^18",
    "react-dom": "^18"
  },
  "devDependencies": {
    "@types/node": "^20",
    "@types/react": "^18",
    "typescript": "^5"
  }
}
```

---

### 4-3. `lib/notion.ts`

```typescript
import { Client } from "@notionhq/client";

export const notion = new Client({
  auth: process.env.NOTION_API_KEY,
});

// 업무 DB에서 특정 날짜 범위의 페이지 목록 조회
export async function getWorkPages(startDate: string, endDate: string) {
  const response = await notion.databases.query({
    database_id: process.env.NOTION_WORK_DB_ID!,
    filter: {
      and: [
        {
          property: "일정",
          date: { on_or_after: startDate },
        },
        {
          property: "일정",
          date: { on_or_before: endDate },
        },
      ],
    },
    sorts: [{ property: "일정", direction: "ascending" }],
  });
  return response.results;
}

// 페이지 본문(블록) 전체를 재귀적으로 가져오기
export async function getAllBlocks(pageId: string): Promise<any[]> {
  const blocks: any[] = [];
  let cursor: string | undefined;

  do {
    const response = await notion.blocks.children.list({
      block_id: pageId,
      start_cursor: cursor,
      page_size: 100,
    });
    blocks.push(...response.results);
    cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
  } while (cursor);

  // 토글 블록 등 하위 블록도 재귀 조회
  const result: any[] = [];
  for (const block of blocks) {
    result.push(block);
    if ((block as any).has_children) {
      const children = await getAllBlocks(block.id);
      result.push(...children);
    }
  }
  return result;
}

// 블록에서 체크된 to_do 항목만 추출
export function extractCheckedTodos(blocks: any[]): string[] {
  return blocks
    .filter((b) => b.type === "to_do" && b.to_do?.checked === true)
    .map((b) => {
      const richTexts = b.to_do?.rich_text ?? [];
      return richTexts.map((rt: any) => rt.plain_text).join("");
    })
    .filter((text) => text.trim().length > 0);
}

// 페이지 사람 속성에서 User ID 목록 반환
export function getPageUsers(page: any): string[] {
  const peopleProp = page.properties?.["사람"];
  if (!peopleProp || peopleProp.type !== "people") return [];
  return peopleProp.people.map((p: any) => p.id);
}

// 페이지 날짜(일정) 반환
export function getPageDate(page: any): string | null {
  const dateProp = page.properties?.["일정"];
  if (!dateProp || dateProp.type !== "date") return null;
  return dateProp.date?.start ?? null;
}

// 미팅 기록 DB에 신규 페이지 생성 (템플릿 적용)
export async function createMeetingPage(title: string, todayIso: string) {
  return await notion.pages.create({
    parent: {
      database_id: process.env.NOTION_MEETING_DB_ID!,
    },
    properties: {
      이름: {
        title: [{ text: { content: title } }],
      },
      날짜: {
        date: { start: todayIso },
      },
      카테고리: {
        select: { name: "교수님 미팅" },
      },
    },
    // 템플릿은 별도 apply로 처리 (아래 함수 참고)
  });
}

// 페이지에 템플릿 적용
export async function applyTemplate(pageId: string, templateId: string) {
  // Notion 공개 API에는 template apply 기능이 없어서
  // 템플릿 페이지 블록을 직접 복사하는 방식으로 처리
  // (아래 appendContent에서 내용을 직접 채움)
}

// 페이지에 텍스트 블록 추가
export async function appendContent(pageId: string, blocks: any[]) {
  await notion.blocks.children.append({
    block_id: pageId,
    children: blocks,
  });
}
```

---

### 4-4. `lib/claude.ts`

```typescript
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

interface DailySummary {
  date: string;
  youngminTasks: string[];
  seyeonTasks: string[];
  allTasks: string[];
}

export async function generateWeeklySummary(
  dailySummaries: DailySummary[]
): Promise<{ overview: string; dailyDetail: string }> {
  // 프롬프트용 데이터 직렬화
  const rawData = dailySummaries
    .map((d) => {
      const all = d.allTasks.join("\n  - ");
      return `[${d.date}]\n  - ${all || "(완료 항목 없음)"}`;
    })
    .join("\n\n");

  const overviewPrompt = `
다음은 지난 1주일간(목요일~목요일) 어센텀 팀의 완료된 업무 목록이야.
이 내용을 바탕으로 **핵심 흐름 3가지 축**으로 총평을 작성해줘.
- 각 축은 "① 제목 — 설명" 형식
- 전체 200자 내외
- 말투는 "~해요" 체
- 리스트 없이 자연스러운 문단으로

업무 데이터:
${rawData}
`;

  const overviewResponse = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 500,
    messages: [{ role: "user", content: overviewPrompt }],
  });

  const overview =
    overviewResponse.content[0].type === "text"
      ? overviewResponse.content[0].text
      : "";

  // 데일리 상세는 그냥 포맷팅만 (AI 불필요)
  const dailyDetail = dailySummaries
    .map((d) => {
      const youngminPart =
        d.youngminTasks.length > 0
          ? d.youngminTasks.map((t) => `- ${t}`).join("\n")
          : "- (없음)";
      const seyeonPart =
        d.seyeonTasks.length > 0
          ? d.seyeonTasks.map((t) => `- ${t}`).join("\n")
          : "- (없음)";
      return `**${d.date}**\n[박영민]\n${youngminPart}\n\n[조세연]\n${seyeonPart}`;
    })
    .join("\n\n---\n\n");

  return { overview, dailyDetail };
}
```

---

### 4-5. `app/api/weekly-report/route.ts` ← 핵심 파일

```typescript
import { NextRequest, NextResponse } from "next/server";
import {
  getWorkPages,
  getAllBlocks,
  extractCheckedTodos,
  getPageUsers,
  getPageDate,
  createMeetingPage,
  appendContent,
} from "@/lib/notion";
import { generateWeeklySummary } from "@/lib/claude";

// Vercel Cron이 호출할 때 Authorization 헤더로 시크릿 검증
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // 1. 날짜 범위 계산 (오늘 기준 7일 전 ~ 오늘)
    const today = new Date();
    const sevenDaysAgo = new Date(today);
    sevenDaysAgo.setDate(today.getDate() - 7);

    const todayIso = today.toISOString().split("T")[0];
    const startIso = sevenDaysAgo.toISOString().split("T")[0];

    const YOUNGMIN_ID = process.env.NOTION_USER_YOUNGMIN!;
    const SEYEON_ID = process.env.NOTION_USER_SEYEON!;

    // 2. 업무 DB에서 해당 기간 페이지 가져오기
    const workPages = await getWorkPages(startIso, todayIso);
    console.log(`Found ${workPages.length} work pages from ${startIso} to ${todayIso}`);

    // 3. 각 페이지의 완료 task 파싱
    const dailySummaries = await Promise.all(
      workPages.map(async (page: any) => {
        const date = getPageDate(page) ?? "날짜 불명";
        const users = getPageUsers(page);
        const blocks = await getAllBlocks(page.id);
        const checkedTasks = extractCheckedTodos(blocks);

        // 사람 속성 기준으로 분류
        // (현재는 페이지 단위 매핑이므로, 박영민 페이지는 youngmin, 조세연 페이지는 seyeon)
        const isYoungmin = users.includes(YOUNGMIN_ID);
        const isSeyeon = users.includes(SEYEON_ID);

        return {
          date,
          youngminTasks: isYoungmin ? checkedTasks : [],
          seyeonTasks: isSeyeon ? checkedTasks : [],
          allTasks: checkedTasks,
        };
      })
    );

    // 완료 task가 하나도 없으면 스킵
    const totalTasks = dailySummaries.reduce(
      (sum, d) => sum + d.allTasks.length,
      0
    );
    if (totalTasks === 0) {
      return NextResponse.json({ message: "No completed tasks found" });
    }

    // 4. Claude로 총평 생성
    const { overview, dailyDetail } = await generateWeeklySummary(dailySummaries);

    // 5. 미팅 기록 DB에 신규 페이지 생성
    const pageTitle = `이민섭교수님 미팅 ${todayIso.replace(/-/g, "").slice(2)}`;
    const newPage = await createMeetingPage(pageTitle, todayIso);
    const newPageId = newPage.id;

    // 6. 페이지 내용 구성 및 삽입
    // 템플릿 구조를 직접 블록으로 구현
    const blocks = buildPageBlocks(overview, dailyDetail);
    await appendContent(newPageId, blocks);

    console.log(`Created meeting page: ${newPageId}`);
    return NextResponse.json({
      success: true,
      pageId: newPageId,
      tasksProcessed: totalTasks,
    });
  } catch (error) {
    console.error("Weekly report error:", error);
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}

// Notion 블록 구조 생성
function buildPageBlocks(overview: string, dailyDetail: string): any[] {
  return [
    // 구분선
    { object: "block", type: "divider", divider: {} },

    // 1️⃣ 아키(Archy) 유저 데이터 섹션 헤딩
    {
      object: "block",
      type: "heading_2",
      heading_2: {
        rich_text: [{ type: "text", text: { content: "1️⃣ 아키(Archy) 유저 데이터" } }],
      },
    },

    // 2️⃣ 업무 진행 현황
    {
      object: "block",
      type: "heading_2",
      heading_2: {
        rich_text: [{ type: "text", text: { content: "2️⃣ 업무 진행 현황" } }],
      },
    },

    // 총평 (paragraph)
    {
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [{ type: "text", text: { content: overview } }],
      },
    },

    // 데일리 업무 진행상황 토글
    {
      object: "block",
      type: "toggle",
      toggle: {
        rich_text: [
          { type: "text", text: { content: "📋 데일리 업무 진행상황" } },
        ],
        children: buildDailyDetailBlocks(dailyDetail),
      },
    },

    // 3️⃣ 인사이트 및 계획
    {
      object: "block",
      type: "heading_2",
      heading_2: {
        rich_text: [{ type: "text", text: { content: "3️⃣ 인사이트 및 계획 (주간 회고)" } }],
      },
    },

    // 4️⃣ 논의하고 싶은 내용
    {
      object: "block",
      type: "heading_2",
      heading_2: {
        rich_text: [{ type: "text", text: { content: "4️⃣ 논의하고 싶은 내용" } }],
      },
    },
  ];
}

// 데일리 상세를 날짜별 단락 블록으로 변환
function buildDailyDetailBlocks(dailyDetail: string): any[] {
  const lines = dailyDetail.split("\n");
  return lines
    .filter((line) => line.trim().length > 0)
    .map((line) => ({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [
          {
            type: "text",
            text: { content: line },
            annotations: {
              bold: line.startsWith("**") && line.endsWith("**"),
            },
          },
        ],
      },
    }));
}
```

---

### 4-6. `next.config.ts`

```typescript
import type { NextConfig } from "next";

const nextConfig: NextConfig = {};

export default nextConfig;
```

---

### 4-7. `.env.example` (커밋용 템플릿)

```env
NOTION_API_KEY=
ANTHROPIC_API_KEY=
CRON_SECRET=
NOTION_WORK_DB_ID=26abd55c-4778-80a6-b4c3-000b1976e9d8
NOTION_MEETING_DB_ID=325bd55c-4778-8140-bec1-000bbfd3c7ad
NOTION_TEMPLATE_ID=328bd55c-4778-8064-9f0d-e89ba4226750
NOTION_USER_YOUNGMIN=7ea05b23-6a71-4a66-992a-5683f75e4145
NOTION_USER_SEYEON=176d872b-594c-813e-beca-00027ae51315
```

---

### 4-8. `.gitignore`

```
.env.local
node_modules/
.next/
```

---

## 5. 로컬 셋업 & GitHub 배포 순서

```bash
# 1. 폴더 생성 및 이동
mkdir "Notion cron" && cd "Notion cron"

# 2. Next.js 프로젝트 초기화 (TypeScript + App Router)
npx create-next-app@latest . --typescript --app --no-tailwind --src-dir no --import-alias "@/*"

# 3. 의존성 설치
npm install @notionhq/client @anthropic-ai/sdk

# 4. 파일 생성
# (위의 코드들을 각 경로에 붙여넣기)

# 5. .env.local 생성 후 값 채우기
cp .env.example .env.local
# → 에디터에서 직접 API 키 입력

# 6. 로컬 테스트 (선택)
npm run dev
# → http://localhost:3000/api/weekly-report 에 GET 요청
# → 하지만 Authorization 헤더 필요:
# curl -H "Authorization: Bearer your_cron_secret" http://localhost:3000/api/weekly-report

# 7. GitHub 레포 생성 및 푸시
git init
git add .
git commit -m "feat: notion weekly report cron"
git remote add origin https://github.com/[username]/notion-cron.git
git push -u origin main
```

---

## 6. Vercel 배포 설정

1. [vercel.com](https://vercel.com) → **Add New Project** → GitHub 레포 선택
2. **Environment Variables** 탭에서 `.env.local`의 값들 모두 입력
3. **Deploy** 클릭
4. 배포 완료 후 **Project Settings → Cron Jobs** 탭에서 `50 6 * * 4` 스케줄 확인

> ⚠️ Vercel 무료 플랜은 Cron Job을 **하루 1회** 까지 지원함. 주 1회이므로 제한 없음.

---

## 7. 로직 흐름 요약

```
[매주 목요일 15:50 KST]
        │
        ▼
Vercel Cron → GET /api/weekly-report
        │
        ▼
① 오늘 기준 -7일 날짜 범위 계산
        │
        ▼
② Notion 업무 DB 쿼리 (date filter)
        │
        ▼
③ 각 페이지 블록 재귀 조회 → 체크된 to_do 항목 추출
        │
        ▼
④ 사람 속성(User ID)으로 박영민 / 조세연 분류
        │
        ▼
⑤ Claude API → 총평(overview) 생성
        │
        ▼
⑥ 미팅 기록 DB에 신규 페이지 생성
        │
        ▼
⑦ 총평 + 데일리 토글 블록 append
        │
        ▼
[완료] 노션에서 확인
```

---

## 8. 향후 개선 포인트 (선택)

- [ ] 토글 내 블록을 2컬럼(박영민 | 조세연)으로 구성 — Notion API가 column 블록을 직접 지원하지 않아 현재는 단일 컬럼
- [ ] 실행 결과를 디스코드 Webhook으로 알림
- [ ] 에러 발생 시 디스코드로 알림 (try-catch 개선)
- [ ] 조세연님이 담당자로 매핑된 별도 업무 DB 페이지가 생기면 seyeon 분류 자동화

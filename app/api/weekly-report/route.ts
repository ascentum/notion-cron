import { NextRequest, NextResponse } from "next/server";
import {
  notion,
  getWorkPages,
  getAllBlocks,
  extractCheckedTodos,
  getPageUsers,
  getPageDate,
  createMeetingPage,
  waitForTemplateBlocks,
  appendContent,
  findMeetingPageByDate,
  findHeadingBlock,
  deleteBlock,
} from "@/lib/notion";
import { generateWeeklySummary, SummarizedDay } from "@/lib/openai";

// Vercel Hobby: 최대 60초
export const maxDuration = 60;

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

    // 3. 각 페이지의 완료 task 파싱 (3개씩 병렬 처리 — rate limit 방지)
    const dailySummaries: {
      date: string;
      youngminTasks: string[];
      seyeonTasks: string[];
      allTasks: string[];
    }[] = [];

    const BATCH_SIZE = 3;
    for (let i = 0; i < workPages.length; i += BATCH_SIZE) {
      const batch = workPages.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async (page: any) => {
          const date = getPageDate(page) ?? "날짜 불명";
          const users = getPageUsers(page);
          const blocks = await getAllBlocks(page.id, 2);
          const checkedTasks = extractCheckedTodos(blocks);

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
      dailySummaries.push(...results);
    }

    // 완료 task가 하나도 없으면 스킵
    let totalTasks = 0;
    for (const d of dailySummaries) {
      totalTasks += d.allTasks.length;
    }
    if (totalTasks === 0) {
      return NextResponse.json({ message: "No completed tasks found" });
    }

    // 4. OpenAI로 총평 + 데일리 요약 생성
    const { overview, summarizedDaily } = await generateWeeklySummary(dailySummaries);

    // 5. 날짜 범위 (short format)
    const startShort = toShortDate(startIso);
    const endShort = toShortDate(todayIso);

    // 6. 기존 페이지 찾기 또는 템플릿으로 새로 생성
    let pageId: string;

    const existingPage = await findMeetingPageByDate(todayIso);
    if (existingPage) {
      pageId = existingPage.id;
      console.log(`Found existing page: ${pageId}`);
    } else {
      const newPage = await createMeetingPage("이민섭교수님 미팅", todayIso);
      pageId = newPage.id;
      await waitForTemplateBlocks(pageId);
      console.log(`Created page from template: ${pageId}`);
    }

    // 7. "2️⃣" 헤딩 뒤에 콘텐츠 삽입
    const insertAfterBlockId = await findHeadingBlock(pageId, "2️⃣");
    const contentBlocks = buildContentBlocks(overview, startShort, endShort);
    if (insertAfterBlockId) {
      await appendContent(pageId, contentBlocks, insertAfterBlockId);
    } else {
      await appendContent(pageId, contentBlocks);
    }

    // 8. 토글 블록에 column 추가 + placeholder 삭제
    const toggleBlock = await findToggleBlock(pageId);
    if (toggleBlock) {
      const columnBlocks = buildColumnBlocks(summarizedDaily);
      await appendContent(toggleBlock, columnBlocks);
      await deleteEmptyParagraph(toggleBlock);
    }

    console.log(`Completed meeting page: ${pageId}`);
    return NextResponse.json({
      success: true,
      pageId,
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

// 페이지에서 토글 블록 ID 찾기
async function findToggleBlock(pageId: string): Promise<string | null> {
  const response = await notion.blocks.children.list({
    block_id: pageId,
    page_size: 100,
  });
  const toggle = response.results.find(
    (b: any) => b.type === "toggle"
  ) as any;
  return toggle?.id ?? null;
}

// 토글 내 빈 paragraph 삭제 (placeholder 제거)
async function deleteEmptyParagraph(toggleBlockId: string) {
  const response = await notion.blocks.children.list({
    block_id: toggleBlockId,
    page_size: 100,
  });
  for (const block of response.results) {
    const b = block as any;
    if (b.type === "paragraph" && b.paragraph?.rich_text?.length === 0) {
      await deleteBlock(b.id);
      break;
    }
  }
}

// "2026-03-12" → "3/12"
function toShortDate(isoDate: string): string {
  const [, m, d] = isoDate.split("-");
  return `${parseInt(m)}/${parseInt(d)}`;
}

// 콘텐츠만 (overview + toggle) — 템플릿 페이지에 삽입할 때
function buildContentBlocks(overview: string, startShort: string, endShort: string): any[] {
  const overviewBlocks = overview
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      // "① 제목 — 설명" 형식에서 "① 제목 —" 부분을 볼드 처리
      const dashIndex = line.indexOf(" — ");
      if (dashIndex !== -1) {
        const boldPart = line.slice(0, dashIndex + 3); // "① 제목 — " 포함
        const restPart = line.slice(dashIndex + 3);
        return {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [
              { type: "text", text: { content: boldPart }, annotations: { bold: true } },
              { type: "text", text: { content: restPart } },
            ],
          },
        };
      }
      return {
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [{ type: "text", text: { content: line } }],
        },
      };
    });

  return [
    ...overviewBlocks,
    {
      object: "block",
      type: "toggle",
      toggle: {
        rich_text: [
          { type: "text", text: { content: `데일리 업무 진행상황 (${startShort}~${endShort})` } },
        ],
        children: [
          {
            object: "block",
            type: "paragraph",
            paragraph: { rich_text: [] },
          },
        ],
      },
    },
  ];
}

// 2단 column_list 블록 생성 (박영민 / 조세연)
function buildColumnBlocks(summarizedDaily: SummarizedDay[]): any[] {
  const youngminEntries: { date: string; text: string }[] = [];
  const seyeonEntries: { date: string; text: string }[] = [];

  for (const d of summarizedDaily) {
    const shortDate = toShortDate(d.date);
    if (d.youngmin) {
      youngminEntries.push({ date: shortDate, text: d.youngmin });
    }
    if (d.seyeon) {
      seyeonEntries.push({ date: shortDate, text: d.seyeon });
    }
  }

  const toBullets = (entries: { date: string; text: string }[]) =>
    entries.map((e) => ({
      object: "block",
      type: "bulleted_list_item",
      bulleted_list_item: {
        rich_text: [
          {
            type: "text",
            text: { content: `${e.date} ` },
            annotations: { bold: true },
          },
          {
            type: "text",
            text: { content: e.text },
          },
        ],
      },
    }));

  const youngminBullets = toBullets(youngminEntries);
  const seyeonBullets = toBullets(seyeonEntries);

  return [
    {
      object: "block",
      type: "column_list",
      column_list: {
        children: [
          {
            object: "block",
            type: "column",
            column: {
              children: [
                {
                  object: "block",
                  type: "heading_3",
                  heading_3: {
                    rich_text: [{ type: "text", text: { content: "박영민" } }],
                  },
                },
                { object: "block", type: "divider", divider: {} },
                ...youngminBullets,
              ],
            },
          },
          {
            object: "block",
            type: "column",
            column: {
              children: [
                {
                  object: "block",
                  type: "heading_3",
                  heading_3: {
                    rich_text: [{ type: "text", text: { content: "조세연" } }],
                  },
                },
                { object: "block", type: "divider", divider: {} },
                ...seyeonBullets,
              ],
            },
          },
        ],
      },
    },
  ];
}

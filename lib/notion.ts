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

// 미팅 기록 DB에서 오늘 날짜의 기존 페이지 찾기
export async function findMeetingPageByDate(todayIso: string) {
  const response = await notion.databases.query({
    database_id: process.env.NOTION_MEETING_DB_ID!,
    filter: {
      and: [
        {
          property: "날짜",
          date: { equals: todayIso },
        },
        {
          property: "이름",
          title: { contains: "이민섭교수님" },
        },
      ],
    },
    page_size: 1,
  });
  return response.results.length > 0 ? response.results[0] : null;
}

// 페이지에서 특정 텍스트를 포함하는 heading_2 블록 ID 찾기
export async function findHeadingBlock(
  pageId: string,
  searchText: string
): Promise<string | null> {
  const response = await notion.blocks.children.list({
    block_id: pageId,
    page_size: 100,
  });
  const heading = response.results.find((b: any) => {
    if (b.type !== "heading_2") return false;
    const text =
      b.heading_2?.rich_text?.map((rt: any) => rt.plain_text).join("") ?? "";
    return text.includes(searchText);
  }) as any;
  return heading?.id ?? null;
}

// 미팅 기록 DB에 템플릿으로 신규 페이지 생성 (Notion API 2025-09-03+)
export async function createMeetingPage(title: string, todayIso: string) {
  const response = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.NOTION_API_KEY}`,
      "Notion-Version": "2025-09-03",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      parent: {
        data_source_id: process.env.NOTION_MEETING_DATA_SOURCE_ID!,
      },
      properties: {
        이름: {
          title: [{ text: { content: title } }],
        },
        날짜: {
          date: { start: todayIso },
        },
      },
      template: {
        type: "template_id",
        template_id: process.env.NOTION_TEMPLATE_ID!,
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to create meeting page: ${response.status} ${body}`);
  }

  return await response.json();
}

// 페이지에 템플릿 블록이 적용될 때까지 대기
export async function waitForTemplateBlocks(
  pageId: string,
  maxRetries = 15
): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    const response = await notion.blocks.children.list({
      block_id: pageId,
      page_size: 10,
    });
    const hasHeading = response.results.some(
      (b: any) => b.type === "heading_2"
    );
    if (hasHeading) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Template blocks not applied after waiting");
}

// 페이지에 블록 추가 (선택적으로 특정 블록 뒤에 삽입)
export async function appendContent(
  pageId: string,
  blocks: any[],
  afterBlockId?: string
) {
  await notion.blocks.children.append({
    block_id: pageId,
    children: blocks,
    ...(afterBlockId && { after: afterBlockId }),
  } as any);
}

// 블록 삭제
export async function deleteBlock(blockId: string) {
  await notion.blocks.delete({ block_id: blockId });
}

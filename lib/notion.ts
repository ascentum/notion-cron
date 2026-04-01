import { Client } from "@notionhq/client";

export const notion = new Client({
  auth: process.env.NOTION_API_KEY,
});

// 어센텀 업무 DB에서 특정 날짜 범위의 완료된 업무 목록 조회 (페이지네이션 지원)
export async function getWorkPages(startDate: string, endDate: string) {
  const allResults: any[] = [];
  let cursor: string | undefined;

  do {
    const response = await notion.databases.query({
      database_id: process.env.NOTION_WORK_DB_ID!,
      filter: {
        and: [
          {
            property: "완료일",
            date: { on_or_after: startDate },
          },
          {
            property: "완료일",
            date: { on_or_before: endDate },
          },
          {
            property: "완료",
            checkbox: { equals: true },
          },
        ],
      },
      sorts: [{ property: "완료일", direction: "ascending" }],
      start_cursor: cursor,
    });
    allResults.push(...response.results);
    cursor = response.has_more
      ? (response.next_cursor ?? undefined)
      : undefined;
  } while (cursor);

  return allResults;
}

// to_do를 포함할 수 있는 블록 타입만 재귀 조회 (heading, divider 등 불필요한 호출 제거)
const TODO_CONTAINER_TYPES = new Set([
  "to_do", "callout", "column_list", "column", "toggle",
  "bulleted_list_item", "numbered_list_item", "quote", "synced_block",
]);

// 페이지 본문(블록)을 가져오기 (depth 제한으로 API 호출 최소화)
export async function getAllBlocks(
  pageId: string,
  maxDepth: number = 2
): Promise<any[]> {
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

  if (maxDepth <= 0) return blocks;

  // to_do를 담을 수 있는 블록 타입만 재귀 조회
  const result: any[] = [];
  for (const block of blocks) {
    result.push(block);
    if ((block as any).has_children && TODO_CONTAINER_TYPES.has(block.type)) {
      const children = await getAllBlocks(block.id, maxDepth - 1);
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

// 페이지 PIC 속성에서 User ID 목록 반환
export function getPageUsers(page: any): string[] {
  const peopleProp = page.properties?.["PIC"];
  if (!peopleProp || peopleProp.type !== "people") return [];
  return peopleProp.people.map((p: any) => p.id);
}

// 페이지 완료일 반환
export function getPageDate(page: any): string | null {
  const dateProp = page.properties?.["완료일"];
  if (!dateProp || dateProp.type !== "date") return null;
  return dateProp.date?.start ?? null;
}

// 업무 아이템의 제목(이름) 반환
export function getTaskTitle(page: any): string {
  const titleProp = page.properties?.["이름"];
  if (!titleProp || titleProp.type !== "title") return "";
  return titleProp.title.map((rt: any) => rt.plain_text).join("");
}

// 업무 아이템의 카테고리 반환
export function getTaskCategory(page: any): string | null {
  const selectProp = page.properties?.["카테고리"];
  if (!selectProp || selectProp.type !== "select") return null;
  return selectProp.select?.name ?? null;
}

// 업무 아이템의 상위 항목 ID 반환 (없으면 null)
export function getTaskParentId(page: any): string | null {
  const relationProp = page.properties?.["상위 항목"];
  if (!relationProp || relationProp.type !== "relation") return null;
  return relationProp.relation?.[0]?.id ?? null;
}

// 단일 페이지의 제목 조회 (부모 업무 제목 가져올 때 사용)
export async function fetchPageTitle(pageId: string): Promise<string> {
  const page = await notion.pages.retrieve({ page_id: pageId });
  return getTaskTitle(page as any);
}

// 업무 페이지를 계층 구조로 변환하고 사람별 포맷된 텍스트 반환
interface TaskInfo {
  id: string;
  title: string;
  category: string | null;
  parentId: string | null;
  users: string[];
  date: string | null;
}

export async function buildFormattedTasks(
  pages: any[],
  userIds: Record<string, string> // { "youngmin": YOUNGMIN_ID, "seyeon": SEYEON_ID }
): Promise<Record<string, string[]>> {
  // 1. 모든 페이지에서 기본 정보 추출
  const tasks: TaskInfo[] = pages.map((page) => ({
    id: page.id as string,
    title: getTaskTitle(page),
    category: getTaskCategory(page),
    parentId: getTaskParentId(page),
    users: getPageUsers(page),
    date: getPageDate(page),
  }));

  const taskById = new Map(tasks.map((t) => [t.id, t]));

  // 2. 쿼리 결과에 없는 부모 ID 수집 → 제목 일괄 조회
  const missingParentIds = new Set<string>();
  for (const t of tasks) {
    if (t.parentId && !taskById.has(t.parentId)) {
      missingParentIds.add(t.parentId);
    }
  }

  const parentTitles = new Map<string, string>();
  if (missingParentIds.size > 0) {
    await Promise.all(
      [...missingParentIds].map(async (pid) => {
        try {
          parentTitles.set(pid, await fetchPageTitle(pid));
        } catch {
          parentTitles.set(pid, "(상위 업무)");
        }
      })
    );
  }

  // 3. 계층 구조 빌드
  const childrenByParent = new Map<string, TaskInfo[]>();
  const topLevel: TaskInfo[] = [];

  for (const t of tasks) {
    if (!t.parentId) {
      topLevel.push(t);
    } else {
      const list = childrenByParent.get(t.parentId) ?? [];
      list.push(t);
      childrenByParent.set(t.parentId, list);
    }
  }

  // 4. 사람별 포맷된 텍스트 생성
  const result: Record<string, string[]> = {};

  for (const [personKey, userId] of Object.entries(userIds)) {
    const lines: string[] = [];
    const personTaskIds = new Set(
      tasks.filter((t) => t.users.includes(userId)).map((t) => t.id)
    );

    // 4a. 최상위 업무 처리
    for (const t of topLevel) {
      const ismine = personTaskIds.has(t.id);
      const myChildren = (childrenByParent.get(t.id) ?? []).filter((c) =>
        personTaskIds.has(c.id)
      );

      if (ismine && myChildren.length > 0) {
        lines.push(formatLine(t.title, t.category));
        for (const c of myChildren) {
          lines.push(`  - ${formatLine(c.title, c.category)}`);
        }
      } else if (ismine) {
        lines.push(formatLine(t.title, t.category));
      } else if (myChildren.length > 0) {
        // 상위 업무 완료 안 됐지만 하위 업무만 완료된 경우
        lines.push(t.title);
        for (const c of myChildren) {
          lines.push(`  - ${formatLine(c.title, c.category)}`);
        }
      }
    }

    // 4b. 부모가 쿼리 결과에 없는 하위 업무
    for (const [parentId, children] of childrenByParent) {
      if (topLevel.some((t) => t.id === parentId)) continue; // 이미 처리됨
      const myChildren = children.filter((c) => personTaskIds.has(c.id));
      if (myChildren.length === 0) continue;

      const parentTitle =
        parentTitles.get(parentId) ??
        taskById.get(parentId)?.title ??
        "(상위 업무)";
      lines.push(parentTitle);
      for (const c of myChildren) {
        lines.push(`  - ${formatLine(c.title, c.category)}`);
      }
    }

    result[personKey] = lines;
  }

  return result;
}

function formatLine(title: string, category: string | null): string {
  return category ? `[${category}] ${title}` : title;
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

// 페이지에 템플릿 블록이 적용될 때까지 대기 (exponential backoff)
export async function waitForTemplateBlocks(
  pageId: string,
  maxRetries = 6
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
    // 200ms, 300ms, 400ms, ... (점진적 증가)
    await new Promise((resolve) => setTimeout(resolve, 200 + i * 100));
  }
  throw new Error("Template blocks not applied after waiting");
}

// 페이지 최상위 블록 목록 한 번에 가져오기
export async function getPageTopBlocks(pageId: string): Promise<any[]> {
  const response = await notion.blocks.children.list({
    block_id: pageId,
    page_size: 100,
  });
  return response.results;
}

// 블록 목록에서 특정 텍스트 포함 heading_2 ID 찾기
export function findHeadingInBlocks(
  blocks: any[],
  searchText: string
): string | null {
  const heading = blocks.find((b: any) => {
    if (b.type !== "heading_2") return false;
    const text =
      b.heading_2?.rich_text?.map((rt: any) => rt.plain_text).join("") ?? "";
    return text.includes(searchText);
  });
  return heading?.id ?? null;
}

// 블록 목록에서 첫 번째 toggle 블록 ID 찾기
export function findToggleInBlocks(blocks: any[]): string | null {
  const toggle = blocks.find((b: any) => b.type === "toggle");
  return toggle?.id ?? null;
}

// 페이지에 블록 추가 (선택적으로 특정 블록 뒤에 삽입) — 생성된 블록 목록 반환
export async function appendContent(
  pageId: string,
  blocks: any[],
  afterBlockId?: string
): Promise<any[]> {
  const response = await notion.blocks.children.append({
    block_id: pageId,
    children: blocks,
    ...(afterBlockId && { after: afterBlockId }),
  } as any);
  return (response as any).results ?? [];
}

// 블록 삭제
export async function deleteBlock(blockId: string) {
  await notion.blocks.delete({ block_id: blockId });
}

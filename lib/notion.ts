import { Client } from "@notionhq/client";
import { getKstDateTimeRange, toKstIsoDate } from "./time";

export const notion = new Client({
  auth: process.env.NOTION_API_KEY,
});

export type WorkSource = "legacy" | "latest";
export type WorkItemStatus = "completed" | "incomplete";

export interface WorkDateRange {
  source: WorkSource;
  startDate: string;
  endDate: string;
}

export interface WorkItem {
  id: string;
  pageId: string;
  source: WorkSource;
  status: WorkItemStatus;
  date: string;
  users: string[];
  title: string;
  category: string | null;
  parentId: string | null;
}

export interface TodoItem {
  text: string;
  checked: boolean;
}

const DEFAULT_LEGACY_WORK_DB_ID = "26abd55c-4778-80b1-a96c-dc8cf9f1a0e4";
const DEFAULT_WORK_DB_CUTOFF_DATE = "2026-04-01";
const LEGACY_BLOCK_FETCH_CONCURRENCY = 3;

function getLegacyWorkDatabaseId(): string {
  return process.env.NOTION_LEGACY_WORK_DB_ID ?? DEFAULT_LEGACY_WORK_DB_ID;
}

function getWorkDbCutoffDate(): string {
  return process.env.NOTION_WORK_DB_CUTOFF_DATE ?? DEFAULT_WORK_DB_CUTOFF_DATE;
}

function shiftIsoDate(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function splitWorkDateRanges(
  startDate: string,
  endDate: string,
  cutoffDate: string = getWorkDbCutoffDate()
): WorkDateRange[] {
  if (startDate > endDate) return [];

  if (endDate < cutoffDate) {
    return [{ source: "legacy", startDate, endDate }];
  }
  if (startDate >= cutoffDate) {
    return [{ source: "latest", startDate, endDate }];
  }

  return [
    {
      source: "legacy",
      startDate,
      endDate: shiftIsoDate(cutoffDate, -1),
    },
    {
      source: "latest",
      startDate: cutoffDate,
      endDate,
    },
  ];
}

function getPeoplePropertyIds(page: any, propertyName: string): string[] {
  const peopleProp = page.properties?.[propertyName];
  if (!peopleProp) return [];
  if (peopleProp.type === "people") {
    return peopleProp.people.map((person: any) => person.id);
  }
  return [];
}

function getDateProperty(page: any, propertyName: string): string | null {
  const dateProp = page.properties?.[propertyName];
  if (!dateProp || dateProp.type !== "date") return null;
  const start = dateProp.date?.start ?? null;
  return start ? toKstIsoDate(start) : null;
}

function getCategoryProperty(page: any, propertyName: string): string | null {
  const categoryProp = page.properties?.[propertyName];
  if (!categoryProp) return null;

  if (categoryProp.type === "select") {
    return categoryProp.select?.name ?? null;
  }
  if (categoryProp.type === "multi_select") {
    const names = categoryProp.multi_select.map((item: any) => item.name);
    return names.length > 0 ? names.join(", ") : null;
  }
  return null;
}

function getCheckboxProperty(page: any, propertyName: string): boolean {
  const checkboxProp = page.properties?.[propertyName];
  if (!checkboxProp || checkboxProp.type !== "checkbox") return false;
  return checkboxProp.checkbox === true;
}

async function queryLatestWorkPagesByCompletion(
  startDate: string,
  endDate: string,
  completed: boolean
) {
  const allResults: any[] = [];
  let cursor: string | undefined;
  const range = getKstDateTimeRange(startDate, endDate);

  do {
    const response = await notion.databases.query({
      database_id: process.env.NOTION_WORK_DB_ID!,
      filter: {
        and: [
          {
            property: "완료일",
            date: { on_or_after: range.start },
          },
          {
            property: "완료일",
            date: { on_or_before: range.end },
          },
          {
            property: "완료",
            checkbox: { equals: completed },
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

// 어센텀 업무 DB에서 특정 날짜 범위의 완료된 업무 목록 조회 (페이지네이션 지원)
export async function getWorkPages(startDate: string, endDate: string) {
  return queryLatestWorkPagesByCompletion(startDate, endDate, true);
}

async function getLegacyWorkPages(startDate: string, endDate: string) {
  const allResults: any[] = [];
  let cursor: string | undefined;

  do {
    const response = await notion.databases.query({
      database_id: getLegacyWorkDatabaseId(),
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

export function extractTodoItems(blocks: any[]): TodoItem[] {
  return blocks
    .filter((b) => b.type === "to_do")
    .map((b) => {
      const richTexts = b.to_do?.rich_text ?? [];
      const text = richTexts.map((rt: any) => rt.plain_text).join("");
      return {
        text,
        checked: b.to_do?.checked === true,
      };
    })
    .filter((item) => item.text.trim().length > 0);
}

// 블록에서 체크된 to_do 항목만 추출
export function extractCheckedTodos(blocks: any[]): string[] {
  return extractTodoItems(blocks)
    .filter((item) => item.checked)
    .map((item) => item.text);
}

// 페이지 PIC 속성에서 User ID 목록 반환
export function getPageUsers(page: any): string[] {
  return getPeoplePropertyIds(page, "PIC");
}

// 페이지 완료일 반환
export function getPageDate(page: any): string | null {
  return getDateProperty(page, "완료일");
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

function getLegacyPageUsers(page: any): string[] {
  return getPeoplePropertyIds(page, "사람");
}

function getLegacyPageDate(page: any): string | null {
  return getDateProperty(page, "일정");
}

function getLegacyPageCategory(page: any): string | null {
  return getCategoryProperty(page, "카테고리");
}

function toLatestWorkItem(page: any): WorkItem | null {
  const date = getPageDate(page);
  const title = getTaskTitle(page);
  if (!date || !title) return null;

  return {
    id: page.id as string,
    pageId: page.id as string,
    source: "latest",
    status: getCheckboxProperty(page, "완료") ? "completed" : "incomplete",
    date,
    users: getPageUsers(page),
    title,
    category: getTaskCategory(page),
    parentId: getTaskParentId(page),
  };
}

function toLegacyWorkItems(
  page: any,
  todos: TodoItem[],
  includeIncomplete: boolean
): WorkItem[] {
  const date = getLegacyPageDate(page);
  if (!date) return [];

  const users = getLegacyPageUsers(page);
  const category = getLegacyPageCategory(page);

  return todos.flatMap((todo, index) => {
    if (!includeIncomplete && !todo.checked) return [];

    return [
      {
        id: `${page.id}:${index}`,
        pageId: page.id as string,
        source: "legacy" as const,
        status: todo.checked ? "completed" : "incomplete",
        date,
        users,
        title: todo.text,
        category,
        parentId: null,
      },
    ];
  });
}

export function formatWorkItem(item: Pick<WorkItem, "title" | "category">): string {
  return formatLine(item.title, item.category);
}

export async function getLegacyWorkItemsForDateRange(
  startDate: string,
  endDate: string,
  options: { includeIncomplete?: boolean } = {}
): Promise<WorkItem[]> {
  const includeIncomplete = options.includeIncomplete ?? false;
  const legacyPages = await getLegacyWorkPages(startDate, endDate);
  const legacyItems = await mapWithConcurrencyLimit(
    legacyPages,
    LEGACY_BLOCK_FETCH_CONCURRENCY,
    async (page) => {
      const blocks = await getAllBlocks((page as any).id, 4);
      const todos = extractTodoItems(blocks);
      return toLegacyWorkItems(page, todos, includeIncomplete);
    }
  );

  return legacyItems.flat();
}

export async function getWorkItems(
  startDate: string,
  endDate: string,
  options: { includeIncomplete?: boolean } = {}
): Promise<WorkItem[]> {
  const includeIncomplete = options.includeIncomplete ?? false;
  const ranges = splitWorkDateRanges(startDate, endDate);

  const workItems = await Promise.all(
    ranges.map(async (range) => {
      if (range.source === "latest") {
        const latestPages = includeIncomplete
          ? (
              await Promise.all([
                queryLatestWorkPagesByCompletion(
                  range.startDate,
                  range.endDate,
                  true
                ),
                queryLatestWorkPagesByCompletion(
                  range.startDate,
                  range.endDate,
                  false
                ),
              ])
            ).flat()
          : await queryLatestWorkPagesByCompletion(
              range.startDate,
              range.endDate,
              true
            );

        return latestPages
          .map(toLatestWorkItem)
          .filter((item): item is WorkItem =>
            item
              ? includeIncomplete || item.status === "completed"
              : false
          );
      }

      return getLegacyWorkItemsForDateRange(range.startDate, range.endDate, {
        includeIncomplete,
      });
    })
  );

  return workItems
    .flat()
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.source.localeCompare(b.source) ||
        a.title.localeCompare(b.title)
    );
}

export interface TaskInfo {
  id: string;
  title: string;
  category: string | null;
  parentId: string | null;
  users: string[];
  isCompleted: boolean;
  isInScope: boolean;
  sourceIndex: number;
}

const TASK_FETCH_CONCURRENCY = 3;
const FALLBACK_PARENT_TITLE = "(상위 업무)";
const ancestorTaskCache = new Map<string, Promise<TaskInfo>>();
const childTaskCache = new Map<string, Promise<TaskInfo[]>>();

function toTaskInfo(
  page: any,
  options: { isInScope: boolean; sourceIndex: number }
): TaskInfo {
  return {
    id: page.id as string,
    title: getTaskTitle(page) || FALLBACK_PARENT_TITLE,
    category: getTaskCategory(page),
    parentId: getTaskParentId(page),
    users: getPageUsers(page),
    isCompleted: getCheckboxProperty(page, "완료"),
    isInScope: options.isInScope,
    sourceIndex: options.sourceIndex,
  };
}

function createFallbackTask(pageId: string): TaskInfo {
  return {
    id: pageId,
    title: FALLBACK_PARENT_TITLE,
    category: null,
    parentId: null,
    users: [],
    isCompleted: false,
    isInScope: false,
    sourceIndex: Number.POSITIVE_INFINITY,
  };
}

async function fetchAncestorTask(pageId: string): Promise<TaskInfo> {
  const cached = ancestorTaskCache.get(pageId);
  if (cached) return cached;

  const promise = notion.pages
    .retrieve({ page_id: pageId })
    .then((page) =>
      toTaskInfo(page as any, {
        isInScope: false,
        sourceIndex: Number.POSITIVE_INFINITY,
      })
    )
    .catch(() => {
      ancestorTaskCache.delete(pageId);
      return createFallbackTask(pageId);
    });

  ancestorTaskCache.set(pageId, promise);
  return promise;
}

async function fetchChildTasks(parentId: string): Promise<TaskInfo[]> {
  const cached = childTaskCache.get(parentId);
  if (cached) return cached;

  const promise = (async () => {
    const children: TaskInfo[] = [];
    let cursor: string | undefined;

    do {
      const response = await notion.databases.query({
        database_id: process.env.NOTION_WORK_DB_ID!,
        filter: {
          property: "상위 항목",
          relation: { contains: parentId },
        },
        start_cursor: cursor,
        page_size: 100,
      });

      children.push(
        ...response.results.map((page) =>
          toTaskInfo(page as any, {
            isInScope: false,
            sourceIndex: Number.POSITIVE_INFINITY,
          })
        )
      );

      cursor = response.has_more
        ? (response.next_cursor ?? undefined)
        : undefined;
    } while (cursor);

    return children;
  })().catch((error) => {
    childTaskCache.delete(parentId);
    throw error;
  });

  childTaskCache.set(parentId, promise);
  return promise;
}

export async function mapWithConcurrencyLimit<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];

  const results = new Array<R>(items.length);
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex++;
        results[currentIndex] = await mapper(items[currentIndex], currentIndex);
      }
    })
  );

  return results;
}

async function loadAncestorTasks(initialTasks: TaskInfo[]): Promise<TaskInfo[]> {
  const taskById = new Map(initialTasks.map((task) => [task.id, task]));
  const ancestors: TaskInfo[] = [];
  const pendingParentIds = new Set<string>();

  for (const task of initialTasks) {
    if (task.parentId && !taskById.has(task.parentId)) {
      pendingParentIds.add(task.parentId);
    }
  }

  while (pendingParentIds.size > 0) {
    const batchIds = [...pendingParentIds];
    pendingParentIds.clear();

    const fetchedAncestors = await mapWithConcurrencyLimit(
      batchIds,
      TASK_FETCH_CONCURRENCY,
      (pageId) => fetchAncestorTask(pageId)
    );

    for (const ancestor of fetchedAncestors) {
      if (taskById.has(ancestor.id)) continue;

      taskById.set(ancestor.id, ancestor);
      ancestors.push(ancestor);

      if (ancestor.parentId && !taskById.has(ancestor.parentId)) {
        pendingParentIds.add(ancestor.parentId);
      }
    }
  }

  return ancestors;
}

async function loadDescendantTasks(initialTasks: TaskInfo[]): Promise<TaskInfo[]> {
  const taskById = new Map(initialTasks.map((task) => [task.id, task]));
  const descendants: TaskInfo[] = [];
  const pendingParentIds = [...new Set(initialTasks.map((task) => task.id))];
  const expandedParentIds = new Set<string>();

  while (pendingParentIds.length > 0) {
    const batchIds = pendingParentIds.filter(
      (parentId) => !expandedParentIds.has(parentId)
    );
    pendingParentIds.length = 0;

    if (batchIds.length === 0) break;
    batchIds.forEach((parentId) => expandedParentIds.add(parentId));

    const fetchedChildren = await mapWithConcurrencyLimit(
      batchIds,
      TASK_FETCH_CONCURRENCY,
      (parentId) => fetchChildTasks(parentId)
    );

    for (const children of fetchedChildren) {
      for (const child of children) {
        if (!taskById.has(child.id)) {
          taskById.set(child.id, child);
          descendants.push(child);
        }

        if (!expandedParentIds.has(child.id)) {
          pendingParentIds.push(child.id);
        }
      }
    }
  }

  return descendants;
}

function mergeTaskInfo(existing: TaskInfo, incoming: TaskInfo): TaskInfo {
  const preferIncoming =
    existing.title === FALLBACK_PARENT_TITLE &&
    incoming.title !== FALLBACK_PARENT_TITLE;
  const preferred = preferIncoming ? incoming : existing;
  const secondary = preferIncoming ? existing : incoming;

  return {
    ...preferred,
    title: preferred.title || secondary.title,
    category: preferred.category ?? secondary.category,
    parentId: preferred.parentId ?? secondary.parentId,
    users: preferred.users.length > 0 ? preferred.users : secondary.users,
    isCompleted: preferred.isCompleted || secondary.isCompleted,
    isInScope: existing.isInScope || incoming.isInScope,
    sourceIndex: Math.min(existing.sourceIndex, incoming.sourceIndex),
  };
}

function buildChildrenByParent(tasks: TaskInfo[]): Map<string, TaskInfo[]> {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const childrenByParent = new Map<string, TaskInfo[]>();

  for (const task of tasks) {
    if (!task.parentId || !taskById.has(task.parentId)) continue;

    const siblings = childrenByParent.get(task.parentId) ?? [];
    siblings.push(task);
    childrenByParent.set(task.parentId, siblings);
  }

  return childrenByParent;
}

function collectVisibleTaskIds(
  seedTaskIds: string[],
  taskById: Map<string, TaskInfo>,
  childrenByParent: Map<string, TaskInfo[]>
): Set<string> {
  const visibleTaskIds = new Set<string>();

  for (const seedTaskId of seedTaskIds) {
    const lineage = new Set<string>();
    let currentId: string | null = seedTaskId;

    while (currentId && !lineage.has(currentId)) {
      visibleTaskIds.add(currentId);
      lineage.add(currentId);
      currentId = taskById.get(currentId)?.parentId ?? null;
    }

    const branchStack = [seedTaskId];
    const visitedBranchIds = new Set<string>();

    while (branchStack.length > 0) {
      const taskId = branchStack.pop();
      if (!taskId || visitedBranchIds.has(taskId)) continue;

      visitedBranchIds.add(taskId);
      visibleTaskIds.add(taskId);

      for (const child of childrenByParent.get(taskId) ?? []) {
        branchStack.push(child.id);
      }
    }
  }

  return visibleTaskIds;
}

function findNearestVisibleCompletedParentId(
  task: TaskInfo,
  taskById: Map<string, TaskInfo>,
  renderableTaskIds: Set<string>
): string | null {
  const lineage = new Set<string>([task.id]);
  let currentId = task.parentId;

  while (currentId && !lineage.has(currentId)) {
    lineage.add(currentId);
    if (renderableTaskIds.has(currentId)) return currentId;
    currentId = taskById.get(currentId)?.parentId ?? null;
  }

  return null;
}

function formatIndentedLine(
  title: string,
  category: string | null,
  depth: number
): string {
  const text = formatLine(title, category);
  if (depth === 0) return text;
  return `${"  ".repeat(depth)}- ${text}`;
}

export function formatTaskTreeByUser(
  tasks: TaskInfo[],
  userIds: Record<string, string>
): Record<string, string[]> {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const childrenByParent = buildChildrenByParent(tasks);

  const results: Record<string, string[]> = {};

  for (const [personKey, userId] of Object.entries(userIds)) {
    const ownTaskIds = tasks
      .filter(
        (task) =>
          task.isInScope && task.isCompleted && task.users.includes(userId)
      )
      .map((task) => task.id);

    if (ownTaskIds.length === 0) {
      results[personKey] = [];
      continue;
    }

    const visibleTaskIds = collectVisibleTaskIds(
      ownTaskIds,
      taskById,
      childrenByParent
    );
    const renderableTasks = tasks.filter(
      (task) => visibleTaskIds.has(task.id) && task.isCompleted
    );
    const renderableTaskIds = new Set(renderableTasks.map((task) => task.id));
    const renderableParentById = new Map<string, string | null>();
    const renderableChildrenByParent = new Map<string, TaskInfo[]>();

    for (const task of renderableTasks) {
      const parentId = findNearestVisibleCompletedParentId(
        task,
        taskById,
        renderableTaskIds
      );
      renderableParentById.set(task.id, parentId);

      if (!parentId) continue;
      const siblings = renderableChildrenByParent.get(parentId) ?? [];
      siblings.push(task);
      renderableChildrenByParent.set(parentId, siblings);
    }

    const sortKeyCache = new Map<string, number>();
    const visiting = new Set<string>();

    const getSortKey = (taskId: string): number => {
      const cached = sortKeyCache.get(taskId);
      if (cached !== undefined) return cached;

      if (visiting.has(taskId)) {
        return taskById.get(taskId)?.sourceIndex ?? Number.POSITIVE_INFINITY;
      }

      visiting.add(taskId);
      const task = taskById.get(taskId);
      let key = task?.sourceIndex ?? Number.POSITIVE_INFINITY;

      for (const child of renderableChildrenByParent.get(taskId) ?? []) {
        key = Math.min(key, getSortKey(child.id));
      }

      visiting.delete(taskId);
      sortKeyCache.set(taskId, key);
      return key;
    };

    for (const children of renderableChildrenByParent.values()) {
      children.sort((a, b) => getSortKey(a.id) - getSortKey(b.id));
    }

    const rootTasks = renderableTasks
      .filter((task) => !renderableParentById.get(task.id))
      .sort((a, b) => getSortKey(a.id) - getSortKey(b.id));

    const lines: string[] = [];
    const renderedTaskIds = new Set<string>();
    const render = (task: TaskInfo, depth: number, branchPath: Set<string>) => {
      if (renderedTaskIds.has(task.id) || branchPath.has(task.id)) return;

      renderedTaskIds.add(task.id);
      lines.push(formatIndentedLine(task.title, task.category, depth));

      const nextPath = new Set(branchPath);
      nextPath.add(task.id);
      for (const child of renderableChildrenByParent.get(task.id) ?? []) {
        render(child, depth + 1, nextPath);
      }
    };

    for (const rootTask of rootTasks) {
      render(rootTask, 0, new Set());
    }

    const orphanTasks = renderableTasks
      .filter((task) => !renderedTaskIds.has(task.id))
      .sort((a, b) => getSortKey(a.id) - getSortKey(b.id));

    for (const orphanTask of orphanTasks) {
      render(orphanTask, 0, new Set());
    }

    results[personKey] = lines;
  }

  return results;
}

export async function buildFormattedTasks(
  pages: any[],
  userIds: Record<string, string>
): Promise<Record<string, string[]>> {
  const scopedTasks = pages.map((page, index) =>
    toTaskInfo(page, { isInScope: true, sourceIndex: index })
  );
  const [ancestorTasks, descendantTasks] = await Promise.all([
    loadAncestorTasks(scopedTasks),
    loadDescendantTasks(scopedTasks),
  ]);
  const taskById = new Map<string, TaskInfo>();

  for (const task of [...scopedTasks, ...ancestorTasks, ...descendantTasks]) {
    const existing = taskById.get(task.id);
    taskById.set(task.id, existing ? mergeTaskInfo(existing, task) : task);
  }

  return formatTaskTreeByUser([...taskById.values()], userIds);
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

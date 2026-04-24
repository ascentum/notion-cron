import {
  appendContent,
  createMeetingPage,
  deleteBlock,
  findHeadingInBlocks,
  findMeetingPageByDate,
  findToggleInBlocks,
  formatWorkItem,
  getPageTopBlocks,
  getWorkItems,
  notion,
  waitForTemplateBlocks,
} from "../../lib/notion";
import { generateWeeklySummary, SummarizedDay } from "../../lib/openai";
import { getKstDateInfo, getPreviousWeekDateRange } from "../../lib/time";
import { config } from "../config";

function toShortDate(isoDate: string) {
  const [, month, day] = isoDate.split("-");
  return `${Number.parseInt(month, 10)}/${Number.parseInt(day, 10)}`;
}

async function deleteEmptyParagraph(toggleBlockId: string) {
  const response = await notion.blocks.children.list({
    block_id: toggleBlockId,
    page_size: 100,
  });

  for (const block of response.results) {
    const current = block as any;
    if (current.type === "paragraph" && current.paragraph?.rich_text?.length === 0) {
      await deleteBlock(current.id);
      break;
    }
  }
}

function buildContentBlocks(overview: string, startShort: string, endShort: string): any[] {
  const overviewBlocks = overview
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const dashIndex = line.indexOf(" — ");
      if (dashIndex !== -1) {
        const boldPart = line.slice(0, dashIndex + 3);
        const restPart = line.slice(dashIndex + 3);
        return {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [
              {
                type: "text",
                text: { content: boldPart },
                annotations: { bold: true },
              },
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
          {
            type: "text",
            text: { content: `데일리 업무 진행상황 (${startShort}~${endShort})` },
          },
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

function buildColumnBlocks(summarizedDaily: SummarizedDay[]): any[] {
  const byDate = new Map<string, { youngmin: string[]; seyeon: string[] }>();

  for (const summary of summarizedDaily) {
    const shortDate = toShortDate(summary.date);
    const entry = byDate.get(shortDate) ?? { youngmin: [], seyeon: [] };
    if (summary.youngmin) entry.youngmin.push(summary.youngmin);
    if (summary.seyeon) entry.seyeon.push(summary.seyeon);
    byDate.set(shortDate, entry);
  }

  const toBullets = (entries: { date: string; text: string }[]) =>
    entries.map((entry) => ({
      object: "block",
      type: "bulleted_list_item",
      bulleted_list_item: {
        rich_text: [
          {
            type: "text",
            text: { content: `${entry.date} ` },
            annotations: { bold: true },
          },
          {
            type: "text",
            text: { content: entry.text },
          },
        ],
      },
    }));

  const youngminBullets = toBullets(
    [...byDate.entries()]
      .filter(([, entry]) => entry.youngmin.length > 0)
      .map(([date, entry]) => ({ date, text: entry.youngmin.join(" / ") }))
  );

  const seyeonBullets = toBullets(
    [...byDate.entries()]
      .filter(([, entry]) => entry.seyeon.length > 0)
      .map(([date, entry]) => ({ date, text: entry.seyeon.join(" / ") }))
  );

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

export async function runWeeklyReport(now: Date = new Date()) {
  const { isoDate: todayIso } = getKstDateInfo(now);
  const { startIso, endIso } = getPreviousWeekDateRange(todayIso);
  const workItems = await getWorkItems(startIso, endIso);
  const byDate = new Map<
    string,
    { youngmin: string[]; seyeon: string[]; all: string[] }
  >();

  for (const item of workItems) {
    const formatted = formatWorkItem(item);
    const entry = byDate.get(item.date) ?? {
      youngmin: [],
      seyeon: [],
      all: [],
    };

    entry.all.push(formatted);
    if (item.users.includes(config.notionUserIds.youngmin)) entry.youngmin.push(formatted);
    if (item.users.includes(config.notionUserIds.seyeon)) entry.seyeon.push(formatted);
    byDate.set(item.date, entry);
  }

  const dailySummaries = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, tasks]) => ({
      date,
      youngminTasks: tasks.youngmin,
      seyeonTasks: tasks.seyeon,
      allTasks: tasks.all,
    }));

  const totalTasks = dailySummaries.reduce(
    (sum, summary) => sum + summary.allTasks.length,
    0
  );

  if (totalTasks === 0) {
    return { success: true, pageId: null, tasksProcessed: 0, skipped: true };
  }

  const { overview, summarizedDaily } = await generateWeeklySummary(dailySummaries, {
    startDate: startIso,
    endDate: endIso,
  });

  const startShort = toShortDate(startIso);
  const endShort = toShortDate(endIso);
  const existingPage = await findMeetingPageByDate(todayIso);
  let pageId: string;

  if (existingPage) {
    pageId = existingPage.id;
  } else {
    const newPage = await createMeetingPage("이민섭교수님 미팅", todayIso);
    pageId = newPage.id;
    await waitForTemplateBlocks(pageId);
  }

  const topBlocks = await getPageTopBlocks(pageId);
  const insertAfterBlockId = findHeadingInBlocks(topBlocks, "2️⃣");
  const appendedBlocks = insertAfterBlockId
    ? await appendContent(
        pageId,
        buildContentBlocks(overview, startShort, endShort),
        insertAfterBlockId
      )
    : await appendContent(pageId, buildContentBlocks(overview, startShort, endShort));

  const toggleBlockId = findToggleInBlocks(appendedBlocks);
  if (toggleBlockId) {
    await appendContent(toggleBlockId, buildColumnBlocks(summarizedDaily));
    await deleteEmptyParagraph(toggleBlockId);
  }

  return {
    success: true,
    pageId,
    tasksProcessed: totalTasks,
    skipped: false,
  };
}

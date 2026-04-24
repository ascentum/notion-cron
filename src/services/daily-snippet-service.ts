import {
  formatWorkItem,
  getLegacyWorkItemsForDateRange,
  getPageDate,
  getWorkPages,
  splitWorkDateRanges,
  buildFormattedTasks,
} from "../../lib/notion";
import {
  generateDailySnippetContent,
  generateWeeklySnippetContent,
} from "../../lib/openai";
import { sendDiscordMessage } from "../../lib/discord";
import { getDailySnippetDateInfo, getPreviousWeekDateRange } from "../../lib/time";
import { config } from "../config";
import { listExistingDispatchPeople } from "../database";
import { buildNoTaskWarningEmbed } from "../snippets";
import { queuePendingSnippetMessage } from "./dispatch-service";
import { Person } from "../types";

export interface SendDailySnippetsOptions {
  targetPerson?: Person | null;
  force?: boolean;
}

function toShortDate(isoDate: string) {
  const [, month, day] = isoDate.split("-");
  return `${Number.parseInt(month, 10)}/${Number.parseInt(day, 10)}`;
}

function resolveTargets(targetPerson?: Person | null): Person[] {
  return targetPerson ? [targetPerson] : ["youngmin", "seyeon"];
}

async function sendNoTaskWarning(person: Person, dateLabel: string) {
  await sendDiscordMessage(
    config.discordChannelId,
    [buildNoTaskWarningEmbed(person, dateLabel)],
    []
  );
}

async function queueSnippet(
  person: Person,
  type: "daily" | "weekly",
  dateLabel: string,
  content: string
) {
  await queuePendingSnippetMessage(person, type, dateLabel, content);
}

async function handleWeeklySnippets(
  todayIso: string,
  targetPerson: Person | null,
  force: boolean
) {
  const { startIso, endIso } = getPreviousWeekDateRange(todayIso);
  const ranges = splitWorkDateRanges(startIso, endIso);
  const byDate = new Map<string, { youngmin: string[]; seyeon: string[] }>();

  for (const range of ranges) {
    if (range.source === "latest") {
      const latestPages = await getWorkPages(range.startDate, range.endDate);
      const pagesByDate = new Map<string, any[]>();

      for (const page of latestPages) {
        const date = getPageDate(page) ?? range.endDate;
        const pages = pagesByDate.get(date) ?? [];
        pages.push(page);
        pagesByDate.set(date, pages);
      }

      for (const [date, datePages] of [...pagesByDate.entries()].sort(([a], [b]) =>
        a.localeCompare(b)
      )) {
        const tasksByPerson = await buildFormattedTasks(
          datePages,
          config.notionUserIds
        );
        const entry = byDate.get(date) ?? { youngmin: [], seyeon: [] };
        entry.youngmin.push(...(tasksByPerson.youngmin ?? []));
        entry.seyeon.push(...(tasksByPerson.seyeon ?? []));
        byDate.set(date, entry);
      }

      continue;
    }

    const legacyItems = await getLegacyWorkItemsForDateRange(
      range.startDate,
      range.endDate
    );

    for (const item of legacyItems) {
      const entry = byDate.get(item.date) ?? { youngmin: [], seyeon: [] };
      const formatted = formatWorkItem(item);
      if (item.users.includes(config.notionUserIds.youngmin)) entry.youngmin.push(formatted);
      if (item.users.includes(config.notionUserIds.seyeon)) entry.seyeon.push(formatted);
      byDate.set(item.date, entry);
    }
  }

  const sortedByDate = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b));
  const weekLabel = `${toShortDate(startIso)}~${toShortDate(endIso)}`;
  const existing = force ? [] : listExistingDispatchPeople(weekLabel, "weekly");
  const targets = resolveTargets(targetPerson).filter(
    (person) => force || !existing.includes(person)
  );

  const youngminWeekly = sortedByDate
    .filter(([, value]) => value.youngmin.length > 0)
    .map(([date, value]) => ({ date, tasks: value.youngmin }));
  const seyeonWeekly = sortedByDate
    .filter(([, value]) => value.seyeon.length > 0)
    .map(([date, value]) => ({ date, tasks: value.seyeon }));

  const jobs: Promise<unknown>[] = [];

  if (targets.includes("youngmin")) {
    if (youngminWeekly.length > 0) {
      jobs.push(
        generateWeeklySnippetContent(
          "박영민",
          toShortDate(startIso),
          toShortDate(endIso),
          youngminWeekly
        ).then((content) => queueSnippet("youngmin", "weekly", weekLabel, content))
      );
    } else {
      jobs.push(sendNoTaskWarning("youngmin", weekLabel));
    }
  }

  if (targets.includes("seyeon")) {
    if (seyeonWeekly.length > 0) {
      jobs.push(
        generateWeeklySnippetContent(
          "조세연",
          toShortDate(startIso),
          toShortDate(endIso),
          seyeonWeekly
        ).then((content) => queueSnippet("seyeon", "weekly", weekLabel, content))
      );
    } else {
      jobs.push(sendNoTaskWarning("seyeon", weekLabel));
    }
  }

  await Promise.all(jobs);

  return {
    dateLabel: weekLabel,
    targets,
  };
}

export async function sendDailySnippets(
  now: Date = new Date(),
  options: SendDailySnippetsOptions = {}
) {
  const { triggerIsoDate, targetIsoDate, weekday } = getDailySnippetDateInfo(now);
  const isMonday = weekday === 1;
  const shortDate = toShortDate(targetIsoDate);
  const force = options.force ?? false;
  const existing = force ? [] : listExistingDispatchPeople(shortDate, "daily");
  const targets = resolveTargets(options.targetPerson).filter(
    (person) => force || !existing.includes(person)
  );

  if (targets.length === 0) {
    return {
      success: true,
      triggerDate: triggerIsoDate,
      targetDate: targetIsoDate,
      skipped: true,
      reason: "all targets already have snippets",
      isMonday,
      targets: [],
    };
  }

  const workPages = await getWorkPages(targetIsoDate, targetIsoDate);
  const tasksByPerson = await buildFormattedTasks(workPages, config.notionUserIds);
  const jobs: Promise<unknown>[] = [];

  for (const person of targets) {
    const tasks = tasksByPerson[person] ?? [];
    if (tasks.length > 0) {
      const nameKo = person === "youngmin" ? "박영민" : "조세연";
      jobs.push(
        generateDailySnippetContent(nameKo, targetIsoDate, tasks).then((content) =>
          queueSnippet(person, "daily", shortDate, content)
        )
      );
    } else {
      jobs.push(sendNoTaskWarning(person, shortDate));
    }
  }

  await Promise.all(jobs);

  let weeklyResult: { dateLabel: string; targets: Person[] } | null = null;
  if (isMonday) {
    weeklyResult = await handleWeeklySnippets(
      triggerIsoDate,
      options.targetPerson ?? null,
      force
    );
  }

  return {
    success: true,
    triggerDate: triggerIsoDate,
    targetDate: targetIsoDate,
    isMonday,
    targets,
    weekly: weeklyResult,
  };
}

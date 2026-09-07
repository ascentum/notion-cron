import { sendDiscordText } from "../../lib/discord";
import { listCalendarEvents } from "../../lib/google-calendar";
import { generateWorkHoursComment } from "../../lib/openai";
import {
  getKstDateInfo,
  getKstDateTimeRange,
  shiftIsoDate,
} from "../../lib/time";
import {
  buildReportMessage,
  computeAverageHours,
  describePerformance,
  getVoicePreset,
  isValidComment,
  getKstWeekStart,
  getWeekLabel,
  getWeekRange,
  pickFallbackComment,
  sumHoursByWeek,
  toWorkSessions,
} from "../../lib/work-hours";
import { config } from "../config";

interface RunOptions {
  // 전송 없이 메시지만 만들어 보고 싶을 때 (테스트/검증용)
  dryRun?: boolean;
  // 특정 주(월요일 ISO)를 강제로 집계하고 싶을 때
  targetWeekStart?: string;
}

async function buildComment(input: {
  weekLabel: string;
  totalHours: number;
  previousHours: number;
  averageHours: number;
}): Promise<string> {
  const voice = getVoicePreset(input.totalHours, input.averageHours);
  const request = {
    name: config.workHours.personName,
    ...input,
    verdict: describePerformance(input.totalHours, input.averageHours),
    voice,
  };

  // 늘어진 문장이 나오면 한 번 더 시도하고, 그래도 아니면 고정 멘트로 간다
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const comment = await generateWorkHoursComment(request);
      if (isValidComment(comment, voice)) return comment.trim();
      console.warn(`[work-hours] 톤/길이 조건 미달로 재시도: ${comment}`);
    } catch (error) {
      console.error("[work-hours] comment generation failed:", error);
      break;
    }
  }

  return pickFallbackComment(input.totalHours, input.averageHours);
}

export async function runWorkHoursReport(
  now: Date = new Date(),
  options: RunOptions = {}
) {
  const { isoDate } = getKstDateInfo(now);
  const targetWeekStart =
    options.targetWeekStart ?? shiftIsoDate(getKstWeekStart(isoDate), -7);
  const previousWeekStart = shiftIsoDate(targetWeekStart, -7);
  const { endIso } = getWeekRange(targetWeekStart);

  // 누적 평균을 내려면 과거 기록도 함께 봐야 해서 조회 구간을 길게 잡는다
  const historyStartIso = shiftIsoDate(
    targetWeekStart,
    -config.workHours.historyLookbackDays
  );
  const range = getKstDateTimeRange(historyStartIso, endIso);

  const events = await listCalendarEvents({
    calendarId: config.workHours.calendarId,
    timeMin: range.start,
    timeMax: range.end,
  });

  const sessions = toWorkSessions(events, config.workHours.eventKeyword);
  const weeklyHours = sumHoursByWeek(sessions);

  const totalHours = weeklyHours.get(targetWeekStart) ?? 0;
  const previousHours = weeklyHours.get(previousWeekStart) ?? 0;
  const averageHours = computeAverageHours(weeklyHours, targetWeekStart);
  const weekLabel = getWeekLabel(targetWeekStart);

  const comment = await buildComment({
    weekLabel,
    totalHours,
    previousHours,
    averageHours,
  });

  const message = buildReportMessage({
    name: config.workHours.personName,
    weekLabel,
    totalHours,
    previousHours,
    averageHours,
    comment,
  });

  const summary = {
    weekStart: targetWeekStart,
    weekEnd: endIso,
    weekLabel,
    totalHours,
    previousHours,
    averageHours,
    sessionCount: sessions.filter(
      (session) => getKstWeekStart(session.dateIso) === targetWeekStart
    ).length,
    message,
  };

  if (options.dryRun) {
    return { ...summary, sent: false as const };
  }

  const messageId = await sendDiscordText(config.workHours.channelId, message);
  console.log(
    `[work-hours] ${targetWeekStart} 리포트 전송 완료 (${totalHours}시간, message ${messageId})`
  );

  return { ...summary, sent: true as const, messageId };
}

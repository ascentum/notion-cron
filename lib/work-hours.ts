import { shiftIsoDate } from "./time";

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const KST_OFFSET_MS = 9 * MS_PER_HOUR;

export interface CalendarEventLike {
  summary?: string | null;
  start?: { dateTime?: string | null; date?: string | null } | null;
  end?: { dateTime?: string | null; date?: string | null } | null;
}

export interface WorkSession {
  dateIso: string;
  hours: number;
}

export interface ReportInput {
  name: string;
  weekLabel: string;
  totalHours: number;
  previousHours: number;
  averageHours: number;
  comment: string;
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// KST 자정을 경계로 하는 날짜 인덱스 (자정을 넘는 일정을 쪼개는 기준)
function toKstDayIndex(epochMs: number): number {
  return Math.floor((epochMs + KST_OFFSET_MS) / MS_PER_DAY);
}

function kstDayStartMs(dayIndex: number): number {
  return dayIndex * MS_PER_DAY - KST_OFFSET_MS;
}

function kstDayIndexToIso(dayIndex: number): string {
  return new Date(dayIndex * MS_PER_DAY).toISOString().slice(0, 10);
}

function diffDays(fromIsoDate: string, toIsoDate: string): number {
  const from = new Date(`${fromIsoDate}T00:00:00.000Z`).getTime();
  const to = new Date(`${toIsoDate}T00:00:00.000Z`).getTime();
  return Math.round((to - from) / MS_PER_DAY);
}

// KST 기준 그 주의 월요일 (주간 집계 단위)
export function getKstWeekStart(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  return shiftIsoDate(isoDate, -daysSinceMonday);
}

export function getWeekRange(weekStartIso: string) {
  return {
    startIso: weekStartIso,
    endIso: shiftIsoDate(weekStartIso, 6),
  };
}

// 주차 표기는 그 주의 목요일이 속한 달을 기준으로 한다 (ISO 주차와 동일한 관례)
export function getWeekLabel(weekStartIso: string): string {
  const thursdayIso = shiftIsoDate(weekStartIso, 3);
  const [, month, day] = thursdayIso.split("-");
  const monthNumber = Number.parseInt(month, 10);
  const weekOfMonth = Math.floor((Number.parseInt(day, 10) - 1) / 7) + 1;

  return `${monthNumber}월 ${weekOfMonth}째주`;
}

// 키워드가 포함된 시간 지정 일정만 근무로 인정 (종일 일정은 근무 시간 산정 불가라 제외)
export function toWorkSessions(
  events: CalendarEventLike[],
  keyword: string
): WorkSession[] {
  const sessions: WorkSession[] = [];

  for (const event of events) {
    const summary = event.summary ?? "";
    if (!summary.includes(keyword)) continue;

    const startDateTime = event.start?.dateTime;
    const endDateTime = event.end?.dateTime;
    if (!startDateTime || !endDateTime) continue;

    const startMs = new Date(startDateTime).getTime();
    const endMs = new Date(endDateTime).getTime();
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
      continue;
    }

    // 자정을 넘는 일정은 KST 자정에서 잘라 각 날짜에 나눠 담는다
    const firstDay = toKstDayIndex(startMs);
    const lastDay = toKstDayIndex(endMs - 1);

    for (let day = firstDay; day <= lastDay; day += 1) {
      const segmentStart = Math.max(startMs, kstDayStartMs(day));
      const segmentEnd = Math.min(endMs, kstDayStartMs(day + 1));
      if (segmentEnd <= segmentStart) continue;

      sessions.push({
        dateIso: kstDayIndexToIso(day),
        hours: roundTo((segmentEnd - segmentStart) / MS_PER_HOUR, 2),
      });
    }
  }

  return sessions;
}

export function sumHoursByWeek(sessions: WorkSession[]): Map<string, number> {
  const weekly = new Map<string, number>();

  for (const session of sessions) {
    const weekStart = getKstWeekStart(session.dateIso);
    weekly.set(weekStart, roundTo((weekly.get(weekStart) ?? 0) + session.hours, 2));
  }

  return weekly;
}

export function formatHours(hours: number): string {
  return `${roundTo(hours, 1)}시간`;
}

export function formatDelta(currentHours: number, previousHours: number): string {
  const diff = roundTo(currentHours - previousHours, 1);
  if (diff === 0) return "±0시간 (0%)";

  const magnitude = formatHours(Math.abs(diff));
  if (previousHours === 0) return `+${magnitude} (지난주 기록 없음)`;

  const percent = Math.round((diff / previousHours) * 100);
  if (diff > 0) return `+${magnitude} (+${percent}%)`;

  return `-${magnitude} (${percent}%)`;
}

// 첫 근무 기록이 있는 주부터 대상 주까지 모든 주가 분모 (근무 0시간인 주도 포함)
export function computeAverageHours(
  weeklyHours: Map<string, number>,
  lastWeekStartIso: string
): number {
  const weekStarts = [...weeklyHours.keys()]
    .filter((weekStart) => weekStart <= lastWeekStartIso)
    .sort();

  if (weekStarts.length === 0) return 0;

  const totalHours = weekStarts.reduce(
    (sum, weekStart) => sum + (weeklyHours.get(weekStart) ?? 0),
    0
  );
  const weekCount = diffDays(weekStarts[0], lastWeekStartIso) / 7 + 1;

  return roundTo(totalHours / weekCount, 2);
}

function pickTrendEmoji(currentHours: number, previousHours: number): string {
  if (currentHours > previousHours) return "📈";
  if (currentHours < previousHours) return "📉";
  return "➡️";
}

export type PerformanceTier = "first" | "great" | "good" | "soso" | "low";

// 이모지·폴백 멘트·LLM 프롬프트가 모두 이 판정을 공유한다
export function getPerformanceTier(
  totalHours: number,
  averageHours: number
): PerformanceTier {
  if (averageHours === 0) return "first";
  if (totalHours >= averageHours * 1.1) return "great";
  if (totalHours >= averageHours) return "good";
  if (totalHours >= averageHours * 0.7) return "soso";
  return "low";
}

const TIER_EMOJIS: Record<PerformanceTier, string> = {
  first: "🎉",
  great: "🔥",
  good: "👌",
  soso: "😐",
  low: "🫠",
};

export type VoicePreset = "B-1" | "B-2";

// 잘한 주는 정중하게 비꼬고(B-2), 못한 주는 거칠게 놀린다(B-1). docs/copy-tone.md 참고
const TIER_VOICES: Record<PerformanceTier, VoicePreset> = {
  first: "B-2",
  great: "B-2",
  good: "B-2",
  soso: "B-1",
  low: "B-1",
};

export function getVoiceForTier(tier: PerformanceTier): VoicePreset {
  return TIER_VOICES[tier];
}

export function getVoicePreset(
  totalHours: number,
  averageHours: number
): VoicePreset {
  return getVoiceForTier(getPerformanceTier(totalHours, averageHours));
}

const TIER_VERDICTS: Record<PerformanceTier, string> = {
  first: "첫 기록이라 비교할 평균이 없는 주",
  great: "평균보다 눈에 띄게 많이 일한 주",
  good: "평균을 웃돈 무난하게 좋은 주",
  soso: "평균에 못 미친 아쉬운 주",
  low: "평균보다 크게 부족했던 주",
};

export function describePerformance(
  totalHours: number,
  averageHours: number
): string {
  return TIER_VERDICTS[getPerformanceTier(totalHours, averageHours)];
}

function pickCommentEmoji(totalHours: number, averageHours: number): string {
  return TIER_EMOJIS[getPerformanceTier(totalHours, averageHours)];
}

export function buildReportMessage(input: ReportInput): string {
  const { name, weekLabel, totalHours, previousHours, averageHours, comment } =
    input;

  return [
    `📊 **${weekLabel} ${name} 업무 시간 : 총 ${formatHours(totalHours)}**`,
    `> ${pickTrendEmoji(totalHours, previousHours)} 지난주 대비 ${formatDelta(totalHours, previousHours)}`,
    `> 🗓️ ${name} 평균 주 업무 시간 : ${formatHours(averageHours)}`,
    "",
    `${pickCommentEmoji(totalHours, averageHours)} ${comment}`,
  ].join("\n");
}

// OpenAI 호출이 실패했을 때 쓰는 대체 멘트 (성과 구간별)
export const FALLBACK_COMMENTS = {
  // great / good — VOICE B-2 (정중한 풍자)
  great: [
    "이 정도면 인정하겠습니다. 다음 주에 그대로 무너지지만 않으면 됩니다.",
    "훌륭합니다. 이 기록이 일회성 이벤트가 아니길 바랄 뿐입니다.",
    "일은 잘하셨습니다. 잠은 언제 주무셨는지가 다음 안건입니다.",
  ],
  good: [
    "평균은 넘기셨습니다. 축하까지는 아니고 확인 정도로 해두겠습니다.",
    "무난합니다. 무난하다는 말이 칭찬으로 들리셨다면 그것도 문제입니다.",
    "기대를 배신하지 않는 선에서 딱 멈추셨습니다.",
  ],
  // soso / low — VOICE B-1 (거친 인터넷 로스팅)
  soso: [
    "지난주보다 늘었다고 좋아하지 마라 ㅋㅋ 평균 밑인 건 그대로임",
    "이번 주 캘린더 ㅈㄴ 한산하던데 ㅋㅋ 뭐 하고 살았음?",
    "일한 척은 했는데 숫자가 정직하네 ㅋㅋ",
  ],
  low: [
    "이 정도면 근무가 아니라 휴가 아니냐 ㅋㅋ",
    "캘린더 텅텅 빈 거 보고 ㅅㅂ 소리 나왔다 ㅋㅋ",
    "이번 주 일한 거 맞음? ㅋㅋ 증거가 없는데",
  ],
} as const;

const CRUDE_TOKENS = ["ㅋㅋ", "ㅅㅂ", "ㅈㄴ", "존나", "씨발", "시발"];

// 한 줄 멘트는 짧아야 톤이 산다. 넘어가면 폴백으로 돌린다
const MAX_COMMENT_LENGTH = 45;

// LLM이 늘어지거나 목소리를 반대로 잡은 결과를 걸러낸다
export function isValidComment(
  comment: string,
  voice: VoicePreset
): boolean {
  const trimmed = comment.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_COMMENT_LENGTH) return false;

  // B-1은 ㅋㅋ가 필수, B-2는 거친 표현이 하나도 없어야 한다
  return voice === "B-1"
    ? trimmed.includes("ㅋㅋ")
    : !CRUDE_TOKENS.some((token) => trimmed.includes(token));
}

export function pickFallbackComment(
  totalHours: number,
  averageHours: number
): string {
  const tier = getPerformanceTier(totalHours, averageHours);
  const candidates = FALLBACK_COMMENTS[tier === "first" ? "great" : tier];

  return candidates[Math.floor(Math.random() * candidates.length)];
}

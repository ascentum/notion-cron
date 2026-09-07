import OpenAI from "openai";

function getClient() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

interface DailySummary {
  date: string;
  youngminTasks: string[];
  seyeonTasks: string[];
  allTasks: string[];
}

export interface SummarizedDay {
  date: string;
  youngmin: string;
  seyeon: string;
}

function splitSummaryText(text: string): string[] {
  return text
    .split(/\s+\/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function dedupePreserveOrder(parts: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const part of parts) {
    if (seen.has(part)) continue;
    seen.add(part);
    result.push(part);
  }

  return result;
}

function joinSummaryParts(parts: string[]): string {
  return dedupePreserveOrder(parts).join(" / ");
}

export function normalizeSummarizedDaily(
  dailySummaries: DailySummary[],
  summarizedDaily: SummarizedDay[]
): SummarizedDay[] {
  const allowedDates = new Set(dailySummaries.map((summary) => summary.date));
  const mergedByDate = new Map<
    string,
    { youngmin: string[]; seyeon: string[] }
  >();

  for (const summary of summarizedDaily) {
    if (!allowedDates.has(summary.date)) continue;

    const entry = mergedByDate.get(summary.date) ?? {
      youngmin: [],
      seyeon: [],
    };

    entry.youngmin.push(...splitSummaryText(summary.youngmin));
    entry.seyeon.push(...splitSummaryText(summary.seyeon));
    mergedByDate.set(summary.date, entry);
  }

  return dailySummaries.flatMap((summary) => {
    const merged = mergedByDate.get(summary.date);
    const youngmin = merged?.youngmin.length
      ? joinSummaryParts(merged.youngmin)
      : summary.youngminTasks.length > 0
        ? summary.youngminTasks.join(" / ")
        : "";
    const seyeon = merged?.seyeon.length
      ? joinSummaryParts(merged.seyeon)
      : summary.seyeonTasks.length > 0
        ? summary.seyeonTasks.join(" / ")
        : "";

    if (!youngmin && !seyeon) return [];

    return [
      {
        date: summary.date,
        youngmin,
        seyeon,
      },
    ];
  });
}

export async function generateWeeklySummary(
  dailySummaries: DailySummary[],
  range: { startDate: string; endDate: string }
): Promise<{ overview: string; summarizedDaily: SummarizedDay[] }> {
  // 프롬프트용 데이터 직렬화
  const rawData = dailySummaries
    .map((d) => {
      const all = d.allTasks.join("\n  - ");
      return `[${d.date}]\n  - ${all || "(완료 항목 없음)"}`;
    })
    .join("\n\n");

  const dailyData = dailySummaries
    .map((d) => {
      const ym = d.youngminTasks.length > 0 ? d.youngminTasks.join(" / ") : "";
      const sy = d.seyeonTasks.length > 0 ? d.seyeonTasks.join(" / ") : "";
      return `[${d.date}]\n  박영민: ${ym || "(없음)"}\n  조세연: ${sy || "(없음)"}`;
    })
    .join("\n\n");

  const overviewPrompt = `
다음은 ${range.startDate}~${range.endDate} (KST 기준) 어센텀 팀의 완료된 업무 목록이야.
이 내용을 바탕으로 **핵심 흐름 3가지 축**으로 총평을 작성해줘.
- 각 축은 "① 제목 — 설명" 형식
- 각 축은 별도 줄에 작성 (줄바꿈으로 구분)
- 전체 200자 내외
- 딱딱한 명사형으로 작성 (예: "팀 운영 기반 구축", "서비스 안정화 및 유저 소통 확대")
- "~했어요", "~해요", "~합니다" 같은 어미 사용 금지
- 리스트 없이 자연스러운 문단으로

업무 데이터:
${rawData}
`;

  const dailySummaryPrompt = `
다음은 팀원별 일자별 완료 업무 목록이야.
각 팀원의 각 일자별 업무를 주요 내용 위주로 간결하게 요약해줘.

규칙:
- 원문 그대로 나열하지 말고, 핵심만 요약
- 각 날짜의 요약은 " / "로 구분된 짧은 항목들로 작성
- 업무가 없는 사람은 빈 문자열 ""
- 업무가 없는 날짜는 포함하지 마
- 응답은 반드시 아래 JSON 배열만 반환 (다른 텍스트 없이):

[{"date":"YYYY-MM-DD","youngmin":"요약1 / 요약2","seyeon":"요약1 / 요약2"}, ...]

업무 데이터:
${dailyData}
`;

  const openai = getClient();
  const [overviewRes, dailyRes] = await Promise.all([
    openai.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 500,
      messages: [{ role: "user", content: overviewPrompt }],
    }),
    openai.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 1000,
      messages: [{ role: "user", content: dailySummaryPrompt }],
    }),
  ]);

  const overview = overviewRes.choices[0].message.content ?? "";

  let summarizedDailyInput: SummarizedDay[] = [];
  try {
    const dailyContent = dailyRes.choices[0].message.content ?? "[]";
    const jsonMatch = dailyContent.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      summarizedDailyInput = JSON.parse(jsonMatch[0]);
    }
  } catch {
    summarizedDailyInput = [];
  }

  const summarizedDaily = normalizeSummarizedDaily(
    dailySummaries,
    summarizedDailyInput
  );

  return { overview, summarizedDaily };
}

// 개인별 데일리 스니펫 내용 생성 (헬스체크 제외)
export async function generateDailySnippetContent(
  name: string,
  date: string,
  tasks: string[]
): Promise<string> {
  const openai = getClient();
  const res = await openai.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 900,
    messages: [
      {
        role: "user",
        content: `다음은 ${name}의 오늘(${date}) 완료한 업무 목록이야.
아래 형식에 맞게 정리해줘.

형식 (섹션 제목은 **굵게**, 항목은 - 리스트):

**오늘 한 일**
- [완료한 업무 항목]

**수행 목적**
- [각 업무의 목적/이유]

**하이라이트**
- [잘 된 것, 의미 있는 성과]

**로우라이트**
- [미완료, 막힌 것, 아쉬운 점]

**내일의 우선순위**
- [오늘 흐름에서 이어질 다음 할 일]

**오늘 내가 팀에 기여한 가치**
- [팀/프로젝트에 실질적으로 기여한 내용]

**오늘의 배움 또는 남길 말**
[인사이트, 회고 — 1~2문장, 리스트 없이 자연스럽게]

규칙:
- 섹션 제목은 반드시 **볼드** 처리
- 항목은 - 리스트로
- 없는 내용은 "- (없음)"으로
- 자연스럽고 간결하게

완료한 업무:
${tasks.join("\n")}`,
      },
    ],
  });
  return res.choices[0].message.content ?? "";
}

// 개인별 주간 스니펫 내용 생성
export async function generateWeeklySnippetContent(
  name: string,
  weekStart: string,
  weekEnd: string,
  dailyTasks: { date: string; tasks: string[] }[]
): Promise<string> {
  const openai = getClient();
  const rawData = dailyTasks
    .filter((d) => d.tasks.length > 0)
    .map((d) => `[${d.date}]\n${d.tasks.map((t) => `- ${t}`).join("\n")}`)
    .join("\n\n");

  const res = await openai.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 800,
    messages: [
      {
        role: "user",
        content: `다음은 ${name}의 ${weekStart}~${weekEnd} 주간 완료 업무야.
아래 형식에 맞게 정리해줘.

형식 (섹션 제목은 **굵게**):

**이번 주 핵심 성과**
① [제목] — [설명]
② [제목] — [설명]
③ [제목] — [설명]

**상세 업무 내역**
- [날짜]: [주요 업무 1줄 요약]

**다음 주 계획**
- [이번 주 흐름에서 이어갈 내용]

**이번 주 회고**
[잘 된 점 / 개선할 점 — 2~3문장, 자연스럽게]

규칙:
- 섹션 제목은 반드시 **볼드** 처리
- 자연스럽고 간결하게

업무 데이터:
${rawData}`,
      },
    ],
  });
  return res.choices[0].message.content ?? "";
}

// 주간 업무 시간 리포트 마지막 줄에 붙는 한 줄 멘트 (docs/copy-tone.md)
const VOICE_GUIDES = {
  "B-1": `톤 (거친 인터넷 로스팅):
- 반말. 디시/인터넷 밈 어투를 자연스럽게 섞을 것 (~노, ~임, ~냐, 개-, ㅈㄴ, ㅅㅂ)
- 문장 어딘가에 ㅋㅋ 를 최소 1회 넣을 것
- 욕설은 ㅅㅂ, ㅈㄴ 같은 축약형 위주로 가볍게. 수위를 올리지 말 것
- 놀리는 게 목적이다. 응원이나 조언으로 마무리하지 말 것

이런 결로 써줘:
- 이번 주 캘린더 ㅈㄴ 한산하던데 ㅋㅋ 뭐 하고 살았음?
- 지난주보다 늘었다고 좋아하지 마라 ㅋㅋ 평균 밑인 건 그대로임
- 이 정도면 근무가 아니라 휴가 아니냐 ㅋㅋ`,
  "B-2": `톤 (정중한 풍자):
- 존댓말 어미(~습니다, ~하시는 편이 좋겠습니다)를 쓰되 내용은 여전히 비꼬는 결일 것
- 욕설, ㅋㅋ, 밈 어투, 반말 금지
- 칭찬으로 곱게 마무리하지 말 것. 인정하되 "그래서 이게 유지가 되겠냐"는 뉘앙스로 한 번 꺾을 것
- 컨설팅 보고서 + 풍자 칼럼 느낌

이런 결로 써줘:
- 평균은 넘기셨습니다. 축하까지는 아니고 확인 정도로 해두겠습니다.
- 훌륭합니다. 이 기록이 일회성 이벤트가 아니길 바랄 뿐입니다.
- 일은 잘하셨습니다. 잠은 언제 주무셨는지가 다음 안건입니다.`,
} as const;

export async function generateWorkHoursComment(input: {
  name: string;
  weekLabel: string;
  totalHours: number;
  previousHours: number;
  averageHours: number;
  verdict: string;
  voice: "B-1" | "B-2";
}): Promise<string> {
  const openai = getClient();
  const res = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.95,
    messages: [
      {
        role: "user",
        content: `${input.name}의 주간 업무 시간 리포트 마지막에 붙일 한 줄 멘트를 써줘.

이번 주(${input.weekLabel}) 업무 시간: ${input.totalHours}시간
지난주 업무 시간: ${input.previousHours}시간
전체 기간 평균 주 업무 시간: ${input.averageHours}시간
종합 판정: ${input.verdict}

${VOICE_GUIDES[input.voice]}

규칙:
- 멘트의 방향은 반드시 '종합 판정'을 따를 것. 지난주보다 늘었더라도 판정이 아쉬우면 놀릴 것
- 공격 대상은 근무 기록(근무 시간, 캘린더가 빈 정도, 밤샘, 지난주 대비 낙차)으로만 한정할 것
- 외모, 건강, 가족, 연애사 등 사적 영역은 절대 건드리지 말 것
- 정확히 한 문장, 50자 이내. 짧을수록 좋다
- 억지로 늘리지 말 것. 어색하게 읽히는 문장은 버리고 짧게 다시 쓸 것
- "화이팅", "개선의 여지" 같은 추상적인 표현으로 도망가지 말 것
- 숫자를 그대로 나열하지 말 것
- 이모지는 넣지 말 것 (앞에 자동으로 붙음)
- 따옴표 없이 문장만 출력`,
      },
    ],
  });

  return (res.choices[0].message.content ?? "")
    .trim()
    .split("\n")[0]
    .replace(/^["'\u201c\u2018]|["'\u201d\u2019]$/g, "")
    .trim();
}

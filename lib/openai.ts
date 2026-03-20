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

export async function generateWeeklySummary(
  dailySummaries: DailySummary[]
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
다음은 지난 1주일간(목요일~목요일) 어센텀 팀의 완료된 업무 목록이야.
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

  let summarizedDaily: SummarizedDay[] = [];
  try {
    const dailyContent = dailyRes.choices[0].message.content ?? "[]";
    const jsonMatch = dailyContent.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      summarizedDaily = JSON.parse(jsonMatch[0]);
    }
  } catch {
    // Fallback: 파싱 실패 시 원본 task 사용
    summarizedDaily = dailySummaries.map((d) => ({
      date: d.date,
      youngmin: d.youngminTasks.join(" / "),
      seyeon: d.seyeonTasks.join(" / "),
    }));
  }

  return { overview, summarizedDaily };
}

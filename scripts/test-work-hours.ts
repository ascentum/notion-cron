import assert from "node:assert/strict";
import {
  buildReportMessage,
  computeAverageHours,
  describePerformance,
  FALLBACK_COMMENTS,
  getPerformanceTier,
  getVoiceForTier,
  getVoicePreset,
  isValidComment,
  formatDelta,
  formatHours,
  getKstWeekStart,
  getWeekLabel,
  getWeekRange,
  sumHoursByWeek,
  toWorkSessions,
} from "../lib/work-hours";

function verifyWeekStart() {
  // 월요일은 그대로, 나머지 요일은 직전 월요일로
  assert.equal(getKstWeekStart("2026-08-31"), "2026-08-31");
  assert.equal(getKstWeekStart("2026-09-06"), "2026-08-31");
  assert.equal(getKstWeekStart("2026-09-03"), "2026-08-31");
  assert.equal(getKstWeekStart("2026-09-07"), "2026-09-07");
}

function verifyWeekRange() {
  assert.deepEqual(getWeekRange("2026-08-31"), {
    startIso: "2026-08-31",
    endIso: "2026-09-06",
  });
}

function verifyWeekLabel() {
  // 그 주의 목요일이 속한 달 기준, 해당 달의 N번째 목요일
  assert.equal(getWeekLabel("2026-08-31"), "9월 1째주"); // 목요일 9/3
  assert.equal(getWeekLabel("2026-09-07"), "9월 2째주"); // 목요일 9/10
  assert.equal(getWeekLabel("2026-08-24"), "8월 4째주"); // 목요일 8/27
  assert.equal(getWeekLabel("2026-12-28"), "12월 5째주"); // 목요일 12/31
}

function verifyWorkSessions() {
  const events = [
    {
      summary: "영민 근무",
      start: { dateTime: "2026-09-01T10:00:00+09:00" },
      end: { dateTime: "2026-09-01T14:30:00+09:00" },
    },
    {
      summary: "[어센텀] 영민 근무 (오후)",
      start: { dateTime: "2026-09-02T13:00:00+09:00" },
      end: { dateTime: "2026-09-02T18:00:00+09:00" },
    },
    {
      summary: "세연 근무",
      start: { dateTime: "2026-09-02T13:00:00+09:00" },
      end: { dateTime: "2026-09-02T18:00:00+09:00" },
    },
    {
      summary: "영민 근무",
      start: { date: "2026-09-03" },
      end: { date: "2026-09-04" },
    },
  ];

  const sessions = toWorkSessions(events, "영민 근무");

  // 키워드 미포함 일정과 종일 일정은 제외
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions[0], { dateIso: "2026-09-01", hours: 4.5 });
  assert.deepEqual(sessions[1], { dateIso: "2026-09-02", hours: 5 });
}

function verifySumHoursByWeek() {
  const weekly = sumHoursByWeek([
    { dateIso: "2026-09-01", hours: 4.5 },
    { dateIso: "2026-09-02", hours: 5 },
    { dateIso: "2026-09-07", hours: 3 },
  ]);

  assert.equal(weekly.get("2026-08-31"), 9.5);
  assert.equal(weekly.get("2026-09-07"), 3);
  assert.equal(weekly.size, 2);
}

function verifyFormatHours() {
  assert.equal(formatHours(32), "32시간");
  assert.equal(formatHours(32.5), "32.5시간");
  assert.equal(formatHours(32.25), "32.3시간");
  assert.equal(formatHours(0), "0시간");
}

function verifyFormatDelta() {
  assert.equal(formatDelta(36, 32), "+4시간 (+13%)");
  assert.equal(formatDelta(30, 32), "-2시간 (-6%)");
  assert.equal(formatDelta(32, 32), "±0시간 (0%)");
  assert.equal(formatDelta(10, 0), "+10시간 (지난주 기록 없음)");
  assert.equal(formatDelta(0, 0), "±0시간 (0%)");
  assert.equal(formatDelta(0, 12), "-12시간 (-100%)");
}

function verifyComputeAverage() {
  const weekly = new Map([
    ["2026-08-17", 20],
    ["2026-08-31", 40],
  ]);

  // 첫 기록 주 ~ 지난주까지 모든 주(0시간 주 포함)가 분모
  assert.equal(computeAverageHours(weekly, "2026-08-31"), 20);

  // 지난주가 더 뒤면 빈 주가 분모에 추가됨
  assert.equal(computeAverageHours(weekly, "2026-09-07"), 15);

  // 기록이 없으면 0
  assert.equal(computeAverageHours(new Map(), "2026-09-07"), 0);
}

function verifyPerformanceTier() {
  // 이모지/폴백/LLM 프롬프트가 같은 판정을 공유하는지
  assert.equal(getPerformanceTier(44, 40), "great"); // 평균의 110% 이상
  assert.equal(getPerformanceTier(40, 40), "good");
  assert.equal(getPerformanceTier(30, 40), "soso"); // 평균의 70% 이상
  assert.equal(getPerformanceTier(20, 40), "low");
  assert.equal(getPerformanceTier(10, 0), "first"); // 비교할 평균 없음

  // 지난주보다 늘었어도 평균 미달이면 아쉬운 주로 판정된다
  assert.equal(describePerformance(31.83, 39.83), "평균에 못 미친 아쉬운 주");
}

function verifyVoicePreset() {
  // 잘한 주는 정중한 풍자, 못한 주는 거친 로스팅
  assert.equal(getVoicePreset(44, 40), "B-2");
  assert.equal(getVoicePreset(40, 40), "B-2");
  assert.equal(getVoicePreset(30, 40), "B-1");
  assert.equal(getVoicePreset(20, 40), "B-1");
  assert.equal(getVoicePreset(10, 0), "B-2");
}

function verifyCommentValidation() {
  assert.equal(isValidComment("평균 밑인 건 그대로임 ㅋㅋ", "B-1"), true);
  assert.equal(isValidComment("톤을 놓쳐서 밈 어투가 없는 멘트", "B-1"), false);
  assert.equal(isValidComment("  ", "B-1"), false);

  assert.equal(
    isValidComment("평균은 넘기셨습니다. 축하까지는 아니고 확인 정도로 해두겠습니다.", "B-2"),
    true
  );
  // B-2인데 거친 표현이 섞이면 탈락
  assert.equal(isValidComment("평균은 넘기셨습니다 ㅋㅋ", "B-2"), false);
  assert.equal(isValidComment("존나 잘하셨습니다.", "B-2"), false);

  // 늘어진 문장은 목소리와 무관하게 탈락 (45자 초과)
  assert.equal(
    isValidComment(
      "출장 간거 아님? 업무 시간 실화냐 ㅋㅋ 평균보다 부족한 거 인정하면서 반성 좀 해라 이렇게 길면 탈락이다",
      "B-1"
    ),
    false
  );
}

// 폴백 멘트 풀이 자기 구간의 목소리 규칙을 실제로 지키는지 (톤 규칙과 멘트가 어긋나는 것 방지)
function verifyFallbackPoolMatchesVoice() {
  for (const tier of ["great", "good", "soso", "low"] as const) {
    const voice = getVoiceForTier(tier);
    for (const comment of FALLBACK_COMMENTS[tier]) {
      assert.equal(
        isValidComment(comment, voice),
        true,
        `${tier}(${voice}) 멘트가 톤 규칙을 어김: ${comment}`
      );
    }
  }
}

function verifyReportMessage() {
  const message = buildReportMessage({
    name: "박영민",
    weekLabel: "9월 1째주",
    totalHours: 36,
    previousHours: 32,
    averageHours: 28.25,
    comment: "이 정도면 근면성실 상 드립니다 🏆",
  });

  // 1행은 볼드, 2~3행은 인용(좌측 바) — Discord 마크다운
  assert.equal(
    message,
    [
      "📊 **9월 1째주 박영민 업무 시간 : 총 36시간**",
      "> 📈 지난주 대비 +4시간 (+13%)",
      "> 🗓️ 박영민 평균 주 업무 시간 : 28.3시간",
      "",
      "🔥 이 정도면 근면성실 상 드립니다 🏆",
    ].join("\n")
  );

  // 감소한 주는 화살표 이모지가 바뀜
  const declining = buildReportMessage({
    name: "박영민",
    weekLabel: "9월 2째주",
    totalHours: 20,
    previousHours: 36,
    averageHours: 28,
    comment: "쉬어가는 것도 전략이죠",
  });
  assert.ok(declining.includes("> 📉 지난주 대비 -16시간 (-44%)"));
}

verifyWeekStart();
verifyWeekRange();
verifyWeekLabel();
verifyWorkSessions();
verifySumHoursByWeek();
verifyFormatHours();
verifyFormatDelta();
verifyComputeAverage();
verifyPerformanceTier();
verifyVoicePreset();
verifyCommentValidation();
verifyFallbackPoolMatchesVoice();
verifyReportMessage();

console.log("work-hours tests passed");

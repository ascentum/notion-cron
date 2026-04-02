import assert from "node:assert/strict";
import {
  extractCheckedTodos,
  extractTodoItems,
  formatWorkItem,
  splitWorkDateRanges,
} from "../lib/notion";
import { normalizeSummarizedDaily } from "../lib/openai";
import {
  getDailySnippetDateInfo,
  getKstDateTimeRange,
  getKstDateInfo,
  getPreviousWeekDateRange,
  toKstIsoDate,
} from "../lib/time";

function verifyDateRangeSplit() {
  assert.deepEqual(
    splitWorkDateRanges("2026-03-25", "2026-03-31", "2026-04-01"),
    [{ source: "legacy", startDate: "2026-03-25", endDate: "2026-03-31" }]
  );

  assert.deepEqual(
    splitWorkDateRanges("2026-04-01", "2026-04-03", "2026-04-01"),
    [{ source: "latest", startDate: "2026-04-01", endDate: "2026-04-03" }]
  );

  assert.deepEqual(
    splitWorkDateRanges("2026-03-27", "2026-04-02", "2026-04-01"),
    [
      { source: "legacy", startDate: "2026-03-27", endDate: "2026-03-31" },
      { source: "latest", startDate: "2026-04-01", endDate: "2026-04-02" },
    ]
  );
}

function verifyTodoExtraction() {
  const blocks = [
    {
      type: "to_do",
      to_do: {
        checked: true,
        rich_text: [{ plain_text: "완료된 업무" }],
      },
    },
    {
      type: "paragraph",
      paragraph: {
        rich_text: [{ plain_text: "무시되는 문단" }],
      },
    },
    {
      type: "to_do",
      to_do: {
        checked: false,
        rich_text: [{ plain_text: "미완료 업무" }],
      },
    },
  ];

  assert.deepEqual(extractTodoItems(blocks), [
    { text: "완료된 업무", checked: true },
    { text: "미완료 업무", checked: false },
  ]);
  assert.deepEqual(extractCheckedTodos(blocks), ["완료된 업무"]);
}

function verifyKstDateBoundary() {
  const dateInfo = getKstDateInfo(new Date("2026-04-01T15:00:00.000Z"));
  assert.equal(dateInfo.isoDate, "2026-04-02");
  assert.equal(dateInfo.weekday, 4);

  assert.deepEqual(getPreviousWeekDateRange(dateInfo.isoDate), {
    startIso: "2026-03-26",
    endIso: "2026-04-01",
  });
}

function verifyDailySnippetDateBoundary() {
  const dateInfo = getDailySnippetDateInfo(
    new Date("2026-04-02T15:00:16.000Z")
  );

  assert.deepEqual(dateInfo, {
    triggerIsoDate: "2026-04-03",
    targetIsoDate: "2026-04-02",
    weekday: 5,
  });
}

function verifyKstDateNormalization() {
  assert.equal(toKstIsoDate("2026-04-02"), "2026-04-02");
  assert.equal(
    toKstIsoDate("2026-04-02T13:51:00.000+09:00"),
    "2026-04-02"
  );
  assert.equal(
    toKstIsoDate("2026-04-03T00:04:00.000+09:00"),
    "2026-04-03"
  );
}

function verifyKstDateTimeRange() {
  assert.deepEqual(getKstDateTimeRange("2026-04-02", "2026-04-02"), {
    start: "2026-04-02T00:00:00.000+09:00",
    end: "2026-04-02T23:59:59.999+09:00",
  });
}

function verifyFormatting() {
  assert.equal(
    formatWorkItem({ title: "주간 회고 진행", category: "Ascentum" }),
    "[Ascentum] 주간 회고 진행"
  );
  assert.equal(
    formatWorkItem({ title: "AI 하네스 디버깅", category: null }),
    "AI 하네스 디버깅"
  );
}

function verifySummarizedDailyNormalization() {
  const normalized = normalizeSummarizedDaily(
    [
      {
        date: "2026-04-01",
        youngminTasks: ["Feature B09", "자동 배포 구현"],
        seyeonTasks: ["GCS pulse 연동 디코 봇 수정"],
        allTasks: [],
      },
      {
        date: "2026-03-31",
        youngminTasks: ["업무 DB 최적화"],
        seyeonTasks: [],
        allTasks: [],
      },
    ],
    [
      { date: "2026-04-01", youngmin: "Feature B09", seyeon: "" },
      { date: "2026-04-01", youngmin: "자동 배포 구현", seyeon: "" },
      {
        date: "2026-04-01",
        youngmin: "",
        seyeon: "GCS pulse 연동 디코 봇 수정",
      },
      { date: "2026-04-02", youngmin: "무시해야 하는 날짜", seyeon: "" },
    ]
  );

  assert.deepEqual(normalized, [
    {
      date: "2026-04-01",
      youngmin: "Feature B09 / 자동 배포 구현",
      seyeon: "GCS pulse 연동 디코 봇 수정",
    },
    {
      date: "2026-03-31",
      youngmin: "업무 DB 최적화",
      seyeon: "",
    },
  ]);
}

function main() {
  verifyDateRangeSplit();
  verifyTodoExtraction();
  verifyKstDateBoundary();
  verifyDailySnippetDateBoundary();
  verifyKstDateNormalization();
  verifyKstDateTimeRange();
  verifyFormatting();
  verifySummarizedDailyNormalization();
  console.log("work query checks passed");
}

main();

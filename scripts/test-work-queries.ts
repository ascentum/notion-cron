import assert from "node:assert/strict";
import {
  extractCheckedTodos,
  extractTodoItems,
  formatWorkItem,
  splitWorkDateRanges,
} from "../lib/notion";
import { getKstDateInfo } from "../lib/time";

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

function main() {
  verifyDateRangeSplit();
  verifyTodoExtraction();
  verifyKstDateBoundary();
  verifyFormatting();
  console.log("work query checks passed");
}

main();

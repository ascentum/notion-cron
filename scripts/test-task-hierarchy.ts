import assert from "node:assert/strict";
import {
  formatTaskTreeByUser,
  mapWithConcurrencyLimit,
  type TaskInfo,
} from "../lib/notion";

const USER_IDS = {
  youngmin: "youngmin-user",
  seyeon: "seyeon-user",
};

async function verifyHierarchyFormatting() {
  const tasks: TaskInfo[] = [
    {
      id: "root",
      title: "Root Task",
      category: "Planning",
      parentId: null,
      users: [USER_IDS.youngmin],
      isCompleted: true,
      isInScope: true,
      sourceIndex: 0,
    },
    {
      id: "child",
      title: "Child Task",
      category: "Execution",
      parentId: "root",
      users: [USER_IDS.youngmin],
      isCompleted: true,
      isInScope: true,
      sourceIndex: 1,
    },
    {
      id: "grandchild",
      title: "Grandchild Task",
      category: "QA",
      parentId: "child",
      users: [USER_IDS.youngmin],
      isCompleted: true,
      isInScope: true,
      sourceIndex: 2,
    },
    {
      id: "context-parent",
      title: "Context Parent",
      category: "Docs",
      parentId: null,
      users: [],
      isCompleted: true,
      isInScope: false,
      sourceIndex: Number.POSITIVE_INFINITY,
    },
    {
      id: "context-child",
      title: "Context Child",
      category: "Release",
      parentId: "context-parent",
      users: [],
      isCompleted: true,
      isInScope: false,
      sourceIndex: Number.POSITIVE_INFINITY,
    },
    {
      id: "leaf-task",
      title: "Leaf Task",
      category: "Ops",
      parentId: "context-child",
      users: [USER_IDS.seyeon],
      isCompleted: true,
      isInScope: true,
      sourceIndex: 3,
    },
  ];

  const formatted = formatTaskTreeByUser(tasks, USER_IDS);

  assert.deepEqual(formatted.youngmin, [
    "[Planning] Root Task",
    "  - [Execution] Child Task",
    "    - [QA] Grandchild Task",
  ]);
  assert.deepEqual(formatted.seyeon, [
    "[Docs] Context Parent",
    "  - [Release] Context Child",
    "    - [Ops] Leaf Task",
  ]);
  assert.equal(
    formatted.youngmin.filter((line) => line.includes("Child Task")).length,
    1
  );
}

async function verifyCompletedExpansionRules() {
  const tasks: TaskInfo[] = [
    {
      id: "root-seed",
      title: "Root Seed",
      category: "Planning",
      parentId: null,
      users: [USER_IDS.youngmin],
      isCompleted: true,
      isInScope: true,
      sourceIndex: 0,
    },
    {
      id: "hidden-bridge",
      title: "Hidden Bridge",
      category: "Internal",
      parentId: "root-seed",
      users: [],
      isCompleted: false,
      isInScope: false,
      sourceIndex: Number.POSITIVE_INFINITY,
    },
    {
      id: "connected-descendant",
      title: "Connected Descendant",
      category: "QA",
      parentId: "hidden-bridge",
      users: [USER_IDS.seyeon],
      isCompleted: true,
      isInScope: false,
      sourceIndex: Number.POSITIVE_INFINITY,
    },
    {
      id: "shared-parent",
      title: "Shared Parent",
      category: "Docs",
      parentId: null,
      users: [],
      isCompleted: true,
      isInScope: false,
      sourceIndex: Number.POSITIVE_INFINITY,
    },
    {
      id: "youngmin-seed",
      title: "Youngmin Seed",
      category: "Execution",
      parentId: "shared-parent",
      users: [USER_IDS.youngmin],
      isCompleted: true,
      isInScope: true,
      sourceIndex: 1,
    },
    {
      id: "seyeon-sibling-seed",
      title: "Seyeon Sibling Seed",
      category: "Ops",
      parentId: "shared-parent",
      users: [USER_IDS.seyeon],
      isCompleted: true,
      isInScope: true,
      sourceIndex: 2,
    },
  ];

  const formatted = formatTaskTreeByUser(tasks, USER_IDS);

  assert.deepEqual(formatted.youngmin, [
    "[Planning] Root Seed",
    "  - [QA] Connected Descendant",
    "[Docs] Shared Parent",
    "  - [Execution] Youngmin Seed",
  ]);
  assert.deepEqual(formatted.seyeon, [
    "[Docs] Shared Parent",
    "  - [Ops] Seyeon Sibling Seed",
  ]);
  assert.equal(
    formatted.youngmin.some((line) => line.includes("Hidden Bridge")),
    false
  );
  assert.equal(
    formatted.youngmin.some((line) => line.includes("Seyeon Sibling Seed")),
    false
  );
  assert.equal(
    formatted.seyeon.some((line) => line.includes("Youngmin Seed")),
    false
  );
}

async function verifyCycleSafety() {
  const tasks: TaskInfo[] = [
    {
      id: "cycle-a",
      title: "Cycle A",
      category: "Ops",
      parentId: "cycle-b",
      users: [USER_IDS.youngmin],
      isCompleted: true,
      isInScope: true,
      sourceIndex: 0,
    },
    {
      id: "cycle-b",
      title: "Cycle B",
      category: "Ops",
      parentId: "cycle-a",
      users: [],
      isCompleted: true,
      isInScope: false,
      sourceIndex: Number.POSITIVE_INFINITY,
    },
  ];

  const formatted = formatTaskTreeByUser(tasks, USER_IDS);

  assert.deepEqual(formatted.youngmin, [
    "[Ops] Cycle A",
    "  - [Ops] Cycle B",
  ]);
}

async function verifyConcurrencyLimit() {
  let active = 0;
  let maxActive = 0;

  const results = await mapWithConcurrencyLimit(
    [1, 2, 3, 4, 5],
    2,
    async (value) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return value * 2;
    }
  );

  assert.deepEqual(results, [2, 4, 6, 8, 10]);
  assert.equal(maxActive, 2);
}

async function main() {
  await verifyHierarchyFormatting();
  await verifyCompletedExpansionRules();
  await verifyCycleSafety();
  await verifyConcurrencyLimit();
  console.log("task hierarchy checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

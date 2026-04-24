export type Person = "youngmin" | "seyeon";
export type SnippetType = "daily" | "weekly";
export type DispatchStatus = "pending" | "posting" | "posted" | "skipped" | "failed";
export type CompletionSource =
  | "auto"
  | "manual-post"
  | "manual-health"
  | "manual-edit"
  | "manual-skip";

export interface DispatchRecord {
  id: number;
  discordMessageId: string;
  person: Person;
  snippetType: SnippetType;
  dateLabel: string;
  content: string;
  status: DispatchStatus;
  healthScore: number | null;
  completionSource: CompletionSource | null;
  dueAt: string;
  postedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDispatchInput {
  discordMessageId: string;
  person: Person;
  snippetType: SnippetType;
  dateLabel: string;
  content: string;
  dueAt: string;
  createdAt?: string;
}

export interface JobRunRecord {
  id: number;
  jobName: string;
  scheduledFor: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

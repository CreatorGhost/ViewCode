import type { SidebarThreadStatus } from "../Sidebar.logic";

const STATUS_LABEL: Record<SidebarThreadStatus, string> = {
  working: "Working",
  monitoring: "Monitoring background work",
  approval: "Waiting for approval",
  input: "Waiting for your answer",
  failed: "Last turn failed",
  ready: "Idle",
};

export function threadStatusLabel(status: SidebarThreadStatus): string {
  return STATUS_LABEL[status];
}

/** "3 threads", "1 thread"; the project card's one-line count. */
export function threadCountLabel(count: number): string {
  return `${count} ${count === 1 ? "thread" : "threads"}`;
}

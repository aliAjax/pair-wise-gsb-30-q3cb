// 落盘层：事件日志（完整交接）+ 状态快照 + 提交前暂存。
// 提交顺序：暂存完整交接 → 追加事件 → 写状态快照 → 清暂存。
// 任意一步掉电/失败，重启后都能凭"完整交接"重放恢复，命令 commandId 保证不重放油量。
import type { Command, DomainEvent, SystemState } from "../domain/types";

const EVENTS_KEY = "hxwlfront-19-handovers-events";
const STATE_KEY = "hxwlfront-19-handovers-state";
const PENDING_KEY = "hxwlfront-19-handovers-pending";

export class DiskError extends Error {}

/** 故障注入：stage=暂存后提交前失败；commit=事件已追加、快照未写时失败 */
export type FailPoint = "none" | "stage" | "commit";

export interface PendingPacket {
  cmd: Command;
  events: DomainEvent[];
  stagedAt: string;
}

export const disk = {
  readEvents(): DomainEvent[] | null {
    const raw = localStorage.getItem(EVENTS_KEY);
    if (raw === null) return null;
    return JSON.parse(raw) as DomainEvent[];
  },
  writeEvents(events: DomainEvent[]): void {
    localStorage.setItem(EVENTS_KEY, JSON.stringify(events));
  },
  readState(): SystemState | null {
    const raw = localStorage.getItem(STATE_KEY);
    if (raw === null) return null;
    return JSON.parse(raw) as SystemState;
  },
  writeState(state: SystemState): void {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  },
  readPending(): PendingPacket | null {
    const raw = localStorage.getItem(PENDING_KEY);
    if (raw === null) return null;
    return JSON.parse(raw) as PendingPacket;
  },
  writePending(packet: PendingPacket): void {
    localStorage.setItem(PENDING_KEY, JSON.stringify(packet));
  },
  clearPending(): void {
    localStorage.removeItem(PENDING_KEY);
  },
  wipe(): void {
    localStorage.removeItem(EVENTS_KEY);
    localStorage.removeItem(STATE_KEY);
    localStorage.removeItem(PENDING_KEY);
  },
};

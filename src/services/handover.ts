// 交接服务：把纯领域命令包上"暂存 → 落盘 → 恢复"的提交协议。
import { applyEvent, handle, nowIso, replay, type DomainError } from "../domain/reducer";
import type { Command, DomainEvent, SystemState } from "../domain/types";
import { disk, DiskError, type FailPoint, type PendingPacket } from "./storage";

export interface CommitOutcome {
  ok: boolean;
  failPhase: "stage" | "commit" | null;
  applied: number;
}

/**
 * 执行命令并按两阶段落盘：
 * 1) 暂存完整交接（命令 + 将产生的事件）；
 * 2) 追加事件日志（失败注入点 stage：暂存后崩溃，事件未入日志）；
 * 3) 写状态快照（失败注入点 commit：事件已入日志，快照仍旧）。
 * 任何阶段失败都不改变内存状态之外的约定，恢复入口为 recover()。
 */
export function commit(state: SystemState, cmd: Command, failPoint: FailPoint): CommitOutcome {
  const { state: next, events } = handle(state, cmd);
  if (events.length === 0 && state.processedCommands.includes(cmd.commandId)) {
    return { ok: true, failPhase: null, applied: 0 }; // 幂等重试：不多算
  }

  // 阶段一：暂存完整交接
  const packet: PendingPacket = { cmd, events, stagedAt: nowIso() };
  disk.writePending(packet);
  if (failPoint === "stage") {
    throw new DiskError("落盘失败：完整交接已暂存，但事件尚未提交（stage）");
  }

  // 阶段二：追加事件日志
  disk.writeEvents([...(disk.readEvents() ?? []), ...events]);
  if (failPoint === "commit") {
    throw new DiskError("落盘失败：事件已写入完整交接，状态快照未更新（commit）");
  }

  // 阶段三：快照落盘并清暂存
  disk.writeState(next);
  disk.clearPending();
  return { ok: true, failPhase: null, applied: events.length };
}

export interface RecoveryResult {
  state: SystemState;
  recoveredFrom: "stage" | "commit" | null;
  detail: string | null;
}

/**
 * 从完整交接恢复：
 * 一律先重放事件日志得到权威状态，再重投暂存命令。
 * commandId 幂等保证：commit 点失败时命令已生效，重投为空操作——油量不会多算。
 */
export function recover(failPoint: FailPoint = "none"): RecoveryResult {
  const eventsLog = disk.readEvents() ?? [];
  let state = replay(eventsLog);
  const pending = disk.readPending();

  if (!pending) {
    disk.writeState(state);
    return { state, recoveredFrom: null, detail: null };
  }

  const alreadyApplied = state.processedCommands.includes(pending.cmd.commandId);
  const recoveredFrom: "stage" | "commit" = alreadyApplied ? "commit" : "stage";

  if (recoveredFrom === "stage") {
    // 暂存后崩溃：事件没入日志，重新执行命令并补提事件
    if (failPoint === "stage") {
      throw new DiskError("恢复再次失败：暂存阶段仍不可用");
    }
    const { events } = handle(state, pending.cmd);
    disk.writeEvents([...(disk.readEvents() ?? []), ...events]);
    for (const e of events) state = applyEvent(state, e);
    if (failPoint === "commit") {
      throw new DiskError("恢复再次失败：事件已补提，快照未写（commit）");
    }
  } else {
    // commit 点崩溃：事件已在完整交接里，重放已包含效果，只补快照，绝不重算油量
    if (failPoint === "commit") {
      throw new DiskError("恢复再次失败：快照仍不可写（commit）");
    }
  }

  const detail =
    recoveredFrom === "stage"
      ? `命令 ${pending.cmd.commandId} 暂存后崩溃，已重放完整交接并补提，油量按原冻结吨数只计一次`
      : `命令 ${pending.cmd.commandId} 提交中断，事件已在完整交接中，重放恢复且未重复计算`;

  const recoveredEvent: DomainEvent = {
    type: "Recovered",
    at: nowIso(),
    commandId: `recover:${pending.cmd.commandId}`,
    detail,
  };
  // 恢复过程中再次崩溃时，同一暂存的恢复留痕也只追加一次
  const currentLog = disk.readEvents() ?? [];
  if (!currentLog.some((e) => e.commandId === recoveredEvent.commandId && e.type === "Recovered")) {
    disk.writeEvents([...currentLog, recoveredEvent]);
    state = applyEvent(state, recoveredEvent);
  }

  disk.writeState(state);
  disk.clearPending();
  return { state, recoveredFrom, detail };
}

export function currentSnapshot(): SystemState | null {
  return disk.readState();
}

export function hasPending(): boolean {
  return disk.readPending() !== null;
}

export type { DomainError };

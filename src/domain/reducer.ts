// 纯函数事件归约层：state + event => newState。
// 不落盘、不碰时间，落盘失败恢复后从事件流重放即可得到完整交接。
import type {
  AuditEntry,
  Command,
  Confirmation,
  DomainEvent,
  ExceptionType,
  FuelType,
  Handover,
  PriceBook,
  SettlementLine,
  SystemState,
} from "./types";
import { FUELS } from "./types";

export function uid(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function initialPriceBook(): PriceBook {
  const prices: Record<FuelType, number> = { "92号汽油": 7800, "95号汽油": 8400, 柴油: 7200 };
  return {
    version: 1,
    prices,
    history: [{ version: 1, prices: { ...prices }, reason: "启用初始计价版本", changedAt: nowIso() }],
  };
}

export function initialState(): SystemState {
  return { handovers: [], priceBook: initialPriceBook(), processedCommands: [], log: [] };
}

// ---------------- 工具 ----------------

function pushLog(state: SystemState, entry: Omit<AuditEntry, "at">, at: string): void {
  state.log = [{ ...entry, at }, ...state.log].slice(0, 300);
}

export function findHandover(state: SystemState, id: string): Handover | undefined {
  return state.handovers.find((h) => h.id === id);
}

function buildLine(
  handoverId: string,
  compartmentIndex: number,
  fuel: FuelType,
  tons: number,
  priceVersion: number,
  unitPrice: number,
  producedBy: string,
): SettlementLine {
  return {
    id: uid("line"),
    compartmentIndex,
    fuel,
    priceVersion,
    unitPrice,
    tons,
    amount: round2(tons * unitPrice),
    status: "待结算",
    producedBy,
    voidedBy: null,
    settledAt: null,
  };
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function activeLines(h: Handover): SettlementLine[] {
  return h.lines.filter((l) => l.status !== "已失效");
}

export function unsettledLines(h: Handover): SettlementLine[] {
  return h.lines.filter((l) => l.status === "待结算");
}

// ---------------- 事件应用（幂等：只在此处改状态） ----------------

export function applyEvent(state: SystemState, event: DomainEvent): SystemState {
  // 全局幂等：同一 commandId 的事件（含恢复时日志中可能残留的重复项）只生效一次
  if (state.processedCommands.includes(event.commandId)) {
    return state;
  }
  const next: SystemState = {
    ...state,
    handovers: state.handovers.map((h) => ({ ...h, compartments: h.compartments.map((c) => ({ ...c })), lines: h.lines.map((l) => ({ ...l })), confirmations: [...h.confirmations] })),
    priceBook: { ...state.priceBook, prices: { ...state.priceBook.prices }, history: [...state.priceBook.history] },
    processedCommands: [...state.processedCommands],
    log: [...state.log],
  };

  const getH = (id: string) => next.handovers.find((h) => h.id === id);

  switch (event.type) {
    case "OrderCreated": {
      // 重放同一命令时（崩溃恢复），不重复插入
      if (!getH(event.handover.id)) next.handovers = [event.handover, ...next.handovers];
      break;
    }
    case "OutboundFrozen": {
      const h = getH(event.handoverId);
      if (h && !h.frozen) {
        h.frozen = event.manifest;
        h.status = "在途";
        for (const c of h.compartments) {
          const m = event.manifest.compartments.find((x) => x.index === c.index);
          if (m) {
            c.loadedTons = m.loadedTons;
            c.sealNo = m.sealNo;
          }
        }
        h.lines = [...h.lines, ...event.newLines];
      }
      break;
    }
    case "ArrivalRecorded": {
      const h = getH(event.handoverId);
      if (h && !h.arrivedAt) {
        h.arrivedAt = event.at;
        const hasException = event.exceptionTypes.length > 0;
        h.status = hasException ? "到站异常" : "到站正常";
        for (const c of h.compartments) {
          const r = event.readings.find((x) => x.index === c.index);
          if (r) {
            c.receivedTons = r.receivedTons;
            c.arrivalSealNo = r.arrivalSealNo;
            c.arrivalFuel = r.arrivalFuel;
            c.sealMatch = r.arrivalSealNo.trim() === c.sealNo;
            c.fuelMatch = r.arrivalFuel === c.fuel;
            c.tonsMatch = c.loadedTons != null && Math.abs(r.receivedTons - c.loadedTons) < 0.001;
          }
        }
        if (hasException) {
          // 未结算部分失效：已结算的历史行不动，待结算行全部作废
          const voidSet = new Set(event.voidedLineIds);
          for (const line of h.lines) {
            if (voidSet.has(line.id)) {
              line.status = "已失效";
              line.voidedBy = event.commandId;
            }
          }
          h.exception = {
            types: event.exceptionTypes,
            reason: "",
            recordedBy: null,
            recordedAt: null,
            voidedLineIds: event.voidedLineIds,
            recomputedLineIds: [],
          };
        }
      }
      break;
    }
    case "ExceptionReasonSupplemented": {
      const h = getH(event.handoverId);
      if (h && h.exception && !h.exception.recordedAt) {
        h.exception.reason = event.reason;
        h.exception.recordedBy = event.operator;
        h.exception.recordedAt = event.at;
        h.exception.recomputedLineIds = event.newLines.map((l) => l.id);
        h.lines = [...h.lines, ...event.newLines];
        // 补原因并重算后，回到正常到站流程等待双人确认
        h.status = "到站正常";
      }
      break;
    }
    case "OperatorConfirmed": {
      const h = getH(event.handoverId);
      if (h) {
        // 同一值班员对同一回单只确认一次；同一 commandId 不重复确认
        if (!h.confirmations.some((c) => c.operator === event.operator || c.commandId === event.commandId)) {
          h.confirmations = [...h.confirmations, { operator: event.operator, at: event.at, commandId: event.commandId } as Confirmation];
        }
      }
      break;
    }
    case "Released": {
      const h = getH(event.handoverId);
      if (h && h.status !== "已放行") {
        h.status = "已放行";
        h.releasedAt = event.at;
        h.releaseCommandId = event.commandId;
      }
      break;
    }
    case "Settled": {
      const h = getH(event.handoverId);
      if (h) {
        const ids = new Set(event.lineIds);
        for (const line of h.lines) {
          if (ids.has(line.id) && line.status === "待结算") {
            line.status = "已结算";
            line.settledAt = event.at;
          }
        }
      }
      break;
    }
    case "PriceChanged": {
      next.priceBook = {
        version: event.newVersion,
        prices: { ...event.prices },
        history: [
          ...next.priceBook.history,
          { version: event.newVersion, prices: { ...event.prices }, reason: event.reason, changedAt: event.at },
        ],
      };
      // 待结算记录重新核对单价；已结算/已失效行不动
      for (const ref of event.repricedLineRefs) {
        const h = getH(ref.handoverId);
        const line = h?.lines.find((l) => l.id === ref.lineId);
        if (line && line.status === "待结算") {
          line.unitPrice = ref.newPrice;
          line.amount = round2(line.tons * ref.newPrice);
          line.priceVersion = event.newVersion;
        }
      }
      break;
    }
    case "Recovered": {
      break;
    }
  }

  // 命令只记录一次（重复投递/重试在此被去重）
  if (!next.processedCommands.includes(event.commandId)) {
    next.processedCommands = [...next.processedCommands, event.commandId];
  }

  pushLog(next, { level: "info", message: labelEvent(event), commandId: event.commandId }, event.at);
  return next;
}

function labelEvent(e: DomainEvent): string {
  switch (e.type) {
    case "OrderCreated":
      return `配送单 ${e.handover.id} 已创建（${e.handover.station}/${e.handover.truckNo}）`;
    case "OutboundFrozen":
      return `出库冻结：油品/吨数/铅封号已锁定，共 ${e.manifest.totalTons} 吨，计价版本 v${e.manifest.priceVersion}`;
    case "ArrivalRecorded":
      return e.exceptionTypes.length
        ? `到站异常：${e.exceptionTypes.join("、")}；${e.voidedLineIds.length} 条待结算行已失效，须回原单补原因`
        : "到站核对一致，等待双人确认放行";
    case "ExceptionReasonSupplemented":
      return `原单已补异常原因并重算，新生成 ${e.newLines.length} 条待结算行`;
    case "OperatorConfirmed":
      return `值班员 ${e.operator} 已确认回单`;
    case "Released":
      return "两名值班员确认完成，回单放行（仅一次）";
    case "Settled":
      return `结算完成，共 ${e.lineIds.length} 行`;
    case "PriceChanged":
      return `计价版本变更 v${e.oldVersion} → v${e.newVersion}，${e.repricedLineRefs.length} 条待结算记录已重新核对单价`;
    case "Recovered":
      return `落盘失败后已从完整交接恢复：${e.detail}`;
  }
}

// ---------------- 命令校验：决定是否产生事件 ----------------

export class DomainError extends Error {}

function ensure<T>(v: T | undefined, message: string): T {
  if (v === undefined) throw new DomainError(message);
  return v;
}

function detectExceptions(h: Handover): ExceptionType[] {
  const types: ExceptionType[] = [];
  if (h.compartments.some((c) => c.sealMatch === false)) types.push("铅封不符");
  if (h.compartments.some((c) => c.fuelMatch === false)) types.push("油品不符");
  if (h.compartments.some((c) => c.tonsMatch === false)) types.push("数量短少");
  return types;
}

/**
 * 处理命令：返回 state 和本次新产生的事件（0 条表示命中幂等/被规则拦截）。
 * 同一 commandId 重试不会重复计算油量、重复确认、重复结算。
 */
export function handle(state: SystemState, cmd: Command): { state: SystemState; events: DomainEvent[] } {
  // 命令级幂等：同一 commandId 直接短路，不产生任何新效果
  if (state.processedCommands.includes(cmd.commandId)) {
    return { state, events: [] };
  }

  const at = nowIso();
  const events: DomainEvent[] = [];

  switch (cmd.kind) {
    case "createOrder": {
      if (!cmd.station || !cmd.truckNo) throw new DomainError("油站和车牌号不能为空");
      if (!cmd.compartments.length) throw new DomainError("至少规划一个舱位");
      if (cmd.compartments.some((c) => c.plannedTons <= 0)) throw new DomainError("舱位计划吨数必须大于 0");
      const handover: Handover = {
        id: uid("PS"),
        station: cmd.station,
        truckNo: cmd.truckNo,
        plannedAt: cmd.plannedAt,
        createdAt: at,
        status: "待出库",
        compartments: cmd.compartments.map((c, i) => ({
          index: i,
          fuel: c.fuel,
          plannedTons: c.plannedTons,
          loadedTons: null,
          sealNo: null,
          receivedTons: null,
          arrivalSealNo: null,
          arrivalFuel: null,
          sealMatch: null,
          fuelMatch: null,
          tonsMatch: null,
        })),
        lines: [],
        frozen: null,
        arrivedAt: null,
        exception: null,
        confirmations: [],
        releasedAt: null,
        releaseCommandId: null,
      };
      events.push({ type: "OrderCreated", at, commandId: cmd.commandId, handover });
      break;
    }

    case "freezeOutbound": {
      const h = ensure(findHandover(state, cmd.handoverId), "配送单不存在");
      if (h.frozen) throw new DomainError("出库冻结只能执行一次（油品、吨数、铅封号已锁定）");
      if (h.status !== "待出库") throw new DomainError("当前状态不允许出库冻结");
      const comps = cmd.compartments;
      if (comps.length !== h.compartments.length) throw new DomainError("舱位数量与配送单不一致");
      for (const c of comps) {
        if (c.loadedTons <= 0) throw new DomainError(`舱位 ${c.index + 1} 实装吨数必须大于 0`);
        if (!c.sealNo.trim()) throw new DomainError(`舱位 ${c.index + 1} 铅封号不能为空`);
      }
      // 多仓罐车允许分装不同油品，但舱位油品以配送单为准，出库只冻结不改单
      const manifest = {
        at,
        operator: cmd.operator,
        priceVersion: state.priceBook.version,
        totalTons: round2(comps.reduce((s, c) => s + c.loadedTons, 0)),
        compartments: comps.map((c) => ({
          index: c.index,
          fuel: h.compartments[c.index].fuel,
          loadedTons: c.loadedTons,
          sealNo: c.sealNo.trim(),
        })),
      };
      // 按舱位生成待结算行，吨数以冻结实装为准
      const newLines = manifest.compartments.map((m) =>
        buildLine(h.id, m.index, m.fuel, m.loadedTons, state.priceBook.version, state.priceBook.prices[m.fuel], cmd.commandId),
      );
      events.push({ type: "OutboundFrozen", at, commandId: cmd.commandId, handoverId: h.id, manifest, newLines });
      break;
    }

    case "recordArrival": {
      const h = ensure(findHandover(state, cmd.handoverId), "配送单不存在");
      if (!h.frozen) throw new DomainError("尚未出库冻结，不能登记到站");
      if (h.arrivedAt) throw new DomainError("到站回单只能登记一次");
      // 先在临时对象上核对，避免污染 state
      const checked = h.compartments.map((c) => {
        const r = cmd.readings.find((x) => x.index === c.index);
        if (!r) throw new DomainError(`舱位 ${c.index + 1} 缺少到站读数`);
        return {
          ...c,
          receivedTons: r.receivedTons,
          arrivalSealNo: r.arrivalSealNo,
          arrivalFuel: r.arrivalFuel,
          sealMatch: r.arrivalSealNo.trim() === c.sealNo,
          fuelMatch: r.arrivalFuel === c.fuel,
          tonsMatch: c.loadedTons != null && Math.abs(r.receivedTons - c.loadedTons) < 0.001,
        };
      });
      const tempH: Handover = { ...h, compartments: checked };
      const exceptionTypes = detectExceptions(tempH);
      // 异常时仅未结算部分失效；已结算行（历史上已放过的部分）保留
      const voided = unsettledLines(h).map((l) => l.id);
      if (exceptionTypes.length && !voided.length) throw new DomainError("异常发生但已无未结算部分可失效");
      events.push({
        type: "ArrivalRecorded",
        at,
        commandId: cmd.commandId,
        handoverId: h.id,
        readings: cmd.readings.map((r) => ({ ...r, arrivalSealNo: r.arrivalSealNo.trim() })),
        exceptionTypes,
        voidedLineIds: exceptionTypes.length ? voided : [],
      });
      break;
    }

    case "supplementReason": {
      const h = ensure(findHandover(state, cmd.handoverId), "配送单不存在");
      if (!h.exception) throw new DomainError("该单没有到站异常，无需补原因");
      if (h.exception.recordedAt) throw new DomainError("异常原因已补录，不能重复补录");
      if (!cmd.reason.trim()) throw new DomainError("必须在原单上补录异常原因");
      // 以到站实测重算：铅封/油品不符按 0 吨计（拒收），数量短少按实收吨数
      const newLines: SettlementLine[] = h.compartments.map((c) => {
        const badSealOrFuel = c.sealMatch === false || c.fuelMatch === false;
        const billTons = badSealOrFuel ? 0 : c.receivedTons ?? c.loadedTons ?? 0;
        return buildLine(h.id, c.index, c.fuel, round2(billTons), state.priceBook.version, state.priceBook.prices[c.fuel], cmd.commandId);
      });
      events.push({
        type: "ExceptionReasonSupplemented",
        at,
        commandId: cmd.commandId,
        handoverId: h.id,
        operator: cmd.operator,
        reason: cmd.reason.trim(),
        newLines,
      });
      break;
    }

    case "confirm": {
      const h = ensure(findHandover(state, cmd.handoverId), "配送单不存在");
      if (h.status !== "到站正常") throw new DomainError("只有到站核对正常（或异常补原因重算后）的回单才能确认");
      if (h.confirmations.some((c) => c.operator === cmd.operator)) throw new DomainError("同一值班员不能重复确认");
      events.push({ type: "OperatorConfirmed", at, commandId: cmd.commandId, handoverId: h.id, operator: cmd.operator });
      // 两名不同值班员确认后自动放行，且整个生命周期只放行一次
      const operators = new Set([...h.confirmations.map((c) => c.operator), cmd.operator]);
      if (operators.size >= 2 && !h.releasedAt) {
        events.push({ type: "Released", at, commandId: uid("rel"), handoverId: h.id });
      }
      break;
    }

    case "settle": {
      const h = ensure(findHandover(state, cmd.handoverId), "配送单不存在");
      if (h.status !== "已放行") throw new DomainError("回单未放行，不能结算");
      const ids = unsettledLines(h).map((l) => l.id);
      if (!ids.length) throw new DomainError("没有待结算记录");
      events.push({ type: "Settled", at, commandId: cmd.commandId, handoverId: h.id, lineIds: ids });
      break;
    }

    case "changePrice": {
      for (const f of FUELS) {
        if (!(f in cmd.prices) || cmd.prices[f] <= 0) throw new DomainError(`${f} 单价不合法`);
      }
      if (state.priceBook.version >= 999) throw new DomainError("计价版本异常");
      const refs: Array<{ handoverId: string; lineId: string; oldPrice: number; newPrice: number }> = [];
      for (const h of state.handovers) {
        for (const line of unsettledLines(h)) {
          const newPrice = cmd.prices[line.fuel];
          if (line.unitPrice !== newPrice) {
            refs.push({ handoverId: h.id, lineId: line.id, oldPrice: line.unitPrice, newPrice });
          }
        }
      }
      events.push({
        type: "PriceChanged",
        at,
        commandId: cmd.commandId,
        oldVersion: state.priceBook.version,
        newVersion: state.priceBook.version + 1,
        prices: { ...cmd.prices },
        reason: cmd.reason.trim() || "统一调价",
        repricedLineRefs: refs,
      });
      break;
    }
  }

  let next = state;
  for (const e of events) next = applyEvent(next, e);
  return { state: next, events };
}

/** 从事件流重放构建状态（崩溃恢复入口） */
export function replay(events: DomainEvent[]): SystemState {
  let state = initialState();
  for (const e of events) state = applyEvent(state, e);
  return state;
}

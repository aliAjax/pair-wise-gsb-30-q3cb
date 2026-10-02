/**
 * 油品交接台 —— 交接账本
 *
 * 设计要点：
 * 1. 事件日志（journal）是唯一事实源，派生态永远可以重放重建。
 * 2. 每个命令携带幂等键；提交 = 先整体落盘、再应用内存。落盘失败内存不变，
 *    调用方用同一幂等键重试不会多算油量。
 * 3. 回单放行有业务幂等：两个值班员同时确认同一回单，只有第一个产生
 *    ReceiptReleased，第二个是幂等成功，结算只生成一次。
 * 4. 出库冻结后油品/吨数/铅封号不可改；异常只能回原单补原因，
 *    未结算部分作废重算，已结算部分不动。
 */

import {
  Annotation,
  AnomalyKind,
  ArrivalReceipt,
  CompartmentPlan,
  DeliveryOrder,
  Envelope,
  FrozenError,
  FrozenLine,
  HandoverEvent,
  PersistError,
  PriceBook,
  ReceiptLine,
  Settlement,
  SettlementLine,
  StateError,
} from "./types.js";

export interface StorageAdapter {
  load(): string | null;
  save(raw: string): void;
}

export interface CommandResult {
  ok: boolean;
  /** true 表示命中幂等/业务去重，未产生新事件 */
  deduplicated: boolean;
  events: HandoverEvent[];
}

interface State {
  orders: Map<string, DeliveryOrder>;
  receipts: Map<string, ArrivalReceipt>;
  settlements: Map<string, Settlement>;
  pricing: PriceBook;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const SHORTAGE_TOLERANCE = 0.01; // 吨，短量判定容差

/** 事件是纯数据，用深拷贝切断日志与派生态之间的引用共享。 */
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function emptyState(): State {
  return {
    orders: new Map(),
    receipts: new Map(),
    settlements: new Map(),
    pricing: { version: 0, prices: {} },
  };
}

export class HandoverLedger {
  private journal: Envelope[] = [];
  private seen = new Set<string>();
  private state: State = emptyState();

  constructor(
    private storage: StorageAdapter,
    private now: () => string = () => new Date().toISOString(),
  ) {
    this.recover();
  }

  /* ---------------- 恢复 ---------------- */

  /** 启动/崩溃后恢复：从存储读出完整交接日志并重放。 */
  recover(): void {
    const raw = this.storage.load();
    this.journal = raw ? (JSON.parse(raw) as Envelope[]) : [];
    this.rebuild();
  }

  /** 存储丢失时，从调用方持有的完整交接日志恢复并重新落盘。 */
  restoreFromJournal(journal: Envelope[]): void {
    const next = clone(journal).map((env, i) => ({ ...env, seq: i }));
    this.storage.save(JSON.stringify(next)); // 失败则抛错，内存不变
    this.journal = next;
    this.rebuild();
  }

  private rebuild(): void {
    this.state = emptyState();
    this.seen = new Set();
    for (const env of this.journal) {
      this.apply(env.event);
      this.seen.add(env.eventId);
    }
  }

  /* ---------------- 提交（幂等 + 先落盘后应用） ---------------- */

  private commit(eventId: string, build: () => HandoverEvent[]): CommandResult {
    if (this.seen.has(eventId)) {
      return { ok: true, deduplicated: true, events: [] };
    }
    const events = build(); // 纯函数：校验失败在此抛业务错误，不落盘、不改状态
    if (events.length === 0) {
      return { ok: true, deduplicated: true, events: [] };
    }
    const envelopes: Envelope[] = events.map((event, i) => ({
      seq: this.journal.length + i,
      eventId: i === 0 ? eventId : `${eventId}#${i}`,
      event: clone(event), // 日志只存快照，命令构造的对象此后与账本无关
    }));
    const next = [...this.journal, ...envelopes];
    try {
      this.storage.save(JSON.stringify(next)); // 先整体落盘
    } catch (err) {
      throw new PersistError(
        `交接日志落盘失败，内存状态未变，可用同一幂等键重试：${(err as Error).message}`,
      );
    }
    this.journal = next; // 落盘成功才推进内存
    for (const env of envelopes) {
      this.apply(env.event);
      this.seen.add(env.eventId);
    }
    return { ok: true, deduplicated: false, events };
  }

  /* ---------------- 命令 ---------------- */

  /** 创建配送单（含罐车舱位计划）。 */
  createOrder(
    key: string,
    input: { orderId: string; station: string; compartments: CompartmentPlan[] },
  ): CommandResult {
    return this.commit(key, () => {
      if (this.state.orders.has(input.orderId)) {
        throw new StateError(`配送单 ${input.orderId} 已存在`);
      }
      if (input.compartments.length === 0) {
        throw new StateError("配送单至少需要一个舱位");
      }
      const order: DeliveryOrder = {
        id: input.orderId,
        station: input.station,
        compartments: input.compartments.map((c) => ({ ...c, tons: round3(c.tons) })),
        status: "待发运",
        frozenAt: null,
        frozenSnapshot: null,
      };
      return [{ type: "OrderCreated", order }];
    });
  }

  /** 冻结前可调整舱位计划；出库冻结后油品/吨数/铅封号一律不可改。 */
  amendCompartments(key: string, orderId: string, compartments: CompartmentPlan[]): CommandResult {
    return this.commit(key, () => {
      const order = this.mustOrder(orderId);
      if (order.status !== "待发运") {
        throw new FrozenError(
          `配送单 ${orderId} 已出库冻结，油品/吨数/铅封号不可改；如有出入请到原到站回单补原因`,
        );
      }
      return [{ type: "CompartmentAmended", orderId, compartments }];
    });
  }

  /** 出库：冻结油品、吨数、铅封号快照。 */
  freezeOutbound(key: string, orderId: string): CommandResult {
    return this.commit(key, () => {
      const order = this.mustOrder(orderId);
      if (order.status !== "待发运") {
        throw new StateError(`配送单 ${orderId} 当前状态 ${order.status}，不能重复出库`);
      }
      const snapshot: FrozenLine[] = order.compartments.map((c) => Object.freeze({ ...c }));
      return [{ type: "OutboundFrozen", orderId, snapshot, at: this.now() }];
    });
  }

  /**
   * 到站登记：以冻结快照为准生成回单，油站只填实收与核验结果，
   * 填不了油品/铅封号（那是冻结的）。核验不符自动标记异常。
   */
  openReceipt(
    key: string,
    orderId: string,
    receiptId: string,
    measured: { compartmentNo: string; receivedTons: number; sealIntact: boolean; productMatch: boolean }[],
  ): CommandResult {
    return this.commit(key, () => {
      const order = this.mustOrder(orderId);
      if (order.status !== "已冻结") {
        throw new StateError(`配送单 ${orderId} 状态 ${order.status}，不能登记到站`);
      }
      const snapshot = order.frozenSnapshot!;
      const byNo = new Map(measured.map((m) => [m.compartmentNo, m]));
      const lines: ReceiptLine[] = snapshot.map((frozen) => {
        const m = byNo.get(frozen.compartmentNo);
        if (!m) throw new StateError(`到站登记缺少舱位 ${frozen.compartmentNo} 的测量值`);
        const receivedTons = round3(m.receivedTons);
        const anomaly: AnomalyKind | null = !m.productMatch
          ? "油品不符"
          : !m.sealIntact
            ? "铅封不符"
            : receivedTons < frozen.tons - SHORTAGE_TOLERANCE
              ? "数量短缺"
              : null;
        return {
          compartmentNo: frozen.compartmentNo,
          product: frozen.product,
          frozenTons: frozen.tons,
          frozenSealNo: frozen.sealNo,
          receivedTons,
          sealIntact: m.sealIntact,
          productMatch: m.productMatch,
          anomaly,
          acceptedTons: null,
        };
      });
      const receipt: ArrivalReceipt = {
        id: receiptId,
        orderId,
        status: lines.some((l) => l.anomaly) ? "异常待补因" : "待确认",
        lines,
        annotations: [],
        confirmedBy: [],
        settlementId: null,
        arrivedAt: this.now(),
      };
      return [{ type: "ReceiptOpened", receipt }];
    });
  }

  /**
   * 报告异常（放行前或放行后均可）：
   * - 放行前：回单行标记异常，转入"异常待补因"；
   * - 放行后：该舱位对应的"待结算"行立即作废（未结算部分失效），
   *   已结算行不动，待补原因后按核定合格量重算。
   */
  reportAnomaly(
    key: string,
    receiptId: string,
    compartmentNo: string,
    kind: AnomalyKind,
    detail: string,
  ): CommandResult {
    return this.commit(key, () => {
      const receipt = this.mustReceipt(receiptId);
      const line = receipt.lines.find((l) => l.compartmentNo === compartmentNo);
      if (!line) throw new StateError(`回单 ${receiptId} 没有舱位 ${compartmentNo}`);
      const events: HandoverEvent[] = [
        { type: "AnomalyReported", receiptId, compartmentNo, kind, detail, at: this.now() },
      ];
      if (receipt.settlementId) {
        const settlement = this.state.settlements.get(receipt.settlementId)!;
        const pendingIds = settlement.lines
          .filter((l) => l.compartmentNo === compartmentNo && l.status === "待结算")
          .map((l) => l.lineId);
        if (pendingIds.length > 0) {
          events.push({
            type: "SettlementLinesVoided",
            settlementId: settlement.id,
            lineIds: pendingIds,
            reason: `到站异常（${kind}）：${detail}，未结算部分失效`,
            at: this.now(),
          });
        }
      }
      return events;
    });
  }

  /**
   * 回原单补原因（只追加，不改单）。异常行必须补因并核定合格量后才能确认；
   * 若回单已放行且该舱位有已作废的待结算行，则按核定合格量重算一行待结算。
   */
  appendReason(
    key: string,
    receiptId: string,
    input: { by: string; reason: string; compartmentNo?: string; acceptedTons?: number },
  ): CommandResult {
    return this.commit(key, () => {
      const receipt = this.mustReceipt(receiptId);
      const annotation: Annotation = {
        by: input.by,
        reason: input.reason,
        compartmentNo: input.compartmentNo ?? null,
        acceptedTons: input.acceptedTons ?? null,
        at: this.now(),
      };
      const events: HandoverEvent[] = [{ type: "ReasonAppended", receiptId, annotation }];
      if (receipt.settlementId && input.compartmentNo && input.acceptedTons != null) {
        const settlement = this.state.settlements.get(receipt.settlementId)!;
        const receiptLine = receipt.lines.find((l) => l.compartmentNo === input.compartmentNo)!;
        const hasVoided = settlement.lines.some(
          (l) => l.compartmentNo === input.compartmentNo && l.status === "已作废",
        );
        const alreadyRecomputed = settlement.lines.some(
          (l) => l.compartmentNo === input.compartmentNo && l.status === "待结算",
        );
        if (hasVoided && !alreadyRecomputed && input.acceptedTons > 0) {
          events.push({
            type: "SettlementLineRecomputed",
            settlementId: settlement.id,
            line: this.makeSettlementLine(
              settlement.id,
              receiptLine,
              round3(input.acceptedTons),
              settlement.lines,
            ),
            at: this.now(),
          });
        }
      }
      return events;
    });
  }

  /**
   * 值班员确认回单并放行结算。
   * 两个值班员同时确认同一回单：第一个生成结算，第二个幂等成功，只放行一次。
   */
  confirmReceipt(key: string, receiptId: string, officer: string): CommandResult {
    const receipt = this.state.receipts.get(receiptId);
    if (receipt && receipt.status === "已放行") {
      // 业务幂等：回单已放行，重复确认（含并发第二人）不再产生事件
      return { ok: true, deduplicated: true, events: [] };
    }
    return this.commit(key, () => {
      const r = this.mustReceipt(receiptId);
      if (r.status === "已放行") return []; // 防御：归约层再挡一次
      const uncovered = r.lines.filter(
        (l) =>
          l.anomaly &&
          !r.annotations.some((a) => a.compartmentNo === l.compartmentNo && a.acceptedTons != null),
      );
      if (uncovered.length > 0) {
        throw new StateError(
          `回单 ${receiptId} 舱位 ${uncovered.map((l) => l.compartmentNo).join("、")} 异常未补原因，不能放行`,
        );
      }
      const settlementId = `ST-${receiptId}`;
      const lines: SettlementLine[] = [];
      for (const line of r.lines) {
        const tons = line.anomaly ? (line.acceptedTons ?? 0) : line.receivedTons;
        if (tons > 0) {
          lines.push(this.makeSettlementLine(settlementId, line, round3(tons), lines));
        }
      }
      const settlement: Settlement = {
        id: settlementId,
        receiptId,
        orderId: r.orderId,
        lines,
        createdAt: this.now(),
      };
      return [
        { type: "ReceiptReleased", receiptId, officer, settlement, at: this.now() },
      ];
    });
  }

  /** 核销一行待结算（待结算 → 已结算）。 */
  settleLine(key: string, settlementId: string, lineId: string): CommandResult {
    return this.commit(key, () => {
      const settlement = this.mustSettlement(settlementId);
      const line = settlement.lines.find((l) => l.lineId === lineId);
      if (!line) throw new StateError(`结算单 ${settlementId} 没有行 ${lineId}`);
      if (line.status !== "待结算") {
        throw new StateError(`结算行 ${lineId} 状态 ${line.status}，不能核销`);
      }
      return [{ type: "SettlementLineSettled", settlementId, lineId, at: this.now() }];
    });
  }

  /** 计价版本升级：所有"待结算"行按新价格重新核价，已结算/已作废不动。 */
  bumpPricing(key: string, prices: Record<string, number>): CommandResult {
    return this.commit(key, () => {
      const version = this.state.pricing.version + 1;
      const events: HandoverEvent[] = [
        { type: "PricingBumped", version, prices: { ...prices }, at: this.now() },
      ];
      for (const settlement of this.state.settlements.values()) {
        for (const line of settlement.lines) {
          if (line.status !== "待结算") continue;
          const unitPrice = prices[line.product];
          if (typeof unitPrice !== "number" || !Number.isFinite(unitPrice) || unitPrice < 0) {
            continue; // 价格缺失或非法的行不核价，保持原版本
          }
          events.push({
            type: "SettlementLineRepriced",
            settlementId: settlement.id,
            lineId: line.lineId,
            unitPrice,
            amount: round2(line.tons * unitPrice),
            pricingVersion: version,
          });
        }
      }
      return events;
    });
  }

  /* ---------------- 归约 ---------------- */

  private apply(event: HandoverEvent): void {
    // 状态只持有事件副本：日志对象一旦入账即为只读快照，归约不得改写它，
    // 否则重放同一日志时会被上次归约的写入污染（结算单丢失、放行被跳过）。
    const e = clone(event);
    const s = this.state;
    switch (e.type) {
      case "OrderCreated":
        s.orders.set(e.order.id, e.order);
        break;
      case "CompartmentAmended": {
        const order = s.orders.get(e.orderId);
        if (!order || order.status !== "待发运") break; // 冻结后的事件直接忽略
        order.compartments = e.compartments;
        break;
      }
      case "OutboundFrozen": {
        const order = s.orders.get(e.orderId);
        if (!order) break;
        order.status = "已冻结";
        order.frozenAt = e.at;
        order.frozenSnapshot = e.snapshot;
        break;
      }
      case "ReceiptOpened": {
        s.receipts.set(e.receipt.id, e.receipt);
        const order = s.orders.get(e.receipt.orderId);
        if (order) order.status = "已到站";
        break;
      }
      case "AnomalyReported": {
        const receipt = s.receipts.get(e.receiptId);
        if (!receipt) break;
        const line = receipt.lines.find((l) => l.compartmentNo === e.compartmentNo);
        if (line) line.anomaly = e.kind;
        if (receipt.status !== "已放行") receipt.status = "异常待补因";
        break;
      }
      case "ReasonAppended": {
        const receipt = s.receipts.get(e.receiptId);
        if (!receipt) break;
        receipt.annotations.push(e.annotation);
        const a = e.annotation;
        if (a.compartmentNo && a.acceptedTons != null) {
          const line = receipt.lines.find((l) => l.compartmentNo === a.compartmentNo);
          if (line) line.acceptedTons = round3(a.acceptedTons);
        }
        if (
          receipt.status === "异常待补因" &&
          receipt.lines.every(
            (l) =>
              !l.anomaly ||
              receipt.annotations.some(
                (x) => x.compartmentNo === l.compartmentNo && x.acceptedTons != null,
              ),
          )
        ) {
          receipt.status = "待确认";
        }
        break;
      }
      case "ReceiptReleased": {
        const receipt = s.receipts.get(e.receiptId);
        if (!receipt || receipt.status === "已放行") break; // 只放行一次
        receipt.status = "已放行";
        receipt.confirmedBy.push(e.officer);
        receipt.settlementId = e.settlement.id;
        s.settlements.set(e.settlement.id, e.settlement);
        const order = s.orders.get(receipt.orderId);
        if (order) order.status = "已放行";
        break;
      }
      case "SettlementLinesVoided": {
        const settlement = s.settlements.get(e.settlementId);
        if (!settlement) break;
        for (const id of e.lineIds) {
          const line = settlement.lines.find((l) => l.lineId === id);
          if (line && line.status === "待结算") {
            line.status = "已作废";
            line.voidReason = e.reason;
          }
        }
        break;
      }
      case "SettlementLineRecomputed": {
        const settlement = s.settlements.get(e.settlementId);
        if (!settlement) break;
        if (!settlement.lines.some((l) => l.lineId === e.line.lineId)) {
          settlement.lines.push(e.line);
        }
        break;
      }
      case "SettlementLineSettled": {
        const line = s.settlements.get(e.settlementId)?.lines.find(
          (l) => l.lineId === e.lineId,
        );
        if (line && line.status === "待结算") line.status = "已结算";
        break;
      }
      case "SettlementLineRepriced": {
        const line = s.settlements.get(e.settlementId)?.lines.find(
          (l) => l.lineId === e.lineId,
        );
        if (line && line.status === "待结算") {
          line.unitPrice = e.unitPrice;
          line.amount = e.amount;
          line.pricingVersion = e.pricingVersion;
        }
        break;
      }
      case "PricingBumped":
        s.pricing = { version: e.version, prices: { ...e.prices } };
        break;
    }
  }

  /* ---------------- 查询 ---------------- */

  get pricing(): PriceBook {
    return this.state.pricing;
  }

  listOrders(): DeliveryOrder[] {
    return [...this.state.orders.values()];
  }

  listReceipts(): ArrivalReceipt[] {
    return [...this.state.receipts.values()];
  }

  listSettlements(): Settlement[] {
    return [...this.state.settlements.values()];
  }

  getOrder(id: string): DeliveryOrder | undefined {
    return this.state.orders.get(id);
  }

  getReceipt(id: string): ArrivalReceipt | undefined {
    return this.state.receipts.get(id);
  }

  getJournal(): readonly Envelope[] {
    return this.journal;
  }

  /** 待结算记录：计价版本变化后需要重新核对的正是这些。 */
  pendingSettlementLines(): (SettlementLine & { settlementId: string })[] {
    return this.listSettlements().flatMap((s) =>
      s.lines.filter((l) => l.status === "待结算").map((l) => ({ ...l, settlementId: s.id })),
    );
  }

  /** 汇总油量/金额：全部由事件派生，重放与重试不会多算。 */
  totals() {
    let pendingTons = 0;
    let settledTons = 0;
    let voidedTons = 0;
    let pendingAmount = 0;
    let settledAmount = 0;
    for (const s of this.state.settlements.values()) {
      for (const l of s.lines) {
        if (l.status === "待结算") {
          pendingTons += l.tons;
          pendingAmount += l.amount;
        } else if (l.status === "已结算") {
          settledTons += l.tons;
          settledAmount += l.amount;
        } else {
          voidedTons += l.tons;
        }
      }
    }
    return {
      pendingTons: round3(pendingTons),
      settledTons: round3(settledTons),
      voidedTons: round3(voidedTons),
      pendingAmount: round2(pendingAmount),
      settledAmount: round2(settledAmount),
    };
  }

  /* ---------------- 内部 ---------------- */

  private makeSettlementLine(
    settlementId: string,
    receiptLine: ReceiptLine,
    tons: number,
    existing: SettlementLine[],
  ): SettlementLine {
    // 行号由舱位历史行数派生，重放/重试结果一致，不会撞号
    const prior = existing.filter((l) => l.compartmentNo === receiptLine.compartmentNo).length;
    const suffix = prior === 0 ? receiptLine.compartmentNo : `${receiptLine.compartmentNo}-R${prior}`;
    const unitPrice = this.state.pricing.prices[receiptLine.product] ?? 0;
    return {
      lineId: `${settlementId}-${suffix}`,
      compartmentNo: receiptLine.compartmentNo,
      product: receiptLine.product,
      tons,
      unitPrice,
      amount: round2(tons * unitPrice),
      pricingVersion: this.state.pricing.version,
      status: "待结算",
      voidReason: null,
    };
  }

  private mustOrder(orderId: string): DeliveryOrder {
    const order = this.state.orders.get(orderId);
    if (!order) throw new StateError(`配送单 ${orderId} 不存在`);
    return order;
  }

  private mustReceipt(receiptId: string): ArrivalReceipt {
    const receipt = this.state.receipts.get(receiptId);
    if (!receipt) throw new StateError(`回单 ${receiptId} 不存在`);
    return receipt;
  }

  private mustSettlement(settlementId: string): Settlement {
    const settlement = this.state.settlements.get(settlementId);
    if (!settlement) throw new StateError(`结算单 ${settlementId} 不存在`);
    return settlement;
  }
}

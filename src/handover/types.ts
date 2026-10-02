/**
 * 油品交接台 —— 领域类型
 *
 * 配送单 → 罐车舱位 → 出库铅封 → 到站回单 → 结算，全链路只认一份交接记录。
 * 所有状态变化都是事件，事件日志（journal）是唯一事实源。
 */

/** 舱位计划：油品、吨数、出库铅封号。出库冻结后不可改。 */
export interface CompartmentPlan {
  compartmentNo: string; // 舱号，如 "1号舱"
  product: string; // 油品，如 "92号汽油"
  tons: number; // 计划/装车吨数
  sealNo: string; // 出库铅封号
}

/** 出库冻结快照行：冻结时刻的 {油品, 吨数, 铅封号}，此后以此为准。 */
export type FrozenLine = Readonly<CompartmentPlan>;

export type OrderStatus = "待发运" | "已冻结" | "已到站" | "已放行";

export interface DeliveryOrder {
  id: string;
  station: string; // 目标油站
  compartments: CompartmentPlan[];
  status: OrderStatus;
  frozenAt: string | null; // 出库冻结时间
  frozenSnapshot: FrozenLine[] | null; // 冻结快照，冻结后唯一有效
}

export type AnomalyKind = "铅封不符" | "油品不符" | "数量短缺";

export interface ReceiptLine {
  compartmentNo: string;
  product: string; // 来自冻结快照
  frozenTons: number; // 冻结吨数
  frozenSealNo: string; // 冻结铅封号
  receivedTons: number; // 到站实收吨数
  sealIntact: boolean; // 到站铅封核验
  productMatch: boolean; // 到站油品核验
  anomaly: AnomalyKind | null; // 异常类型
  acceptedTons: number | null; // 补因后核定的合格量（异常行专用）
}

export type ReceiptStatus = "待确认" | "异常待补因" | "已放行";

export interface Annotation {
  by: string; // 补记人（司机/油站/值班员）
  reason: string; // 原因说明
  compartmentNo: string | null; // 针对哪个舱位，null 表示整单
  acceptedTons: number | null; // 核定合格量（仅异常行）
  at: string;
}

/** 到站回单：只有一份，只允许追加补记，不允许各改各的。 */
export interface ArrivalReceipt {
  id: string;
  orderId: string;
  status: ReceiptStatus;
  lines: ReceiptLine[];
  annotations: Annotation[]; // 只增不改
  confirmedBy: string[]; // 确认过的值班员（可能多人并发，只放行一次）
  settlementId: string | null;
  arrivedAt: string;
}

export type SettlementLineStatus = "待结算" | "已结算" | "已作废";

export interface SettlementLine {
  lineId: string;
  compartmentNo: string;
  product: string;
  tons: number; // 应结算吨数
  unitPrice: number; // 元/吨
  amount: number; // 元
  pricingVersion: number; // 计价版本快照
  status: SettlementLineStatus;
  voidReason: string | null;
}

/** 结算单：回单放行时生成，行级跟踪结算状态。 */
export interface Settlement {
  id: string;
  receiptId: string;
  orderId: string;
  lines: SettlementLine[];
  createdAt: string;
}

/** 价格本：版本化，版本变化后待结算记录重新核价。 */
export interface PriceBook {
  version: number;
  prices: Record<string, number>; // 油品 → 元/吨
}

/* ---------------- 事件 ---------------- */

export type HandoverEvent =
  | { type: "OrderCreated"; order: DeliveryOrder }
  | { type: "CompartmentAmended"; orderId: string; compartments: CompartmentPlan[] }
  | { type: "OutboundFrozen"; orderId: string; snapshot: FrozenLine[]; at: string }
  | { type: "ReceiptOpened"; receipt: ArrivalReceipt }
  | {
      type: "AnomalyReported";
      receiptId: string;
      compartmentNo: string;
      kind: AnomalyKind;
      detail: string;
      at: string;
    }
  | {
      type: "ReasonAppended";
      receiptId: string;
      annotation: Annotation;
    }
  | {
      type: "ReceiptReleased";
      receiptId: string;
      officer: string;
      settlement: Settlement;
      at: string;
    }
  | {
      type: "SettlementLinesVoided";
      settlementId: string;
      lineIds: string[];
      reason: string;
      at: string;
    }
  | {
      type: "SettlementLineRecomputed";
      settlementId: string;
      line: SettlementLine;
      at: string;
    }
  | { type: "SettlementLineSettled"; settlementId: string; lineId: string; at: string }
  | {
      type: "SettlementLineRepriced";
      settlementId: string;
      lineId: string;
      unitPrice: number;
      amount: number;
      pricingVersion: number;
    }
  | { type: "PricingBumped"; version: number; prices: Record<string, number>; at: string };

/** 日志信封：seq 全序，eventId 为幂等键。 */
export interface Envelope {
  seq: number;
  eventId: string;
  event: HandoverEvent;
}

/* ---------------- 错误 ---------------- */

export class FrozenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrozenError";
  }
}

export class StateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateError";
  }
}

export class PersistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistError";
  }
}

// 交接台领域模型：配送单 → 罐车舱位 → 出库铅封冻结 → 到站回单 → 双人确认放行 → 结算
// 所有状态变更都通过事件产生（事件溯源），命令带 commandId，天然支持重试去重与崩溃恢复。

export const FUELS = ["92号汽油", "95号汽油", "柴油"] as const;
export type FuelType = (typeof FUELS)[number];

export const OPERATORS = ["王强", "李敏", "赵磊"] as const;

export const STATIONS = ["城东站", "机场站", "新区站"];

/** 交接主状态：司机出库与油站到站共用同一张交接单，不允许各改各的 */
export type HandoverStatus =
  | "待出库" // 配送单已建，尚未装车铅封
  | "在途" // 出库已冻结油品/吨数/铅封号
  | "到站正常" // 到站核对一致，等待双人确认
  | "到站异常" // 到站发现异常，未结算部分已失效，须回原单补原因后重算
  | "已放行"; // 两名值班员确认完成，只放行一次

export type SettlementStatus = "待结算" | "已失效" | "已结算";

export const EXCEPTION_TYPES = ["铅封不符", "油品不符", "数量短少"] as const;
export type ExceptionType = (typeof EXCEPTION_TYPES)[number];

/** 罐车舱位：计划值来自配送单，实装值/铅封在出库时冻结，实测值在到站录入 */
export interface Compartment {
  index: number;
  fuel: FuelType; // 配送单油品
  plannedTons: number; // 配送单计划吨数
  loadedTons: number | null; // 出库实装吨数（冻结）
  sealNo: string | null; // 出库铅封号（冻结）
  receivedTons: number | null; // 到站实收/实测吨数
  arrivalSealNo: string | null; // 到站抄录的铅封号
  arrivalFuel: FuelType | null; // 到站目测/取样油品
  sealMatch: boolean | null;
  fuelMatch: boolean | null;
  tonsMatch: boolean | null;
}

export interface SettlementLine {
  id: string;
  compartmentIndex: number;
  fuel: FuelType;
  /** 计价版本，价格变更后待结算行会重新核对并抬版本 */
  priceVersion: number;
  unitPrice: number;
  tons: number;
  amount: number;
  status: SettlementStatus;
  /** 本行由哪条命令产生（出库冻结 / 异常补原因重算） */
  producedBy: string;
  /** 若被异常作废，记录作废它的命令；作废行永不再参与结算 */
  voidedBy: string | null;
  settledAt: string | null;
}

export interface ExceptionRecord {
  types: ExceptionType[];
  /** 异常原因：只允许回到原配送单补录 */
  reason: string;
  recordedBy: string | null;
  recordedAt: string | null;
  /** 未结算部分失效的行 */
  voidedLineIds: string[];
  /** 补原因后重算出的行 */
  recomputedLineIds: string[];
}

export interface Confirmation {
  operator: string;
  at: string;
  commandId: string;
}

/** 出库冻结快照：结算与到站核对都以此为准，任何人不能改 */
export interface FrozenManifest {
  at: string;
  operator: string;
  compartments: Array<{ index: number; fuel: FuelType; loadedTons: number; sealNo: string }>;
  totalTons: number;
  priceVersion: number;
}

export interface Handover {
  id: string; // 配送单号
  station: string;
  truckNo: string;
  plannedAt: string;
  createdAt: string;
  status: HandoverStatus;
  compartments: Compartment[];
  lines: SettlementLine[];
  frozen: FrozenManifest | null;
  arrivedAt: string | null;
  exception: ExceptionRecord | null;
  confirmations: Confirmation[];
  releasedAt: string | null;
  releaseCommandId: string | null;
}

export interface PriceBook {
  version: number;
  prices: Record<FuelType, number>;
  history: Array<{ version: number; prices: Record<FuelType, number>; reason: string; changedAt: string }>;
}

export interface AuditEntry {
  at: string;
  level: "info" | "warn" | "ok";
  message: string;
  commandId?: string;
}

export interface SystemState {
  handovers: Handover[];
  priceBook: PriceBook;
  /** 已处理命令幂等表：同一 commandId 重放不重复生效 */
  processedCommands: string[];
  log: AuditEntry[];
}

// ---------------- 命令 ----------------

export interface CreateOrderCmd {
  kind: "createOrder";
  commandId: string;
  station: string;
  truckNo: string;
  plannedAt: string;
  compartments: Array<{ fuel: FuelType; plannedTons: number }>;
}

export interface FreezeOutboundCmd {
  kind: "freezeOutbound";
  commandId: string;
  handoverId: string;
  operator: string;
  compartments: Array<{ index: number; loadedTons: number; sealNo: string }>;
}

export interface ArrivalReading {
  index: number;
  receivedTons: number;
  arrivalSealNo: string;
  arrivalFuel: FuelType;
}

export interface RecordArrivalCmd {
  kind: "recordArrival";
  commandId: string;
  handoverId: string;
  readings: ArrivalReading[];
}

export interface SupplementReasonCmd {
  kind: "supplementReason";
  commandId: string;
  handoverId: string;
  operator: string;
  reason: string;
}

export interface ConfirmCmd {
  kind: "confirm";
  commandId: string;
  handoverId: string;
  operator: string;
}

export interface SettleCmd {
  kind: "settle";
  commandId: string;
  handoverId: string;
}

export interface ChangePriceCmd {
  kind: "changePrice";
  commandId: string;
  prices: Record<FuelType, number>;
  reason: string;
}

export type Command =
  | CreateOrderCmd
  | FreezeOutboundCmd
  | RecordArrivalCmd
  | SupplementReasonCmd
  | ConfirmCmd
  | SettleCmd
  | ChangePriceCmd;

// ---------------- 事件 ----------------

export type DomainEvent =
  | { type: "OrderCreated"; at: string; commandId: string; handover: Handover }
  | { type: "OutboundFrozen"; at: string; commandId: string; handoverId: string; manifest: FrozenManifest; newLines: SettlementLine[] }
  | {
      type: "ArrivalRecorded";
      at: string;
      commandId: string;
      handoverId: string;
      readings: ArrivalReading[];
      exceptionTypes: ExceptionType[];
      voidedLineIds: string[];
    }
  | { type: "ExceptionReasonSupplemented"; at: string; commandId: string; handoverId: string; operator: string; reason: string; newLines: SettlementLine[] }
  | { type: "OperatorConfirmed"; at: string; commandId: string; handoverId: string; operator: string }
  | { type: "Released"; at: string; commandId: string; handoverId: string }
  | { type: "Settled"; at: string; commandId: string; handoverId: string; lineIds: string[] }
  | {
      type: "PriceChanged";
      at: string;
      commandId: string;
      oldVersion: number;
      newVersion: number;
      prices: Record<FuelType, number>;
      reason: string;
      repricedLineRefs: Array<{ handoverId: string; lineId: string; oldPrice: number; newPrice: number }>;
    }
  | { type: "Recovered"; at: string; commandId: string; detail: string };

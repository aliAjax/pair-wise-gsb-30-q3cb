/**
 * 交接台六条规则的可执行验证：
 *  1. 出库冻结油品/吨数/铅封号，冻结后不可改
 *  2. 两个值班员同时确认同一回单，只放行一次
 *  3. 落盘失败后从完整交接恢复，重试不多算油量
 *  4. 到站异常：未结算部分失效重算，只允许回原单补原因
 *  5. 放行前异常必须先补因，结算量按核定合格量
 *  6. 计价版本变化后，待结算记录重新核对单价（已结算不动）
 *
 * 运行：npm run verify
 */

import { HandoverLedger, StorageAdapter } from "../src/handover/ledger.js";
import { FrozenError, PersistError, StateError } from "../src/handover/types.js";

declare const process: { exit(code: number): never };

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}`, extra === undefined ? "" : JSON.stringify(extra));
  }
}

function expectThrow(name: string, fn: () => void, ErrClass: new (m: string) => Error) {
  try {
    fn();
    failed++;
    console.error(`  ✗ ${name}（本应抛 ${ErrClass.name}，实际未抛）`);
  } catch (err) {
    check(name, err instanceof ErrClass, err);
  }
}

/** 可注入故障的内存存储：failNext>0 时下一次 save 抛错，模拟落盘失败。 */
class MemStorage implements StorageAdapter {
  private raw: string | null = null;
  failNext = 0;
  load() {
    return this.raw;
  }
  save(raw: string) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("模拟磁盘写失败");
    }
    this.raw = raw;
  }
}

const clock = () => "2026-10-02T08:00:00.000Z";
const newLedger = (storage: MemStorage) => new HandoverLedger(storage, clock);

/* ============ 规则 1：出库冻结油品/吨数/铅封号 ============ */
console.log("\n规则 1：出库时冻结油品、吨数和铅封号");
{
  const ledger = newLedger(new MemStorage());
  ledger.createOrder("k1", {
    orderId: "D-1",
    station: "城东站",
    compartments: [
      { compartmentNo: "1号舱", product: "92号汽油", tons: 18, sealNo: "SF-1001" },
      { compartmentNo: "2号舱", product: "柴油", tons: 12, sealNo: "SF-1002" },
    ],
  });
  // 冻结前可调整
  ledger.amendCompartments("k2", "D-1", [
    { compartmentNo: "1号舱", product: "92号汽油", tons: 18, sealNo: "SF-1001" },
    { compartmentNo: "2号舱", product: "柴油", tons: 12.5, sealNo: "SF-1002" },
  ]);
  ledger.freezeOutbound("k3", "D-1");
  const order = ledger.getOrder("D-1")!;
  check("冻结后状态为已冻结", order.status === "已冻结");
  check("冻结快照记录铅封号", order.frozenSnapshot![1].sealNo === "SF-1002");
  check("冻结快照记录调整后的吨数", order.frozenSnapshot![1].tons === 12.5);
  expectThrow(
    "冻结后改油品/吨数/铅封号被拒绝",
    () =>
      ledger.amendCompartments("k4", "D-1", [
        { compartmentNo: "1号舱", product: "95号汽油", tons: 18, sealNo: "SF-9999" },
      ]),
    FrozenError,
  );
  // 到站回单以冻结快照为准，油站改不了油品和铅封号
  ledger.openReceipt("k5", "D-1", "R-1", [
    { compartmentNo: "1号舱", receivedTons: 18, sealIntact: true, productMatch: true },
    { compartmentNo: "2号舱", receivedTons: 12.5, sealIntact: true, productMatch: true },
  ]);
  const receipt = ledger.getReceipt("R-1")!;
  check("回单油品来自冻结快照", receipt.lines[0].product === "92号汽油");
  check("回单铅封号来自冻结快照", receipt.lines[1].frozenSealNo === "SF-1002");
}

/* ============ 规则 2：双值班员同时确认只放行一次 ============ */
console.log("\n规则 2：两个值班员同时确认同一回单只放行一次");
{
  const storage = new MemStorage();
  const ledger = newLedger(storage);
  ledger.bumpPricing("p1", { "92号汽油": 8500, 柴油: 7200 });
  ledger.createOrder("k1", {
    orderId: "D-2",
    station: "机场站",
    compartments: [{ compartmentNo: "1号舱", product: "92号汽油", tons: 18, sealNo: "SF-2001" }],
  });
  ledger.freezeOutbound("k2", "D-2");
  ledger.openReceipt("k3", "D-2", "R-2", [
    { compartmentNo: "1号舱", receivedTons: 18, sealIntact: true, productMatch: true },
  ]);
  // 两个值班员各自发起确认（不同幂等键，模拟并发点击）
  const r1 = ledger.confirmReceipt("confirm-甲", "R-2", "值班员甲");
  const r2 = ledger.confirmReceipt("confirm-乙", "R-2", "值班员乙");
  check("第一个值班员放行成功", r1.events.some((e) => e.type === "ReceiptReleased"));
  check("第二个值班员幂等成功、无新事件", r2.ok && r2.deduplicated && r2.events.length === 0);
  const released = ledger.getJournal().filter((e) => e.event.type === "ReceiptReleased");
  check("日志中 ReceiptReleased 只有一条", released.length === 1, released.length);
  check("结算单只生成一张", ledger.listSettlements().length === 1);
  check("待结算吨数只算一次（18 吨）", ledger.totals().pendingTons === 18, ledger.totals());
  // 同一值班员用同一幂等键重试（网络重试场景）
  const r3 = ledger.confirmReceipt("confirm-甲", "R-2", "值班员甲");
  check("同键重试被幂等键拦截", r3.deduplicated);
  check("重试后待结算吨数不变", ledger.totals().pendingTons === 18);
}

/* ============ 规则 3：落盘失败恢复，重试不多算油量 ============ */
console.log("\n规则 3：落盘失败后从完整交接恢复，重试不多算油量");
{
  const storage = new MemStorage();
  const ledger = newLedger(storage);
  ledger.bumpPricing("p1", { "92号汽油": 8500 });
  ledger.createOrder("k1", {
    orderId: "D-3",
    station: "新区站",
    compartments: [{ compartmentNo: "1号舱", product: "92号汽油", tons: 20, sealNo: "SF-3001" }],
  });
  ledger.freezeOutbound("k2", "D-3");
  ledger.openReceipt("k3", "D-3", "R-3", [
    { compartmentNo: "1号舱", receivedTons: 20, sealIntact: true, productMatch: true },
  ]);
  // 第一次确认：落盘失败
  storage.failNext = 1;
  expectThrow(
    "落盘失败抛 PersistError",
    () => ledger.confirmReceipt("confirm-1", "R-3", "值班员甲"),
    PersistError,
  );
  check("落盘失败后内存状态未变（仍未放行）", ledger.getReceipt("R-3")!.status === "待确认");
  check("落盘失败后无结算单", ledger.listSettlements().length === 0);
  // 同一幂等键重试
  const retry = ledger.confirmReceipt("confirm-1", "R-3", "值班员甲");
  check("修复后同键重试成功", retry.ok && !retry.deduplicated);
  check("重试后只放行一次（20 吨）", ledger.totals().pendingTons === 20, ledger.totals());
  // 模拟进程崩溃：新实例从存储重放完整交接日志
  const recovered = newLedger(storage);
  check("崩溃恢复后回单状态一致", recovered.getReceipt("R-3")!.status === "已放行");
  check("崩溃恢复后待结算吨数一致", recovered.totals().pendingTons === 20);
  // 崩溃恢复后客户端再次重试同一命令（幂等键已在日志里）
  const again = recovered.confirmReceipt("confirm-1", "R-3", "值班员甲");
  check("恢复后同键重试被拦截", again.deduplicated);
  check("恢复后重试不多算油量", recovered.totals().pendingTons === 20, recovered.totals());
  // 存储整体丢失：从调用方持有的完整交接日志恢复
  const journalCopy = recovered.getJournal().map((e) => ({ ...e }));
  const revived = newLedger(new MemStorage());
  check("存储丢失后是新账本", revived.totals().pendingTons === 0);
  revived.restoreFromJournal(journalCopy);
  check("从完整交接恢复后状态一致", revived.totals().pendingTons === 20);
  check("恢复后回单仍是已放行", revived.getReceipt("R-3")!.status === "已放行");
}

/* ============ 规则 4：异常 → 未结算部分失效重算，只回原单补原因 ============ */
console.log("\n规则 4：到站异常让未结算部分失效重算，只允许回原单补原因");
{
  const ledger = newLedger(new MemStorage());
  ledger.bumpPricing("p1", { "92号汽油": 8500, 柴油: 7200 });
  ledger.createOrder("k1", {
    orderId: "D-4",
    station: "城东站",
    compartments: [
      { compartmentNo: "1号舱", product: "92号汽油", tons: 20, sealNo: "SF-4001" },
      { compartmentNo: "2号舱", product: "柴油", tons: 10, sealNo: "SF-4002" },
    ],
  });
  ledger.freezeOutbound("k2", "D-4");
  ledger.openReceipt("k3", "D-4", "R-4", [
    { compartmentNo: "1号舱", receivedTons: 20, sealIntact: true, productMatch: true },
    { compartmentNo: "2号舱", receivedTons: 10, sealIntact: true, productMatch: true },
  ]);
  ledger.confirmReceipt("c1", "R-4", "值班员甲");
  const settlement = ledger.listSettlements()[0];
  const line1 = settlement.lines.find((l) => l.compartmentNo === "1号舱")!;
  // 1 号舱先核销（已结算），2 号舱留待结算
  ledger.settleLine("s1", settlement.id, line1.lineId);
  // 到站复核发现 2 号舱铅封不符
  ledger.reportAnomaly("a1", "R-4", "2号舱", "铅封不符", "到站铅封号 SF-4009 与出库 SF-4002 不符");
  let t = ledger.totals();
  check("异常后未结算部分失效（作废 10 吨）", t.voidedTons === 10, t);
  check("异常后待结算清零", t.pendingTons === 0, t);
  check("已结算部分不动（20 吨）", t.settledTons === 20, t);
  // 司机/油站不各改各的：只能回原单补原因
  ledger.appendReason("r1", "R-4", {
    by: "司机",
    reason: "出库时铅封登记笔误，油站复化验油品合格，实收 9.8 吨",
    compartmentNo: "2号舱",
    acceptedTons: 9.8,
  });
  const receipt = ledger.getReceipt("R-4")!;
  check("补记挂在原回单上", receipt.annotations.length === 1 && receipt.id === "R-4");
  t = ledger.totals();
  check("补因后按核定合格量重算（待结算 9.8 吨）", t.pendingTons === 9.8, t);
  check("已结算部分仍不动", t.settledTons === 20, t);
  const recomputed = ledger.pendingSettlementLines().find((l) => l.compartmentNo === "2号舱")!;
  check("重算行带当前计价版本", recomputed.pricingVersion === ledger.pricing.version);
}

/* ============ 规则 5：放行前异常必须先补因，按核定合格量结算 ============ */
console.log("\n规则 5：放行前异常必须先回原单补原因");
{
  const ledger = newLedger(new MemStorage());
  ledger.bumpPricing("p1", { "92号汽油": 8500 });
  ledger.createOrder("k1", {
    orderId: "D-5",
    station: "机场站",
    compartments: [{ compartmentNo: "1号舱", product: "92号汽油", tons: 15, sealNo: "SF-5001" }],
  });
  ledger.freezeOutbound("k2", "D-5");
  ledger.openReceipt("k3", "D-5", "R-5", [
    { compartmentNo: "1号舱", receivedTons: 14.6, sealIntact: false, productMatch: true },
  ]);
  check("核验不符自动转异常待补因", ledger.getReceipt("R-5")!.status === "异常待补因");
  expectThrow(
    "异常未补因不能放行",
    () => ledger.confirmReceipt("c1", "R-5", "值班员甲"),
    StateError,
  );
  ledger.appendReason("r1", "R-5", {
    by: "油站",
    reason: "铅封运输途中破损，视频复核无异常，实收 14.6 吨",
    compartmentNo: "1号舱",
    acceptedTons: 14.6,
  });
  check("补因后回到待确认", ledger.getReceipt("R-5")!.status === "待确认");
  ledger.confirmReceipt("c2", "R-5", "值班员乙");
  check("按核定合格量结算（14.6 吨）", ledger.totals().pendingTons === 14.6, ledger.totals());
}

/* ============ 规则 6：计价版本变化后，待结算记录重新核对单价 ============ */
console.log("\n规则 6：计价版本变化后，待结算记录重新核对单价");
{
  const ledger = newLedger(new MemStorage());
  ledger.bumpPricing("p1", { "92号汽油": 8500, 柴油: 7200 });
  ledger.createOrder("k1", {
    orderId: "D-6",
    station: "新区站",
    compartments: [
      { compartmentNo: "1号舱", product: "92号汽油", tons: 10, sealNo: "SF-6001" },
      { compartmentNo: "2号舱", product: "柴油", tons: 8, sealNo: "SF-6002" },
    ],
  });
  ledger.freezeOutbound("k2", "D-6");
  ledger.openReceipt("k3", "D-6", "R-6", [
    { compartmentNo: "1号舱", receivedTons: 10, sealIntact: true, productMatch: true },
    { compartmentNo: "2号舱", receivedTons: 8, sealIntact: true, productMatch: true },
  ]);
  ledger.confirmReceipt("c1", "R-6", "值班员甲");
  const settlement = ledger.listSettlements()[0];
  const petrol = settlement.lines.find((l) => l.product === "92号汽油")!;
  const diesel = settlement.lines.find((l) => l.product === "柴油")!;
  check("放行时按 v1 计价", petrol.unitPrice === 8500 && petrol.pricingVersion === 1);
  // 汽油行核销（已结算），柴油行留待结算
  ledger.settleLine("s1", settlement.id, petrol.lineId);
  // 计价版本升级
  ledger.bumpPricing("p2", { "92号汽油": 8600, 柴油: 7300 });
  const after = ledger.listSettlements()[0];
  const petrolAfter = after.lines.find((l) => l.lineId === petrol.lineId)!;
  const dieselAfter = after.lines.find((l) => l.lineId === diesel.lineId)!;
  check("待结算行重新核价（柴油 7300）", dieselAfter.unitPrice === 7300);
  check("待结算行计价版本升到 v2", dieselAfter.pricingVersion === 2);
  check("待结算金额重算（8×7300）", dieselAfter.amount === 58400, dieselAfter.amount);
  check("已结算行单价不动（仍 8500）", petrolAfter.unitPrice === 8500);
  check("已结算行版本不动（仍 v1）", petrolAfter.pricingVersion === 1);
  // 同键重试调价不会重复升版
  const dup = ledger.bumpPricing("p2", { "92号汽油": 8600, 柴油: 7300 });
  check("调价同键重试被拦截", dup.deduplicated && ledger.pricing.version === 2);
  // 崩溃恢复后核价结果仍在
  const storage2 = new MemStorage();
  const l2 = newLedger(storage2);
  l2.restoreFromJournal(ledger.getJournal().map((e) => ({ ...e })));
  const dieselRecovered = l2.listSettlements()[0].lines.find((l) => l.lineId === diesel.lineId)!;
  check("恢复后重核价结果保留", dieselRecovered.unitPrice === 7300);
}

/* ============ 汇总 ============ */
console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);
console.log("交接台六条规则全部验证通过。");

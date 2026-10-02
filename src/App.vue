<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { HandoverLedger, StorageAdapter } from "./handover/ledger.js";
import { FrozenError, PersistError, StateError } from "./handover/types.js";
import type { AnomalyKind, ArrivalReceipt, DeliveryOrder, Envelope } from "./handover/types.js";

/** 浏览器存储适配器：可注入一次落盘故障，演示"失败可恢复、重试不多算"。 */
class LocalStorageAdapter implements StorageAdapter {
  failNextSave = false;
  constructor(private key: string) {}
  load() {
    return localStorage.getItem(this.key);
  }
  save(raw: string) {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error("模拟磁盘写失败");
    }
    localStorage.setItem(this.key, raw);
  }
}

const STORAGE_KEY = "hxwlfront-19-handover";
const adapter = new LocalStorageAdapter(STORAGE_KEY);
const ledger = new HandoverLedger(adapter);

// 首次使用播种演示数据（幂等键固定，刷新不会重复入账）
if (ledger.getJournal().length === 0) {
  ledger.bumpPricing("seed-pricing", { "92号汽油": 8500, "95号汽油": 8900, 柴油: 7200 });
  ledger.createOrder("seed-order-1", {
    orderId: "D-1001",
    station: "城东站",
    compartments: [
      { compartmentNo: "1号舱", product: "92号汽油", tons: 18, sealNo: "SF-8801" },
      { compartmentNo: "2号舱", product: "柴油", tons: 12, sealNo: "SF-8802" },
    ],
  });
  ledger.freezeOutbound("seed-freeze-1", "D-1001");
  ledger.createOrder("seed-order-2", {
    orderId: "D-1002",
    station: "机场站",
    compartments: [{ compartmentNo: "1号舱", product: "95号汽油", tons: 16, sealNo: "SF-8803" }],
  });
  ledger.freezeOutbound("seed-freeze-2", "D-1002");
  ledger.openReceipt("seed-receipt-2", "D-1002", "R-1002", [
    { compartmentNo: "1号舱", receivedTons: 16, sealIntact: true, productMatch: true },
  ]);
  ledger.createOrder("seed-order-3", {
    orderId: "D-1003",
    station: "新区站",
    compartments: [{ compartmentNo: "1号舱", product: "92号汽油", tons: 20, sealNo: "SF-8804" }],
  });
  ledger.freezeOutbound("seed-freeze-3", "D-1003");
  ledger.openReceipt("seed-receipt-3", "D-1003", "R-1003", [
    { compartmentNo: "1号舱", receivedTons: 19.4, sealIntact: false, productMatch: true },
  ]);
}

const PRODUCTS = ["92号汽油", "95号汽油", "柴油"] as const;
const STATIONS = ["城东站", "机场站", "新区站"] as const;
const ANOMALIES: AnomalyKind[] = ["铅封不符", "油品不符", "数量短缺"];
const OFFICERS = ["值班员甲", "值班员乙"] as const;

const rev = ref(0); // 账本版本号：每条命令后 +1，驱动视图重算
const error = ref("");
const notice = ref("");

function showResult(result: { deduplicated: boolean }, okText: string) {
  notice.value = result.deduplicated ? "操作已去重：同一交接只入账一次" : okText;
}

function run(fn: () => { deduplicated: boolean } | void, okText: string) {
  error.value = "";
  notice.value = "";
  try {
    const result = fn();
    if (result) showResult(result, okText);
    else notice.value = okText;
  } catch (err) {
    if (err instanceof PersistError) error.value = `落盘失败：${err.message}`;
    else if (err instanceof FrozenError) error.value = `已冻结：${err.message}`;
    else if (err instanceof StateError) error.value = `状态不允许：${err.message}`;
    else error.value = String(err);
  } finally {
    ensureForms();
    rev.value++;
  }
}

/* ---------------- 创建配送单 ---------------- */

let orderSeq = 1004;
const orderForm = reactive({
  orderId: `D-${orderSeq}`,
  station: STATIONS[0] as string,
});
const compForm = ref([{ compartmentNo: "1号舱", product: PRODUCTS[0] as string, tons: 18, sealNo: nextSeal() }]);

function nextSeal() {
  return `SF-${Math.floor(1000 + Math.random() * 9000)}`;
}

function addComp() {
  compForm.value.push({
    compartmentNo: `${compForm.value.length + 1}号舱`,
    product: PRODUCTS[0],
    tons: 20,
    sealNo: nextSeal(),
  });
}

function removeComp(index: number) {
  compForm.value.splice(index, 1);
}

function submitOrder() {
  run(() => {
    ledger.createOrder(`order-${orderForm.orderId}`, {
      orderId: orderForm.orderId,
      station: orderForm.station,
      compartments: compForm.value.map((c) => ({
        compartmentNo: c.compartmentNo,
        product: c.product,
        tons: Number(c.tons),
        sealNo: c.sealNo,
      })),
    });
    orderSeq++;
    orderForm.orderId = `D-${orderSeq}`;
    compForm.value = [{ compartmentNo: "1号舱", product: PRODUCTS[0], tons: 18, sealNo: nextSeal() }];
    return undefined;
  }, `配送单已创建`);
}

/* ---------------- 出库冻结 / 到站登记 ---------------- */

function freeze(order: DeliveryOrder) {
  run(() => ledger.freezeOutbound(`freeze-${order.id}`, order.id), `配送单 ${order.id} 已出库冻结`);
}

/** 演示：冻结后试图改油品/铅封号，会被账本拒绝 */
function tryAmendFrozen(order: DeliveryOrder) {
  run(() => {
    ledger.amendCompartments(`amend-${order.id}-${Date.now()}`, order.id, [
      { compartmentNo: "1号舱", product: "95号汽油", tons: 1, sealNo: "SF-0000" },
    ]);
    return undefined;
  }, "");
}

interface ArrivalRow {
  receivedTons: number;
  sealIntact: boolean;
  productMatch: boolean;
}
const arrivalForms = reactive<Record<string, Record<string, ArrivalRow>>>({});

function ensureForms() {
  for (const order of ledger.listOrders()) {
    if (order.status === "已冻结" && order.frozenSnapshot && !arrivalForms[order.id]) {
      arrivalForms[order.id] = Object.fromEntries(
        order.frozenSnapshot.map((c) => [
          c.compartmentNo,
          { receivedTons: c.tons, sealIntact: true, productMatch: true },
        ]),
      );
    }
  }
  for (const receipt of ledger.listReceipts()) {
    if (!reasonForms[receipt.id]) {
      reasonForms[receipt.id] = { by: "油站", reason: "", compartmentNo: "", acceptedTons: 0 };
    }
    if (!anomalyForms[receipt.id]) {
      anomalyForms[receipt.id] = {
        compartmentNo: receipt.lines[0]?.compartmentNo ?? "",
        kind: ANOMALIES[0],
        detail: "",
      };
    }
  }
}

function openReceipt(order: DeliveryOrder) {
  const rows = arrivalForms[order.id];
  run(
    () =>
      ledger.openReceipt(`receipt-${order.id}`, order.id, `R-${order.id.slice(2)}`, Object.entries(rows).map(([compartmentNo, r]) => ({
        compartmentNo,
        receivedTons: Number(r.receivedTons),
        sealIntact: r.sealIntact,
        productMatch: r.productMatch,
      }))),
    `到站回单已生成（以冻结快照为准）`,
  );
}

/* ---------------- 回单：补原因 / 报异常 / 双值班员确认 ---------------- */

const reasonForms = reactive<Record<string, { by: string; reason: string; compartmentNo: string; acceptedTons: number }>>({});
const anomalyForms = reactive<Record<string, { compartmentNo: string; kind: AnomalyKind; detail: string }>>({});

function appendReason(receipt: ArrivalReceipt) {
  const form = reasonForms[receipt.id];
  if (!form.reason.trim()) {
    error.value = "请填写原因说明";
    return;
  }
  const seq = receipt.annotations.length + 1;
  run(
    () =>
      ledger.appendReason(`reason-${receipt.id}-${seq}`, receipt.id, {
        by: form.by,
        reason: form.reason,
        compartmentNo: form.compartmentNo || undefined,
        acceptedTons: form.compartmentNo ? Number(form.acceptedTons) : undefined,
      }),
    "原因已补记到原回单（只追加，不改单）",
  );
  form.reason = "";
}

function reportAnomaly(receipt: ArrivalReceipt) {
  const form = anomalyForms[receipt.id];
  if (!form.detail.trim()) {
    error.value = "请填写异常说明";
    return;
  }
  run(
    () =>
      ledger.reportAnomaly(
        `anomaly-${receipt.id}-${form.compartmentNo}`,
        receipt.id,
        form.compartmentNo,
        form.kind,
        form.detail,
      ),
    "异常已登记：未结算部分已失效，待补原因后重算",
  );
  form.detail = "";
}

function confirm(receipt: ArrivalReceipt, officer: string) {
  run(
    () => ledger.confirmReceipt(`confirm-${receipt.id}-${officer}`, receipt.id, officer),
    `回单 ${receipt.id} 已放行，结算单已生成`,
  );
}

/* ---------------- 结算 / 计价 ---------------- */

function settle(settlementId: string, lineId: string) {
  run(() => ledger.settleLine(`settle-${lineId}`, settlementId, lineId), "该舱位已核销结算");
}

const priceForm = reactive<Record<string, number>>({ ...ledger.pricing.prices });

function bumpPricing() {
  const nextVersion = ledger.pricing.version + 1;
  const pending = ledger.pendingSettlementLines().length;
  const prices = Object.fromEntries(
    Object.entries(priceForm).map(([k, v]) => [k, Number(v)]),
  );
  run(
    () => ledger.bumpPricing(`pricing-v${nextVersion}`, prices),
    `计价版本 v${nextVersion} 已发布，${pending} 条待结算记录重新核价`,
  );
}

/* ---------------- 可靠性演示 ---------------- */

const failNext = ref(false);

function toggleFail() {
  adapter.failNextSave = failNext.value;
}

/** 演示：清空本地存储（模拟存储丢失），从持有的完整交接日志恢复 */
function simulateCrashRecovery() {
  const journalCopy = ledger.getJournal().map((e) => ({ ...e }));
  localStorage.removeItem(STORAGE_KEY);
  ledger.recover(); // 读到空存储：账本归零
  const lost = ledger.listOrders().length === 0;
  ledger.restoreFromJournal(journalCopy);
  run(
    () => undefined,
    lost
      ? `存储已清空，从完整交接日志恢复 ${journalCopy.length} 条事件，油量分毫不差`
      : "恢复完成",
  );
}

/* ---------------- 视图 ---------------- */

const orders = computed(() => (rev.value, ledger.listOrders()));
const receipts = computed(() => (rev.value, ledger.listReceipts()));
const totals = computed(() => (rev.value, ledger.totals()));
const pricing = computed(() => (rev.value, ledger.pricing));
const settlementRows = computed(() => {
  rev.value;
  return ledger.listSettlements().flatMap((s) =>
    s.lines.map((l) => ({ ...l, settlementId: s.id, receiptId: s.receiptId })),
  );
});
const journalView = computed(() => (rev.value, [...ledger.getJournal()].reverse().slice(0, 40)));

const metrics = computed(() => [
  { label: "配送单", value: orders.value.length },
  { label: "待结算吨数", value: totals.value.pendingTons },
  { label: "待结算金额(元)", value: totals.value.pendingAmount.toLocaleString() },
  { label: "计价版本", value: `v${pricing.value.version}` },
]);

function receiptOf(orderId: string) {
  return receipts.value.find((r) => r.orderId === orderId);
}

function statusClass(status: string) {
  if (status.includes("异常")) return "status bad";
  if (status === "已放行" || status === "已结算") return "status ok";
  if (status === "已作废") return "status void";
  return "status";
}

function summarize(env: Envelope): string {
  const e = env.event;
  switch (e.type) {
    case "OrderCreated":
      return `创建配送单 ${e.order.id}（${e.order.station}，${e.order.compartments.length} 舱）`;
    case "CompartmentAmended":
      return `调整配送单 ${e.orderId} 舱位计划`;
    case "OutboundFrozen":
      return `配送单 ${e.orderId} 出库冻结 ${e.snapshot.length} 个舱位（油品/吨数/铅封号定格）`;
    case "ReceiptOpened":
      return `生成到站回单 ${e.receipt.id}（${e.receipt.status}）`;
    case "AnomalyReported":
      return `回单 ${e.receiptId} ${e.compartmentNo} 报告异常：${e.kind}`;
    case "ReasonAppended":
      return `回单 ${e.receiptId} 补记原因（${e.annotation.by}）`;
    case "ReceiptReleased":
      return `回单 ${e.receiptId} 由 ${e.officer} 确认放行，生成结算单 ${e.settlement.id}`;
    case "SettlementLinesVoided":
      return `结算单 ${e.settlementId} ${e.lineIds.length} 行未结算部分失效`;
    case "SettlementLineRecomputed":
      return `结算单 ${e.settlementId} 按核定合格量重算 ${e.line.compartmentNo}（${e.line.tons} 吨）`;
    case "SettlementLineSettled":
      return `结算行 ${e.lineId} 核销`;
    case "SettlementLineRepriced":
      return `结算行 ${e.lineId} 按 v${e.pricingVersion} 重新核价（${e.unitPrice} 元/吨）`;
    case "PricingBumped":
      return `计价版本升级到 v${e.version}`;
  }
}

ensureForms();
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">石油行业 · 交接台</p>
          <h1>油品交接台</h1>
          <p class="subtitle">
            配送单、罐车舱位、出库铅封、到站回单一本账：出库冻结油品/吨数/铅封号；
            到站异常让未结算部分失效重算，只允许回原单补原因；双人同时确认只放行一次；
            落盘失败从完整交接恢复，重试不多算油量；计价版本变化后待结算重新核价。
          </p>
        </div>
      </header>

      <p v-if="error" class="banner bad">{{ error }}</p>
      <p v-if="notice" class="banner ok">{{ notice }}</p>

      <section class="metrics four">
        <article v-for="m in metrics" :key="m.label" class="metric">
          <span>{{ m.label }}</span>
          <strong>{{ m.value }}</strong>
        </article>
      </section>

      <section class="workspace">
        <div class="side">
          <form class="panel" @submit.prevent="submitOrder">
            <h2>创建配送单</h2>
            <div class="form-grid">
              <label>
                配送单号
                <input v-model="orderForm.orderId" required />
              </label>
              <label>
                目标油站
                <select v-model="orderForm.station">
                  <option v-for="s in STATIONS" :key="s">{{ s }}</option>
                </select>
              </label>
              <div class="comp-list">
                <div v-for="(c, i) in compForm" :key="i" class="comp-row">
                  <input v-model="c.compartmentNo" placeholder="舱号" required />
                  <select v-model="c.product">
                    <option v-for="p in PRODUCTS" :key="p">{{ p }}</option>
                  </select>
                  <input v-model="c.tons" type="number" step="0.1" min="0.1" placeholder="吨数" required />
                  <input v-model="c.sealNo" placeholder="铅封号" required />
                  <button v-if="compForm.length > 1" type="button" class="danger small" @click="removeComp(i)">删</button>
                </div>
              </div>
              <button type="button" class="secondary" @click="addComp">+ 加舱位</button>
              <button type="submit">保存配送单</button>
            </div>
          </form>

          <section class="panel">
            <h2>价格本（当前 v{{ pricing.version }}）</h2>
            <div class="form-grid">
              <label v-for="p in PRODUCTS" :key="p">
                {{ p }}（元/吨）
                <input v-model="priceForm[p]" type="number" step="1" min="0" />
              </label>
              <button type="button" @click="bumpPricing">发布新计价版本</button>
              <p class="hint">发布后只有"待结算"记录重新核价，已结算/已作废不动。</p>
            </div>
          </section>

          <section class="panel">
            <h2>可靠性演示</h2>
            <div class="form-grid">
              <label class="check">
                <input v-model="failNext" type="checkbox" @change="toggleFail" />
                让下一次落盘失败（再点任意操作试试，状态不变，重试不多算）
              </label>
              <button type="button" class="secondary" @click="simulateCrashRecovery">
                模拟存储丢失 → 从完整交接恢复
              </button>
            </div>
          </section>
        </div>

        <div class="main-col">
          <section class="list-panel">
            <div class="toolbar"><h2>配送单</h2></div>
            <div class="record-grid">
              <article v-for="order in orders" :key="order.id" class="record">
                <div class="record-head">
                  <p class="record-title">{{ order.id }} · {{ order.station }}</p>
                  <span :class="statusClass(order.status)">{{ order.status }}</span>
                </div>
                <table class="lines">
                  <thead>
                    <tr><th>舱位</th><th>油品</th><th>吨数</th><th>铅封号</th></tr>
                  </thead>
                  <tbody>
                    <tr v-for="c in (order.frozenSnapshot ?? order.compartments)" :key="c.compartmentNo">
                      <td>{{ c.compartmentNo }}</td>
                      <td>{{ c.product }}</td>
                      <td>{{ c.tons }}</td>
                      <td>
                        {{ c.sealNo }}
                        <span v-if="order.frozenSnapshot" class="lock">已冻结</span>
                      </td>
                    </tr>
                  </tbody>
                </table>
                <div class="actions">
                  <button v-if="order.status === '待发运'" type="button" @click="freeze(order)">出库冻结</button>
                  <button v-if="order.frozenSnapshot" type="button" class="secondary" @click="tryAmendFrozen(order)">
                    试着改油品/铅封（会被拒）
                  </button>
                </div>

                <div v-if="order.status === '已冻结' && arrivalForms[order.id]" class="arrival">
                  <h3>到站登记（按冻结快照核对）</h3>
                  <div v-for="c in order.frozenSnapshot ?? []" :key="c.compartmentNo" class="arrival-row">
                    <span>{{ c.compartmentNo }} · {{ c.product }} · 冻结 {{ c.tons }} 吨 · {{ c.sealNo }}</span>
                    <label>实收吨数
                      <input v-model="arrivalForms[order.id][c.compartmentNo].receivedTons" type="number" step="0.1" min="0" />
                    </label>
                    <label class="check">
                      <input v-model="arrivalForms[order.id][c.compartmentNo].sealIntact" type="checkbox" /> 铅封完好
                    </label>
                    <label class="check">
                      <input v-model="arrivalForms[order.id][c.compartmentNo].productMatch" type="checkbox" /> 油品一致
                    </label>
                  </div>
                  <button type="button" @click="openReceipt(order)">生成到站回单</button>
                </div>
              </article>
            </div>
          </section>

          <section class="list-panel">
            <div class="toolbar"><h2>到站回单</h2></div>
            <div class="record-grid">
              <div v-if="receipts.length === 0" class="empty">暂无回单</div>
              <article v-for="receipt in receipts" :key="receipt.id" class="record">
                <div class="record-head">
                  <p class="record-title">{{ receipt.id }} · 配送单 {{ receipt.orderId }}</p>
                  <span :class="statusClass(receipt.status)">{{ receipt.status }}</span>
                </div>
                <table class="lines">
                  <thead>
                    <tr><th>舱位</th><th>油品</th><th>冻结吨数</th><th>实收</th><th>铅封</th><th>异常</th><th>合格量</th></tr>
                  </thead>
                  <tbody>
                    <tr v-for="l in receipt.lines" :key="l.compartmentNo" :class="{ 'row-bad': l.anomaly }">
                      <td>{{ l.compartmentNo }}</td>
                      <td>{{ l.product }}</td>
                      <td>{{ l.frozenTons }}</td>
                      <td>{{ l.receivedTons }}</td>
                      <td>{{ l.sealIntact ? "完好" : "破损" }}</td>
                      <td>{{ l.anomaly ?? "—" }}</td>
                      <td>{{ l.acceptedTons ?? "—" }}</td>
                    </tr>
                  </tbody>
                </table>

                <div v-if="receipt.annotations.length" class="annotations">
                  <p v-for="(a, i) in receipt.annotations" :key="i" class="note">
                    [补记 {{ i + 1 }} · {{ a.by }}<template v-if="a.compartmentNo"> · {{ a.compartmentNo }}</template>]
                    {{ a.reason }}
                    <template v-if="a.acceptedTons != null">（核定合格量 {{ a.acceptedTons }} 吨）</template>
                  </p>
                </div>

                <div class="actions">
                  <template v-if="receipt.status !== '已放行'">
                    <button v-for="o in OFFICERS" :key="o" type="button" @click="confirm(receipt, o)">
                      {{ o }}确认放行
                    </button>
                  </template>
                  <span v-else class="released">已放行（{{ receipt.confirmedBy.join("、") }}），重复确认自动合并</span>
                </div>

                <details class="extra">
                  <summary>回原单补原因</summary>
                  <div class="inline-form">
                    <select v-model="reasonForms[receipt.id].by">
                      <option>油站</option><option>司机</option><option>值班员</option>
                    </select>
                    <select v-model="reasonForms[receipt.id].compartmentNo">
                      <option value="">整单</option>
                      <option v-for="l in receipt.lines" :key="l.compartmentNo">{{ l.compartmentNo }}</option>
                    </select>
                    <input v-model="reasonForms[receipt.id].acceptedTons" type="number" step="0.1" min="0" placeholder="核定合格量(吨)" />
                    <input v-model="reasonForms[receipt.id].reason" placeholder="原因说明" />
                    <button type="button" class="secondary" @click="appendReason(receipt)">补记到原单</button>
                  </div>
                </details>

                <details v-if="receipt.status === '已放行'" class="extra">
                  <summary>放行后发现异常？未结算部分失效重算</summary>
                  <div class="inline-form">
                    <select v-model="anomalyForms[receipt.id].compartmentNo">
                      <option v-for="l in receipt.lines" :key="l.compartmentNo">{{ l.compartmentNo }}</option>
                    </select>
                    <select v-model="anomalyForms[receipt.id].kind">
                      <option v-for="k in ANOMALIES" :key="k">{{ k }}</option>
                    </select>
                    <input v-model="anomalyForms[receipt.id].detail" placeholder="异常说明" />
                    <button type="button" class="danger" @click="reportAnomaly(receipt)">报告异常</button>
                  </div>
                </details>
              </article>
            </div>
          </section>

          <section class="list-panel">
            <div class="toolbar">
              <h2>结算台</h2>
              <span class="hint">
                待结算 {{ totals.pendingTons }} 吨 / {{ totals.pendingAmount.toLocaleString() }} 元 ·
                已结算 {{ totals.settledTons }} 吨 · 已作废 {{ totals.voidedTons }} 吨
              </span>
            </div>
            <table class="lines">
              <thead>
                <tr><th>结算单</th><th>舱位</th><th>油品</th><th>吨数</th><th>单价</th><th>版本</th><th>金额</th><th>状态</th><th></th></tr>
              </thead>
              <tbody>
                <tr v-for="row in settlementRows" :key="row.lineId" :class="{ 'row-void': row.status === '已作废' }">
                  <td>{{ row.settlementId }}</td>
                  <td>{{ row.compartmentNo }}</td>
                  <td>{{ row.product }}</td>
                  <td>{{ row.tons }}</td>
                  <td>{{ row.unitPrice }}</td>
                  <td>v{{ row.pricingVersion }}</td>
                  <td>{{ row.amount.toLocaleString() }}</td>
                  <td><span :class="statusClass(row.status)">{{ row.status }}</span></td>
                  <td>
                    <button v-if="row.status === '待结算'" type="button" class="small" @click="settle(row.settlementId, row.lineId)">
                      核销
                    </button>
                  </td>
                </tr>
                <tr v-if="settlementRows.length === 0">
                  <td colspan="9" class="empty">回单放行后生成结算行</td>
                </tr>
              </tbody>
            </table>
          </section>

          <section class="list-panel">
            <div class="toolbar"><h2>交接流水（事件日志，恢复依据）</h2></div>
            <ol class="event-log">
              <li v-for="env in journalView" :key="env.eventId">
                <code>#{{ env.seq }} {{ env.event.type }}</code>
                <span>{{ summarize(env) }}</span>
                <em>{{ env.eventId }}</em>
              </li>
            </ol>
          </section>
        </div>
      </section>
    </div>
  </main>
</template>

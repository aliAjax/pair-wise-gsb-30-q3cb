<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { useHandoverStore } from "../stores/handover";
import { FUELS, OPERATORS } from "../domain/types";
import type { FuelType, Handover } from "../domain/types";

const props = defineProps<{ handover: Handover }>();
const store = useHandoverStore();

const h = computed(() => props.handover);

const statusType: Record<string, "" | "success" | "warning" | "danger" | "info" | "primary"> = {
  待出库: "info",
  在途: "primary",
  到站正常: "success",
  到站异常: "danger",
  已放行: "warning",
};

const lineStatusTag: Record<string, "" | "success" | "danger" | "info"> = {
  待结算: "",
  已失效: "danger",
  已结算: "success",
};

const outstandingAmount = computed(() =>
  h.value.lines.filter((l) => l.status === "待结算").reduce((s, l) => s + l.amount, 0),
);
const settledAmount = computed(() =>
  h.value.lines.filter((l) => l.status === "已结算").reduce((s, l) => s + l.amount, 0),
);
const settledTons = computed(() => h.value.lines.filter((l) => l.status === "已结算").reduce((s, l) => s + l.tons, 0));

// ---------------- 出库冻结弹窗 ----------------
const freezeVisible = ref(false);
const freezeOperator = ref<string>(OPERATORS[0]);
const freezeForm = reactive<Array<{ loadedTons: number; sealNo: string }>>([]);

function openFreeze() {
  freezeForm.splice(
    0,
    freezeForm.length,
    ...h.value.compartments.map((c) => ({ loadedTons: c.plannedTons, sealNo: "" })),
  );
  freezeVisible.value = true;
}

function submitFreeze() {
  store.freezeOutbound(
    h.value.id,
    freezeOperator.value,
    h.value.compartments.map((c, i) => ({ index: c.index, ...freezeForm[i] })),
  );
  freezeVisible.value = false;
}

// ---------------- 到站登记弹窗 ----------------
const arriveVisible = ref(false);
const arriveForm = reactive<Array<{ receivedTons: number; arrivalSealNo: string; arrivalFuel: FuelType }>>([]);

function openArrive() {
  arriveForm.splice(
    0,
    arriveForm.length,
    ...h.value.compartments.map((c) => ({
      receivedTons: c.loadedTons ?? 0,
      arrivalSealNo: c.sealNo ?? "",
      arrivalFuel: c.fuel,
    })),
  );
  arriveVisible.value = true;
}

/** 演示用：一键构造到站异常读数 */
function fakeException(kind: "铅封不符" | "油品不符" | "数量短少") {
  for (const c of h.value.compartments) {
    const f = arriveForm[c.index];
    if (kind === "铅封不符") f.arrivalSealNo = `BROKEN-${c.sealNo?.slice(-4) ?? "XXXX"}`;
    if (kind === "油品不符") {
      f.arrivalFuel = FUELS.find((x) => x !== c.fuel) ?? "柴油";
    }
    if (kind === "数量短少") f.receivedTons = Math.max(0, (c.loadedTons ?? 0) - 1.5);
  }
}

function submitArrive() {
  store.recordArrival(
    h.value.id,
    h.value.compartments.map((c, i) => ({ index: c.index, ...arriveForm[i] })),
  );
  arriveVisible.value = false;
}

// ---------------- 回原单补原因 ----------------
const reasonVisible = ref(false);
const reasonOperator = ref<string>(OPERATORS[0]);
const reasonText = ref("");

function openReason() {
  reasonText.value = "";
  reasonVisible.value = true;
}

function submitReason() {
  store.supplementReason(h.value.id, reasonOperator.value, reasonText.value);
  reasonVisible.value = false;
}

function doConfirm(operator: string) {
  store.confirm(h.value.id, operator);
}

function doSettle() {
  store.settle(h.value.id);
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}

function mark(v: boolean | null): string {
  if (v === null) return "";
  return v ? "✓ 一致" : "✗ 不符";
}
</script>

<template>
  <article class="record handover-card" :class="{ 'is-error': h.status === '到站异常' }">
    <div class="record-head">
      <div>
        <p class="record-title">{{ h.id }} · {{ h.station }} · {{ h.truckNo }}</p>
        <p class="sub-line">计划到达 {{ h.plannedAt }} ｜ 舱位 {{ h.compartments.length }} 个</p>
      </div>
      <el-tag :type="statusType[h.status]" size="large" effect="dark">{{ h.status }}</el-tag>
    </div>

    <!-- 舱位核对表 -->
    <div class="table-wrap">
      <table class="grid-table">
        <thead>
          <tr>
            <th>舱</th>
            <th>配送单油品</th>
            <th>计划吨</th>
            <th>冻结实装吨</th>
            <th>冻结铅封号</th>
            <th>到站铅封</th>
            <th>到站油品</th>
            <th>实收吨</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in h.compartments" :key="c.index">
            <td>{{ c.index + 1 }}</td>
            <td>{{ c.fuel }}</td>
            <td>{{ c.plannedTons }}</td>
            <td :class="{ frozen: c.loadedTons != null }">{{ c.loadedTons ?? "—" }}</td>
            <td :class="{ frozen: c.sealNo != null }">{{ c.sealNo ?? "—" }}</td>
            <td :class="{ bad: c.sealMatch === false, ok: c.sealMatch === true }">
              {{ c.arrivalSealNo ?? "—" }}
              <small v-if="c.sealMatch !== null">{{ mark(c.sealMatch) }}</small>
            </td>
            <td :class="{ bad: c.fuelMatch === false, ok: c.fuelMatch === true }">
              {{ c.arrivalFuel ?? "—" }}
              <small v-if="c.fuelMatch !== null">{{ mark(c.fuelMatch) }}</small>
            </td>
            <td :class="{ bad: c.tonsMatch === false, ok: c.tonsMatch === true }">
              {{ c.receivedTons ?? "—" }}
              <small v-if="c.tonsMatch !== null">{{ mark(c.tonsMatch) }}</small>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 出库冻结凭证 -->
    <div v-if="h.frozen" class="manifest">
      <strong>出库冻结凭证</strong>
      <span>操作员 {{ h.frozen.operator }}</span>
      <span>{{ fmtTime(h.frozen.at) }}</span>
      <span>合计 {{ h.frozen.totalTons }} 吨</span>
      <el-tag size="small" type="info">计价 v{{ h.frozen.priceVersion }}</el-tag>
    </div>

    <!-- 异常与补原因 -->
    <div v-if="h.exception" class="exception-box">
      <div class="exc-head">
        <el-tag type="danger" size="small" v-for="t in h.exception.types" :key="t" class="exc-tag">{{ t }}</el-tag>
        <span class="void-note">未结算 {{ h.exception.voidedLineIds.length }} 行已失效（旧回单不再用于结算）</span>
      </div>
      <p v-if="h.exception.recordedAt" class="reason-line">
        回原单补因（{{ h.exception.recordedBy }}，{{ fmtTime(h.exception.recordedAt) }}）：{{ h.exception.reason }}
      </p>
      <p v-else class="reason-line pending">异常原因待补录：仅可回到本单 {{ h.id }} 补原因后重算，不允许另开新单。</p>
    </div>

    <!-- 结算行 -->
    <div class="table-wrap">
      <table class="grid-table lines">
        <thead>
          <tr>
            <th>结算行</th>
            <th>舱</th>
            <th>油品</th>
            <th>吨数</th>
            <th>单价(v版本)</th>
            <th>金额(元)</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="l in h.lines" :key="l.id" :class="{ voided: l.status === '已失效', settled: l.status === '已结算' }">
            <td class="mono">{{ l.id.slice(-6) }}</td>
            <td>{{ l.compartmentIndex + 1 }}</td>
            <td>{{ l.fuel }}</td>
            <td>{{ l.tons }}</td>
            <td>{{ l.unitPrice }} <small>(v{{ l.priceVersion }})</small></td>
            <td>{{ l.amount.toLocaleString() }}</td>
            <td><el-tag :type="lineStatusTag[l.status]" size="small">{{ l.status }}</el-tag></td>
          </tr>
          <tr v-if="h.lines.length === 0">
            <td colspan="7" class="empty-cell">出库冻结后生成待结算行</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 双人确认 -->
    <div class="confirm-row">
      <div class="operators">
        <el-tag
          v-for="op in OPERATORS"
          :key="op"
          :type="h.confirmations.some((c) => c.operator === op) ? 'success' : 'info'"
          class="op-tag"
        >
          {{ op }}{{ h.confirmations.some((c) => c.operator === op) ? " ✓" : "" }}
        </el-tag>
      </div>
      <div class="release">
        <template v-if="h.releasedAt">
          <el-tag type="warning" effect="dark">已放行 · {{ fmtTime(h.releasedAt) }}（整单仅一次）</el-tag>
        </template>
        <template v-else>
          <span>已确认 {{ h.confirmations.length }}/2，两名不同值班员齐签自动放行</span>
        </template>
      </div>
    </div>

    <div class="sum-line">
      <span>待结算金额：<strong>¥{{ outstandingAmount.toLocaleString() }}</strong></span>
      <span v-if="settledTons > 0">已结算：{{ settledTons }} 吨 / ¥{{ settledAmount.toLocaleString() }}</span>
    </div>

    <!-- 按状态出操作 -->
    <div class="actions">
      <template v-if="h.status === '待出库'">
        <el-button type="primary" @click="openFreeze">出库冻结（锁油品/吨数/铅封）</el-button>
      </template>
      <template v-else-if="h.status === '在途'">
        <el-button type="primary" @click="openArrive">到站登记回单</el-button>
      </template>
      <template v-else-if="h.status === '到站异常'">
        <el-button type="danger" @click="openReason">回原单补原因并重算</el-button>
      </template>
      <template v-else-if="h.status === '到站正常'">
        <el-button
          v-for="op in OPERATORS"
          :key="op"
          :type="h.confirmations.some((c) => c.operator === op) ? 'success' : 'primary'"
          plain
          :disabled="h.confirmations.some((c) => c.operator === op)"
          @click="doConfirm(op)"
        >
          {{ h.confirmations.some((c) => c.operator === op) ? `${op} 已确认` : `${op} 确认放行` }}
        </el-button>
      </template>
      <template v-else-if="h.status === '已放行'">
        <el-button type="success" @click="doSettle">按当前有效行结算</el-button>
      </template>
    </div>

    <!-- 出库冻结弹窗 -->
    <el-dialog v-model="freezeVisible" title="出库冻结：锁定油品 / 实装吨数 / 铅封号" width="560px">
      <el-alert type="info" :closable="false" show-icon class="dlg-alert">
        <template #default>冻结后任何人（含司机）不得再改配送单油品与吨数；结算吨数以实装冻结值为准。</template>
      </el-alert>
      <div v-for="(c, i) in h.compartments" :key="c.index" class="dlg-row">
        <div class="dlg-label">舱{{ c.index + 1 }} · {{ c.fuel }}（计划 {{ c.plannedTons }} 吨）</div>
        <div class="dlg-inputs">
          <el-input-number v-model="freezeForm[i].loadedTons" :min="0.1" :step="1" :precision="2" controls-position="right" />
          <el-input v-model="freezeForm[i].sealNo" placeholder="铅封号 如 SL-20261002-01" />
        </div>
      </div>
      <el-select v-model="freezeOperator" class="dlg-operator">
        <el-option v-for="op in OPERATORS" :key="op" :label="`出库操作员：${op}`" :value="op" />
      </el-select>
      <template #footer>
        <el-button @click="freezeVisible = false">取消</el-button>
        <el-button type="primary" @click="submitFreeze">确认冻结</el-button>
      </template>
    </el-dialog>

    <!-- 到站登记弹窗 -->
    <el-dialog v-model="arriveVisible" title="到站登记：核对铅封 / 油品 / 实收吨" width="620px">
      <el-alert type="info" :closable="false" show-icon class="dlg-alert">
        与冻结凭证逐项比对；任一不符，未结算部分立即失效，只能回本单补原因。
      </el-alert>
      <div class="demo-row">
        <span class="demo-label">异常演示：</span>
        <el-button size="small" plain @click="fakeException('铅封不符')">铅封不符</el-button>
        <el-button size="small" plain @click="fakeException('油品不符')">油品不符</el-button>
        <el-button size="small" plain @click="fakeException('数量短少')">数量短少</el-button>
      </div>
      <div v-for="(c, i) in h.compartments" :key="c.index" class="dlg-block">
        <div class="dlg-label">
          舱{{ c.index + 1 }} · 冻结：{{ c.loadedTons }} 吨 / {{ c.sealNo }} / {{ c.fuel }}
        </div>
        <div class="dlg-inputs three">
          <el-input v-model="arriveForm[i].arrivalSealNo" placeholder="到站铅封号" />
          <el-select v-model="arriveForm[i].arrivalFuel">
            <el-option v-for="f in FUELS" :key="f" :label="f" :value="f" />
          </el-select>
          <el-input-number v-model="arriveForm[i].receivedTons" :min="0" :step="0.5" :precision="2" controls-position="right" />
        </div>
      </div>
      <template #footer>
        <el-button @click="arriveVisible = false">取消</el-button>
        <el-button type="primary" @click="submitArrive">提交回单</el-button>
      </template>
    </el-dialog>

    <!-- 补原因弹窗 -->
    <el-dialog v-model="reasonVisible" :title="`回原单 ${h.id} 补异常原因`" width="520px">
      <el-alert type="warning" :closable="false" show-icon class="dlg-alert">
        已失效的待结算行不会复活；补原因后按到站实测重算新行，已结算部分保持不动。
      </el-alert>
      <div class="exc-types">
        <el-tag v-for="t in h.exception?.types ?? []" :key="t" type="danger" class="exc-tag">{{ t }}</el-tag>
      </div>
      <el-input v-model="reasonText" type="textarea" :rows="3" placeholder="如：出厂后运输途中铅封被换，到站拒收，按零吨重算；已上报安环部。" />
      <el-select v-model="reasonOperator" class="dlg-operator">
        <el-option v-for="op in OPERATORS" :key="op" :label="`油站值班员：${op}`" :value="op" />
      </el-select>
      <template #footer>
        <el-button @click="reasonVisible = false">取消</el-button>
        <el-button type="danger" @click="submitReason">补原因并重算</el-button>
      </template>
    </el-dialog>
  </article>
</template>

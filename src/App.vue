<script setup lang="ts">
import { computed, ref } from "vue";
import { useHandoverStore } from "./stores/handover";
import CreateOrderForm from "./components/CreateOrderForm.vue";
import HandoverCard from "./components/HandoverCard.vue";
import AdminBar from "./components/AdminBar.vue";
import AuditLog from "./components/AuditLog.vue";

const store = useHandoverStore();

const stationFilter = ref("全部油站");
const statusFilter = ref("全部状态");

const stations = computed(() => ["全部油站", ...new Set(store.handovers.map((h) => h.station))]);
const statuses = ["全部状态", "待出库", "在途", "到站正常", "到站异常", "已放行"];

const filtered = computed(() =>
  store.handovers.filter(
    (h) =>
      (stationFilter.value === "全部油站" || h.station === stationFilter.value) &&
      (statusFilter.value === "全部状态" || h.status === statusFilter.value),
  ),
);
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">石油行业 · 一次冻结、一次确认、一次结算</p>
          <h1>油品配送交接台</h1>
          <p class="subtitle">
            配送单、罐车舱位、出库铅封、到站回单串成同一张交接单：出库冻结油品/吨数/铅封号，
            到站异常只让未结算部分失效并回原单补原因重算；两名值班员确认仅放行一次，落盘失败凭完整交接恢复。
          </p>
        </div>
        <div class="stack">
          <span class="tag">Vue3</span>
          <span class="tag">Pinia</span>
          <span class="tag">事件溯源</span>
          <span class="tag">命令幂等</span>
        </div>
      </header>

      <transition name="fade">
        <el-alert
          v-if="store.flash"
          :type="store.flash.kind === 'ok' ? 'success' : store.flash.kind === 'warn' ? 'warning' : 'error'"
          :title="store.flash.text"
          :closable="false"
          show-icon
          class="flash"
        />
      </transition>

      <AdminBar />

      <section class="metrics">
        <article class="metric">
          <span>在途/未放行交接单</span>
          <strong>{{ store.totals.activeOrders }}</strong>
        </article>
        <article class="metric">
          <span>冻结在途油量（吨）</span>
          <strong>{{ store.totals.frozenTons }}</strong>
        </article>
        <article class="metric">
          <span>待结算金额（元）</span>
          <strong>¥{{ store.totals.unsettledAmount.toLocaleString() }}</strong>
        </article>
      </section>

      <section class="workspace handover-layout">
        <CreateOrderForm />
        <section class="list-panel">
          <div class="toolbar">
            <h2>交接单列表（{{ filtered.length }}）</h2>
            <div class="filters">
              <el-select v-model="stationFilter" size="small" style="width: 120px">
                <el-option v-for="s in stations" :key="s" :label="s" :value="s" />
              </el-select>
              <el-select v-model="statusFilter" size="small" style="width: 130px">
                <el-option v-for="s in statuses" :key="s" :label="s" :value="s" />
              </el-select>
            </div>
          </div>

          <div class="record-grid">
            <div v-if="filtered.length === 0" class="empty">暂无匹配交接单</div>
            <HandoverCard v-for="h in filtered" :key="h.id" :handover="h" />
          </div>
        </section>
      </section>

      <AuditLog />
    </div>
  </main>
</template>

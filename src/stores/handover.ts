import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { initialState, replay, round2 } from "../domain/reducer";
import type { Command, FuelType, SystemState } from "../domain/types";
import { FUELS } from "../domain/types";
import { commit, recover, type CommitOutcome, type RecoveryResult } from "../services/handover";
import { disk, DiskError, type FailPoint } from "../services/storage";

let seq = 1;
function cid(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

export const useHandoverStore = defineStore("handover", () => {
  // 启动即检测崩溃痕迹：有暂存包就先从完整交接恢复
  const boot = recoverSafe();
  const state = ref<SystemState>(boot.state);

  const failPoint = ref<FailPoint>("none");
  const lastError = ref<string | null>(null);
  const flash = ref<{ kind: "ok" | "warn" | "error"; text: string } | null>(null);
  // localStorage 不是响应式的，用版本号驱动暂存状态重算
  const pendingVersion = ref(0);
  function refreshPending() {
    pendingVersion.value += 1;
  }

  function recoverSafe(): RecoveryResult | { state: SystemState; recoveredFrom: null; detail: null } {
    try {
      return recover("none");
    } catch (e) {
      // 极端情况下日志也读不出来：退回空状态，不做猜测
      console.warn("启动恢复失败", e);
      return { state: initialState(), recoveredFrom: null, detail: null };
    }
  }

  function notify(kind: "ok" | "warn" | "error", text: string) {
    flash.value = { kind, text };
    window.setTimeout(() => {
      if (flash.value?.text === text) flash.value = null;
    }, 6000);
  }

  function dispatch(cmd: Command): CommitOutcome | null {
    lastError.value = null;
    try {
      const result = commit(state.value, cmd, failPoint.value);
      const snap = disk.readState();
      if (snap) state.value = snap;
      refreshPending();
      if (result.applied > 0) notify("ok", "操作已按完整交接落盘");
      else if (result.applied === 0) notify("warn", "重复命令已幂等忽略，油量/确认不重复计");
      return result;
    } catch (e) {
      const msg = e instanceof DiskError ? e.message : e instanceof Error ? e.message : String(e);
      lastError.value = msg;
      notify("error", msg);
      // 内存态与磁盘保持一致：stage 失败磁盘未变；commit 失败以日志重放为准
      state.value = replay(disk.readEvents() ?? []);
      refreshPending();
      return null;
    }
  }

  function createOrder(payload: {
    station: string;
    truckNo: string;
    plannedAt: string;
    compartments: Array<{ fuel: FuelType; plannedTons: number }>;
  }) {
    return dispatch({ kind: "createOrder", commandId: cid("cmd"), ...payload });
  }

  function freezeOutbound(
    handoverId: string,
    operator: string,
    compartments: Array<{ index: number; loadedTons: number; sealNo: string }>,
  ) {
    return dispatch({ kind: "freezeOutbound", commandId: cid("freeze"), handoverId, operator, compartments });
  }

  function recordArrival(handoverId: string, readings: Array<{ index: number; receivedTons: number; arrivalSealNo: string; arrivalFuel: FuelType }>) {
    return dispatch({ kind: "recordArrival", commandId: cid("arrive"), handoverId, readings });
  }

  function supplementReason(handoverId: string, operator: string, reason: string) {
    return dispatch({ kind: "supplementReason", commandId: cid("reason"), handoverId, operator, reason });
  }

  function confirm(handoverId: string, operator: string) {
    return dispatch({ kind: "confirm", commandId: cid("confirm"), handoverId, operator });
  }

  function settle(handoverId: string) {
    return dispatch({ kind: "settle", commandId: cid("settle"), handoverId });
  }

  function changePrice(prices: Record<FuelType, number>, reason: string) {
    return dispatch({ kind: "changePrice", commandId: cid("price"), prices, reason });
  }

  function recoverNow() {
    try {
      const r = recover(failPoint.value === "none" ? "none" : failPoint.value);
      state.value = r.state;
      refreshPending();
      lastError.value = null;
      notify("ok", r.detail ?? "未发现未完成交接，已校验完整快照");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      lastError.value = msg;
      notify("error", `恢复被阻断：${msg}。请把故障注入切回"无"后重试。`);
    }
  }

  function resetAll() {
    disk.wipe();
    seed();
    state.value = disk.readState() ?? initialState();
    lastError.value = null;
    refreshPending();
    notify("ok", "已重置为演示数据");
  }

  // 首次使用时写入演示场景（全部走标准命令通道，保证事件链可重放）
  function seed() {
    if (disk.readEvents() !== null) return;
    let s = initialState();
    disk.writeEvents([]);

    const run = (cmd: Command, fp: FailPoint = "none") => {
      const out = commit(s, cmd, fp);
      const snap = disk.readState();
      if (!snap) throw new Error("seed snapshot missing");
      s = snap;
      return out;
    };

    run({
      kind: "createOrder",
      commandId: "seed-order-1",
      station: "城东站",
      truckNo: "鲁B·88888",
      plannedAt: "2026-10-03",
      compartments: [
        { fuel: "92号汽油", plannedTons: 10 },
        { fuel: "92号汽油", plannedTons: 8 },
      ],
    });
    run({
      kind: "createOrder",
      commandId: "seed-order-2",
      station: "机场站",
      truckNo: "鲁B·12345",
      plannedAt: "2026-10-03",
      compartments: [{ fuel: "柴油", plannedTons: 12 }],
    });
    run({
      kind: "freezeOutbound",
      commandId: "seed-freeze-1",
      handoverId: s.handovers[1].id,
      operator: "王强",
      compartments: [
        { index: 0, loadedTons: 10.0, sealNo: "SL-20261002-01" },
        { index: 1, loadedTons: 8.0, sealNo: "SL-20261002-02" },
      ],
    });
  }

  if (disk.readEvents() === null) {
    seed();
    state.value = disk.readState() ?? initialState();
  }

  const handovers = computed(() => state.value.handovers);
  const priceVersion = computed(() => state.value.priceBook.version);
  const prices = computed(() => state.value.priceBook.prices);
  const auditLog = computed(() => state.value.log);
  const pending = computed(() => {
    void pendingVersion.value;
    return disk.readPending();
  });

  const totals = computed(() => {
    let frozenTons = 0;
    let unsettledAmount = 0;
    let activeOrders = 0;
    for (const h of state.value.handovers) {
      if (h.frozen) frozenTons += h.frozen.totalTons;
      for (const line of h.lines) {
        if (line.status === "待结算") unsettledAmount += line.amount;
      }
      if (h.status !== "已放行") activeOrders += 1;
    }
    return { activeOrders, frozenTons: round2(frozenTons), unsettledAmount: round2(unsettledAmount) };
  });

  return {
    state,
    failPoint,
    lastError,
    flash,
    handovers,
    priceVersion,
    prices,
    auditLog,
    pending,
    totals,
    fuels: FUELS,
    createOrder,
    freezeOutbound,
    recordArrival,
    supplementReason,
    confirm,
    settle,
    changePrice,
    recoverNow,
    resetAll,
  };
});

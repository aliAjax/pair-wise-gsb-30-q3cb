<script setup lang="ts">
import { reactive, ref } from "vue";
import { useHandoverStore } from "../stores/handover";
import { FUELS, STATIONS } from "../domain/types";
import type { FuelType } from "../domain/types";

const store = useHandoverStore();

const station = ref(STATIONS[0]);
const truckNo = ref("");
const plannedAt = ref(new Date().toISOString().slice(0, 10));
const compartments = reactive<Array<{ fuel: FuelType; plannedTons: number }>>([
  { fuel: "92号汽油", plannedTons: 10 },
]);

function addCompartment() {
  if (compartments.length >= 3) return;
  compartments.push({ fuel: "柴油", plannedTons: 5 });
}

function removeCompartment(index: number) {
  compartments.splice(index, 1);
}

function submit() {
  if (!truckNo.value.trim()) {
    store.flash = { kind: "warn", text: "请填写车牌号" };
    return;
  }
  if (compartments.some((c) => c.plannedTons <= 0)) {
    store.flash = { kind: "warn", text: "舱位计划吨数必须大于 0" };
    return;
  }
  store.createOrder({
    station: station.value,
    truckNo: truckNo.value.trim(),
    plannedAt: plannedAt.value,
    compartments: compartments.map((c) => ({ ...c })),
  });
  truckNo.value = "";
}
</script>

<template>
  <form class="panel create-form" @submit.prevent="submit">
    <h2>新建配送单</h2>
    <p class="hint">配送单是交接台主单：司机与油站共用，舱位一经出库冻结即不可改。</p>
    <div class="form-grid">
      <label>
        目标油站
        <el-select v-model="station">
          <el-option v-for="s in STATIONS" :key="s" :label="s" :value="s" />
        </el-select>
      </label>
      <label>
        罐车车牌
        <el-input v-model="truckNo" placeholder="如 鲁B·88888" />
      </label>
      <label>
        计划到达
        <el-input v-model="plannedAt" type="date" />
      </label>

      <div class="comp-head">
        <span>罐车舱位（{{ compartments.length }}/3）</span>
        <el-button size="small" type="primary" plain :disabled="compartments.length >= 3" @click="addCompartment">
          加舱
        </el-button>
      </div>
      <div v-for="(c, i) in compartments" :key="i" class="comp-row">
        <el-select v-model="c.fuel">
          <el-option v-for="f in FUELS" :key="f" :label="f" :value="f" />
        </el-select>
        <el-input-number v-model="c.plannedTons" :min="0.1" :step="1" :precision="2" controls-position="right" />
        <el-button size="small" type="danger" plain :disabled="compartments.length === 1" @click="removeCompartment(i)">
          删
        </el-button>
      </div>

      <el-button type="primary" native-type="submit" size="large">生成配送单</el-button>
    </div>
  </form>
</template>

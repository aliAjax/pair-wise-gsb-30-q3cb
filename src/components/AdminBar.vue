<script setup lang="ts">
import { reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useHandoverStore } from "../stores/handover";
import { FUELS } from "../domain/types";
import type { FailPoint } from "../services/storage";

const store = useHandoverStore();

const priceVisible = ref(false);
const priceForm = reactive({
  "92号汽油": 0,
  "95号汽油": 0,
  柴油: 0,
  reason: "",
});

function openPrice() {
  for (const f of FUELS) priceForm[f] = store.prices[f];
  priceForm.reason = "";
  priceVisible.value = true;
}

function submitPrice() {
  store.changePrice(
    { "92号汽油": priceForm["92号汽油"], "95号汽油": priceForm["95号汽油"], 柴油: priceForm["柴油"] },
    priceForm.reason,
  );
  priceVisible.value = false;
}

async function onFailPointChange(value: FailPoint) {
  store.failPoint = value;
  if (value !== "none") {
    ElMessage.warning(`故障注入已开启：下一次操作将在「${value === "stage" ? "暂存后" : "提交中"}」失败，但完整交接已保留`);
  }
}

async function resetAll() {
  await ElMessageBox.confirm("将清空浏览器内全部交接记录并重建演示数据，是否继续？", "重置演示环境", {
    type: "warning",
    confirmButtonText: "重置",
    cancelButtonText: "取消",
  });
  store.resetAll();
}
</script>

<template>
  <section class="panel admin-bar">
    <div class="admin-left">
      <el-tag type="primary" effect="dark" size="large">当前计价版本 v{{ store.priceVersion.version }}</el-tag>
      <el-button type="primary" plain @click="openPrice">调价并核对待结算单价</el-button>
    </div>

    <div class="admin-right">
      <span class="admin-label">落盘故障注入</span>
      <el-radio-group :model-value="store.failPoint" size="small" @change="onFailPointChange">
        <el-radio-button value="none">无</el-radio-button>
        <el-radio-button value="stage">暂存后失败</el-radio-button>
        <el-radio-button value="commit">提交中断</el-radio-button>
      </el-radio-group>
      <el-button type="warning" @click="store.recoverNow()">从完整交接恢复</el-button>
      <el-button type="danger" plain @click="resetAll">重置演示数据</el-button>
    </div>

    <el-alert
      v-if="store.pending"
      class="pending-alert"
      type="error"
      :closable="false"
      show-icon
      title="检测到未落盘的完整交接暂存，请点击「从完整交接恢复」（重试不重复计算油量）"
    />

    <el-dialog v-model="priceVisible" title="计价版本变更" width="460px">
      <el-alert type="info" :closable="false" show-icon class="dlg-alert">
        保存后版本号 +1，所有「待结算」行立即按新单价重核金额；已结算与已失效行不变。
      </el-alert>
      <div v-for="f in FUELS" :key="f" class="price-row">
        <span>{{ f }}（旧 {{ store.prices[f] }}）</span>
        <el-input-number v-model="priceForm[f]" :min="1" :step="100" controls-position="right" />
      </div>
      <el-input v-model="priceForm.reason" type="textarea" :rows="2" placeholder="调价说明，如：发改委10月调价" />
      <template #footer>
        <el-button @click="priceVisible = false">取消</el-button>
        <el-button type="primary" @click="submitPrice">发布新版本</el-button>
      </template>
    </el-dialog>
  </section>
</template>

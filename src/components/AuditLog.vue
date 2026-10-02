<script setup lang="ts">
import { useHandoverStore } from "../stores/handover";

const store = useHandoverStore();

function fmt(iso: string): string {
  return new Date(iso).toLocaleTimeString("zh-CN", { hour12: false });
}

const dotClass: Record<string, string> = {
  info: "dot info",
  warn: "dot warn",
  ok: "dot ok",
};
</script>

<template>
  <section class="panel audit-panel">
    <h2>交接审计日志</h2>
    <p class="hint">每次状态变更、幂等去重、崩溃恢复、调价重核都会留痕，顺序即完整交接链。</p>
    <div v-if="store.auditLog.length === 0" class="empty">暂无日志</div>
    <ul v-else class="audit-list">
      <li v-for="(entry, i) in store.auditLog.slice(0, 40)" :key="i">
        <span :class="dotClass[entry.level] ?? dotClass.info" />
        <time>{{ fmt(entry.at) }}</time>
        <span class="msg">{{ entry.message }}</span>
        <code v-if="entry.commandId">{{ entry.commandId.slice(0, 22) }}</code>
      </li>
    </ul>
  </section>
</template>

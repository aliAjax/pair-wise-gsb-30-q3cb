# 油品交接台

- 行业：石油
- 技术栈：Vue3、Vite、TypeScript、Pinia、Element Plus
- 启动：`npm install && npm run dev`
- 构建：`npm run build`
- 规则验证：`npm run verify`

把配送单、罐车舱位、出库铅封、到站回单接成一本交接账（`src/handover/`）：

1. **出库冻结**：`freezeOutbound` 定格油品、吨数、铅封号快照，之后改单一律 `FrozenError`；
2. **异常重算**：到站发现铅封/油品异常，未结算部分作废（`SettlementLinesVoided`），
   只允许回原单补原因（`appendReason`），按核定合格量重算待结算行，已结算部分不动；
3. **只放行一次**：回单确认带幂等键 + 业务去重，两个值班员同时确认也只生成一张结算单；
4. **失败可恢复**：事件日志是唯一事实源，先落盘后改内存；落盘失败内存不变，
   崩溃后重放完整交接日志恢复，同一幂等键重试不多算油量；
5. **计价版本**：`bumpPricing` 升级版本后，所有待结算记录重新核价，已结算记录保持原版本。

数据默认保存在浏览器 localStorage（键 `hxwlfront-19-handover`），
`scripts/verify-handover.ts` 是六条规则的可执行验证（44 项断言）。

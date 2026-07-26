import assert from "node:assert/strict";
import {
  combineFinancialAmounts,
  evaluateFinancialMatter,
  reconcileBidirectionalLinks,
} from "../lib/financial-rules.mjs";

const additionalPayable = evaluateFinancialMatter({
  approvedBudget: "1000000",
  committedAmount: "1200000",
  recognizedObligation: "1200000",
  invoicedAmount: "1200000",
  paidAmount: "700000",
  dueObligation: "1200000",
});

assert.deepEqual(
  {
    payableAmount: additionalPayable.amounts.payableAmount,
    budgetExecutionBalance:
      additionalPayable.amounts.budgetExecutionBalance,
    executionRate: additionalPayable.ratios.executionRate,
    highestRisk: additionalPayable.highestRisk,
  },
  {
    payableAmount: 500000,
    budgetExecutionBalance: -200000,
    executionRate: 1.2,
    highestRisk: "红色",
  },
);
assert.ok(
  additionalPayable.alerts.some(
    (alert) =>
      alert.code === "BUDGET_OBLIGATION_EXCEEDED" &&
      alert.amount === 200000,
  ),
);

const payableIncluded = evaluateFinancialMatter({
  approvedBudget: "1000000",
  committedAmount: "1080000",
  recognizedObligation: "1080000",
  invoicedAmount: "1080000",
  paidAmount: "800000",
  dueObligation: "1080000",
});

assert.equal(payableIncluded.amounts.payableAmount, 280000);
assert.equal(payableIncluded.amounts.budgetExecutionBalance, -80000);
assert.equal(payableIncluded.ratios.executionRate, 1.08);
assert.ok(
  payableIncluded.alerts.some(
    (alert) =>
      alert.code === "BUDGET_OBLIGATION_EXCEEDED" &&
      alert.amount === 80000,
  ),
);

const withinBudget = evaluateFinancialMatter({
  approvedBudget: "1000000",
  committedAmount: "850000",
  recognizedObligation: "600000",
  invoicedAmount: "600000",
  paidAmount: "500000",
  dueObligation: "500000",
});

assert.equal(withinBudget.highestRisk, "黄色");
assert.equal(withinBudget.signatureAdvice, "重点复核");
assert.ok(
  withinBudget.alerts.some(
    (alert) => alert.code === "COMMITMENT_USAGE_WARNING_80",
  ),
);

const emptyDraft = evaluateFinancialMatter({});
assert.equal(emptyDraft.highestRisk, "无");
assert.equal(emptyDraft.signatureAdvice, "常规复核");
assert.deepEqual(emptyDraft.alerts, []);

assert.equal(
  combineFinancialAmounts([
    { amount: "0.10" },
    { amount: "0.20" },
    { amount: "0.05", direction: -1 },
  ]),
  0.25,
);
const warningsDisabled = evaluateFinancialMatter(
  {
    approvedBudget: "100",
    committedAmount: "95",
  },
  { usageWarningsEnabled: false },
);
assert.equal(warningsDisabled.highestRisk, "无");
assert.ok(
  !warningsDisabled.alerts.some((item) =>
    item.code.startsWith("COMMITMENT_USAGE_WARNING_"),
  ),
);
const onlyOrangeEnabled = evaluateFinancialMatter(
  {
    approvedBudget: "100",
    committedAmount: "85",
  },
  {
    yellowWarningEnabled: false,
    orangeWarningEnabled: true,
  },
);
assert.ok(
  !onlyOrangeEnabled.alerts.some((item) =>
    item.code.startsWith("COMMITMENT_USAGE_WARNING_"),
  ),
);
const onlyYellowEnabled = evaluateFinancialMatter(
  {
    approvedBudget: "100",
    committedAmount: "95",
  },
  {
    yellowWarningEnabled: true,
    orangeWarningEnabled: false,
  },
);
assert.ok(
  onlyYellowEnabled.alerts.some(
    (item) => item.code === "COMMITMENT_USAGE_WARNING_80",
  ),
);

assert.throws(
  () => evaluateFinancialMatter({ approvedBudget: "-1" }),
  /approvedBudget 不能为负数/,
);
assert.throws(
  () => evaluateFinancialMatter({ paidAmount: "1.001" }),
  /paidAmount 最多保留两位小数/,
);
assert.deepEqual(
  reconcileBidirectionalLinks(["FIN-1\u001fTASK-1"], [], []),
  ["FIN-1\u001fTASK-1"],
);
assert.deepEqual(
  reconcileBidirectionalLinks(
    ["FIN-1\u001fTASK-1"],
    [],
    ["FIN-1\u001fTASK-1"],
  ),
  [],
);

console.log(
  JSON.stringify({
    financialRuleCases: 4,
    ambiguousWordingSeparated: true,
    integerCentArithmetic: true,
  }),
);

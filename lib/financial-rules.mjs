const AMOUNT_FIELDS = [
  "approvedBudget",
  "committedAmount",
  "recognizedObligation",
  "invoicedAmount",
  "paidAmount",
  "dueObligation",
];

const RISK_ORDER = new Map([
  ["无", 0],
  ["黄色", 1],
  ["红色", 2],
]);

function amountToCents(value, fieldName) {
  if (value === undefined || value === null || value === "") return 0;
  const text = String(value).trim();
  if (/^-\d/.test(text)) {
    throw new Error(`${fieldName} 不能为负数`);
  }
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) {
    if (/^\d+\.\d{3,}$/.test(text)) {
      throw new Error(`${fieldName} 最多保留两位小数`);
    }
    throw new Error(`${fieldName} 必须是非负金额`);
  }
  const [integer, fraction = ""] = text.split(".");
  const cents = BigInt(integer) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${fieldName} 超出可安全计算范围`);
  }
  return Number(cents);
}

function centsToAmount(cents) {
  return Number((cents / 100).toFixed(2));
}

export function combineFinancialAmounts(items = []) {
  const total = items.reduce((sum, item, index) => {
    const direction = Number(item?.direction ?? 1);
    if (![1, -1].includes(direction)) {
      throw new Error(`items[${index}].direction 必须是 1 或 -1`);
    }
    return (
      sum +
      direction *
        amountToCents(item?.amount, `items[${index}].amount`)
    );
  }, 0);
  return centsToAmount(total);
}

export function reconcileBidirectionalLinks(
  leftLinks = [],
  rightLinks = [],
  previousLinks = [],
) {
  const left = new Set(leftLinks);
  const right = new Set(rightLinks);
  const previous = new Set(previousLinks);
  const desired = new Set();
  for (const candidate of new Set([...left, ...right, ...previous])) {
    const linked = previous.has(candidate)
      ? left.has(candidate) && right.has(candidate)
      : left.has(candidate) || right.has(candidate);
    if (linked) desired.add(candidate);
  }
  return [...desired].sort();
}

function ratio(numerator, denominator) {
  if (denominator === 0) return null;
  return Number((numerator / denominator).toFixed(4));
}

function alert(code, severity, title, detail, amountCents = 0) {
  return {
    code,
    severity,
    title,
    detail,
    amount: centsToAmount(amountCents),
  };
}

/**
 * Deterministically evaluates one economic matter.
 *
 * All input amounts are decimal yuan values. They are converted to integer
 * cents before calculation so callers never depend on binary floating-point
 * arithmetic for financial comparisons.
 */
export function evaluateFinancialMatter(input = {}, policy = {}) {
  const cents = Object.fromEntries(
    AMOUNT_FIELDS.map((field) => [
      field,
      amountToCents(input[field], field),
    ]),
  );
  const yellowThreshold = Number(policy.yellowThreshold ?? 0.8);
  const orangeThreshold = Number(policy.orangeThreshold ?? 0.9);
  const yellowWarningEnabled =
    policy.yellowWarningEnabled ??
    policy.usageWarningsEnabled ??
    true;
  const orangeWarningEnabled =
    policy.orangeWarningEnabled ??
    policy.usageWarningsEnabled ??
    true;
  if (
    (yellowWarningEnabled &&
      !(yellowThreshold > 0 && yellowThreshold < 1)) ||
    (orangeWarningEnabled &&
      !(orangeThreshold > 0 && orangeThreshold < 1)) ||
    (yellowWarningEnabled &&
      orangeWarningEnabled &&
      !(orangeThreshold > yellowThreshold))
  ) {
    throw new Error("预警阈值必须满足 0 < 黄色阈值 < 橙色阈值 < 1");
  }

  const payableAmount = Math.max(
    cents.recognizedObligation - cents.paidAmount,
    0,
  );
  const duePayableAmount = Math.max(
    cents.dueObligation - cents.paidAmount,
    0,
  );
  const budgetCommitmentBalance =
    cents.approvedBudget - cents.committedAmount;
  const budgetExecutionBalance =
    cents.approvedBudget - cents.recognizedObligation;
  const commitmentRate = ratio(
    cents.committedAmount,
    cents.approvedBudget,
  );
  const executionRate = ratio(
    cents.recognizedObligation,
    cents.approvedBudget,
  );

  const alerts = [];
  const hasFinancialActivity = AMOUNT_FIELDS.slice(1).some(
    (field) => cents[field] > 0,
  );

  if (cents.approvedBudget === 0 && hasFinancialActivity) {
    alerts.push(
      alert(
        "MISSING_APPROVED_BUDGET",
        "红色",
        "存在业务金额但没有有效预算",
        "应补充已批准预算或停止继续形成承诺、义务和付款。",
      ),
    );
  }
  if (cents.committedAmount > cents.approvedBudget) {
    alerts.push(
      alert(
        "BUDGET_COMMITMENT_EXCEEDED",
        "红色",
        "合同及其他承诺超过有效预算",
        "承诺口径已突破当前有效预算。",
        cents.committedAmount - cents.approvedBudget,
      ),
    );
  }
  if (cents.recognizedObligation > cents.approvedBudget) {
    alerts.push(
      alert(
        "BUDGET_OBLIGATION_EXCEEDED",
        "红色",
        "已确认义务超过有效预算",
        "已验收、已确认的对外义务已突破当前有效预算。",
        cents.recognizedObligation - cents.approvedBudget,
      ),
    );
  }
  if (cents.paidAmount > cents.approvedBudget) {
    alerts.push(
      alert(
        "PAID_OVER_BUDGET",
        "红色",
        "已付款超过有效预算",
        "现金支出已经突破当前有效预算。",
        cents.paidAmount - cents.approvedBudget,
      ),
    );
  }
  if (cents.paidAmount > cents.recognizedObligation) {
    alerts.push(
      alert(
        "PAID_OVER_RECOGNIZED_OBLIGATION",
        "红色",
        "付款超过已确认义务",
        "需要核查预付款性质、验收记录或付款归集是否正确。",
        cents.paidAmount - cents.recognizedObligation,
      ),
    );
  }
  if (cents.recognizedObligation > cents.committedAmount) {
    alerts.push(
      alert(
        "OBLIGATION_OVER_COMMITMENT",
        "红色",
        "已确认义务超过合同及其他承诺",
        "可能存在合同外履约、合同变更未登记或金额归集错误。",
        cents.recognizedObligation - cents.committedAmount,
      ),
    );
  }
  if (cents.invoicedAmount > cents.recognizedObligation) {
    alerts.push(
      alert(
        "INVOICE_OVER_RECOGNIZED_OBLIGATION",
        "黄色",
        "开票金额超过已确认义务",
        "可能属于预开发票，也可能缺少验收或义务确认记录，需要复核。",
        cents.invoicedAmount - cents.recognizedObligation,
      ),
    );
  }
  if (duePayableAmount > 0) {
    alerts.push(
      alert(
        "DUE_PAYABLE_OUTSTANDING",
        "红色",
        "存在已到期未付款",
        "按事项总额采用先到期先抵扣口径计算，应结合付款分配明细复核。",
        duePayableAmount,
      ),
    );
  }

  if (
    (yellowWarningEnabled || orangeWarningEnabled) &&
    cents.approvedBudget > 0 &&
    cents.committedAmount <= cents.approvedBudget
  ) {
    if (
      orangeWarningEnabled &&
      commitmentRate >= orangeThreshold
    ) {
      alerts.push(
        alert(
          "COMMITMENT_USAGE_WARNING_90",
          "黄色",
          "预算承诺占用达到高位",
          `合同及其他承诺已占有效预算的 ${(commitmentRate * 100).toFixed(1)}%。`,
        ),
      );
    } else if (
      yellowWarningEnabled &&
      commitmentRate >= yellowThreshold
    ) {
      alerts.push(
        alert(
          "COMMITMENT_USAGE_WARNING_80",
          "黄色",
          "预算承诺占用接近上限",
          `合同及其他承诺已占有效预算的 ${(commitmentRate * 100).toFixed(1)}%。`,
        ),
      );
    }
  }

  const highestRisk = alerts.reduce(
    (highest, item) =>
      RISK_ORDER.get(item.severity) > RISK_ORDER.get(highest)
        ? item.severity
        : highest,
    "无",
  );
  const signatureAdvice =
    highestRisk === "红色"
      ? "暂停签字并核查"
      : highestRisk === "黄色"
        ? "重点复核"
        : "常规复核";

  return {
    amounts: {
      approvedBudget: centsToAmount(cents.approvedBudget),
      committedAmount: centsToAmount(cents.committedAmount),
      recognizedObligation: centsToAmount(cents.recognizedObligation),
      invoicedAmount: centsToAmount(cents.invoicedAmount),
      paidAmount: centsToAmount(cents.paidAmount),
      payableAmount: centsToAmount(payableAmount),
      duePayableAmount: centsToAmount(duePayableAmount),
      budgetCommitmentBalance: centsToAmount(budgetCommitmentBalance),
      budgetExecutionBalance: centsToAmount(budgetExecutionBalance),
    },
    ratios: {
      commitmentRate,
      executionRate,
    },
    highestRisk,
    signatureAdvice,
    alerts,
  };
}

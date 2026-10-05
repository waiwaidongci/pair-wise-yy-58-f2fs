import type { RiskField, RiskFinding, RuleConflict, StepParams } from './types';

/** 单步骤的安全规则判定，阈值与会签页面展示保持一致。 */
export function evaluateStep(step: StepParams, blocked = false): RiskFinding[] {
  const findings: RiskFinding[] = [];
  if (step.loadRate > 90) {
    findings.push({ stepId: step.id, field: 'loadRate', message: `荷载率 ${step.loadRate}% 超过 90% 阈值` });
  }
  if (step.clearance < 1.5) {
    findings.push({ stepId: step.id, field: 'clearance', message: `净空 ${step.clearance}m 小于 1.5m` });
  }
  return findings;
}

/** 冲突清单页面使用的展示结构（含风速、幅度等全部规则）。 */
export function ruleConflicts(steps: StepParams[]): RuleConflict[] {
  return steps.flatMap((step) => {
    const issues: { message: string; field?: RiskField }[] = [];
    if (step.loadRate > 90) issues.push({ message: `荷载率 ${step.loadRate}% 超过 90% 阈值`, field: 'loadRate' });
    if (step.clearance < 1.5) issues.push({ message: `净空 ${step.clearance}m 小于 1.5m`, field: 'clearance' });
    if (step.wind > 8) issues.push({ message: `风速 ${step.wind}m/s 超过暂停值` });
    if (step.radius > step.boom * 0.62) issues.push({ message: '工作半径接近额定幅度' });
    return issues.map((issue, index) => ({
      id: `${step.id}-${index}`,
      stepId: step.id,
      title: step.title,
      message: issue.message,
      severity: step.status === 'blocked' ? 'high' : 'medium'
    }));
  });
}

/**
 * 比较基线步骤与合并后步骤，只看净空与荷载率两个风险字段：
 * 找出合并后新出现或恶化的风险，用于使原会签结论失效。
 */
export function diffNewRisks(baselineSteps: StepParams[], mergedSteps: StepParams[]): RiskFinding[] {
  const newRisks: RiskFinding[] = [];
  for (const merged of mergedSteps) {
    const baseline = baselineSteps.find((step) => step.id === merged.id);
    if (!baseline) continue;
    const before = new Set(evaluateStep(baseline).map((f) => `${f.stepId}:${f.field}`));
    for (const finding of evaluateStep(merged)) {
      const key = `${finding.stepId}:${finding.field}`;
      if (!before.has(key)) newRisks.push(finding);
    }
  }
  return newRisks;
}

/** 与新风险步骤相关的会签意见（含已关闭意见）需要重新打开。 */
export function affectedCommentIds(findings: RiskFinding[], comments: { id: string; stepId: string }[]): string[] {
  const riskySteps = new Set(findings.map((f) => f.stepId));
  return comments.filter((comment) => riskySteps.has(comment.stepId)).map((comment) => comment.id);
}

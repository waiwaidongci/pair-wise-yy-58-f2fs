import { ApolloClient, ApolloLink, InMemoryCache, gql } from '@apollo/client/core';

export type SnapshotStep = {
  id: string;
  title: string;
  time: string;
  loadRate: number;
  clearance: number;
  wind: number;
  radius: number;
  boom: number;
  status: string;
  note: string;
};

export type SnapshotComment = {
  id: string;
  author: string;
  role: string;
  content: string;
  status: string;
  stepId: string;
};

export type SnapshotSignoff = {
  id: string;
  name: string;
  team: string;
  scope: string;
  state: string;
};

export type PlanSnapshot = {
  __typename: 'LiftPlan';
  id: string;
  name: string;
  revision: number;
  status: string;
  steps: SnapshotStep[];
  comments: SnapshotComment[];
  signoffs: SnapshotSignoff[];
};

export const planId = 'LP-2026-0918';

export const initialSteps: SnapshotStep[] = [
  { id: 'S-01', title: '吊车支腿就位与地耐力复核', time: '07:30', loadRate: 0, clearance: 4.2, wind: 3.4, radius: 18, boom: 42, status: 'passed', note: '支腿钢板 2.4m × 2.4m，已完成压实度复检。' },
  { id: 'S-02', title: '空钩回转与障碍物净空检查', time: '08:10', loadRate: 28, clearance: 1.2, wind: 4.1, radius: 22, boom: 46, status: 'blocked', note: '东侧临时配电箱侵入回转半径 0.6m。' },
  { id: 'S-03', title: '桁架试吊离地 300mm', time: '08:45', loadRate: 76, clearance: 2.8, wind: 5.2, radius: 20, boom: 44, status: 'pending', note: '需安全员确认吊点受力均匀。' },
  { id: 'S-04', title: '主吊回转至安装轴线', time: '09:20', loadRate: 83, clearance: 1.8, wind: 6.8, radius: 24, boom: 48, status: 'pending', note: '风速超过 8m/s 立即停止。' },
  { id: 'S-05', title: '双机抬吊姿态调整', time: '10:05', loadRate: 92, clearance: 1.3, wind: 7.2, radius: 27, boom: 52, status: 'blocked', note: '辅吊荷载率超过方案控制值。' },
  { id: 'S-06', title: '就位、临时固定与摘钩', time: '10:50', loadRate: 68, clearance: 2.1, wind: 5.6, radius: 21, boom: 45, status: 'pending', note: '四组临时螺栓到位后方可摘钩。' }
];

export const initialComments: SnapshotComment[] = [
  { id: 'C-11', author: '周工', role: '安全', content: 'S-02 回转路径与配电箱净空不足，请调整吊车站位或迁移配电箱。', status: 'open', stepId: 'S-02' },
  { id: 'C-12', author: '刘明', role: '设备', content: '辅吊支腿下方需要补充路基板，提供地耐力实测记录。', status: 'open', stepId: 'S-05' },
  { id: 'C-13', author: '陈晓', role: '总包', content: '同意主吊选型，建议把第三检查点前移到试吊阶段。', status: 'resolved', stepId: 'S-03' }
];

export const initialSignoffs: SnapshotSignoff[] = [
  { id: 'SG-01', name: '陈晓', team: '总包项目部', scope: '吊装工序与场地移交', state: 'accepted' },
  { id: 'SG-02', name: '刘明', team: '设备管理', scope: '吊车参数与支腿地基', state: 'pending' },
  { id: 'SG-03', name: '周工', team: '安全监督', scope: '净空、风速与警戒区', state: 'reserved' },
  { id: 'SG-04', name: '赵磊', team: '方案工程', scope: '载荷计算与路径参数', state: 'pending' }
];

export const initialSnapshot: PlanSnapshot = {
  __typename: 'LiftPlan',
  id: planId,
  name: '东塔转换桁架吊装',
  revision: 4,
  status: 'REVIEW',
  steps: initialSteps.map((s) => ({ ...s })),
  comments: initialComments.map((c) => ({ ...c })),
  signoffs: initialSignoffs.map((s) => ({ ...s }))
};

export const LIFT_PLAN_QUERY = gql`
  query LiftPlan($id: ID!) {
    liftPlan(id: $id) {
      id
      name
      revision
      status
      steps {
        id
        title
        time
        loadRate
        clearance
        wind
        radius
        boom
        status
        note
      }
      comments {
        id
        author
        role
        content
        status
        stepId
      }
      signoffs {
        id
        name
        team
        scope
        state
      }
    }
  }
`;

export const graphqlClient = new ApolloClient({
  cache: new InMemoryCache(),
  link: ApolloLink.empty()
});

graphqlClient.writeQuery({
  query: LIFT_PLAN_QUERY,
  variables: { id: planId },
  data: { liftPlan: initialSnapshot }
});

export function readSnapshot(): PlanSnapshot {
  const result = graphqlClient.readQuery<{ liftPlan: PlanSnapshot }>({
    query: LIFT_PLAN_QUERY,
    variables: { id: planId }
  });
  if (!result?.liftPlan) throw new Error('方案快照读取失败');
  return result.liftPlan;
}

export function writeSnapshot(snapshot: PlanSnapshot): void {
  graphqlClient.writeQuery({
    query: LIFT_PLAN_QUERY,
    variables: { id: planId },
    data: { liftPlan: snapshot }
  });
}

/** 离线可编辑、参与逐字段合并的步骤字段。 */
export const TRACKED_STEP_FIELDS: (keyof SnapshotStep)[] = [
  'loadRate',
  'clearance',
  'wind',
  'radius',
  'boom',
  'status',
  'note'
];

/** 净空 / 荷载率：合并后若越限会触发会签结论失效。 */
export const RISK_FIELDS: (keyof SnapshotStep)[] = ['loadRate', 'clearance'];

export function isRisky(step: Pick<SnapshotStep, 'loadRate' | 'clearance'>): boolean {
  return step.loadRate > 90 || step.clearance < 1.5;
}

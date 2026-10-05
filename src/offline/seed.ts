import type { CommentRecord, Reviewer, StepParams } from './types';

export const PLAN_ID = 'LP-2026-0918';
export const PLAN_NAME = '东塔转换桁架吊装';
export const BASE_REVISION = 4;

export const seedSteps: StepParams[] = [
  { id: 'S-01', title: '吊车支腿就位与地耐力复核', time: '07:30', loadRate: 0, clearance: 4.2, wind: 3.4, radius: 18, boom: 42, status: 'passed', note: '支腿钢板 2.4m × 2.4m，已完成压实度复检。' },
  { id: 'S-02', title: '空钩回转与障碍物净空检查', time: '08:10', loadRate: 28, clearance: 1.2, wind: 4.1, radius: 22, boom: 46, status: 'blocked', note: '东侧临时配电箱侵入回转半径 0.6m。' },
  { id: 'S-03', title: '桁架试吊离地 300mm', time: '08:45', loadRate: 76, clearance: 2.8, wind: 5.2, radius: 20, boom: 44, status: 'pending', note: '需安全员确认吊点受力均匀。' },
  { id: 'S-04', title: '主吊回转至安装轴线', time: '09:20', loadRate: 83, clearance: 1.8, wind: 6.8, radius: 24, boom: 48, status: 'pending', note: '风速超过 8m/s 立即停止。' },
  { id: 'S-05', title: '双机抬吊姿态调整', time: '10:05', loadRate: 92, clearance: 1.3, wind: 7.2, radius: 27, boom: 52, status: 'blocked', note: '辅吊荷载率超过方案控制值。' },
  { id: 'S-06', title: '就位、临时固定与摘钩', time: '10:50', loadRate: 68, clearance: 2.1, wind: 5.6, radius: 21, boom: 45, status: 'pending', note: '四组临时螺栓到位后方可摘钩。' }
];

export const seedComments: CommentRecord[] = [
  { id: 'C-11', author: '周工', role: '安全', content: 'S-02 回转路径与配电箱净空不足，请调整吊车站位或迁移配电箱。', status: 'open', stepId: 'S-02', createdAt: '2026-09-16T09:12:00Z' },
  { id: 'C-12', author: '刘明', role: '设备', content: '辅吊支腿下方需要补充路基板，提供地耐力实测记录。', status: 'open', stepId: 'S-05', createdAt: '2026-09-16T10:03:00Z' },
  { id: 'C-13', author: '陈晓', role: '总包', content: '同意主吊选型，建议把第三检查点前移到试吊阶段。', status: 'resolved', stepId: 'S-03', createdAt: '2026-09-16T11:20:00Z' },
  { id: 'C-14', author: '赵磊', role: '方案', content: '试吊净空 2.8m 满足要求，荷载率 76% 在控制值以内，该步可执行。', status: 'resolved', stepId: 'S-03', createdAt: '2026-09-17T08:40:00Z' }
];

export const seedReviewers: Reviewer[] = [
  { id: 'R-01', name: '陈晓', team: '总包项目部', scope: '吊装工序与场地移交', state: 'accepted', signedAt: '2026-09-17T09:00:00Z' },
  { id: 'R-02', name: '刘明', team: '设备管理', scope: '吊车参数与支腿地基', state: 'accepted', signedAt: '2026-09-17T09:05:00Z' },
  { id: 'R-03', name: '周工', team: '安全监督', scope: '净空、风速与警戒区', state: 'accepted', signedAt: '2026-09-17T09:10:00Z' },
  { id: 'R-04', name: '赵磊', team: '方案工程', scope: '载荷计算与路径参数', state: 'accepted', signedAt: '2026-09-17T09:15:00Z' }
];

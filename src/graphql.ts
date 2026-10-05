import { ApolloClient, ApolloLink, InMemoryCache, gql } from '@apollo/client/core';
import type { PlanStateDTO } from './offline/types';

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
    }
  }
`;

export const graphqlClient = new ApolloClient({
  cache: new InMemoryCache(),
  link: ApolloLink.empty()
});

/** 方案快照：每次合并对齐后整体写入，快照版本与步骤/冲突/就绪度指向同一版本。 */
export function writePlanSnapshot(plan: PlanStateDTO, snapshotId?: string): void {
  graphqlClient.writeQuery({
    query: LIFT_PLAN_QUERY,
    variables: { id: plan.id },
    data: {
      liftPlan: {
        __typename: 'LiftPlan',
        id: plan.id,
        name: plan.name,
        revision: plan.revision,
        status: plan.status,
        steps: plan.steps.map((step) => ({ __typename: 'LiftStep', ...step })),
        comments: plan.comments.map((comment) => ({ __typename: 'PlanComment', ...comment }))
      }
    }
  });
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('yy58-lift-plan-snapshot', JSON.stringify({ snapshotId, revision: plan.revision, savedAt: new Date().toISOString() }));
  }
}

export function readSnapshotMeta(): { snapshotId?: string; revision?: number } {
  const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('yy58-lift-plan-snapshot') : null;
  return raw ? JSON.parse(raw) : {};
}

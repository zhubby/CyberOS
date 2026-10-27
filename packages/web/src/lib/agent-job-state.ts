import type { JobStatus } from "../api.js";

export interface ActiveAgentJobState {
  id: string | null;
  status: JobStatus | null;
}

export const EMPTY_ACTIVE_AGENT_JOB: ActiveAgentJobState = {
  id: null,
  status: null
};

export function markActiveAgentJobRunning(
  current: ActiveAgentJobState,
  jobId: string | null
): ActiveAgentJobState {
  return {
    id: jobId ?? current.id,
    status: "running"
  };
}

export function markActiveAgentJobWaitingApproval(
  current: ActiveAgentJobState,
  jobId: string | null
): ActiveAgentJobState {
  if (jobId && current.id && current.id !== jobId) {
    return current;
  }
  return {
    id: jobId ?? current.id,
    status: "waiting_approval"
  };
}

export function settleActiveAgentJob(
  current: ActiveAgentJobState,
  jobId: string | null
): ActiveAgentJobState {
  return targetsActiveAgentJob(current, jobId) ? EMPTY_ACTIVE_AGENT_JOB : current;
}

export function targetsActiveAgentJob(
  current: ActiveAgentJobState,
  jobId: string | null
): boolean {
  return jobId === null || current.id === jobId;
}

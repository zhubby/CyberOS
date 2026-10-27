import { describe, expect, it } from "vitest";
import {
  EMPTY_ACTIVE_AGENT_JOB,
  markActiveAgentJobRunning,
  markActiveAgentJobWaitingApproval,
  settleActiveAgentJob,
  targetsActiveAgentJob,
  type ActiveAgentJobState
} from "./agent-job-state.js";

const runningJob: ActiveAgentJobState = { id: "job-1", status: "running" };

describe("active Agent job state", () => {
  it("updates the job id and status together when a turn starts", () => {
    expect(markActiveAgentJobRunning(EMPTY_ACTIVE_AGENT_JOB, "job-1")).toEqual(runningJob);
    expect(markActiveAgentJobRunning({ id: "job-1", status: "queued" }, null)).toEqual(runningJob);
  });

  it("keeps an active turn when another job settles", () => {
    expect(settleActiveAgentJob(runningJob, "job-2")).toBe(runningJob);
  });

  it("clears the matching job atomically", () => {
    expect(settleActiveAgentJob(runningJob, "job-1")).toBe(EMPTY_ACTIVE_AGENT_JOB);
    expect(settleActiveAgentJob(runningJob, null)).toBe(EMPTY_ACTIVE_AGENT_JOB);
  });

  it("scopes terminal UI effects to the active job", () => {
    expect(targetsActiveAgentJob(runningJob, "job-1")).toBe(true);
    expect(targetsActiveAgentJob(runningJob, null)).toBe(true);
    expect(targetsActiveAgentJob(runningJob, "job-2")).toBe(false);
  });

  it("applies approval state only to the active job", () => {
    expect(markActiveAgentJobWaitingApproval(runningJob, "job-1")).toEqual({
      id: "job-1",
      status: "waiting_approval"
    });
    expect(markActiveAgentJobWaitingApproval(runningJob, "job-2")).toBe(runningJob);
  });
});

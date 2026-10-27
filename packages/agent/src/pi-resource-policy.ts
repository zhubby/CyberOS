import type { AgentSessionRecord } from "@zos/shared";

export interface PiResourcePolicyDecision {
  allowProjectSkills: boolean;
  allowProjectPrompts: boolean;
  allowProjectContext: boolean;
  allowUserExtensions: false;
  allowProjectExtensions: false;
}

export class PiResourcePolicy {
  evaluate(session: AgentSessionRecord): PiResourcePolicyDecision {
    const trusted = session.piResourcesTrusted === true;
    return {
      allowProjectSkills: trusted,
      allowProjectPrompts: trusted,
      allowProjectContext: trusted,
      allowUserExtensions: false,
      allowProjectExtensions: false
    };
  }
}

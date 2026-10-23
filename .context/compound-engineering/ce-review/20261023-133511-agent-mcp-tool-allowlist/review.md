# Code Review Results

- Scope: `packages/agent/src/pi-agent.ts` and `packages/agent/src/pi-agent.test.ts`
- Intent: expose the authenticated ZOS MCP tool catalog to Pi Agent sessions without enabling legacy host tools or external MCP namespaces
- Mode: autofix
- Reviewers: correctness, testing, maintainability, project-standards, agent-native, learnings, security, kieran-typescript

## Findings

No unresolved findings.

The initial review found one P2 `safe_auto` issue: adding `mcp__zos__*` enabled direct ZOS tools but caused Pi's strict MCP allowlist to remove `list_mcp_resources`, `list_mcp_resource_templates`, and `read_mcp_resource`.

## Applied Fixes

- Added all three Pi MCP resource helpers to the MCP-enabled allowlist.
- Derived the ZOS MCP tool namespace and configured server name from one constant.
- Reworked the regression test to register MCP tools during `session_start`, matching the production extension lifecycle.
- Covered direct and codemode ZOS tools, external namespace exclusion, resource helpers, every legacy host tool, and exact MCP/legacy/Photostaff allowlists.

## Advisory Outputs

- The repository has no `docs/solutions/` knowledge base applicable to this change.
- The final agent-native review reports all five capability boundaries preserved.

## Residual Actionable Work

None.

## Residual Risks

- The SDK-level test exercises dynamic registration and allowlist behavior without a real HTTP MCP connection. CM5 browser acceptance must verify a direct ZOS tool call and a resource helper against the deployed server.

## Verification

- Focused Pi Agent tests: 10 passed
- TypeScript typecheck: passed
- Target ESLint: passed
- `git diff --check`: passed
- Full `make ci`: passed
- Focused Kieran TypeScript re-review: no findings
- Focused agent-native re-review: 5/5 capability boundaries, PASS

## Verdict

Ready with fixes. No residual downstream finding remains; proceed to the full quality gate and CM5 runtime acceptance.

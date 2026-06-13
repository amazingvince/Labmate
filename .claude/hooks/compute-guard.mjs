#!/usr/bin/env node
/**
 * Advisory compute/leakage guard (PreToolUse on Bash).
 *
 * Hard enforcement is in the control plane, not here: launch_experiment refuses
 * compute without a recorded approval (402) and rejects manifests with banned
 * columns or tune_on=test (422); the Modal runner re-validates. This hook only
 * surfaces a gentle reminder for risky shell patterns and NEVER blocks — it always
 * exits 0 — so it cannot disrupt a session.
 */
let input = "";
const done = () => process.exit(0);
setTimeout(done, 2000); // safety: never hang
process.stdin.on("error", done);
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  try {
    const evt = JSON.parse(input || "{}");
    const cmd = (evt.tool_input && evt.tool_input.command) || "";
    const risky = /(\brm\s+-rf\b|DROP\s+TABLE|TRUNCATE\b|r2\b[^\n]*\bdelete\b|d1\b[^\n]*\b(drop|delete)\b|modal\s+deploy|wrangler\s+deploy)/i;
    if (risky.test(cmd)) {
      process.stderr.write(
        "[labmate] reminder: destructive/compute action — needs explicit human approval; the Worker also gates launches (402/approval).\n",
      );
    }
  } catch {
    /* advisory only */
  }
  done();
});

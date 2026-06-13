#!/usr/bin/env node
/**
 * Stop hook: a one-line reminder that "done" is machine-checkable.
 *
 * The real verdict comes from grade_study_against_rubric (POST /api/grade), which
 * the run-study workflow calls at the end of the loop. This hook is advisory and
 * always exits 0 so it can never block a session.
 */
const done = () => process.exit(0);
setTimeout(done, 1500);
let _ = "";
process.stdin.on("error", done);
process.stdin.on("data", (d) => (_ += d));
process.stdin.on("end", () => {
  process.stderr.write("[labmate] done is verifiable: run `npm run study` then POST /api/grade for a verdict.\n");
  done();
});

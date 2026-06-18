/**
 * Re-kick / dedup registry tests for startStudy — NO network, NO live Anthropic.
 *
 * PRODUCTION BUG these lock down: startStudy used to dedupe purely on
 * `studies.has(studyId)`, so once a study's session had been registered, a re-kick was
 * a permanent no-op — even after that session DIED (the registry entry was never cleared
 * on a crashed/ended loop). A study that failed to start could therefore never be
 * retried. The fix: only a *genuinely active* session dedupes the kick; a finished /
 * inactive entry is dropped and a fresh session starts.
 *
 * We inject a stub loop runner so no Anthropic SDK / network is touched. The stub loop
 * never resolves on its own (so the entry stays `active`) until the test ends it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

// startStudy reads config.agentId()/environmentId() (required env getters) when it
// builds the loop opts. Provide deterministic dummies so the registry logic can run
// with no real Managed Agents config. (The control plane + agent adapter are stubbed
// below, so no token / SDK / network is touched.)
process.env.LABMATE_AGENT_ID ??= "agent_test";
process.env.LABMATE_ENVIRONMENT_ID ??= "env_test";

const { startStudy, finishStudy, studies, server } = await import("../src/server.mjs");

// A loop runner that records each invocation and returns a promise we control. Each call
// is a distinct "session"; we count calls to prove a NEW session was (or was not) started.
function stubLoopFactory() {
  const calls = [];
  const runLoop = (args) => {
    let resolve;
    const promise = new Promise((r) => {
      resolve = r;
    });
    const call = { args, promise, resolve };
    calls.push(call);
    return promise; // never resolves until the test calls resolve()
  };
  return { calls, runLoop };
}

const makeControlPlane = () => ({ async post() {} });
const makeAgent = () => ({});
const deps = (runLoop) => ({ runLoop, makeControlPlane, makeAgent });

// Clean up any lingering registry entries + the (unbound in tests) server handle so the
// test process exits cleanly.
test.after(() => {
  for (const id of [...studies.keys()]) finishStudy(id);
  studies.clear();
  try {
    server.close();
  } catch {
    /* never listened in tests */
  }
});

test("startStudy dedupes a genuinely ACTIVE session (no second loop)", () => {
  const id = `study_active_${Date.now()}`;
  const { calls, runLoop } = stubLoopFactory();

  const first = startStudy(id, deps(runLoop));
  assert.equal(first.active, true);
  assert.equal(calls.length, 1, "first kick starts one loop");

  const second = startStudy(id, deps(runLoop));
  assert.equal(second, first, "an active session re-kick returns the SAME entry");
  assert.equal(calls.length, 1, "no new loop is started while the session is active");

  finishStudy(id);
});

test("startStudy RE-KICKS a study whose entry is inactive (starts a NEW session)", () => {
  const id = `study_dead_${Date.now()}`;
  const { calls, runLoop } = stubLoopFactory();

  const first = startStudy(id, deps(runLoop));
  assert.equal(calls.length, 1);
  assert.equal(first.active, true);

  // Simulate the session dying: its loop ended / a terminal frame fired. finishStudy is
  // exactly the path the emitter takes on a terminal frame — it marks the entry inactive.
  finishStudy(id);
  assert.equal(studies.get(id).active, false, "the dead session is marked inactive");

  // A re-kick must NOT dedupe against the dead entry — it must start a fresh session.
  const second = startStudy(id, deps(runLoop));
  assert.equal(calls.length, 2, "a re-kick of a dead session starts a NEW loop");
  assert.notEqual(second, first, "the fresh session is a NEW registry entry");
  assert.equal(second.active, true, "the fresh session is active");
  assert.equal(studies.get(id), second, "the registry now points at the fresh entry");

  finishStudy(id);
});

// Smoke test: the bundled sla_tickets dataset must match docs/data_contract.md.
// This catches dataset drift (regenerating with different columns, losing the
// planted leakage fields, or breaking the target) before it derails a demo.
// Run with: node --test tests/   (no external deps)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const csvPath = join(root, "examples/sla_tickets/data.csv");

const TARGET = "breached_sla";
const LEAKAGE = ["resolved_at", "time_to_resolution", "closed_status", "agent_notes_final"];
const SAFE = [
  "created_at",
  "priority",
  "customer_tier",
  "channel",
  "product_area",
  "region",
  "reporter_history_count",
  "queue_depth_at_creation",
  "is_reopen",
  "description_length",
  "business_hours_flag",
];

function loadHeaderAndRows() {
  const text = readFileSync(csvPath, "utf8").replace(/\r/g, "");
  const lines = text.split("\n").filter((l) => l.length > 0);
  const header = lines[0].split(",");
  return { header, rowCount: lines.length - 1, lines };
}

test("dataset file exists", () => {
  assert.ok(existsSync(csvPath), "examples/sla_tickets/data.csv should exist (run npm run gen:data)");
});

test("dataset has a meaningful number of rows", () => {
  const { rowCount } = loadHeaderAndRows();
  assert.ok(rowCount >= 5000, `expected >=5000 rows, got ${rowCount}`);
});

test("target column is present", () => {
  const { header } = loadHeaderAndRows();
  assert.ok(header.includes(TARGET), `missing target column ${TARGET}`);
});

test("all planted leakage columns are present (the demo depends on them)", () => {
  const { header } = loadHeaderAndRows();
  for (const col of LEAKAGE) {
    assert.ok(header.includes(col), `missing planted leakage column ${col}`);
  }
});

test("all safe feature columns are present", () => {
  const { header } = loadHeaderAndRows();
  for (const col of SAFE) {
    assert.ok(header.includes(col), `missing safe feature column ${col}`);
  }
});

test("target is binary 0/1", () => {
  const { header, lines } = loadHeaderAndRows();
  const idx = header.indexOf(TARGET);
  const seen = new Set();
  for (let i = 1; i < Math.min(lines.length, 500); i++) {
    const cells = lines[i].split(",");
    seen.add(cells[idx]);
  }
  for (const v of seen) {
    assert.ok(v === "0" || v === "1", `target had non-binary value: ${v}`);
  }
});

test("both classes are represented (not degenerate)", () => {
  const { header, lines } = loadHeaderAndRows();
  const idx = header.indexOf(TARGET);
  let zeros = 0;
  let ones = 0;
  for (let i = 1; i < lines.length; i++) {
    const v = lines[i].split(",")[idx];
    if (v === "0") zeros++;
    else if (v === "1") ones++;
  }
  assert.ok(zeros > 0 && ones > 0, `degenerate target: zeros=${zeros} ones=${ones}`);
});

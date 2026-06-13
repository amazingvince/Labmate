/**
 * upload_skills.mjs — upload Labmate's 4 custom DS skills to the Anthropic
 * workspace via the Skills API, then print a LABMATE_SKILL_IDS=skill_a,skill_b,...
 * line to paste into .env so bootstrap.mjs can attach them to the agent.
 *
 *   npm run skills:upload          (from apps/agent-runtime)
 *   node src/upload_skills.mjs
 *
 * This is an ENHANCEMENT, not load-bearing: DS_SYSTEM_PROMPT in bootstrap.mjs
 * already inlines the core methodology, and bootstrap attaches zero skills when
 * LABMATE_SKILL_IDS is empty. So we exit non-zero with a clear message on any
 * failure rather than half-wiring the agent.
 *
 * Needs network + a real ANTHROPIC_API_KEY (loaded from the repo .env). Do not
 * run in CI without a key.
 *
 * ── Skills API shape (CONFIRMED) ────────────────────────────────────────────
 * Endpoints (beta header `skills-2025-10-02`; the SDK adds it when we also pass
 * it in `betas`):
 *   POST /v1/skills                  -> client.beta.skills.create(params)
 *   POST /v1/skills/{id}/versions    -> client.beta.skills.versions.create(id, params)
 *   GET  /v1/skills                  -> client.beta.skills.list(params)
 *
 * The request is multipart/form-data. The SDK's `SkillCreateParams` is:
 *     { display_title?: string | null;
 *       files?: Array<Uploadable> | null;
 *       betas?: Array<AnthropicBeta>; }
 * and `VersionCreateParams` is { files?: Array<Uploadable> | null; betas?: ... }
 * (NO display_title on a version). Source: anthropic-sdk-typescript
 * src/resources/beta/skills/{skills,versions}.ts.
 *
 * Files are uploaded as `Uploadable`s built with the SDK's `toFile(...)` helper.
 * The SDK doc comment on `files` states: "Files to upload for the skill. All
 * files must be in the same top-level directory and must include a SKILL.md
 * file at the root of that directory." So each file's name must be
 * "<dir>/<path>" and one of them must be "<dir>/SKILL.md". We upload one file
 * per skill: `toFile(<SKILL.md bytes>, "<skill-name>/SKILL.md", {type:"text/markdown"})`.
 * Confirmed against the docs example (build-with-claude/skills-guide):
 *     files: [ await toFile(fs.createReadStream("financial_skill/SKILL.md"),
 *                "financial_skill/SKILL.md", { type: "text/markdown" }) ]
 * and the raw curl: `-F "files[]=@.../SKILL.md;filename=financial_skill/SKILL.md"`.
 *
 * The skill's identity `name` comes from the SKILL.md YAML frontmatter (NOT from
 * an API field). `display_title` is the separate human label we pass to create().
 *
 * Skill `name` rules (docs/agent-skills/overview): max 64 chars, lowercase
 * letters/numbers/hyphens only, no reserved words "anthropic"/"claude". Our four
 * skill dir names already satisfy this.
 *
 * ── Uncertainty ─────────────────────────────────────────────────────────────
 * The exact field name carrying a skill's frontmatter `name` on the LIST/GET
 * response is not 100% nailed down in the public type stubs we could fetch
 * (VersionCreateResponse exposes `name`; the SkillListResponse element shape was
 * not in the fetched stub). For idempotency we therefore match a previously
 * uploaded skill by checking several plausible fields (name / display_title and
 * any nested latest-version name) case-insensitively. If the match misses, we
 * fall back to CREATING a new skill — the API allows duplicate display titles —
 * which is safe (just an extra workspace skill), never destructive. Verify the
 * real list-response field with: `client.beta.skills.list()` against your
 * workspace, or src/resources/beta/skills/skills.ts (SkillListResponse) for the
 * pinned @anthropic-ai/sdk build.
 */
import Anthropic, { toFile } from "@anthropic-ai/sdk";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const envPath = join(repoRoot, ".env");
const skillsRoot = join(repoRoot, ".claude", "skills");

// Beta header for the Skills API. Confirmed: skills-2025-10-02.
const SKILLS_BETA = "skills-2025-10-02";

// The four Labmate custom DS skills. The directory name IS the skill `name`
// declared in each SKILL.md frontmatter; `title` is the human display_title.
const SKILLS = [
  { dir: "tabular-ds-protocol", title: "Labmate: Tabular DS protocol" },
  { dir: "leakage-review", title: "Labmate: Leakage review" },
  { dir: "optuna-search", title: "Labmate: Optuna search" },
  { dir: "model-card", title: "Labmate: Model card" },
];

/**
 * Load .env into process.env. Tolerates both dotenv `KEY=value` and `KEY: value`
 * (the repo's .env uses the colon form); the separator is the FIRST `=` or `:`,
 * so values containing `:` (e.g. http://host:8787) parse correctly.
 * Reused verbatim from src/bootstrap.mjs loadEnv.
 */
function loadEnv() {
  if (!existsSync(envPath)) return {};
  const map = {};
  for (const raw of readFileSync(envPath, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    const colon = line.indexOf(":");
    const i = eq === -1 ? colon : colon === -1 ? eq : Math.min(eq, colon);
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    map[k] = v;
    if (process.env[k] === undefined) process.env[k] = v;
  }
  return map;
}

/** Pull the frontmatter `name` out of a SKILL.md so we can match/report on it. */
function frontmatterName(md) {
  // Frontmatter is a leading `---` block; grab the first `name:` line in it.
  const fm = md.match(/^---\s*[\r\n]([\s\S]*?)[\r\n]---/);
  const block = fm ? fm[1] : md;
  const m = block.match(/^\s*name\s*:\s*(.+?)\s*$/m);
  return m ? m[1].trim() : null;
}

/**
 * Best-effort match of an already-uploaded skill to one of ours. `display_title`
 * is the only human-controlled field the Skills list/create response carries, and
 * it's what we set on create — so match on it (case-insensitively) against the
 * title/name we'd upload with.
 */
function matchExisting(existing, { name, title }) {
  const dt = existing?.display_title;
  if (!dt) return false;
  const have = String(dt).toLowerCase();
  return [name, title].filter(Boolean).some((w) => String(w).toLowerCase() === have);
}

async function listAllSkills(client) {
  const out = [];
  try {
    // skills.list auto-paginates on iteration (cursor page).
    for await (const s of client.beta.skills.list({ betas: [SKILLS_BETA] })) {
      out.push(s);
    }
  } catch (err) {
    // Listing is only used for idempotency; if it fails (e.g. endpoint shape
    // drift) we proceed to create and warn rather than abort.
    console.warn(
      `  (could not list existing skills — will create fresh: ${err?.message ?? err})`,
    );
  }
  return out;
}

async function uploadOne(client, existingSkills, { dir, title }) {
  const mdPath = join(skillsRoot, dir, "SKILL.md");
  if (!existsSync(mdPath)) {
    throw new Error(`missing SKILL.md for "${dir}" at ${mdPath}`);
  }
  const md = readFileSync(mdPath, "utf8");
  const name = frontmatterName(md) || dir;

  // All files must share one top-level dir with SKILL.md at its root. Each
  // Labmate skill is a single SKILL.md, so we upload "<name>/SKILL.md".
  const buildFiles = async () => [
    await toFile(Buffer.from(md, "utf8"), `${name}/SKILL.md`, {
      type: "text/markdown",
    }),
  ];

  const prior = existingSkills.find((s) => matchExisting(s, { name, title }));
  if (prior?.id) {
    // Idempotent path: add a new VERSION to the existing skill instead of
    // creating a duplicate. version.create takes no display_title.
    console.info(`  ${name}: exists (${prior.id}) -> uploading new version`);
    const version = await client.beta.skills.versions.create(prior.id, {
      files: await buildFiles(),
      betas: [SKILLS_BETA],
    });
    return {
      name,
      id: prior.id,
      version: version?.version ?? version?.id ?? "latest",
      action: "versioned",
    };
  }

  console.info(`  ${name}: creating new skill`);
  const skill = await client.beta.skills.create({
    display_title: title,
    files: await buildFiles(),
    betas: [SKILLS_BETA],
  });
  const id = skill?.id;
  if (!id) throw new Error(`create returned no id for "${name}"`);
  return {
    name,
    id,
    version: skill?.latest_version ?? "latest",
    action: "created",
  };
}

async function main() {
  loadEnv();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing ANTHROPIC_API_KEY. Set it in the repo .env (KEY=value or KEY: value).",
    );
  }

  const client = new Anthropic({ apiKey });

  console.info(
    `Uploading ${SKILLS.length} Labmate DS skills to the Anthropic workspace...`,
  );
  const existing = await listAllSkills(client);

  const results = [];
  for (const spec of SKILLS) {
    // Sequential on purpose: clearer per-skill logging and gentler on rate limits.
    results.push(await uploadOne(client, existing, spec));
  }

  const ids = results.map((r) => r.id);

  console.info("\nSummary:");
  for (const r of results) {
    console.info(`  ${r.action.padEnd(9)} ${r.name}  ${r.id}  (version ${r.version})`);
  }
  console.info(
    "\nPaste this into your repo .env (bootstrap.mjs maps each id to " +
      '{type:"custom", skill_id, version:"latest"}):\n',
  );
  console.info(`LABMATE_SKILL_IDS=${ids.join(",")}`);
  console.info(
    "\nThen re-run bootstrap to bake them into the agent: " +
      "node src/bootstrap.mjs --force",
  );
}

main().catch((err) => {
  console.error("\nSkill upload failed:", err?.message ?? err);
  if (err?.request_id) console.error("request_id:", err.request_id);
  console.error(
    "Skills are an enhancement — the agent still works without them " +
      "(DS_SYSTEM_PROMPT inlines the methodology). Fix the error and re-run.",
  );
  process.exit(1);
});

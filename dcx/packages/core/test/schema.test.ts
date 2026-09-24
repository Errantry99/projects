import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";
import type Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  calibrateAnswer,
  migrateDuckdb,
  migrateSqlite,
  openJournal,
  openWarehouse,
  STEP_KINDS,
  type WarehouseHandle,
} from "../src/index.js";

const dir = mkdtempSync(join(tmpdir(), "dcx-core-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SQLITE_TABLES = ["runs", "steps", "tool_calls", "hitl_queue", "outbox"];
const DUCKDB_TABLES = [
  "records",
  "content",
  "questions",
  "projections",
  "judge_calls",
  "judgments",
  "judge_uses",
  "llm_calls",
  "trace_steps",
  "tool_schemas",
  "routes",
  "labels",
  "calibrators",
  "thresholds",
  "prices",
  "decision_points",
  "proposals",
  "promotions",
  "processes",
  "dcx_outbox_applied",
];
const DUCKDB_VIEWS = [
  "training_labels",
  "decisions",
  "decision_actions",
  "asks",
  "savings_ledger",
];

async function rows(conn: DuckDBConnection, sql: string, params: unknown[] = []) {
  const r = await conn.runAndReadAll(sql, params as never);
  return r.getRowObjectsJson() as Record<string, unknown>[];
}

describe("SQLite journal", () => {
  let db: Database.Database;
  beforeAll(() => {
    db = openJournal(join(dir, "journal.sqlite"));
  });
  afterAll(() => db.close());

  it("uses WAL and migrates idempotently", () => {
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(migrateSqlite(db)).toEqual([]);
    db.close();
    db = openJournal(join(dir, "journal.sqlite"));
    expect(migrateSqlite(db)).toEqual([]);
    const v = db.prepare("SELECT version FROM schema_migrations").all();
    expect(v).toEqual([{ version: 1 }]);
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    for (const t of SQLITE_TABLES) expect(names).toContain(t);
  });

  it("accepts a row in every table", () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO runs (run_id, workflow, workflow_v, status, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("r1", "screen-baseline", 1, "running", now);
    db.prepare(
      `INSERT INTO steps (run_id, step_no, kind, name, status, mode, output, started_at)
       VALUES ('r1', 1, 'judge', 'screen', 'completed', 'active', '{"ok":true}', ?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO tool_calls (run_id, step_no, tool, args_canonical, args_hash, in_doubt)
       VALUES ('r1', 2, 'send', '{}', 'h', 0)`,
    ).run();
    db.prepare(
      `INSERT INTO hitl_queue (id, kind, run_id, step_no, card, created_at)
       VALUES ('h1', 'review', 'r1', 3, '{}', ?)`,
    ).run(now);
    db.prepare("INSERT INTO outbox (target_table, row, created_at) VALUES (?, ?, ?)").run(
      "llm_calls",
      JSON.stringify({ call_id: "c1", run_id: "r1" }),
      now,
    );
    for (const t of SQLITE_TABLES) {
      const n = db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number };
      expect(n.n, t).toBe(1);
    }
  });

  it("enforces steps.kind, mode and insert-if-absent", () => {
    const ins = db.prepare(
      "INSERT INTO steps (run_id, step_no, kind, name, status, mode) VALUES (?, ?, ?, 'n', 's', ?)",
    );
    expect(() => ins.run("r1", 10, "magic", "active")).toThrow(/CHECK/);
    expect(() => ins.run("r1", 11, "sql", "live")).toThrow(/CHECK/);
    STEP_KINDS.forEach((k, i) => {
      ins.run("r1", 100 + i, k, "active");
    });
    expect(() => ins.run("r1", 1, "sql", "active")).toThrow(/UNIQUE|PRIMARY/);
    const r = db
      .prepare(
        "INSERT INTO steps (run_id, step_no, kind, name, status, mode) VALUES ('r1', 1, 'sql', 'n', 's', 'active') ON CONFLICT DO NOTHING",
      )
      .run();
    expect(r.changes).toBe(0);
  });

  it("the outbox CHECK keeps Jev-sourced labels out of the journal (H5)", () => {
    const ins = db.prepare(
      "INSERT INTO outbox (target_table, row, created_at) VALUES ('labels', ?, 0)",
    );
    for (const source of [
      "llm:jev",
      "jev",
      "LLM:JEV-1.13.0",
      "rule:jev",
      "llm:typesafe",
      "llm:",
    ]) {
      expect(() => ins.run(JSON.stringify({ source })), source).toThrow(/CHECK/);
    }
    expect(() => ins.run(JSON.stringify({}))).toThrow(/CHECK/);
    for (const source of ["human", "behaviour", "llm:claude", "rule:x"]) {
      expect(() => ins.run(JSON.stringify({ source })), source).not.toThrow();
    }
  });
});

describe("DuckDB warehouse", () => {
  let wh: WarehouseHandle;
  let conn: DuckDBConnection;
  const path = join(dir, "warehouse.duckdb");
  beforeAll(async () => {
    wh = await openWarehouse(path);
    conn = wh.conn;
  });
  afterAll(() => wh.close());

  it("migrates idempotently (twice, across reopen)", async () => {
    expect(await migrateDuckdb(conn)).toEqual([]);
    wh.close();
    wh = await openWarehouse(path);
    conn = wh.conn;
    expect(await migrateDuckdb(conn)).toEqual([]);
    expect(await rows(conn, "SELECT version FROM schema_migrations")).toEqual([{ version: 1 }]);
    const names = (await rows(conn, "SELECT table_name FROM information_schema.tables")).map(
      (r) => r.table_name,
    );
    for (const t of [...DUCKDB_TABLES, ...DUCKDB_VIEWS]) expect(names).toContain(t);
  });

  it("accepts a row in every table, and the views read them", async () => {
    const H = (c: string) => c.repeat(64);
    const stmts = [
      `INSERT INTO records (record_id, kind, source, state, state_hash)
       VALUES ('rec1', 'paper', 'synergy', '{"untrusted_record":{"title":"T","abstract":"A"}}', 'sh1')`,
      `INSERT INTO content (ref, body, pii_class) VALUES ('c:1', '{"x":1}', 'public')`,
      `INSERT INTO questions (question_id, version, question_hash, qtype, instructions, options,
         no_match_label, fields, fields_key, max_state_tokens, status, applies_to)
       VALUES ('screen.crit_1', 1, '${H("q")}', 'choice', 'Meets?',
         '[{"label":"meets","description":"m"},{"label":"other","description":"o"}]',
         'other', ['untrusted_record.abstract'], '["untrusted_record.abstract"]', 512, 'active', 'paper'),
         ('screen.on_topic', 1, '${H("n")}', 'noul', 'On topic?', '[]', NULL,
          ['untrusted_record.title'], '["untrusted_record.title"]', 512, 'active', NULL)`,
      `INSERT INTO projections VALUES ('rec1', '["untrusted_record.abstract"]', 'sh1', '${H("p")}',
         '{"untrusted_record":{"abstract":"A"}}')`,
      `INSERT INTO judge_calls (call_id, backend, model_req, model_v, n_questions, input_tokens,
         cost_usd, cost_basis, latency_ms, attempts, status)
       VALUES ('00000000-0000-0000-0000-000000000001', 'jev', 'jev-1.13.0', 'jev-1.13.0', 2, 100,
         0.0002, 'token-price', 120, 1, 'ok')`,
      `INSERT INTO judgments (payload_hash, question_hash, backend, model_v, sample_no, question_id,
         question_v, qtype, answer, p_answer, probs, call_id) VALUES
         ('${H("p")}', '${H("q")}', 'jev', 'jev-1.13.0', 0, 'screen.crit_1', 1, 'choice', 'meets', 0.8,
          MAP {'meets': 0.8, 'other': 0.2}, '00000000-0000-0000-0000-000000000001'),
         ('${H("p")}', '${H("q")}', 'jev', 'jev-1.13.0', 1, 'screen.crit_1', 1, 'choice', 'other', 0.6,
          MAP {'meets': 0.4, 'other': 0.6}, '00000000-0000-0000-0000-000000000001'),
         ('${H("t")}', '${H("n")}', 'jev', 'jev-1.13.0', 0, 'screen.on_topic', 1, 'noul', 'false', 0.1,
          MAP {'true': 0.1, 'false': 0.9}, '00000000-0000-0000-0000-000000000001')`,
      `INSERT INTO judge_uses (run_id, step_no, record_id, question_hash, payload_hash, backend,
         model_v, mode, cache_hit) VALUES
         ('run1', 1, 'rec1', '${H("q")}', '${H("p")}', 'jev', 'jev-1.13.0', 'active', false),
         ('run1', 1, 'rec1', '${H("n")}', '${H("t")}', 'jev', 'jev-1.13.0', 'shadow', true)`,
      `INSERT INTO llm_calls (call_id, run_id, step_no, workflow, workflow_v, record_ids,
         template_id, template_v, template_hash, slots, model_requested, model_returned,
         output_kind, parsed, normalised_answer, effect, branch_taken, input_tokens, output_tokens,
         cost_usd, cost_basis, latency_ms, retries, label_source, is_jev_output, teacher_blind)
       VALUES ('llm1', 'run1', 2, 'screen-compiled', 1, ['rec1'], 'screen', 1, 'th',
         '{"abstract":{"path":"untrusted_record.abstract","field_hash":"fh"}}', 'm', 'm-1',
         'structured', '{"answer":"include"}', 'include', '{"route":"include"}', 'include', 900, 20,
         0.005, 'token-price', 2100, 0, 'llm:m-1', false, true)`,
      `INSERT INTO trace_steps (run_id, step_no, kind, name, status, mode, activity, record_id)
       VALUES ('run1', 1, 'judge', 'screen', 'completed', 'active', 'judge:screen', 'rec1')`,
      `INSERT INTO tool_schemas VALUES ('tsh', 'send', '{"type":"object"}')`,
      `INSERT INTO routes (run_id, step_no, record_id, decision_point_id, tiers, branch_taken,
         reason_code, threshold_id, cost_usd, mode)
       VALUES ('run1', 3, 'rec1', 'dp1', '[]', 'include', 'above_threshold', 'th1', 0.0001, 'active')`,
      `INSERT INTO labels (record_id, target_kind, target_ref, label, source, labeller, split,
         selected_by, teacher_blind) VALUES
         ('rec1', 'question', 'screen.crit_1@1', 'meets', 'human', 'author', 'tune', 'exhaustive', NULL),
         ('rec1', 'question', 'screen.crit_1@1', 'meets', 'human', 'owner', 'tune', 'jev_disagreement', NULL),
         ('rec1', 'question', 'screen.crit_1@1', 'meets', 'llm:claude', 'm', 'tune', 'audit', true)`,
      `INSERT INTO calibrators (calibrator_id, question_hash, backend, model_v, method, params, status)
       VALUES ('cal1', '${H("q")}', 'jev', 'jev-1.13.0', 'isotonic',
         '{"knots":[[0,0],[0.5,0.3],[1,0.9]]}', 'active'),
              ('cal2', '${H("n")}', 'jev', 'jev-1.13.0', 'platt', '{"a":1.5,"b":-0.2}', 'active')`,
      `INSERT INTO thresholds (threshold_id, policy_id, question_hash, backend, model_v,
         calibrator_id, action, rule, valid_from, status) VALUES
         ('th1', 'screen', '${H("q")}', 'jev', 'jev-1.13.0', 'cal1', 'auto_include',
          '{"label":"meets","min_p":0.7,"on_error":"human"}', TIMESTAMPTZ '2000-01-01', 'active'),
         ('th2', 'screen', '${H("q")}', 'jev', 'jev-1.13.0', 'cal1', 'auto_flag',
          '{"label":null,"min_p":0.95,"abstain_band":[0.2,0.95],"on_error":"human"}',
          TIMESTAMPTZ '2000-01-01', 'active')`,
      `INSERT INTO prices VALUES ('jev', 'jev-1.13.0', 0.042, 0, TIMESTAMPTZ '2026-01-01')`,
      `INSERT INTO decision_points (dp_id, template_fp, n, k, class) VALUES ('dp1', 'fp', 300, 3, 'question')`,
      `INSERT INTO proposals (proposal_id, artefact_kind, artefact_ref, dp_id, status)
       VALUES ('pr1', 'question', 'screen.crit_1@1', 'dp1', 'proposed')`,
      `INSERT INTO promotions (proposal_id, from_status, to_status, approver, decision)
       VALUES ('pr1', 'proposed', 'shadow', 'owner', 'approve')`,
      `INSERT INTO processes (process_id, version, spec, status) VALUES ('screen', 1, '{"nodes":[]}', 'shadow')`,
      `INSERT INTO dcx_outbox_applied (seq, target_table) VALUES (1, 'labels')`,
    ];
    for (const s of stmts) await conn.run(s);
    for (const t of DUCKDB_TABLES) {
      const [r] = await rows(conn, `SELECT count(*)::INTEGER AS n FROM ${t}`);
      expect(r?.n, t).toBeGreaterThanOrEqual(1);
    }

    // decisions: repeat samples excluded, isotonic applied, noul p_cal_answer is the max side.
    const d = await rows(
      conn,
      "SELECT question_id, answer, p_answer, p_cal, p_cal_answer, calibrator_id FROM decisions ORDER BY question_id",
    );
    expect(d).toHaveLength(2);
    const crit = d.find((r) => r.question_id === "screen.crit_1");
    const topic = d.find((r) => r.question_id === "screen.on_topic");
    const expCrit = calibrateAnswer(
      "choice",
      "isotonic",
      {
        knots: [
          [0, 0],
          [0.5, 0.3],
          [1, 0.9],
        ],
      },
      "meets",
      0.8,
    );
    expect(crit?.p_cal as number).toBeCloseTo(expCrit.pCal as number, 12);
    const expTopic = calibrateAnswer("noul", "platt", { a: 1.5, b: -0.2 }, "false", 0.1);
    expect(topic?.p_cal as number).toBeCloseTo(expTopic.pCal as number, 12);
    expect(topic?.p_cal_answer as number).toBeCloseTo(expTopic.pCalAnswer as number, 12);
    expect(topic?.p_cal_answer as number).toBeGreaterThan(0.5);

    const acts = await rows(
      conn,
      "SELECT threshold_id, outcome, band_lo FROM decision_actions ORDER BY threshold_id",
    );
    // p_cal = 0.3 + 0.6 * 0.6 = 0.66: th1 (min_p 0.7, floor 0.5) → abstain_band;
    // th2 (min_p 0.95, band from 0.2) → abstain_band.
    expect(acts).toEqual([
      { threshold_id: "th1", outcome: "abstain_band", band_lo: 0.5 },
      { threshold_id: "th2", outcome: "abstain_band", band_lo: 0.2 },
    ]);

    // judgments ON CONFLICT DO NOTHING (the cache is immutable).
    await conn.run(
      `INSERT INTO judgments (payload_hash, question_hash, backend, model_v, qtype, answer, p_answer)
       VALUES ('${H("p")}', '${H("q")}', 'jev', 'jev-1.13.0', 'choice', 'other', 0.1)
       ON CONFLICT DO NOTHING`,
    );
    const [j] = await rows(
      conn,
      `SELECT answer FROM judgments WHERE payload_hash = '${H("p")}' AND sample_no = 0`,
    );
    expect(j?.answer).toBe("meets");

    const tl = await rows(conn, "SELECT labeller FROM training_labels");
    expect(tl).toEqual([{ labeller: "author" }]);

    const asks = await rows(
      conn,
      "SELECT question_id, payload_hash, candidate_set_hash, pack_mode, sample_no FROM asks ORDER BY question_id",
    );
    expect(asks).toEqual([
      {
        question_id: "screen.crit_1",
        payload_hash: H("p"),
        candidate_set_hash: "",
        pack_mode: "single",
        sample_no: 0,
      },
      {
        question_id: "screen.on_topic",
        payload_hash: null,
        candidate_set_hash: "",
        pack_mode: "single",
        sample_no: 0,
      },
    ]);

    const [led] = await rows(conn, "SELECT * FROM savings_ledger WHERE run_id = 'run1'");
    expect(led?.llm_calls).toBe("1");
    expect(led?.judge_uses).toBe("2");
    expect(led?.judge_cache_hits).toBe("1");
    expect(led?.judge_cost_usd as number).toBeCloseTo(0.0001, 12);
    expect(led?.coverage_without_llm).toBe(1);
  });

  it("labels.source CHECK: rejects Jev, accepts the four allowed forms (H5)", async () => {
    const ins = (source: string) =>
      conn.run(
        `INSERT INTO labels (record_id, target_kind, target_ref, label, source)
         VALUES ('rec1', 'question', 'q', 'x', $1)`,
        [source],
      );
    for (const s of [
      "llm:jev",
      "jev",
      "LLM:Jev-1.13.0",
      "rule:jev_x",
      "llm:typesafe",
      "llm:",
      "person",
    ]) {
      await expect(ins(s), s).rejects.toThrow(/CHECK/);
    }
    for (const s of ["human", "behaviour", "llm:claude", "rule:x"]) {
      await expect(ins(s), s).resolves.toBeDefined();
    }
  });

  it("status, kind, mode and pin CHECKs", async () => {
    await expect(
      conn.run(
        "INSERT INTO proposals (proposal_id, artefact_kind, artefact_ref, status) VALUES ('p9', 'question', 'x', 'draft')",
      ),
    ).rejects.toThrow(/CHECK/);
    await expect(
      conn.run(
        "INSERT INTO trace_steps (run_id, step_no, kind, name, status, mode, activity) VALUES ('r', 1, 'magic', 'n', 's', 'active', 'a')",
      ),
    ).rejects.toThrow(/CHECK/);
    await expect(
      conn.run(
        "INSERT INTO judge_uses (run_id, step_no, question_hash, payload_hash, backend, model_v, mode, cache_hit) VALUES ('r', 1, 'q', 'p', 'b', 'm', 'live', false)",
      ),
    ).rejects.toThrow(/CHECK/);
    await expect(
      conn.run(
        "INSERT INTO judge_calls (backend, model_v, n_questions, cost_basis, status) VALUES ('jev', 'jev-latest', 1, 'zero', 'ok')",
      ),
    ).rejects.toThrow(/CHECK/);
  });
});

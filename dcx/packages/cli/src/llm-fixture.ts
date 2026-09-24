// A kernel `LlmClient` that replays recorded responses (07 §6 PR tier: no key, no network).
// Files live at `<root>/<template_id>@<v>/<record_id>.json` (see dcx/fixtures/README.md). A
// response is served only when the recorded template text hash and model match the request; a
// miss or a mismatch throws, so a changed prompt fails loudly instead of replaying stale text.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Json, type LlmReq, type LlmRes, sha256Hex } from "@dcx/core";
import type { LlmClient } from "@dcx/kernel";

interface LlmFixtureFile {
  recordId: string;
  request: {
    template_id: string;
    template_v: number;
    template_text_sha256: string;
    model: string;
  };
  response: Omit<LlmRes, "callId">;
}

export class LlmFixtureMiss extends Error {
  override name = "LlmFixtureMiss";
}

export class FixtureLlm implements LlmClient {
  readonly provider = "fixture";
  private readonly cache = new Map<string, LlmFixtureFile>();
  calls = 0;

  constructor(private readonly root: string) {}

  private load(path: string): LlmFixtureFile {
    let f = this.cache.get(path);
    if (!f) {
      if (!existsSync(path)) throw new LlmFixtureMiss(`no LLM fixture at ${path}`);
      f = JSON.parse(readFileSync(path, "utf8")) as LlmFixtureFile;
      this.cache.set(path, f);
    }
    return f;
  }

  async complete<T extends Json>(
    req: LlmReq<T>,
    _o: { callId: string },
  ): Promise<Omit<LlmRes<T>, "callId">> {
    const recordId = req.recordIds?.[0];
    if (!recordId) throw new LlmFixtureMiss("fixture LLM needs req.recordIds[0]");
    const dir = `${req.template.id}@${req.template.version}`;
    const f = this.load(join(this.root, dir, `${recordId}.json`));
    const sha = sha256Hex(req.template.text);
    if (f.request.template_text_sha256 !== sha) {
      throw new LlmFixtureMiss(`${dir}/${recordId}: template text changed since recording`);
    }
    if (f.request.model !== req.model) {
      throw new LlmFixtureMiss(
        `${dir}/${recordId}: recorded for model ${f.request.model}, requested ${req.model}`,
      );
    }
    this.calls++;
    return f.response as unknown as Omit<LlmRes<T>, "callId">;
  }
}

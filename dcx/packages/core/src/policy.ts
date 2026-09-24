// Policy guards shared by every package: model pinning (02 §3.4 "lint bans jev-latest") and the
// H5 label-source rule (07 §1 H5, §3 item 13). The DDL enforces the same rules; these let code
// fail early with a clear message.

/** True for model aliases that are not pinned versions: `latest`, `*-latest`, `*:latest`. */
export function isUnpinnedModel(model: string): boolean {
  return /(^|[-:@/])latest$/i.test(model.trim());
}

/** Throws unless `model` is a non-empty, pinned version (rejects `jev-latest`). */
export function assertPinned(model: string): void {
  if (!model || model.trim() === "") throw new Error("model version is required");
  if (isUnpinnedModel(model)) {
    throw new Error(`model "${model}" is an alias; pin a version (e.g. jev-1.13.0)`);
  }
}

/** Substrings a label source may never contain (case-insensitive). Mirrors the DDL CHECK. */
export const BANNED_LABEL_SOURCE_SUBSTRINGS = ["jev", "typesafe"] as const;

/**
 * Mirrors the `labels.source` CHECK: 'human' | 'behaviour' | 'llm:<model>' | 'rule:<id>', and
 * never anything naming Jev/TypeSafe (so 'llm:jev-1.13.0' and 'rule:jev_x' are rejected).
 */
export function isAllowedLabelSource(source: string): boolean {
  const lower = source.toLowerCase();
  if (BANNED_LABEL_SOURCE_SUBSTRINGS.some((b) => lower.includes(b))) return false;
  return (
    source === "human" ||
    source === "behaviour" ||
    (source.startsWith("llm:") && source.length > 4) ||
    (source.startsWith("rule:") && source.length > 5)
  );
}

/** Label sources that may train anything (the `training_labels` view). */
export const TRAINING_LABEL_SOURCES = ["human", "behaviour"] as const;

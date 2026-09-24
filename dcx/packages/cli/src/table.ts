// A plain-text table: columns padded to their widest cell, two spaces apart.

export function table(head: readonly string[], rows: readonly (readonly string[])[]): string {
  const all = [head, ...rows];
  const w = head.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  return all
    .map((r) =>
      r
        .map((c, i) => c.padEnd((w[i] ?? 0) + 2))
        .join("")
        .trimEnd(),
    )
    .join("\n");
}

export const f3 = (x: number | null | undefined) =>
  x === null || x === undefined || !Number.isFinite(x) ? "–" : x.toFixed(3);

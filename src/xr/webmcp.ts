import { describePlan, toolSpecs, type CommandBus, type CommandName } from '../core/commands.js';
import type { WallCheck } from '../core/fit.js';

/**
 * Offer the plan's commands to a browser AI agent through WebMCP
 * (document.modelContext). Every tool runs a normal command, tagged as
 * coming from an assistant, so it's checked, lock-aware and undoable.
 * Does nothing in browsers without WebMCP.
 */

interface ModelContext {
  registerTool(tool: unknown, opts?: { signal?: AbortSignal }): unknown;
}

const text = (v: unknown) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }] });

export function registerWebMcp(cmd: CommandBus, onChange: () => void, verify?: () => WallCheck[] | null): () => void {
  const mc = ((document as unknown as { modelContext?: ModelContext }).modelContext ??
    (navigator as unknown as { modelContext?: ModelContext }).modelContext) as ModelContext | undefined;
  if (!mc?.registerTool) return () => {};
  const ctrl = new AbortController();
  const reg = (tool: Record<string, unknown>) => {
    try {
      void Promise.resolve(mc.registerTool(tool, { signal: ctrl.signal })).catch(() => {});
    } catch {
      /* older shape: ignore */
    }
  };
  reg({
    name: 'plan_describe',
    description: 'Read the basement plan: walls (with openings, phase new/existing/demolish, evidence), rooms, pins, soffits. Units: inches.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    execute: async () => text(describePlan(cmd.store.plan)),
  });
  reg({
    name: 'plan_verify',
    description:
      'Check real walls against the scanned room mesh. For each wall: evidence (measured/partial/inferred), deviation in inches between the drawn faces and the mesh, coverage, and where the mesh says the wall is. Use after edits to confirm they match reality.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    execute: async () => {
      const r = verify?.();
      if (!r) return text('No room mesh yet: scan the room first.');
      const q = (n: number) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);
      return text(
        r.map((c) => ({
          wallId: c.wallId,
          evidence: c.check.evidence,
          deviation: q(c.check.deviation),
          coverage: q(c.check.coverage),
          meshSays: { a: c.fitted.a, b: c.fitted.b, thickness: q(c.fitted.thickness) },
          openings: c.check.openings.map((o) => ({ evidence: o.evidence, blocked: q(o.blocked), meshWidth: q(o.width) })),
        })),
      );
    },
  });
  reg({
    name: 'plan_undo',
    description: 'Undo the last change to the plan.',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => text(cmd.store.undo() ? 'Undone' : 'Nothing to undo'),
  });
  for (const t of toolSpecs()) {
    reg({
      name: t.name.replace('.', '_'),
      description: t.description,
      inputSchema: t.inputSchema,
      execute: async (input: unknown) => {
        const r = cmd.exec(t.name as CommandName, input as never, 'assistant');
        onChange();
        return text(r.ok ? { ok: true, result: r.value ?? null } : { ok: false, error: r.error });
      },
    });
  }
  return () => ctrl.abort();
}

import type { BoundaryError, CompileResult, DiscoveryContext, NormalizedSkillInput, SkillConflictDiagnostic, SkillManifest, SkillSection, SkillSourceRef } from '../types.js';
import { buildManifest, buildSections } from './manifest.js';

function toSourceRef(input: NormalizedSkillInput): SkillSourceRef {
  return { system: input.system, sourcePath: input.sourcePath, sourceHash: input.sourceHash };
}

export function compile(inputs: NormalizedSkillInput[], ctx: DiscoveryContext): CompileResult {
  const store = new Map<string, SkillSection>();
  const errors: BoundaryError[] = [];
  const manifests: SkillManifest[] = [];
  const diagnostics: SkillConflictDiagnostic[] = [];
  // ponytail: global collision tracking across all inputs
  const seenIds = new Map<string, number>();

  // Group inputs by system::skillName
  const groups = new Map<string, NormalizedSkillInput[]>();
  for (const input of inputs) {
    const key = `${input.system}::${input.skillName}`;
    const group = groups.get(key);
    if (group) group.push(input);
    else groups.set(key, [input]);
  }

  // Select winners: precedence DESC (higher wins), then sourcePath ASC, then sourceHash ASC
  const winners: NormalizedSkillInput[] = [];
  for (const [, group] of groups) {
    const sorted = [...group].sort((a, b) =>
      b.precedence - a.precedence ||
      a.sourcePath.localeCompare(b.sourcePath) ||
      a.sourceHash.localeCompare(b.sourceHash)
    );
    const winner = sorted[0]!;
    winners.push(winner);

    if (sorted.length > 1) {
      const conflictKey = `${winner.system}::${winner.skillName}`;
      const shadowed = sorted.slice(1).map(toSourceRef);
      // Determine reason: all shadowed have same or lower precedence than winner
      // check if any shadowed had same precedence as winner (tiebreak)
      const samePrec = shadowed.some(s => {
        const inp = sorted.slice(1).find(i => i.sourcePath === s.sourcePath && i.sourceHash === s.sourceHash);
        return inp?.precedence === winner.precedence;
      });
      diagnostics.push({
        conflictKey,
        winner: toSourceRef(winner),
        shadowed,
        reason: samePrec ? 'same_precedence_tiebreak' : 'higher_precedence',
        winnerPrecedence: winner.precedence
      });
    }
  }

  // Sort winners for deterministic output order
  winners.sort((a, b) =>
    a.system.localeCompare(b.system) ||
    a.skillName.localeCompare(b.skillName) ||
    a.sourcePath.localeCompare(b.sourcePath) ||
    a.sourceHash.localeCompare(b.sourceHash)
  );

  // Build a lookup of winner -> diagnostics for manifest attachment
  const winnerDiags = new Map<NormalizedSkillInput, SkillConflictDiagnostic[]>();
  for (const d of diagnostics) {
    const winner = winners.find(w =>
      w.sourcePath === d.winner.sourcePath &&
      w.sourceHash === d.winner.sourceHash
    );
    if (winner) {
      const list = winnerDiags.get(winner);
      if (list) list.push(d);
      else winnerDiags.set(winner, [d]);
    }
  }

  for (const input of winners) {
    try {
      const sections = buildSections(input, ctx, seenIds);
      for (const section of sections) store.set(section.id, section);
      manifests.push(buildManifest(input, sections, input.precedence, winnerDiags.get(input)));
    } catch (err) {
      errors.push({ path: input.sourcePath, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { store, manifests, errors, diagnostics };
}

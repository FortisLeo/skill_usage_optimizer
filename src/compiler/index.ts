import type { BoundaryError, CompileResult, DiscoveryContext, NormalizedSkillInput, SkillManifest, SkillSection } from '../types.js';
import { buildManifest, buildSections } from './manifest.js';

export function compile(inputs: NormalizedSkillInput[], ctx: DiscoveryContext): CompileResult {
  const store = new Map<string, SkillSection>();
  const errors: BoundaryError[] = [];
  const manifests: SkillManifest[] = [];
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

    for (let i = 1; i < sorted.length; i++) {
      const loser = sorted[i]!;
      errors.push({
        path: loser.sourcePath,
        error: `Skill conflict: '${loser.system}::${loser.skillName}' dropped (precedence ${loser.precedence} < ${winner.precedence}); winner at ${winner.sourcePath}`
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

  for (const input of winners) {
    try {
      const sections = buildSections(input, ctx, seenIds);
      for (const section of sections) store.set(section.id, section);
      manifests.push(buildManifest(input, sections));
    } catch (err) {
      errors.push({ path: input.sourcePath, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { store, manifests, errors };
}

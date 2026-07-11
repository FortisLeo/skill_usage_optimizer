import { statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { DiscoveredArtifact, DiscoveryContext, SkillSection } from '../types.js';
import { normalize } from '../normalize/index.js';
import { compile } from '../compiler/index.js';

export function loadEvalSections(fixturesDir: string, names: string[]): Record<string, SkillSection[]> {
  const files = names.map(name => join(fixturesDir, name === 'well-structured' ? 'compiler' : 'eval', `${name}.md`));
  const ctx: DiscoveryContext = {
    workspaceRoot: fixturesDir,
    repoRoot: null,
    homeDir: fixturesDir,
    includeGlobals: false,
    includeSystem: false,
    explicitRoots: []
  };
  const artifacts: DiscoveredArtifact[] = files.map(absolutePath => {
    const stat = statSync(absolutePath);
    return {
      system: 'opencode',
      kind: 'instruction_file',
      absolutePath,
      relativePath: relative(fixturesDir, absolutePath),
      rootOrigin: fixturesDir,
      precedence: 70,
      configIndirection: null,
      rawStat: { mtimeMs: stat.mtimeMs, size: stat.size }
    };
  });
  const normalized = normalize(artifacts, ctx);
  if (normalized.errors.length) throw new Error(normalized.errors.map(e => e.error).join('; '));
  const result = compile(normalized.inputs, ctx);
  if (result.errors.length) throw new Error(result.errors.map(e => e.error).join('; '));

  const sections: Record<string, SkillSection[]> = {};
  for (const name of names) sections[name] = [...(result.store instanceof Map ? result.store.values() : Object.values(result.store))]
    .filter(section => section.manifestId?.includes(`::${name}::`));

  for (const skillSections of Object.values(sections)) {
    for (const section of skillSections) {
      if (section.requires) section.requires = section.requires.map(required => {
        const target = expectedSection(skillSections, required);
        return target?.id ?? required;
      });
    }
  }
  return sections;
}

export function expectedSection(sections: SkillSection[], slug: string): SkillSection | undefined {
  return sections.find(section => section.id.endsWith(`::${slug}`) || section.id.endsWith(`--${slug}`));
}

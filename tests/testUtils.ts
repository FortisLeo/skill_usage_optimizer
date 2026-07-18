import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { computeHash, normalizeContent } from '../src/fs/freshness.js';
import type { DiscoveryContext, SkillManifest, SkillSection } from '../src/types.js';

export function makeTempWorkspace(): { root: string; ctx: DiscoveryContext; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'skill-opt-test-'));
  // Create typical source-system directory structure
  mkdirSync(join(root, '.claude', 'skills'), { recursive: true });
  mkdirSync(join(root, '.opencode', 'skills'), { recursive: true });
  mkdirSync(join(root, '.codex', 'skills'), { recursive: true });
  mkdirSync(join(root, '.github', 'skills'), { recursive: true });

  const homeDir = mkdtempSync(join(tmpdir(), 'skill-opt-home-'));
  mkdirSync(join(homeDir, '.claude', 'skills'), { recursive: true });
  mkdirSync(join(homeDir, '.opencode', 'skills'), { recursive: true });
  mkdirSync(join(homeDir, '.config', 'opencode', 'skills'), { recursive: true });

  const ctx: DiscoveryContext = {
    workspaceRoot: root,
    repoRoot: null,
    homeDir,
    includeGlobals: true,
    includeSystem: false,
    explicitRoots: []
  };

  const cleanup = () => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ok */ }
    try { rmSync(homeDir, { recursive: true, force: true }); } catch { /* ok */ }
  };

  return { root, ctx, cleanup };
}

export function writeFixture(root: string, relPath: string, content: string): string {
  const full = join(root, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf-8');
  return full;
}

export function materializeIndexFixture(sourceSections: SkillSection[], sourceManifests: Record<string, SkillManifest>) {
  const root = mkdtempSync(join(tmpdir(), 'skill-opt-index-'));
  const sections = sourceSections.map(section => ({ ...section }));
  const manifests = Object.fromEntries(Object.entries(sourceManifests).map(([id, manifest]) => [id, { ...manifest }]));
  const manifestIds = new Set([...Object.keys(manifests), ...sections.map(section => section.manifestId).filter((id): id is string => !!id)]);

  let index = 0;
  for (const manifestId of manifestIds) {
    const members = sections.filter(section => section.manifestId === manifestId);
    const content = members.map(section => `## ${section.title}\n\n${section.content}`).join('\n\n');
    const sourcePath = writeFixture(root, `${index++}.md`, content);
    const stat = statSync(sourcePath);
    const sourceHash = computeHash(normalizeContent(content));
    for (const section of members) Object.assign(section, { sourcePath, sourceHash, mtimeMs: stat.mtimeMs, size: stat.size });
    if (manifests[manifestId]) {
      manifests[manifestId] = {
        ...manifests[manifestId], sourcePath, sourceHash, byteLength: stat.size,
        sections: members.map((section, order) => ({ id: section.id, title: section.title, class: section.class ?? 'phase', tokenCount: section.tokenCount ?? 0, byteLength: Buffer.byteLength(section.content), references: section.references ?? [], order: section.order ?? order }))
      };
    }
  }

  return { sections, manifests, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

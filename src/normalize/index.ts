import { basename, extname, dirname } from 'node:path';
import YAML from 'yaml';
import type { BoundaryError, DiscoveredArtifact, DiscoveryContext, NormalizeResult, NormalizedSkillInput } from '../types.js';
import { computeHash, normalizeContent } from '../fs/freshness.js';
import { isPathSafe, collectAllowedRoots } from '../fs/roots.js';
import { readBoundedSource } from '../fs/safeSource.js';
import { scannerLimits } from '../discovery/shared.js';

export function normalize(
  artifacts: DiscoveredArtifact[],
  ctx: DiscoveryContext
): NormalizeResult {
  try {
    const errors: BoundaryError[] = [];
    const inputs: NormalizedSkillInput[] = [];
    const allowedRoots = collectAllowedRoots(ctx);

    for (const a of artifacts) {
    // Security: reject artifacts with paths outside allowed roots before any read.
    try {
      if (!isPathSafe(a.absolutePath, allowedRoots)) {
        errors.push({ path: a.absolutePath, error: `artifact path outside allowed roots: ${a.absolutePath}` });
        continue;
      }
    } catch (err) {
      errors.push({ path: a.absolutePath, error: `artifact path cannot be resolved: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }

    try {
      // Normalize all input bytes once so parsing, rawMarkdown, and sourceHash agree.
      const { content: raw, stat: freshStat } = readBoundedSource(a.absolutePath, allowedRoots, scannerLimits.fileBytes, a.rawStat);
      const content = normalizeContent(raw);
      const { frontmatter, body } = extractSimpleFrontmatter(content);
      const sourceHash = computeHash(content);
      inputs.push({
        system: a.system,
        kind: a.kind,
        skillName: deriveSkillName(a),
        description: extractDescription(frontmatter.description, body),
        rawMarkdown: content,
        frontmatter,
        attachments: parseAttachments(frontmatter),
        sourcePath: a.absolutePath,
        sourceHash,
        mtimeMs: freshStat.mtimeMs,
        size: freshStat.size,
        precedence: a.precedence
      });
    } catch (err) {
      errors.push({
        path: a.absolutePath,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

    return { inputs, errors };
  } catch (err) {
    return { inputs: [], errors: [{ path: 'normalize', error: err instanceof Error ? err.message : String(err) }] };
  }
}

function extractSimpleFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  if (!raw.startsWith('---\n')) {
    return { frontmatter: {}, body: raw };
  }
  const lines = raw.split('\n');
  const end = lines.findIndex((line, idx) => idx > 0 && line.trim() === '---');
  if (end === -1) throw new Error('malformed frontmatter: missing closing ---');
  const fmBlock = lines.slice(1, end).join('\n');
  const body = lines.slice(end + 1).join('\n').replace(/^\n+/, '');

  if (fmBlock.trim().length === 0) return { frontmatter: {}, body };

  const parsed = YAML.parse(fmBlock, {
    schema: 'core',
    customTags: [],
    maxAliasCount: 100
  });
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const rootType = Array.isArray(parsed) ? 'list' : parsed === null ? 'null' : 'scalar';
    throw new Error(`frontmatter root must be a mapping, got ${rootType}`);
  }
  return { frontmatter: parsed as Record<string, unknown>, body };
}

function deriveSkillName(a: DiscoveredArtifact): string {
  if (a.kind === 'skill_package') {
    // Use parent dir name for package entries like SKILL.md
    const parent = basename(dirname(a.absolutePath));
    return parent || basename(a.absolutePath, extname(a.absolutePath));
  }
  return basename(a.absolutePath, extname(a.absolutePath));
}

function extractDescription(raw: unknown, body: string): string | null {
  if (typeof raw === 'string' && raw.length > 0) return raw;
  // Fall back to first non-heading, non-empty paragraph in body.
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    return trimmed;
  }
  return null;
}

function parseAttachments(fm: Record<string, unknown>): string[] {
  const raw = fm.attachments;
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') return raw.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

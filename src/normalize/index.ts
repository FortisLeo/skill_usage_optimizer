import { readFileSync, statSync } from 'node:fs';
import { basename, extname, dirname } from 'node:path';
import type { BoundaryError, DiscoveredArtifact, DiscoveryContext, NormalizeResult, NormalizedSkillInput } from '../types.js';
import { computeHash, normalizeContent } from '../fs/freshness.js';
import { isPathSafe, collectAllowedRoots } from '../fs/roots.js';

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
      const raw = readFileSync(a.absolutePath, 'utf-8');
      const content = normalizeContent(raw);
      const { frontmatter, body } = extractSimpleFrontmatter(content);
      const sourceHash = computeHash(content);
      const freshStat = statSync(a.absolutePath);

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

  return { frontmatter: parseSimpleYaml(fmBlock), body };
}

function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const match = line.match(/^(\w[\w-]*)\s*:\s*(.*)/);
    if (!match) continue;
    const key = match[1]!;
    let val = match[2]!.trim();
    if (val === '|' || val === '>') {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1]!)) {
        block.push(lines[++i]!.replace(/^ {1,2}/, ''));
      }
      result[key] = val === '|'
        ? block.join('\n').replace(/\n$/, '')
        : block.map(s => s.trim()).join(' ').replace(/\s+/g, ' ').trim();
    } else if (val === '') {
      const list: string[] = [];
      while (i + 1 < lines.length) {
        const item = lines[i + 1]!.match(/^\s+-\s*(.*)$/);
        if (!item) break;
        list.push(unquote(item[1]!.trim()));
        i++;
      }
      result[key] = list.length > 0 ? list : null;
    } else if (val === '~' || val === 'null') {
      result[key] = null;
    } else if (val === 'true') {
      result[key] = true;
    } else if (val === 'false') {
      result[key] = false;
    } else if (/^-?\d+(\.\d+)?$/.test(val)) {
      result[key] = Number(val);
    } else {
      result[key] = unquote(val);
    }
  }
  return result;
}

function unquote(val: string): string {
  return val.replace(/^['"](.*)['"]$/, '$1');
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

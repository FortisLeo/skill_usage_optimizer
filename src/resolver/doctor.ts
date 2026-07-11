import { readFileSync } from 'node:fs';
import type { SkillManifest, SkillSection } from '../types.js';
import { detectCycles, isLowerToHigherTier, precedenceToTier, resolveRequiredId } from './graph.js';

/** Sections over this whitespace-token count need to be split. */
export const MAX_SECTION_TOKENS = 500;

export type DoctorSeverity = 'error' | 'warn';
export type DoctorStatus = 'clean' | 'warnings' | 'errors';

export interface DoctorDiagnostic {
  code: string;
  severity: DoctorSeverity;
  message: string;
  sectionId?: string;
  sourceSection?: string;
  targetId?: string;
  sourcePath?: string;
}

export interface DoctorResult {
  status: DoctorStatus;
  diagnostics: DoctorDiagnostic[];
}

function values(sections: Map<string, SkillSection> | SkillSection[]): SkillSection[] {
  return sections instanceof Map ? [...sections.values()] : sections;
}

function beforeFirstHeading(raw: string): string {
  const lines = raw.replace(/<!--[\s\S]*?-->/g, '').replace(/\r\n/g, '\n').split('\n');
  let inFrontmatter = false;
  let started = false;
  const kept: string[] = [];
  for (const line of lines) {
    if (!started && line.trim() === '---') { inFrontmatter = !inFrontmatter; continue; }
    if (inFrontmatter) continue;
    if (/^\s*#{1,6}\s+/.test(line)) break;
    if (line.trim()) kept.push(line);
    started = true;
  }
  return kept.join('\n').trim();
}

function hasSafetyPolicy(raw: string): boolean {
  return /\b(?:must|never|do not|required|security|unsafe|prohibited|forbidden)\b/i.test(beforeFirstHeading(raw));
}

function diagnosticSort(a: DoctorDiagnostic, b: DoctorDiagnostic): number {
  return a.code.localeCompare(b.code) || (a.sectionId ?? a.sourceSection ?? '').localeCompare(b.sectionId ?? b.sourceSection ?? '') || (a.targetId ?? a.sourcePath ?? '').localeCompare(b.targetId ?? b.sourcePath ?? '') || a.message.localeCompare(b.message);
}

export function doctor(sections: Map<string, SkillSection> | SkillSection[], manifests: Record<string, SkillManifest> | SkillManifest[] = {}): DoctorResult {
  const list = values(sections);
  const map = new Map(list.map(section => [section.id, section]));
  const diagnostics: DoctorDiagnostic[] = [];
  const requires = (section: SkillSection) => section.requires ?? [];

  for (const cycle of detectCycles(map, requires)) {
    diagnostics.push({ code: 'cycle', severity: 'error', message: `dependency cycle: ${cycle.nodeIds.join(' -> ')}`, sectionId: cycle.nodeIds[0] });
  }
  for (const section of list) {
    for (const rawId of requires(section)) {
      const targetId = resolveRequiredId(section, rawId, map);
      const target = map.get(targetId);
      if (!target) {
        diagnostics.push({ code: 'dangling_requires', severity: 'error', message: `required section "${targetId}" not found`, sourceSection: section.id, targetId });
        continue;
      }
      if (isLowerToHigherTier(section.precedence, target.precedence)) {
        diagnostics.push({ code: 'trust_lower_to_higher', severity: 'error', message: `${precedenceToTier(section.precedence)} section requires higher-trust ${precedenceToTier(target.precedence)} section`, sourceSection: section.id, targetId });
      } else if (isLowerToHigherTier(target.precedence, section.precedence)) {
        diagnostics.push({ code: 'trust_higher_to_lower', severity: 'warn', message: `${precedenceToTier(section.precedence)} section requires lower-trust ${precedenceToTier(target.precedence)} section`, sourceSection: section.id, targetId });
      }
    }
    if ((section.tokenCount ?? (section.title + '\n' + section.content).trim().split(/\s+/).filter(Boolean).length) > MAX_SECTION_TOKENS) {
      diagnostics.push({ code: 'oversized_section', severity: 'warn', message: `section exceeds ${MAX_SECTION_TOKENS} tokens`, sectionId: section.id });
    }
  }

  const persisted = Array.isArray(manifests) ? manifests : Object.values(manifests);
  for (const manifest of persisted) {
    for (const conflict of manifest.conflicts ?? []) {
      for (const source of conflict.shadowed) {
        try {
          if (hasSafetyPolicy(readFileSync(source.sourcePath, 'utf8'))) {
            diagnostics.push({ code: 'shadowed_safety_preamble', severity: 'warn', message: 'shadowed source contains safety-policy text before its first heading', sourcePath: source.sourcePath });
          }
        } catch {
          diagnostics.push({ code: 'shadowed_source_unreadable', severity: 'warn', message: 'shadowed source is missing or unreadable', sourcePath: source.sourcePath });
        }
      }
    }
  }

  diagnostics.sort(diagnosticSort);
  return { status: diagnostics.some(d => d.severity === 'error') ? 'errors' : diagnostics.length ? 'warnings' : 'clean', diagnostics };
}

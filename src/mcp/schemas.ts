// ponytail: manual validators for MCP tool arguments — no zod
import type { SourceSystem } from '../types.js';

const VALID_SYSTEMS = new Set<string>(['claude', 'opencode', 'codex', 'copilot']);

function isSourceSystem(v: unknown): v is SourceSystem {
  return typeof v === 'string' && VALID_SYSTEMS.has(v);
}

export interface ValidatedIndexSkillsArgs {
  system: SourceSystem;
  roots?: string[];
  baseDir?: string;
  force?: boolean;
}

export interface ValidatedListSkillsArgs {
  system?: SourceSystem;
}

export interface ValidatedGetSkillManifestArgs {
  skillId: string;
}

export interface ValidatedGetSkillSectionsArgs {
  skillId: string;
}

export interface ValidatedLoadSkillContextArgs {
  query?: string;
  phase?: string;
  includeReferences?: boolean;
  maxBytes?: number;
}

export interface ValidatedLoadSectionArgs {
  sectionId: string;
}

export function validateIndexSkillsArgs(raw: unknown): {
  ok: true; value: ValidatedIndexSkillsArgs
} | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['arguments must be an object'] };
  const a = raw as Record<string, unknown>;

  if (!isSourceSystem(a.system)) {
    errors.push(`system must be one of: ${[...VALID_SYSTEMS].join(', ')}`);
  }

  let roots: string[] | undefined;
  if (a.roots !== undefined) {
    if (!Array.isArray(a.roots) || !a.roots.every((r): r is string => typeof r === 'string')) {
      errors.push('roots must be an array of strings');
    } else {
      roots = a.roots;
    }
  }

  let baseDir: string | undefined;
  if (a.baseDir !== undefined) {
    if (typeof a.baseDir !== 'string') {
      errors.push('baseDir must be a string');
    } else {
      baseDir = a.baseDir;
    }
  }

  let force: boolean | undefined;
  if (a.force !== undefined) {
    if (typeof a.force !== 'boolean') {
      errors.push('force must be a boolean');
    } else {
      force = a.force;
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { system: a.system as SourceSystem, roots, baseDir, force } };
}

export function validateListSkillsArgs(raw: unknown): {
  ok: true; value: ValidatedListSkillsArgs
} | { ok: false; errors: string[] } {
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['arguments must be an object'] };
  const a = raw as Record<string, unknown>;

  if (a.system !== undefined && !isSourceSystem(a.system)) {
    return { ok: false, errors: [`system must be one of: ${[...VALID_SYSTEMS].join(', ')}`] };
  }

  return { ok: true, value: { system: a.system as SourceSystem | undefined } };
}

export function validateGetSkillManifestArgs(raw: unknown): {
  ok: true; value: ValidatedGetSkillManifestArgs
} | { ok: false; errors: string[] } {
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['arguments must be an object'] };
  const a = raw as Record<string, unknown>;

  if (typeof a.skillId !== 'string' || a.skillId.length === 0) {
    return { ok: false, errors: ['skillId must be a non-empty string'] };
  }

  return { ok: true, value: { skillId: a.skillId } };
}

export function validateGetSkillSectionsArgs(raw: unknown): {
  ok: true; value: ValidatedGetSkillSectionsArgs
} | { ok: false; errors: string[] } {
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['arguments must be an object'] };
  const a = raw as Record<string, unknown>;

  if (typeof a.skillId !== 'string' || a.skillId.length === 0) {
    return { ok: false, errors: ['skillId must be a non-empty string'] };
  }

  return { ok: true, value: { skillId: a.skillId } };
}

export function validateLoadSkillContextArgs(raw: unknown): {
  ok: true; value: ValidatedLoadSkillContextArgs
} | { ok: false; errors: string[] } {
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['arguments must be an object'] };
  const a = raw as Record<string, unknown>;

  let query: string | undefined;
  if (a.query !== undefined) {
    if (typeof a.query !== 'string' || a.query.length === 0) {
      return { ok: false, errors: ['query must be a non-empty string when set'] };
    }
    query = a.query;
  }

  let phase: string | undefined;
  if (a.phase !== undefined) {
    if (typeof a.phase !== 'string') {
      return { ok: false, errors: ['phase must be a string'] };
    }
    phase = a.phase;
  }

  let includeReferences: boolean | undefined;
  if (a.includeReferences !== undefined) {
    if (typeof a.includeReferences !== 'boolean') {
      return { ok: false, errors: ['includeReferences must be a boolean'] };
    }
    includeReferences = a.includeReferences;
  }

  let maxBytes: number | undefined;
  if (a.maxBytes !== undefined) {
    if (typeof a.maxBytes !== 'number' || a.maxBytes <= 0) {
      return { ok: false, errors: ['maxBytes must be a positive number'] };
    }
    maxBytes = a.maxBytes;
  }

  return { ok: true, value: { query, phase, includeReferences, maxBytes } };
}

export function validateLoadSectionArgs(raw: unknown): {
  ok: true; value: ValidatedLoadSectionArgs
} | { ok: false; errors: string[] } {
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['arguments must be an object'] };
  const a = raw as Record<string, unknown>;

  if (typeof a.sectionId !== 'string' || a.sectionId.length === 0) {
    return { ok: false, errors: ['sectionId must be a non-empty string'] };
  }

  return { ok: true, value: { sectionId: a.sectionId } };
}
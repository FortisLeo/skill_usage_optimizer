// ponytail: manual validators for MCP tool arguments — no zod
import type { SourceSystem } from '../types.js';

const VALID_SYSTEMS = new Set<string>(['claude', 'opencode', 'codex', 'copilot', 'generic']);

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

export interface ValidatedSearchSkillSectionsArgs {
  query: string;
  phase?: string;
  skill?: string;
  k?: number;
}

export interface ValidatedResolveTaskSectionsArgs {
  query: string;
  phase?: string;
  skill?: string;
  budget?: number;
  includeSoft?: boolean;
  sessionId?: string;
  newSession?: boolean;
}

export interface ValidatedTokenSavingsStatsArgs { sessionId?: string; newSession?: boolean; }
export interface ValidatedDiscoverSkillFoldersArgs { scope: 'project' | 'home'; maxDepth?: number; limit?: number; }

const DISCOVERY_MAX_DEPTH = 10;
const DISCOVERY_MAX_LIMIT = 500;

function sessionArgs(a: Record<string, unknown>, errors: string[]): Pick<ValidatedTokenSavingsStatsArgs, 'sessionId' | 'newSession'> {
  if (a.sessionId !== undefined && (typeof a.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(a.sessionId))) errors.push('sessionId must be an opaque 1-64 character identifier using letters, numbers, _ or -');
  if (a.newSession !== undefined && typeof a.newSession !== 'boolean') errors.push('newSession must be a boolean');
  if (a.sessionId !== undefined && a.newSession === true) errors.push('sessionId and newSession cannot be used together');
  return { sessionId: a.sessionId as string | undefined, newSession: a.newSession as boolean | undefined };
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
    if (!Array.isArray(a.roots) || !a.roots.every((r): r is string => typeof r === 'string' && r.trim().length > 0)) {
      errors.push('roots must be an array of strings');
    } else {
      roots = a.roots;
    }
  }

  if (a.system === 'generic' && (!roots || roots.length === 0)) {
    errors.push('generic system requires at least one explicit non-empty root');
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

function validateSectionQueryArgs(raw: unknown, allowK: boolean): { ok: true; value: ValidatedSearchSkillSectionsArgs | ValidatedResolveTaskSectionsArgs } | { ok: false; errors: string[] } {
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['arguments must be an object'] };
  const a = raw as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof a.query !== 'string' || a.query.trim().length === 0) errors.push('query must be a non-empty string');
  if (a.phase !== undefined && (typeof a.phase !== 'string' || a.phase.trim().length === 0)) errors.push('phase must be a non-empty string when set');
  if (a.skill !== undefined && (typeof a.skill !== 'string' || a.skill.trim().length === 0)) errors.push('skill must be a non-empty string when set');
  const session = allowK ? {} : sessionArgs(a, errors);
  if (allowK) {
    if (a.k !== undefined && (!Number.isInteger(a.k) || (a.k as number) <= 0)) errors.push('k must be a positive integer');
  } else if (a.budget !== undefined && (typeof a.budget !== 'number' || !Number.isFinite(a.budget) || a.budget <= 0)) {
    errors.push('budget must be a positive number');
  }
  if (errors.length) return { ok: false, errors };
  if (allowK) return { ok: true, value: { query: a.query as string, phase: a.phase as string | undefined, skill: a.skill as string | undefined, k: a.k as number | undefined } };
  if (a.includeSoft !== undefined && typeof a.includeSoft !== 'boolean') errors.push('includeSoft must be a boolean');
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { query: a.query as string, phase: a.phase as string | undefined, skill: a.skill as string | undefined, budget: a.budget as number | undefined, includeSoft: a.includeSoft as boolean | undefined, ...session } };
}

export function validateSearchSkillSectionsArgs(raw: unknown) { return validateSectionQueryArgs(raw, true) as { ok: true; value: ValidatedSearchSkillSectionsArgs } | { ok: false; errors: string[] }; }
export function validateResolveTaskSectionsArgs(raw: unknown) { return validateSectionQueryArgs(raw, false) as { ok: true; value: ValidatedResolveTaskSectionsArgs } | { ok: false; errors: string[] }; }

export function validateTokenSavingsStatsArgs(raw: unknown): { ok: true; value: ValidatedTokenSavingsStatsArgs } | { ok: false; errors: string[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['arguments must be an object'] };
  const errors: string[] = [];
  const value = sessionArgs(raw as Record<string, unknown>, errors);
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

export function validateDoctorArgs(raw: unknown): { ok: true; value: Record<string, never> } | { ok: false; errors: string[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['arguments must be an object'] };
  return { ok: true, value: {} };
}

export function validateDiscoverSkillFoldersArgs(raw: unknown): { ok: true; value: ValidatedDiscoverSkillFoldersArgs } | { ok: false; errors: string[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['arguments must be an object'] };
  const a = raw as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of Object.keys(a)) if (!['scope', 'maxDepth', 'limit'].includes(key)) errors.push(`unknown argument: ${key}`);
  if (a.scope !== undefined && a.scope !== 'project' && a.scope !== 'home') errors.push('scope must be project or home');
  const maxDepth = a.maxDepth;
  const limit = a.limit;
  if (maxDepth !== undefined && (typeof maxDepth !== 'number' || !Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > DISCOVERY_MAX_DEPTH)) errors.push(`maxDepth must be an integer between 0 and ${DISCOVERY_MAX_DEPTH}`);
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > DISCOVERY_MAX_LIMIT)) errors.push(`limit must be an integer between 1 and ${DISCOVERY_MAX_LIMIT}`);
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { scope: (a.scope ?? 'project') as 'project' | 'home', maxDepth: maxDepth as number | undefined, limit: limit as number | undefined } };
}

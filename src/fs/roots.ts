import { realpathSync, existsSync, statSync } from 'node:fs';
import { relative, isAbsolute } from 'node:path';
import type { DiscoveryContext } from '../types.js';
import { CODEX_SYSTEM_SKILLS_DIR } from '../config.js';

export function resolveRealpath(p: string): string {
  if (!existsSync(p)) throw new Error(`path does not exist: ${p}`);
  return realpathSync(p);
}

export function isWithinRoot(target: string, root: string): boolean {
  const realTarget = resolveRealpath(target);
  const realRoot = resolveRealpath(root);
  const rel = relative(realRoot, realTarget);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function isPathSafe(absolutePath: string, allowedRoots: string[]): boolean {
  const resolved = resolveRealpath(absolutePath);
  for (const root of allowedRoots) {
    if (isWithinRoot(resolved, root)) return true;
  }
  return false;
}

export function collectAllowedRoots(ctx: DiscoveryContext): string[] {
  const { workspaceRoot, repoRoot, homeDir, includeGlobals, includeSystem, codexSystemRoot, explicitRoots } = ctx;
  const roots: string[] = [];

  if (workspaceRoot && existsSync(workspaceRoot)) {
    try { roots.push(resolveRealpath(workspaceRoot)); } catch { /* skip */ }
  }
  if (repoRoot && existsSync(repoRoot)) {
    try { roots.push(resolveRealpath(repoRoot)); } catch { /* skip */ }
  }
  for (const r of explicitRoots) {
    try { if (existsSync(r)) roots.push(resolveRealpath(r)); } catch { /* skip */ }
  }
  // home is only an allowed root when globals are included
  if (includeGlobals) {
    try { if (existsSync(homeDir)) roots.push(resolveRealpath(homeDir)); } catch { /* skip */ }
  }
  // codex system root is only an allowed root when includeSystem is true
  if (includeSystem) {
    const sysRoot = codexSystemRoot ?? CODEX_SYSTEM_SKILLS_DIR;
    try { if (existsSync(sysRoot)) roots.push(resolveRealpath(sysRoot)); } catch { /* skip */ }
  }

  return [...new Set(roots)];
}

export function validateRoot(root: string): string {
  if (!existsSync(root)) throw new Error(`root does not exist: ${root}`);
  const real = resolveRealpath(root);
  const stat = statSync(real);
  if (!stat.isDirectory()) throw new Error(`root is not a directory: ${root}`);
  return real;
}

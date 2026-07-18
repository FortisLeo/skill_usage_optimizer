import { existsSync, lstatSync, opendirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DiscoveredArtifact, DiscoveryContext, DiscoveryDiagnostic } from '../types.js';
import { collectAllowedRoots, isPathSafe } from '../fs/roots.js';
import { createScanBudget, EXPLICIT_ROOT_GUIDANCE, reportBudgetExhaustion, scanFile, scanMarkdownRoot, scanSourceRoot, scannerLimits, type ScanBudget, type ScanSafetyCallback } from './shared.js';
type RooDiagnosticCallback = (diagnostic: DiscoveryDiagnostic) => void;

export function discoverRoo(
  ctx: DiscoveryContext,
  onScan?: ScanSafetyCallback,
  onDiagnostic?: RooDiagnosticCallback,
  artifactLimit = scannerLimits.results,
  budget: ScanBudget = createScanBudget({ ...scannerLimits, results: Math.min(scannerLimits.results, artifactLimit) })
): DiscoveredArtifact[] {
  const results: DiscoveredArtifact[] = [];
  const allowedRoots = collectAllowedRoots(ctx);
  const projectRoots = [ctx.repoRoot, ctx.workspaceRoot].filter((root, index, roots): root is string => Boolean(root) && roots.indexOf(root) === index);
  const levels = [...projectRoots, ...(ctx.includeGlobals ? [ctx.homeDir] : [])];
  const add = (artifacts: DiscoveredArtifact[]): void => { results.push(...artifacts); };

  for (const base of levels) {
    if (budget.exhausted) break;
    for (const root of rooDirectories(base, 'skills-', allowedRoots, onScan, budget)) {
      add(withOffset(scanSourceRoot(root, allowedRoots, ctx, 'roo', 3, onScan, scannerLimits, budget), 4));
      if (budget.exhausted) break;
    }
    if (budget.exhausted) break;
    add(withOffset(scanSourceRoot(join(base, '.roo', 'skills'), allowedRoots, ctx, 'roo', 3, onScan, scannerLimits, budget), 3));
    if (budget.exhausted) break;
    for (const root of rooDirectories(base, 'agents-skills-', allowedRoots, onScan, budget)) {
      add(withOffset(scanSourceRoot(root, allowedRoots, ctx, 'roo', 3, onScan, scannerLimits, budget), 2));
      if (budget.exhausted) break;
    }
    if (budget.exhausted) break;
    add(withOffset(scanSourceRoot(join(base, '.agents', 'skills'), allowedRoots, ctx, 'roo', 3, onScan, scannerLimits, budget), 1));
  }

  let genericRuleCount = 0;
  for (const base of levels) {
    if (budget.exhausted) break;
    const rules = scanMarkdownRoot(join(base, '.roo', 'rules'), allowedRoots, ctx, 'roo', '', 'rule_file', 4, onScan, budget);
    genericRuleCount += rules.length;
    add(rules);
  }
  if (!budget.exhausted && genericRuleCount === 0) {
    for (const base of projectRoots) {
      add(scanFile(join(base, '.roorules'), base, allowedRoots, ctx, 'roo', 'rule_file', base, onScan, budget));
      if (budget.exhausted) break;
    }
  }

  const modes = new Set(!budget.exhausted ? levels.flatMap(base => [
    ...rooNames(base, '.roo', 'rules-', allowedRoots, onScan, budget),
    ...rooNames(base, '.', '.roorules-', allowedRoots, onScan, budget)
  ]) : []);
  for (const mode of modes) {
    let modeRuleCount = 0;
    for (const base of levels) {
      const modeRules = withOffset(scanMarkdownRoot(join(base, '.roo', `rules-${mode}`), allowedRoots, ctx, 'roo', '', 'rule_file', 4, onScan, budget), 1);
      modeRuleCount += modeRules.length;
      add(modeRules);
      if (budget.exhausted) break;
    }
    if (!budget.exhausted && modeRuleCount === 0) {
      for (const base of projectRoots) {
        add(withOffset(scanFile(join(base, `.roorules-${mode}`), base, allowedRoots, ctx, 'roo', 'rule_file', base, onScan, budget), 1));
        if (budget.exhausted) break;
      }
    }
    if (budget.exhausted) break;
  }

  const userSetting = !budget.exhausted && ctx.includeGlobals ? readAgentRulesSetting(userSettingsPath(ctx.homeDir), allowedRoots) : { state: 'absent' as const };
  let usedSettings = userSetting.state === 'used';
  let invalidSettings = userSetting.state === 'invalid';
  let useAgentRules = userSetting.state === 'used' ? userSetting.value : true;
  for (const base of budget.exhausted ? [] : projectRoots) {
    const workspaceSetting = readAgentRulesSetting(join(base, '.vscode', 'settings.json'), allowedRoots);
    usedSettings ||= workspaceSetting.state === 'used';
    invalidSettings ||= workspaceSetting.state === 'invalid';
    if (workspaceSetting.state === 'used') useAgentRules = workspaceSetting.value;
  }
  if (!budget.exhausted && useAgentRules) {
    for (const base of projectRoots) {
      const agents = scanFile(join(base, 'AGENTS.md'), base, allowedRoots, ctx, 'roo', 'instruction_file', base, onScan, budget);
      add(agents);
      if (budget.exhausted) break;
      if (agents.length === 0) add(scanFile(join(base, 'AGENT.md'), base, allowedRoots, ctx, 'roo', 'instruction_file', base, onScan, budget));
      if (budget.exhausted) break;
    }
  }

  if (results.length === 0) onDiagnostic?.(diagnostic('roots', 'roots', 'unavailable', 'SOURCE_ABSENT', 'No supported Roo Code documented roots were present.'));
  if (budget.exhausted) onDiagnostic?.(diagnostic('roots', 'roots', 'truncated', 'SOURCE_TRUNCATED', 'Roo discovery reached its aggregate scan budget; remaining roots were skipped.'));
  else if (usedSettings) onDiagnostic?.(diagnostic('configuration', 'configuration', 'used', 'SOURCE_USED', 'Stable VS Code settings were used only to honor roo-cline.useAgentRules.'));
  else onDiagnostic?.(diagnostic('configuration', 'configuration', invalidSettings ? 'skipped' : 'unavailable', invalidSettings ? 'SOURCE_INVALID' : 'SOURCE_ABSENT', invalidSettings ? 'A stable settings file was invalid or unsafe and was skipped.' : 'No stable readable Roo Code extension settings were present.'));
  onDiagnostic?.(diagnostic('configuration', 'configuration', 'unavailable', 'SOURCE_UNSUPPORTED', 'Active mode, UI prompt state, private extension storage, and final prompt reconstruction are unsupported.'));
  return results;
}

function rooDirectories(base: string, prefix: string, allowedRoots: string[], onScan: ScanSafetyCallback | undefined, budget: ScanBudget): string[] {
  if (prefix === 'agents-skills-') return listDirectories(join(base, '.agents'), 'skills-', allowedRoots, onScan, budget);
  return listDirectories(join(base, '.roo'), prefix, allowedRoots, onScan, budget);
}

function rooNames(base: string, parent: string, prefix: string, allowedRoots: string[], onScan: ScanSafetyCallback | undefined, budget: ScanBudget): string[] {
  const root = parent === '.' ? base : join(base, parent);
  return listEntries(root, prefix, allowedRoots, onScan, false, budget).map(name => name.slice(prefix.length)).filter(Boolean);
}

function listDirectories(root: string, prefix: string, allowedRoots: string[], onScan: ScanSafetyCallback | undefined, budget: ScanBudget): string[] {
  return listEntries(root, prefix, allowedRoots, onScan, true, budget).map(name => join(root, name));
}

function listEntries(root: string, prefix: string, allowedRoots: string[], onScan: ScanSafetyCallback | undefined, directories: boolean, budget: ScanBudget): string[] {
  if (budget.exhausted || !existsSync(root)) return [];
  const found: string[] = [];
  let skipped = 0;
  let truncated = false;
  try {
    if (lstatSync(root).isSymbolicLink() || !isPathSafe(root, allowedRoots)) throw new Error('unsafe');
    const dir = opendirSync(root);
    try {
      for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
        if (!budget.visit()) { skipped++; truncated = true; break; }
        if (!entry.name.startsWith(prefix)) continue;
        if (entry.isSymbolicLink() || (directories ? !entry.isDirectory() : !entry.isFile())) { skipped++; continue; }
        found.push(entry.name);
      }
    } finally { dir.closeSync(); }
  } catch { skipped++; }
  if (truncated && budget.exhausted) reportBudgetExhaustion(budget, root, 'roo', onScan);
  else if (skipped > 0) onScan?.({ root, system: 'roo', foundCount: 0, skippedCount: skipped, truncated, reasons: [truncated ? 'entry_limit' : 'unsafe'] });
  return found.sort((a, b) => a.localeCompare(b));
}

function readAgentRulesSetting(path: string, allowedRoots: string[]): { state: 'absent' | 'invalid' } | { state: 'used'; value: boolean } {
  if (!existsSync(path)) return { state: 'absent' };
  try {
    if (Buffer.byteLength(path, 'utf8') > scannerLimits.pathBytes || lstatSync(path).isSymbolicLink() || !isPathSafe(path, allowedRoots)) return { state: 'invalid' };
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > scannerLimits.fileBytes) return { state: 'invalid' };
    const parsed = JSON.parse(stripJsonComments(readFileSync(path, 'utf8'))) as Record<string, unknown>;
    return typeof parsed['roo-cline.useAgentRules'] === 'boolean'
      ? { state: 'used', value: parsed['roo-cline.useAgentRules'] }
      : { state: 'absent' };
  } catch { return { state: 'invalid' }; }
}

function stripJsonComments(input: string): string {
  let output = '';
  let string = false;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    const next = input[i + 1];
    if (string) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') string = false;
    } else if (char === '"') { string = true; output += char; }
    else if (char === '/' && next === '/') { while (i < input.length && input[i] !== '\n') i++; output += '\n'; }
    else if (char === '/' && next === '*') { i += 2; while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) i++; i++; }
    else output += char;
  }
  return output;
}

function userSettingsPath(home: string): string {
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'Code', 'User', 'settings.json');
  if (process.platform === 'win32') return join(home, 'AppData', 'Roaming', 'Code', 'User', 'settings.json');
  return join(home, '.config', 'Code', 'User', 'settings.json');
}

function withOffset(artifacts: DiscoveredArtifact[], offset: number): DiscoveredArtifact[] {
  return artifacts.map(artifact => ({ ...artifact, precedence: artifact.precedence + offset }));
}

function diagnostic(
  capability: DiscoveryDiagnostic['capability'], sourceType: DiscoveryDiagnostic['sourceType'], status: DiscoveryDiagnostic['status'],
  code: DiscoveryDiagnostic['code'], limitation: string
): DiscoveryDiagnostic {
  return { environment: 'roo', capability, sourceType, status, code, foundCount: 0, skippedCount: 0, limitation, explicitRootGuidance: EXPLICIT_ROOT_GUIDANCE };
}

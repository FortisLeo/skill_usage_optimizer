import { describe, expect, it, onTestFinished } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dedupArtifacts, discover } from '../src/discovery/index.js';
import { GLOBAL_SKILL_DIRS, CODEX_SYSTEM_SKILLS_DIR } from '../src/config.js';
import { collectAllowedRoots } from '../src/fs/roots.js';
import { scanFile, scanSourceRoot, scannerLimits, type ScanSafetyResult } from '../src/discovery/shared.js';
import { makeTempWorkspace, writeFixture } from './testUtils.js';

describe('discover', () => {
  it('returns empty artifacts for an empty workspace', () => {
    const { ctx, cleanup } = makeTempWorkspace();
    try {
      const { artifacts } = discover(ctx);
      expect(artifacts).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('reports a requested adapter exception as fatal', () => {
    const { ctx, cleanup } = makeTempWorkspace();
    ctx.requestedSystem = 'claude';
    try {
      const result = discover({ ...ctx, homeDir: null as unknown as string });
      expect(result.artifacts).toEqual([]);
      expect(result.errors).toEqual([expect.objectContaining({ path: 'discover:claude' })]);
    } finally { cleanup(); }
  });

  it('discovers claude skills in workspace .claude/skills/', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    writeFixture(root, '.claude/skills/myskill.md', '---\nname: test\n---\n# Hello');
    try {
      const { artifacts } = discover(ctx);
      const claudeArts = artifacts.filter(a => a.system === 'claude');
      expect(claudeArts.length).toBeGreaterThanOrEqual(1);
      expect(claudeArts[0]!.kind).toBe('instruction_file');
    } finally {
      cleanup();
    }
  });

  it('discovers opencode skills', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    writeFixture(root, '.opencode/skills/code.md', '---\nname: oc\n---\n# OC');
    try {
      const { artifacts } = discover(ctx);

      const ocs = artifacts.filter(a => a.system === 'opencode');
      expect(ocs.length).toBeGreaterThanOrEqual(1);
    } finally {
      cleanup();
    }
  });

  it('discovers codex skills', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    writeFixture(root, '.agents/skills/cx/SKILL.md', '---\nname: cx\n---\n# CX');
    ctx.requestedSystem = 'codex';
    try {
      const { artifacts } = discover(ctx);

      const cxs = artifacts.filter(a => a.system === 'codex');
      expect(cxs.length).toBeGreaterThanOrEqual(1);
    } finally {
      cleanup();
    }
  });

  it('discovers copilot skills', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    writeFixture(root, '.github/skills/cp/SKILL.md', '---\nname: cp\ndescription: Copilot skill\n---\n# CP');
    try {
      const { artifacts } = discover(ctx);

      const cps = artifacts.filter(a => a.system === 'copilot');
      expect(cps.length).toBeGreaterThanOrEqual(1);
    } finally {
      cleanup();
    }
  });

  it('global skills are discovered when includeGlobals is true', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    writeFixture(ctx.homeDir, '.claude/skills/global-skill.md', '---\nname: global\n---\n# Global');
    try {
      const { artifacts } = discover(ctx);
      const globals = artifacts.filter(a => a.rootOrigin.startsWith(ctx.homeDir));
      expect(globals.length).toBeGreaterThanOrEqual(1);
      expect(globals[0]!.system).toBe('claude');
    } finally {
      cleanup();
    }
  });

  it('skips globals when includeGlobals is false', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    writeFixture(ctx.homeDir, '.claude/skills/global-skill.md', '---\nname: g\n---\n# G');
    ctx.includeGlobals = false;
    try {
      const { artifacts } = discover(ctx);
      const globals = artifacts.filter(a => a.rootOrigin.startsWith(ctx.homeDir));
      expect(globals).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('deduplicates artifacts on same absolutePath by highest precedence', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    writeFixture(root, '.claude/skills/dup.md', '---\nname: dup\n---\n# Dup');
    try {
      const { artifacts } = discover(ctx);
      const dupes = artifacts.filter(a => a.absolutePath.endsWith('dup.md'));
      expect(dupes.length).toBe(1);
    } finally {
      cleanup();
    }
  });

  it('deterministic sort: system > kind > path', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    writeFixture(root, '.claude/skills/a.md', '---\nname: a\n---\n# A');
    writeFixture(root, '.opencode/skills/b.md', '---\nname: b\n---\n# B');
    try {
      const { artifacts } = discover(ctx);
      const systems = artifacts.map(a => a.system);
      expect(systems[0]).toBe('claude');
    } finally {
      cleanup();
    }
  });

  it('handles bad workspace roots silently (no throw)', () => {
    const ctx = {
      workspaceRoot: '/nonexistent/path/that/does/not/exist',
      repoRoot: null,
      homeDir: '/nonexistent/home',
      includeGlobals: true,
      includeSystem: false,
      explicitRoots: []
    };
    const { artifacts } = discover(ctx);
    expect(Array.isArray(artifacts)).toBe(true);
    expect(artifacts).toEqual([]);
  });

  it('does not attribute unsupported root AGENTS.md to claude', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    writeFixture(root, 'AGENTS.md', '# Agent instructions');
    try {
      const { artifacts } = discover(ctx);

      const agents = artifacts.filter(a => a.system === 'claude' && a.relativePath === 'AGENTS.md');
      expect(agents).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('discovers root CLAUDE.md as claude instruction_file', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    writeFixture(root, 'CLAUDE.md', '# Claude config');
    try {
      const { artifacts } = discover(ctx);

      const claude = artifacts.filter(a => a.system === 'claude' && a.relativePath === 'CLAUDE.md');
      expect(claude.length).toBe(1);
      expect(claude[0]!.kind).toBe('instruction_file');
    } finally {
      cleanup();
    }
  });

  it('discovers .github/copilot-instructions.md as copilot instruction_file', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    writeFixture(root, '.github/copilot-instructions.md', '# Copilot instructions');
    try {
      const { artifacts } = discover(ctx);

      const cpi = artifacts.filter(a => a.system === 'copilot' && a.relativePath.includes('copilot-instructions.md'));
      expect(cpi.length).toBe(1);
      expect(cpi[0]!.kind).toBe('instruction_file');
    } finally {
      cleanup();
    }
  });

  it('discovers recursive .github/instructions/**/*.instructions.md', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    writeFixture(root, '.github/instructions/deep/nested/file.instructions.md', '# Nested instructions');
    writeFixture(root, '.github/instructions/top.instructions.md', '# Top');
    try {
      const { artifacts } = discover(ctx);

      const instrs = artifacts.filter(a =>
        a.system === 'copilot' && a.absolutePath.includes('.instructions.md')
      );
      expect(instrs.length).toBeGreaterThanOrEqual(2);
    } finally {
      cleanup();
    }
  });

  it('discovers recursive SKILL.md beyond one nested dir', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    writeFixture(root, '.claude/skills/a/b/c/SKILL.md', '# Deep skill');
    writeFixture(root, '.claude/skills/direct/SKILL.md', '# Shallow skill');
    try {
      const { artifacts } = discover(ctx);

      const deepSkills = artifacts.filter(a =>
        a.kind === 'skill_package' && a.absolutePath.endsWith('SKILL.md')
      );
      expect(deepSkills.length).toBeGreaterThanOrEqual(2);
    } finally {
      cleanup();
    }
  });

  it('skips unknown explicitRoots and returns an error', () => {
    const { ctx, cleanup } = makeTempWorkspace();
    const explicitRoot = join(tmpdir(), 'skill-opt-explicit-' + Date.now());
    mkdirSync(explicitRoot, { recursive: true });
    writeFileSync(join(explicitRoot, 'custom-skill.md'), '---\nname: custom\n---\n# Custom');
    ctx.explicitRoots = [explicitRoot];
    try {
      const { artifacts, errors } = discover(ctx);

      const explicit = artifacts.filter(a => a.absolutePath.includes('custom-skill.md'));
      expect(explicit).toEqual([]);
      expect(errors.some(e => e.path === explicitRoot && /unknown explicit root/.test(e.error))).toBe(true);
    } finally {
      cleanup();
      try { rmSync(explicitRoot, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it('reports an error for a nonexistent explicit root', () => {
    const { ctx, cleanup } = makeTempWorkspace();
    const bogus = join(tmpdir(), 'skill-opt-no-such-root-' + Date.now());
    ctx.explicitRoots = [bogus];
    try {
      const { artifacts, errors } = discover(ctx);
      expect(artifacts).toEqual([]);
      expect(errors.some(e => e.path === bogus && /does not exist/.test(e.error))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('reports an error when an explicit root is a file, not a directory', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    const filePath = writeFixture(root, 'not-a-dir.txt', 'hello');
    ctx.explicitRoots = [filePath];
    ctx.explicitRootSystem = 'claude';
    try {
      const { errors } = discover(ctx);
      expect(errors.some(e => e.path === filePath && /not a directory/.test(e.error))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('indexes arbitrary explicitRoots when explicitRootSystem is set', () => {
    const { ctx, cleanup } = makeTempWorkspace();
    const explicitRoot = mkdtempSync(join(tmpdir(), 'skill-opt-explicit-override-'));
    writeFileSync(join(explicitRoot, 'plugin-skill.md'), '---\nname: plugin\n---\n# Plugin');
    ctx.explicitRoots = [explicitRoot];
    ctx.explicitRootSystem = 'claude';
    try {
      const { artifacts, errors } = discover(ctx);
      expect(errors).toEqual([]);
      expect(artifacts.some(a => a.absolutePath.endsWith('plugin-skill.md') && a.system === 'claude')).toBe(true);
    } finally {
      cleanup();
      rmSync(explicitRoot, { recursive: true, force: true });
    }
  });

  it('indexes explicit generic roots without changing known-system discovery', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    const explicitRoot = join(root, 'unknown', 'skills');
    mkdirSync(join(explicitRoot, 'shared'), { recursive: true });
    writeFileSync(join(explicitRoot, 'shared', 'SKILL.md'), '# Generic');
    writeFixture(root, '.claude/skills/shared/SKILL.md', '# Claude');
    ctx.explicitRoots = [explicitRoot];
    ctx.explicitRootSystem = 'generic';
    try {
      const { artifacts, errors } = discover(ctx);
      expect(errors).toEqual([]);
      expect(artifacts.some(a => a.system === 'generic' && a.absolutePath === join(explicitRoot, 'shared', 'SKILL.md'))).toBe(true);
      expect(artifacts.some(a => a.system === 'claude' && a.absolutePath.endsWith('.claude/skills/shared/SKILL.md'))).toBe(true);
    } finally { cleanup(); }
  });

  it('does not index recursive SKILL.md through symlink escapes', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    const outside = mkdtempSync(join(tmpdir(), 'skill-opt-symlink-outside-'));
    mkdirSync(join(root, '.claude', 'skills', 'links'), { recursive: true });
    mkdirSync(join(outside, 'outside-skill'), { recursive: true });
    writeFileSync(join(outside, 'outside-skill', 'SKILL.md'), '# Escaped');
    symlinkSync(outside, join(root, '.claude', 'skills', 'links', 'escape'), 'dir');
    try {
      const { artifacts } = discover(ctx);
      expect(artifacts.some(a => a.absolutePath.includes('outside-skill'))).toBe(false);
    } finally {
      cleanup();
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('does not recurse through symlink loops', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    const loopDir = join(root, '.claude', 'skills', 'loop');
    mkdirSync(loopDir, { recursive: true });
    writeFileSync(join(loopDir, 'SKILL.md'), '# Loop root');
    symlinkSync(loopDir, join(loopDir, 'again'), 'dir');
    try {
      const { artifacts, errors } = discover(ctx);
      expect(errors).toEqual([]);
      expect(artifacts.filter(a => a.absolutePath.endsWith('loop/SKILL.md'))).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it('scans known explicitRoots for skill files', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    const explicitRoot = require('node:path').join(root, '.claude', 'explicit');
    require('node:fs').mkdirSync(explicitRoot, { recursive: true });
    require('node:fs').writeFileSync(require('node:path').join(explicitRoot, 'custom-skill.md'), '---\nname: custom\n---\n# Custom');
    ctx.explicitRoots = [explicitRoot];
    try {
      const { artifacts, errors } = discover(ctx);
      expect(errors).toEqual([]);
      expect(artifacts.some(a => a.absolutePath.includes('custom-skill.md') && a.system === 'claude')).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('uses shared precedence for copilot instruction files', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    ctx.repoRoot = root;
    writeFixture(root, '.github/copilot-instructions.md', '# Copilot instructions');
    try {
      const { artifacts } = discover(ctx);
      const cpi = artifacts.find(a => a.system === 'copilot' && a.relativePath.includes('copilot-instructions.md'));
      expect(cpi).toBeDefined();
      expect(cpi!.precedence).toBe(100);
    } finally {
      cleanup();
    }
  });

  it('repo precedence beats workspace precedence', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    // Set repoRoot to the same dir as workspaceRoot so a path is inside both
    ctx.repoRoot = root;
    writeFixture(root, '.claude/skills/repo-skill.md', '---\nname: rs\n---\n# RS');
    try {
      const { artifacts } = discover(ctx);

      const match = artifacts.find(a => a.absolutePath.endsWith('repo-skill.md'));
      expect(match).toBeDefined();
      // workspace_repo = 100
      expect(match!.precedence).toBe(100);
    } finally {
      cleanup();
    }
  });

  it('discovers opencode skills in ~/.config/opencode/skills (global root)', () => {
    const { ctx, cleanup } = makeTempWorkspace();
    writeFixture(ctx.homeDir, '.config/opencode/skills/config-skill.md', '---\nname: oc-cfg\n---\n# OC Config');
    try {
      const { artifacts } = discover(ctx);

      const configSkills = artifacts.filter(a =>
        a.system === 'opencode' && a.absolutePath.includes('config-skill.md')
      );
      expect(configSkills.length).toBe(1);
      expect(configSkills[0]!.precedence).toBe(40); // global
    } finally {
      cleanup();
    }
  });

  it('GLOBAL_SKILL_DIRS.opencode includes .config/opencode/skills', () => {
    expect(GLOBAL_SKILL_DIRS.opencode).toContain('.config/opencode/skills');
  });

  it('CODEX_SYSTEM_SKILLS_DIR is /etc/codex/skills', () => {
    expect(CODEX_SYSTEM_SKILLS_DIR).toBe('/etc/codex/skills');
  });

  it('codex system root is discovered when includeSystem is true', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    ctx.includeSystem = true;
    // Use the test seam to point at a temp dir instead of /etc/codex/skills
    const systemRoot = require('node:path').join(require('node:os').tmpdir(), 'codex-system-test-' + Date.now());
    const skillsDir = require('node:path').join(systemRoot, 'codex', 'skills');
    require('node:fs').mkdirSync(skillsDir, { recursive: true });
    require('node:fs').writeFileSync(
      require('node:path').join(systemRoot, 'codex', 'skills', 'system-skill.md'),
      '---\nname: sys\n---\n# System'
    );
    ctx.codexSystemRoot = skillsDir;
    try {
      const { artifacts } = discover(ctx);

      const systemArts = artifacts.filter(a =>
        a.system === 'codex' && a.absolutePath.includes('system-skill.md')
      );
      expect(systemArts.length).toBe(1);
      expect(systemArts[0]!.precedence).toBe(10); // system
    } finally {
      cleanup();
      try { require('node:fs').rmSync(systemRoot, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it('codex system root is skipped when includeSystem is false', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    ctx.includeSystem = false;
    const systemRoot = require('node:path').join(require('node:os').tmpdir(), 'codex-system-skip-' + Date.now());
    const skillsDir = require('node:path').join(systemRoot, 'codex', 'skills');
    require('node:fs').mkdirSync(skillsDir, { recursive: true });
    require('node:fs').writeFileSync(
      require('node:path').join(systemRoot, 'codex', 'skills', 'system-skill.md'),
      '---\nname: sys\n---\n# System'
    );
    ctx.codexSystemRoot = skillsDir;
    try {
      const { artifacts } = discover(ctx);

      const systemArts = artifacts.filter(a =>
        a.system === 'codex' && a.absolutePath.includes('system-skill.md')
      );
      expect(systemArts).toEqual([]);
    } finally {
      cleanup();
      try { require('node:fs').rmSync(systemRoot, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it('uses the fixed scanner bounds', () => {
    expect(scannerLimits).toEqual({ entries: 10_000, results: 500, fileBytes: 1_048_576, pathBytes: 4096 });
  });

  it('stops at entry limit and reports skipped', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    onTestFinished(cleanup);
    const source = join(root, '.claude', 'skills');
    const limits = { ...scannerLimits, entries: 2 };
    for (let i = 0; i <= limits.entries; i++) mkdirSync(join(source, `${i}`));
    const reports: ScanSafetyResult[] = [];
    expect(scanSourceRoot(source, collectAllowedRoots(ctx), ctx, 'claude', 0, report => reports.push(report), limits)).toEqual([]);
    expect(reports).toEqual([expect.objectContaining({ truncated: true, skippedCount: 1, reasons: ['entry_limit'] })]);
  });

  it('stops at result limit', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    const source = join(root, '.claude', 'skills');
    for (let i = 0; i <= scannerLimits.results; i++) writeFileSync(join(source, `${i}.md`), '# skill');
    const reports: ScanSafetyResult[] = [];
    try {
      const artifacts = scanSourceRoot(source, collectAllowedRoots(ctx), ctx, 'claude', 3, report => reports.push(report));
      expect(artifacts).toHaveLength(scannerLimits.results);
      expect(reports).toEqual([expect.objectContaining({ foundCount: scannerLimits.results, skippedCount: 1, truncated: true, reasons: ['result_limit'] })]);
    } finally { cleanup(); }
  });

  it('skips oversized file before discovery', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    const source = join(root, '.claude', 'skills');
    const oversized = join(source, 'oversized.md');
    writeFileSync(oversized, Buffer.alloc(scannerLimits.fileBytes + 1));
    const reports: ScanSafetyResult[] = [];
    try {
      expect(scanSourceRoot(source, collectAllowedRoots(ctx), ctx, 'claude', 3, report => reports.push(report))).toEqual([]);
      expect(reports[0]).toEqual(expect.objectContaining({ skippedCount: 1, truncated: false, reasons: ['file_size'] }));
    } finally { cleanup(); }
  });

  it('skips overlong path before filesystem resolution', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    const reports: ScanSafetyResult[] = [];
    const overlong = join(root, `${'x'.repeat(scannerLimits.pathBytes)}.md`);
    try {
      expect(scanFile(overlong, root, collectAllowedRoots(ctx), ctx, 'claude', 'instruction_file', root, report => reports.push(report))).toEqual([]);
      expect(reports[0]).toEqual(expect.objectContaining({ skippedCount: 1, reasons: ['path_length'] }));
    } finally { cleanup(); }
  });

  it('contains each scan to its supplied root and reports a symlink cache escape', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    const source = join(root, '.claude', 'skills');
    const cache = mkdtempSync(join(tmpdir(), 'skill-opt-cache-escape-'));
    writeFileSync(join(source, 'safe.md'), '# safe');
    writeFileSync(join(cache, 'escaped.md'), '# escaped');
    symlinkSync(cache, join(source, 'cache-link'), 'dir');
    const reports: ScanSafetyResult[] = [];
    try {
      const artifacts = scanSourceRoot(source, [...collectAllowedRoots(ctx), cache], ctx, 'claude', 3, report => reports.push(report));
      expect(artifacts.map(a => a.absolutePath)).toEqual([join(source, 'safe.md')]);
      expect(reports[0]).toEqual(expect.objectContaining({ skippedCount: 1, reasons: ['symlink'] }));
    } finally { cleanup(); rmSync(cache, { recursive: true, force: true }); }
  });

  it('skips unsafe explicit-root entries but keeps explicit attribution', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    const explicitRoot = join(root, 'explicit');
    const outside = mkdtempSync(join(tmpdir(), 'skill-opt-explicit-escape-'));
    mkdirSync(explicitRoot);
    writeFileSync(join(explicitRoot, 'safe.md'), '# safe');
    writeFileSync(join(outside, 'unsafe.md'), '# unsafe');
    symlinkSync(join(outside, 'unsafe.md'), join(explicitRoot, 'unsafe.md'));
    ctx.explicitRoots = [explicitRoot];
    ctx.explicitRootSystem = 'generic';
    const reports: ScanSafetyResult[] = [];
    try {
      const { artifacts, errors } = discover(ctx, report => reports.push(report));
      expect(errors).toEqual([]);
      expect(artifacts.some(a => a.absolutePath === join(explicitRoot, 'safe.md') && a.system === 'generic')).toBe(true);
      expect(artifacts.some(a => a.absolutePath === join(explicitRoot, 'unsafe.md'))).toBe(false);
      expect(reports.some(report => report.root === explicitRoot && report.reasons.includes('symlink'))).toBe(true);
    } finally { cleanup(); rmSync(outside, { recursive: true, force: true }); }
  });

  it('keeps an unsafe explicit root fatal', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    const target = join(root, 'explicit-target');
    const link = join(root, 'explicit-link');
    mkdirSync(target);
    symlinkSync(target, link, 'dir');
    ctx.explicitRoots = [link];
    ctx.explicitRootSystem = 'claude';
    try {
      const { artifacts, errors } = discover(ctx);
      expect(artifacts.some(a => a.rootOrigin === link)).toBe(false);
      expect(errors.some(error => error.path === link && /resolved safely/.test(error.error))).toBe(true);
    } finally { cleanup(); }
  });

  it('preserves Claude, OpenCode, Codex, Copilot, and generic discovery compatibility', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    writeFixture(root, '.claude/skills/claude.md', '# Claude');
    writeFixture(root, '.opencode/skills/opencode.md', '# OpenCode');
    writeFixture(root, '.codex/agents/codex.toml', 'name = "codex"\ndescription = "Codex"\ndeveloper_instructions = "Codex"');
    writeFixture(root, '.github/copilot/copilot.md', '# Copilot');
    const generic = join(root, 'custom-skills');
    mkdirSync(generic);
    writeFileSync(join(generic, 'generic.md'), '# Generic');
    ctx.explicitRoots = [generic];
    ctx.explicitRootSystem = 'generic';
    try {
      const { artifacts, errors } = discover(ctx);
      expect(errors).toEqual([]);
      expect(new Set(artifacts.map(a => a.system))).toEqual(new Set(['claude', 'opencode', 'codex', 'copilot', 'generic']));
    } finally { cleanup(); }
  });

  it('discovery diagnostics use exact bounded redacted response shape', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    const explicitRoot = join(root, 'private-customer-name');
    mkdirSync(explicitRoot);
    writeFileSync(join(explicitRoot, 'secret-project.md'), Buffer.alloc(scannerLimits.fileBytes + 1));
    ctx.explicitRoots = [explicitRoot];
    ctx.explicitRootSystem = 'claude';
    try {
      const result = discover(ctx);
      expect(result.errors).toEqual([]);
      const diagnostic = result.discoveryDiagnostics?.find(item => item.sourceType === 'explicit');
      expect(diagnostic).toBeDefined();
      expect(Object.keys(diagnostic!).sort()).toEqual([
        'capability', 'code', 'environment', 'explicitRootGuidance', 'foundCount',
        'limitation', 'skippedCount', 'sourceType', 'status'
      ]);
      expect(diagnostic).toMatchObject({
        environment: 'claude', capability: 'roots', sourceType: 'explicit',
        status: 'limited', code: 'SOURCE_UNSAFE', foundCount: 0, skippedCount: 1
      });
      expect(Buffer.byteLength(diagnostic!.limitation, 'utf8')).toBeLessThanOrEqual(256);
      expect(Buffer.byteLength(diagnostic!.explicitRootGuidance, 'utf8')).toBeLessThanOrEqual(256);
      expect(JSON.stringify(result.discoveryDiagnostics)).not.toContain(explicitRoot);
      expect(JSON.stringify(result.discoveryDiagnostics)).not.toContain('secret-project.md');
      expect(result.discoveryDiagnostics!.length).toBeLessThanOrEqual(100);
    } finally { cleanup(); }
  });

  it('reports scanner truncation without making discovery fatal', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    const explicitRoot = join(root, 'bounded-explicit');
    mkdirSync(explicitRoot);
    for (let i = 0; i <= scannerLimits.results; i++) writeFileSync(join(explicitRoot, `${i}.md`), '# skill');
    ctx.explicitRoots = [explicitRoot];
    ctx.explicitRootSystem = 'generic';
    try {
      const result = discover(ctx);
      expect(result.errors).toEqual([]);
      expect(result.artifacts.filter(artifact => artifact.system === 'generic')).toHaveLength(scannerLimits.results);
      expect(result.discoveryDiagnostics).toContainEqual(expect.objectContaining({
        environment: 'generic', sourceType: 'explicit', status: 'truncated',
        code: 'SOURCE_TRUNCATED', foundCount: scannerLimits.results, skippedCount: 1
      }));
    } finally { cleanup(); }
  });

  it('canonical path tie uses static adapter order and keeps higher precedence', () => {
    const { root, cleanup } = makeTempWorkspace();
    const path = writeFixture(root, 'tie.md', '# tie');
    mkdirSync(join(root, 'alias'));
    const alias = `${root}/alias/../tie.md`;
    const artifact = (system: 'claude' | 'opencode' | 'generic', absolutePath: string, precedence: number) => ({
      system, kind: 'instruction_file' as const, absolutePath, relativePath: 'tie.md', rootOrigin: root,
      precedence, configIndirection: null, rawStat: { mtimeMs: 1, size: 5 }
    });
    try {
      expect(dedupArtifacts([artifact('opencode', alias, 70), artifact('claude', path, 70)]))
        .toEqual([expect.objectContaining({ system: 'claude', absolutePath: path })]);
      expect(dedupArtifacts([artifact('claude', path, 70), artifact('generic', alias, 80)]))
        .toEqual([expect.objectContaining({ system: 'generic', absolutePath: alias })]);
    } finally { cleanup(); }
  });
});

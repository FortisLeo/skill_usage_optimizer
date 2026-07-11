import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalize } from '../src/normalize/index.js';
import { discover } from '../src/discovery/index.js';
import type { DiscoveredArtifact, DiscoveryContext } from '../src/types.js';
import { makeTempWorkspace, writeFixture } from './testUtils.js';
import { computeHash } from '../src/fs/freshness.js';

function makeArtifact(overrides: Partial<DiscoveredArtifact> = {}): DiscoveredArtifact {
  return {
    system: 'claude',
    kind: 'instruction_file',
    absolutePath: '/tmp/test.md',
    relativePath: 'test.md',
    rootOrigin: '/tmp',
    precedence: 80,
    configIndirection: null,
    rawStat: { mtimeMs: 0, size: 0 },
    ...overrides
  };
}

function makeTestCtx(): DiscoveryContext {
  return {
    workspaceRoot: '/tmp',
    repoRoot: null,
    homeDir: '/tmp/home',
    includeGlobals: false,
    includeSystem: false,
    explicitRoots: []
  };
}

describe('normalize', () => {
  it('returns empty inputs for empty artifacts', () => {
    const { inputs, errors } = normalize([], makeTestCtx());
    expect(inputs).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('normalizes a simple markdown skill into NormalizedSkillInput', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    const path = writeFixture(root, 'simple.md', '---\nname: test\n---\n# This is a test');
    try {
      const artifact: DiscoveredArtifact = {
        system: 'claude',
        kind: 'instruction_file',
        absolutePath: path,
        relativePath: 'simple.md',
        rootOrigin: root,
        precedence: 80,
        configIndirection: null,
        rawStat: { mtimeMs: 0, size: statSync(path).size }
      };
      const { inputs, errors } = normalize([artifact], ctx);
      expect(errors).toEqual([]);
      expect(inputs).toHaveLength(1);
      expect(inputs[0]!.skillName).toBe('simple');
      expect(inputs[0]!.frontmatter).toEqual({ name: 'test' });
      expect(inputs[0]!.sourcePath).toBe(path);
      expect(inputs[0]!.sourceHash).toBeTruthy();
      expect(inputs[0]!.sourceHash.length).toBe(64); // sha256
      expect(inputs[0]!.size).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });

  it('uses fresh size and mtime when file changes after discovery', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    const path = writeFixture(root, '.claude/skills/race.md', '# Old');
    try {
      const { artifacts } = discover(ctx);
      const artifact = artifacts.find(a => a.absolutePath === path)!;
      writeFileSync(path, '# New content with a different size', 'utf-8');
      const current = statSync(path);

      const { inputs, errors } = normalize([artifact], ctx);

      expect(errors).toEqual([]);
      expect(inputs[0]!.mtimeMs).toBe(current.mtimeMs);
      expect(inputs[0]!.size).toBe(current.size);
    } finally {
      cleanup();
    }
  });

  it('extracts frontmatter fields correctly', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    const path = writeFixture(root, 'fm.md', [
      '---',
      'name: my-skill',
      'description: Does things',
      'version: 2.0',
      'enabled: true',
      'tags: null',
      '---',
      '# Body'
    ].join('\n'));
    try {
      const artifact = makeArtifact({ absolutePath: path, relativePath: 'fm.md' });
      const { inputs, errors } = normalize([artifact], ctx);
      expect(errors).toEqual([]);
      expect(inputs[0]!.frontmatter).toMatchObject({
        name: 'my-skill',
        description: 'Does things',
        version: 2,
        enabled: true,
        tags: null
      });
      expect(inputs[0]!.description).toBe('Does things');
      expect(inputs[0]!.rawMarkdown).toContain('# Body');
      expect(inputs[0]!.rawMarkdown).toContain('---');
    } finally {
      cleanup();
    }
  });

  it('handles markdown without frontmatter', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    const path = writeFixture(root, 'no-fm.md', '# Just a heading\nSome content');
    try {
      const artifact = makeArtifact({ absolutePath: path });
      const { inputs, errors } = normalize([artifact], ctx);
      expect(errors).toEqual([]);
      expect(inputs[0]!.frontmatter).toEqual({});
      expect(inputs[0]!.rawMarkdown).toBe('# Just a heading\nSome content');
    } finally {
      cleanup();
    }
  });

  it('handles attachments from frontmatter', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    const path = writeFixture(root, 'att.md', [
      '---',
      'name: with-attachments',
      'attachments: a.md, b.md',
      '---',
      '# With attachments'
    ].join('\n'));
    try {
      const artifact = makeArtifact({ absolutePath: path });
      const { inputs } = normalize([artifact], ctx);
      expect(inputs[0]!.attachments).toEqual(['a.md', 'b.md']);
    } finally {
      cleanup();
    }
  });

  it('strips BOM, detects frontmatter, and hashes normalized full markdown', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    const normalized = '---\ndescription: From fm\n---\n# Heading\nBody';
    const path = writeFixture(root, 'bom.md', `\uFEFF${normalized}`);
    try {
      const artifact = makeArtifact({ absolutePath: path });
      const { inputs, errors } = normalize([artifact], ctx);
      expect(errors).toEqual([]);
      expect(inputs[0]!.frontmatter.description).toBe('From fm');
      expect(inputs[0]!.rawMarkdown).toBe(normalized);
      expect(inputs[0]!.sourceHash).toBe(computeHash(normalized));
    } finally {
      cleanup();
    }
  });

  it('normalizes CRLF and bare CR to LF', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    const path = writeFixture(root, 'cr.md', '---\r\ndescription: D\r\n---\r# A\rBody');
    try {
      const { inputs, errors } = normalize([makeArtifact({ absolutePath: path })], ctx);
      expect(errors).toEqual([]);
      expect(inputs[0]!.rawMarkdown).toBe('---\ndescription: D\n---\n# A\nBody');
    } finally {
      cleanup();
    }
  });

  it('handles YAML list attachments', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    const path = writeFixture(root, 'yaml-list.md', [
      '---',
      'attachments:',
      '  - a.md',
      '  - b.md',
      '---',
      '# Body'
    ].join('\n'));
    try {
      const { inputs, errors } = normalize([makeArtifact({ absolutePath: path })], ctx);
      expect(errors).toEqual([]);
      expect(inputs[0]!.attachments).toEqual(['a.md', 'b.md']);
    } finally {
      cleanup();
    }
  });

  it('handles block scalar description', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    const path = writeFixture(root, 'block.md', [
      '---',
      'description: >',
      '  One line',
      '  two line',
      '---',
      '# Body'
    ].join('\n'));
    try {
      const { inputs, errors } = normalize([makeArtifact({ absolutePath: path })], ctx);
      expect(errors).toEqual([]);
      expect(inputs[0]!.description).toBe('One line two line\n');
    } finally {
      cleanup();
    }
  });

  it('parses block scalar modifiers and nested YAML values', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    const path = writeFixture(root, 'nested-yaml.md', [
      '---',
      'description: >-',
      '  One line',
      '  two line',
      'metadata:',
      '  audience: developers',
      '  tags:',
      '    - yaml',
      '    - normalize',
      '---',
      '# Body'
    ].join('\n'));
    try {
      const { inputs, errors } = normalize([makeArtifact({ absolutePath: path })], ctx);
      expect(errors).toEqual([]);
      expect(inputs[0]!.description).toBe('One line two line');
      expect(inputs[0]!.frontmatter.metadata).toEqual({
        audience: 'developers',
        tags: ['yaml', 'normalize']
      });
    } finally {
      cleanup();
    }
  });

  it('handles empty frontmatter', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    const path = writeFixture(root, 'empty-fm.md', '---\n---\n# Body');
    try {
      const { inputs, errors } = normalize([makeArtifact({ absolutePath: path })], ctx);
      expect(errors).toEqual([]);
      expect(inputs[0]!.frontmatter).toEqual({});
    } finally {
      cleanup();
    }
  });

  it('rejects non-mapping frontmatter roots', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    const path = writeFixture(root, 'list-fm.md', '---\n- not a mapping\n---\n# Body');
    try {
      const { inputs, errors } = normalize([makeArtifact({ absolutePath: path })], ctx);
      expect(inputs).toEqual([]);
      expect(errors[0]!.path).toBe(path);
      expect(errors[0]!.error).toMatch(/frontmatter root must be a mapping/);
    } finally {
      cleanup();
    }
  });

  it('rejects null frontmatter roots', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    const path = writeFixture(root, 'null-fm.md', '---\nnull\n---\n# Body');
    try {
      const { inputs, errors } = normalize([makeArtifact({ absolutePath: path })], ctx);
      expect(inputs).toEqual([]);
      expect(errors[0]!.error).toMatch(/frontmatter root must be a mapping/);
    } finally {
      cleanup();
    }
  });

  it('returns an error and skips malformed frontmatter', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    const path = writeFixture(root, 'bad.md', '---\ndescription: nope\n# Body');
    try {
      const { inputs, errors } = normalize([makeArtifact({ absolutePath: path })], ctx);
      expect(inputs).toEqual([]);
      expect(errors[0]!.path).toBe(path);
      expect(errors[0]!.error).toBeTruthy();
    } finally {
      cleanup();
    }
  });

  it('catches read errors and returns them in errors array', () => {
    const artifact = makeArtifact({ absolutePath: '/nonexistent/file.md' });
    const { inputs, errors } = normalize([artifact], makeTestCtx());
    expect(inputs).toEqual([]);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0]!.path).toBe('/nonexistent/file.md');
    expect(errors[0]!.error).toBeTruthy();
  });

  it('rejects artifact whose path is outside allowed roots (path safety)', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    try {
      // Create a file outside the workspace to simulate an artifact from an
      // unauthorized root. The artifact points to a path that exists but is
      // not within workspaceRoot, repoRoot, or homeDir.
      const outsidePath = writeFixture(root, '../outside-skill.md', '# Outside');
      const realOutside = require('node:fs').realpathSync(outsidePath);

      // ctx has workspaceRoot=root, homeDir=some temp dir — neither contains realOutside
      const artifact: DiscoveredArtifact = {
        system: 'claude',
        kind: 'instruction_file',
        absolutePath: realOutside,
        relativePath: 'outside-skill.md',
        rootOrigin: '/etc',
        precedence: 80,
        configIndirection: null,
        rawStat: { mtimeMs: 0, size: 0 }
      };
      const { inputs, errors } = normalize([artifact], ctx);
      expect(inputs).toEqual([]);
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors[0]!.path).toBe(realOutside);
      expect(errors[0]!.error).toMatch(/outside allowed roots/);
    } finally {
      cleanup();
    }
  });

  it('rejects artifact whose absolutePath cannot be resolved', () => {
    const ctx = makeTestCtx();
    const artifact: DiscoveredArtifact = {
      system: 'claude',
      kind: 'instruction_file',
      absolutePath: '/nonexistent/abc/def.md',
      relativePath: 'def.md',
      rootOrigin: '/nonexistent/abc',
      precedence: 80,
      configIndirection: null,
      rawStat: { mtimeMs: 0, size: 0 }
    };
    const { inputs, errors } = normalize([artifact], ctx);
    expect(inputs).toEqual([]);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0]!.error).toMatch(/cannot be resolved/);
  });

  it('discover → normalize: accepts codex system artifacts when includeSystem is true', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    ctx.includeSystem = true;
    ctx.includeGlobals = false;
    const sysDir = mkdtempSync(join(tmpdir(), 'codex-sys-norm-'));
    const skillsDir = join(sysDir, 'codex', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'system-skill.md'), '---\nname: sys-norm\n---\n# System Norm');
    ctx.codexSystemRoot = skillsDir;
    try {
      const { artifacts: discovered } = discover(ctx);
      const sysArts = discovered.filter(a =>
        a.system === 'codex' && a.absolutePath.includes('system-skill.md')
      );
      expect(sysArts.length).toBe(1);

      const { inputs, errors } = normalize(sysArts, ctx);
      expect(errors).toEqual([]);
      expect(inputs).toHaveLength(1);
      expect(inputs[0]!.skillName).toBe('system-skill');
      expect(inputs[0]!.description).toBeNull(); // name is not a description fallback
      expect(inputs[0]!.sourceHash).toHaveLength(64);
      expect(inputs[0]!.system).toBe('codex');
      expect(inputs[0]!.precedence).toBe(10); // system precedence
    } finally {
      cleanup();
      try { rmSync(sysDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });
});

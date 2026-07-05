// ponytail: eval tests — property-based and edge cases for schema validators
import { describe, expect, it } from 'vitest';
import {
  validateIndexSkillsArgs,
  validateListSkillsArgs,
  validateGetSkillManifestArgs,
  validateGetSkillSectionsArgs,
  validateLoadSkillContextArgs,
  validateLoadSectionArgs
} from '../src/mcp/schemas.js';

describe('schema validators', () => {
  describe('validateIndexSkillsArgs', () => {
    it('accepts valid input', () => {
      const r = validateIndexSkillsArgs({ system: 'claude' });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.system).toBe('claude');
    });

    it('rejects missing system', () => {
      const r = validateIndexSkillsArgs({});
      expect(r.ok).toBe(false);
    });

    it('rejects invalid system', () => {
      const r = validateIndexSkillsArgs({ system: 'invalid' });
      expect(r.ok).toBe(false);
    });

    it('accepts all valid systems', () => {
      for (const sys of ['claude', 'opencode', 'codex', 'copilot']) {
        const r = validateIndexSkillsArgs({ system: sys });
        expect(r.ok).toBe(true);
      }
    });

    it('validates optional roots', () => {
      const r = validateIndexSkillsArgs({ system: 'claude', roots: ['/a', '/b'] });
      expect(r.ok).toBe(true);
    });

    it('rejects non-array roots', () => {
      const r = validateIndexSkillsArgs({ system: 'claude', roots: 'not-array' });
      expect(r.ok).toBe(false);
    });

    it('rejects null input', () => {
      const r = validateIndexSkillsArgs(null);
      expect(r.ok).toBe(false);
    });
  });

  describe('validateListSkillsArgs', () => {
    it('accepts empty args', () => {
      const r = validateListSkillsArgs({});
      expect(r.ok).toBe(true);
    });

    it('accepts optional system filter', () => {
      const r = validateListSkillsArgs({ system: 'opencode' });
      expect(r.ok).toBe(true);
    });

    it('rejects invalid system', () => {
      const r = validateListSkillsArgs({ system: 'nope' });
      expect(r.ok).toBe(false);
    });
  });

  describe('validateGetSkillManifestArgs', () => {
    it('accepts valid skillId', () => {
      const r = validateGetSkillManifestArgs({ skillId: 'my-skill' });
      expect(r.ok).toBe(true);
    });

    it('rejects empty skillId', () => {
      const r = validateGetSkillManifestArgs({ skillId: '' });
      expect(r.ok).toBe(false);
    });

    it('rejects missing skillId', () => {
      const r = validateGetSkillManifestArgs({});
      expect(r.ok).toBe(false);
    });
  });

  describe('validateGetSkillSectionsArgs', () => {
    it('accepts valid skillId', () => {
      const r = validateGetSkillSectionsArgs({ skillId: 'skill-x' });
      expect(r.ok).toBe(true);
    });

    it('rejects missing skillId', () => {
      const r = validateGetSkillSectionsArgs({});
      expect(r.ok).toBe(false);
    });
  });

  describe('validateLoadSkillContextArgs', () => {
    it('accepts valid query', () => {
      const r = validateLoadSkillContextArgs({ query: 'find skills' });
      expect(r.ok).toBe(true);
    });

    it('rejects empty query when set', () => {
      const r = validateLoadSkillContextArgs({ query: '' });
      expect(r.ok).toBe(false);
    });

    it('accepts empty object (no query, full request mode)', () => {
      const r = validateLoadSkillContextArgs({});
      expect(r.ok).toBe(true);
    });

    it('accepts phase only without query', () => {
      const r = validateLoadSkillContextArgs({ phase: 'build' });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.query).toBeUndefined();
    });

    it('accepts full request with includeReferences and maxBytes', () => {
      const r = validateLoadSkillContextArgs({ includeReferences: true, maxBytes: 5000 });
      expect(r.ok).toBe(true);
    });
  });

  describe('validateLoadSectionArgs', () => {
    it('accepts valid sectionId', () => {
      const r = validateLoadSectionArgs({ sectionId: 'sec-1' });
      expect(r.ok).toBe(true);
    });

    it('rejects empty sectionId', () => {
      const r = validateLoadSectionArgs({ sectionId: '' });
      expect(r.ok).toBe(false);
    });
  });
});
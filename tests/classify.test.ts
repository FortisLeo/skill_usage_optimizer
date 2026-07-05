import { describe, expect, it } from 'vitest';
import { classifyHeading } from '../src/compiler/classify.js';

const classifySection = (title: string, _content: string) => classifyHeading(title);

describe('classifySection', () => {
  it('classifies "overview" headings as always', () => {
    expect(classifySection('Overview', '')).toBe('always');
    expect(classifySection('Introduction', '')).toBe('always');
    expect(classifySection('Summary', '')).toBe('always');
  });

  it('classifies "setup" headings as always', () => {
    expect(classifySection('Setup', '')).toBe('always');
    expect(classifySection('Getting Started', '')).toBe('always');
    expect(classifySection('Prerequisites', '')).toBe('always');
    expect(classifySection('Installation', '')).toBe('always');
    expect(classifySection('Configuration', '')).toBe('always');
    expect(classifySection('Requirements', '')).toBe('always');
  });

  it('classifies "usage" headings as phase', () => {
    expect(classifySection('Usage', '')).toBe('phase');
    expect(classifySection('Implementation', '')).toBe('phase');
    expect(classifySection('Steps', '')).toBe('phase');
    expect(classifySection('Instructions', '')).toBe('phase');
    expect(classifySection('Workflow', '')).toBe('phase');
    expect(classifySection('Step by Step', '')).toBe('phase');
    expect(classifySection('Procedure', '')).toBe('phase');
  });

  it('classifies "examples" headings as on_demand', () => {
    expect(classifySection('Examples', '')).toBe('on_demand');
    expect(classifySection('Troubleshooting', '')).toBe('on_demand');
    expect(classifySection('Edge Cases', '')).toBe('on_demand');
    expect(classifySection('Common Issues', '')).toBe('on_demand');
    expect(classifySection('Debugging', '')).toBe('on_demand');
    expect(classifySection('FAQ', '')).toBe('on_demand');
    expect(classifySection('Tips', '')).toBe('on_demand');
    expect(classifySection('Best Practices', '')).toBe('on_demand');
  });

  it('classifies "references" headings as reference', () => {
    expect(classifySection('References', '')).toBe('reference');
    expect(classifySection('Links', '')).toBe('reference');
    expect(classifySection('Further Reading', '')).toBe('reference');
    expect(classifySection('See Also', '')).toBe('reference');
    expect(classifySection('Related Skills', '')).toBe('reference');
    expect(classifySection('Resources', '')).toBe('reference');
  });

  it('classifies mandatory-rule headings as always', () => {
    expect(classifySection('Rules', '')).toBe('always');
    expect(classifySection('Safety', '')).toBe('always');
    expect(classifySection('Permissions', '')).toBe('always');
    expect(classifySection('Constraints', '')).toBe('always');
    expect(classifySection('Output Contract', '')).toBe('always');
    expect(classifySection('Output Format', '')).toBe('always');
    expect(classifySection('When Not To Use', '')).toBe('always');
    expect(classifySection('Security', '')).toBe('always');
    expect(classifySection('Persistence', '')).toBe('always');
    expect(classifySection('State', '')).toBe('always');
  });

  it('classifies singular rule headings as always', () => {
    expect(classifySection('Critical Rule', '')).toBe('always');
    expect(classifySection('Hard Global Execution Rule', '')).toBe('always');
    expect(classifySection('Mandatory Rule', '')).toBe('always');
    expect(classifySection('Global Rule', '')).toBe('always');
    expect(classifySection('Execution Rule', '')).toBe('always');
    expect(classifySection('Hard Rule', '')).toBe('always');
    expect(classifySection('Mandatory', '')).toBe('always');
  });

  it('defaults unknown headings to phase', () => {
    expect(classifySection('Mystery Heading', '')).toBe('phase');
    expect(classifySection('Custom Section', '')).toBe('phase');
    expect(classifySection('Advanced Topics', '')).toBe('phase');
  });

  it('matches keywords case-insensitively', () => {
    expect(classifySection('OVERVIEW', '')).toBe('always');
    expect(classifySection('Troubleshooting', '')).toBe('on_demand');
    expect(classifySection('REFERENCES', '')).toBe('reference');
  });

  it('matches partial keyword includes within heading', () => {
    expect(classifySection('Setup and Configuration', '')).toBe('always');
    expect(classifySection('Usage Examples', '')).toBe('phase');
    expect(classifySection('Examples and Demos', '')).toBe('on_demand');
  });

  it('first matching keyword wins when multiple match', () => {
    // "usage examples" matches both "usage" (phase) and "examples" (on_demand)
    // Object.entries order determines winner
    const result = classifySection('Usage Examples', '');
    expect(['phase', 'on_demand']).toContain(result);
  });
});

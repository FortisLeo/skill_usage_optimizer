import type { SectionClass } from '../types.js';

export type { SectionClass } from '../types.js';

const KEYWORD_MAP: Record<string, SectionClass> = {
  preamble: 'always',
  overview: 'always',
  setup: 'always',
  'getting started': 'always',
  introduction: 'always',
  prerequisites: 'always',
  installation: 'always',
  configuration: 'always',
  requirements: 'always',
  summary: 'always',
  rules: 'always',
  rule: 'always',
  'critical rule': 'always',
  'mandatory rule': 'always',
  'global rule': 'always',
  'execution rule': 'always',
  'hard rule': 'always',
  mandatory: 'always',
  safety: 'always',
  permissions: 'always',
  constraints: 'always',
  'output contract': 'always',
  'output format': 'always',
  'when not to use': 'always',
  'when not': 'always',
  security: 'always',
  persistence: 'always',
  state: 'always',
  usage: 'phase',
  implementation: 'phase',
  steps: 'phase',
  instructions: 'phase',
  workflow: 'phase',
  'step by step': 'phase',
  procedure: 'phase',
  examples: 'on_demand',
  troubleshooting: 'on_demand',
  'edge cases': 'on_demand',
  'common issues': 'on_demand',
  debugging: 'on_demand',
  faq: 'on_demand',
  tips: 'on_demand',
  'best practices': 'on_demand',
  references: 'reference',
  links: 'reference',
  'further reading': 'reference',
  'see also': 'reference',
  'related skills': 'reference',
  resources: 'reference'
};

export function classifyHeading(title: string): SectionClass {
  const lower = title.toLowerCase().trim();
  for (const [keyword, cls] of Object.entries(KEYWORD_MAP)) {
    if (lower.includes(keyword)) return cls;
  }
  return 'phase';
}

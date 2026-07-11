// Flow expansion scaffold.
// Full flow parsing (from <!-- flow: ... --> annotations) is Phase P7.
// This phase implements the expansion function that flows.ts needs to exist for.

import type { SkillSection } from '../types.js';

export interface FlowDefinition {
  id: string;
  summary: string;
  steps: string[]; // ordered section IDs
}

// Placeholder: Phase P7 will populate this from parsed flows.json
const activeFlows = new Map<string, FlowDefinition>();

export function registerFlow(flow: FlowDefinition): void {
  activeFlows.set(flow.id, flow);
}

export function isFlow(query: string, allSections: SkillSection[]): boolean {
  // Phase P7: search activeFlows by query
  // For now, return false (no flows registered)
  return false;
}

export function expandFlow(flowId: string, allSections: SkillSection[]): SkillSection[] {
  const flow = activeFlows.get(flowId);
  if (!flow) return [];

  return flow.steps
    .map(id => allSections.find(s => s.id === id))
    .filter((s): s is SkillSection => s !== undefined)
    .map((s, i) => ({
      ...s,
      // Re-order by flow step order
      order: i,
    }));
}
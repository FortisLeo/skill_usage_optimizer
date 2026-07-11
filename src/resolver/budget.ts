// Budget tracking and collapse-to-whole-file valve

import type { SkillSection } from '../types.js';

const DEFAULT_COLLAPSE_RATIO = 0.7;
const DEFAULT_BUDGET = 2500;

export interface BudgetConfig {
  limit: number;
  collapseRatio: number;
}

export function defaultBudget(): BudgetConfig {
  return { limit: DEFAULT_BUDGET, collapseRatio: DEFAULT_COLLAPSE_RATIO };
}

function countTokens(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

// ---------------------------------------------------------------------------
// Collapse-to-whole-file valve
// If the hard closure already approaches the whole file in size, just load
// the whole file — it's cheaper and safer.
// ---------------------------------------------------------------------------

export function shouldCollapse(
  hardSections: SkillSection[],
  skillSections: SkillSection[],
  collapseRatio: number
): boolean {
  if (hardSections.length === 0 || skillSections.length === 0) return false;

  const hardTokens = hardSections.reduce((sum, s) => sum + countTokens(s.content), 0);
  const wholeTokens = skillSections.reduce((sum, s) => sum + countTokens(s.content), 0);

  if (wholeTokens === 0) return false;
  return hardTokens / wholeTokens >= collapseRatio;
}

// ---------------------------------------------------------------------------
// Budget tracking for soft section expansion
// ---------------------------------------------------------------------------

export interface BudgetState {
  remaining: number;
  used: number;
}

export function createBudget(limit: number): BudgetState {
  return { remaining: limit, used: 0 };
}

export function sectionTokens(section: SkillSection): number {
  return section.tokenCount ?? countTokens(section.title + '\n' + section.content);
}

// Returns true if the section fits within the remaining budget
export function fitsInBudget(state: BudgetState, section: SkillSection): boolean {
  return state.remaining - sectionTokens(section) >= 0;
}

// Deduct the section's token cost from the budget. Returns new state.
export function deductBudget(state: BudgetState, section: SkillSection): BudgetState {
  const tokens = sectionTokens(section);
  return {
    remaining: state.remaining - tokens,
    used: state.used + tokens,
  };
}
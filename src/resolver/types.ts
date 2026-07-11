// Resolver-internal types. Phase P2 implements resolution logic against these.

export interface DanglingDep {
  type: 'dangling_requires';
  sourceSection: string;
  targetId: string;
  reason: string;
}

export interface TrustDemotion {
  type: 'trust_demotion';
  sourceSection: string;
  targetId: string;
  fromTier: string;
  toTier: string;
  direction: 'lower_to_higher' | 'higher_to_lower';
}

export type ResolveWarning = DanglingDep | TrustDemotion;
/**
 * Shared domain types for the multiplex PCR pool allocator.
 */

/** One amplicon as submitted by the caller, in recording order. */
export interface AmpliconInput {
  name: string;
  /** Positive integer reaction load. */
  load: number;
  /** Whether this amplicon carries the positive control marker. */
  isControl: boolean;
}

/** Unordered amplicon pair with a non-negative dimer risk score. */
export interface RiskPairInput {
  /** Amplicon name (order of a/b does not matter). */
  a: string;
  /** Amplicon name (order of a/b does not matter). */
  b: string;
  /** Non-negative integer risk score. */
  risk: number;
}

/** One pre-installed (immovable) amplicon position. */
export interface PreassignmentInput {
  /** Amplicon name; must reference a known amplicon. */
  amplicon: string;
  /** 1-based pool number (1..poolCount). */
  pool: number;
}

export interface AllocateRequest {
  amplicons: AmpliconInput[];
  /** Number of parallel reaction pools, 2..4. */
  poolCount: number;
  /** Inclusive uniform load interval that every pool must fall into. */
  loadRange: { min: number; max: number };
  riskPairs: RiskPairInput[];
  /** Pairs whose risk reaches this value are forbidden from sharing a pool. */
  hardThreshold: number;
  /**
   * Optional pre-installed (immovable) amplicon positions: 1–4 entries, each
   * naming a known amplicon and its 1-based pool number. Pre-installed
   * amplicons still count toward per-pool controls, loads, hard forbidden
   * pairs and risk statistics; only the remaining amplicons are allocated.
   */
  preassignments?: PreassignmentInput[];
}

export interface PoolResult {
  pool: number;
  members: string[];
  load: number;
  controls: string[];
  riskPairs: { a: string; b: string; risk: number }[];
  riskSum: number;
}

/** A hard-constraint violation already forced by the pre-installed positions. */
export interface PreassignmentConflict {
  /** Pre-installed amplicons involved, in recording order. */
  members: string[];
  /** 1-based pool number where the rule is violated. */
  pool: number;
  /** Human-readable description of the violated rule. */
  rule: string;
}

export interface ConflictSummary {
  /** Forbidden pairs (risk >= hardThreshold); a feasible partition may still exist. */
  forbiddenPairs: { a: string; b: string; risk: number }[];
  /**
   * Clique (set of pairwise forbidden amplicons) that is larger than the
   * available pool count, proving impossibility of the hard constraints.
   */
  overCapacityClique: string[];
  /** Pools lacking a positive control at infeasibility, when attributable. */
  poolsWithoutControl?: number;
  /** Load-range explanation, when the interval itself can never fit. */
  loadIssue?: string;
  /**
   * Hard-constraint violations already forced by the pre-installed positions
   * (a forbidden pair pinned into one pool, or a pre-installed load that
   * exceeds the pool capacity on its own).
   */
  preassignmentConflicts?: PreassignmentConflict[];
}

export interface AllocateResponse {
  feasible: boolean;
  poolCount?: number;
  pools?: PoolResult[];
  maxPoolRisk?: number;
  totalRisk?: number;
  loadSpread?: number;
  assignment?: { amplicon: string; pool: number }[];
  conflictSummary?: ConflictSummary;
}

/** A single validation problem; field is a JSON pointer-ish locator. */
export interface ValidationIssue {
  field: string;
  message: string;
}

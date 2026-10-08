// src/components/landing/landing-intro-constants.ts

/**
 * Shared deterministic timing constants for the SYNQ landing intro animation sequence (B.11.5).
 */
export const LANDING_INTRO_TIMING = {
  /** 0–250ms: Genuinely empty charcoal #242424 background hold */
  EMPTY_HOLD_MS: 250,

  /** 250–1000ms: Wordmark emerges from darkness at initial scale 0.30 */
  WORDMARK_EMERGE_END_MS: 1000,

  /** 1000–1500ms: 500ms pause holding small Synq wordmark at scale 0.30 before expansion */
  WORDMARK_PAUSE_END_MS: 1500,

  /** 1500–2250ms: Coordinated wordmark expansion (0.30 -> 1.0) and smootherstep hand entrance */
  EXPANSION_HANDS_END_MS: 2250,

  /** Hand travel duration (2250 - 1500 = 750ms) */
  HAND_TRAVEL_DURATION_MS: 750,

  /** 2250–2700ms: Autonomous pixel flicker and indicator cubes reveal; full interactivity at 2700ms */
  TOTAL_DURATION_MS: 2700,

  /** Initial wordmark scale during the first second and pause */
  INITIAL_WORDMARK_SCALE: 0.30,
} as const;

/**
 * Shared deterministic timing constants for the SYNQ Enter exit transition (B.11.5 Part B).
 */
export const LANDING_EXIT_TIMING = {
  /** Phase 1 (0–500ms): Both hands retreat offscreen using smootherstep */
  HANDS_RETREAT_DURATION_MS: 500,

  /** Phase 2 (500–1000ms): Remaining landing elements fade into #242424 charcoal */
  FADE_OUT_DURATION_MS: 500,

  /** Total exit animation duration before router navigation */
  TOTAL_DURATION_MS: 1000,
} as const;

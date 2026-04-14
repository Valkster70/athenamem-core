/**
 * AthenaMem Salience Scoring
 * 
 * Determines how "important" a memory is based on content analysis
 * and metadata. High-salience memories are prioritized for recall
 * and protected from compaction.
 */

import { SalienceInput } from './event.js';

export interface SalienceScore {
  score: number; // 0.0 - 1.0
  components: {
    baseScore: number;
    categoryBoost: number;
    contentBoost: number;
    metadataBoost: number;
    penalty: number;
  };
  reasoning: string[];
}

const CATEGORY_WEIGHTS: Record<string, number> = {
  preference: 0.85,
  project: 0.80,
  decision: 0.75,
  lesson: 0.70,
  person: 0.65,
  system: 0.60,
  discoveries: 0.55,
  general: 0.40,
};

const CONTENT_PATTERNS = {
  // High-value patterns boost salience
  decisionWords: /\b(decided|chose|selected|picked|opted|went with)\b/gi,
  preferenceWords: /\b(prefers|likes|wants|hates|avoids|favorite)\b/gi,
  projectWords: /\b(project|milestone|deadline|deliverable|release)\b/gi,
  lessonWords: /\b(lesson|learned|realized|understood|mistake|fixed)\b/gi,
  personWords: /\b(works at|contact|phone|email|@|meeting with)\b/gi,
  
  // Low-value patterns reduce salience
  fillerWords: /\b(um|uh|like|you know|sort of|kind of)\b/gi,
  shortContent: /^.{0,20}$/,
  repetitive: /(.{10,})\1+/gi,
};

export function scoreSalience(input: SalienceInput): SalienceScore {
  const reasoning: string[] = [];
  
  // Base score from category
  const baseScore = CATEGORY_WEIGHTS[input.category] ?? 0.40;
  reasoning.push(`Base category (${input.category}): +${baseScore.toFixed(2)}`);
  
  // Category-specific boosts
  let categoryBoost = 0;
  if (input.isPreference) {
    categoryBoost += 0.15;
    reasoning.push('Preference flag: +0.15');
  }
  if (input.isProjectMemory) {
    categoryBoost += 0.10;
    reasoning.push('Project memory: +0.10');
  }
  if (input.isDecision) {
    categoryBoost += 0.10;
    reasoning.push('Decision flag: +0.10');
  }
  
  // Content analysis
  let contentBoost = 0;
  if (input.content) {
    if (CONTENT_PATTERNS.decisionWords.test(input.content)) {
      contentBoost += 0.10;
      reasoning.push('Decision pattern detected: +0.10');
    }
    if (CONTENT_PATTERNS.preferenceWords.test(input.content)) {
      contentBoost += 0.10;
      reasoning.push('Preference pattern detected: +0.10');
    }
    if (CONTENT_PATTERNS.projectWords.test(input.content)) {
      contentBoost += 0.08;
      reasoning.push('Project pattern detected: +0.08');
    }
    if (CONTENT_PATTERNS.lessonWords.test(input.content)) {
      contentBoost += 0.08;
      reasoning.push('Lesson pattern detected: +0.08');
    }
    if (CONTENT_PATTERNS.personWords.test(input.content)) {
      contentBoost += 0.05;
      reasoning.push('Person/contact pattern: +0.05');
    }
  }
  
  // Metadata boosts
  let metadataBoost = 0;
  if (input.contradictionCount && input.contradictionCount > 0) {
    metadataBoost += 0.15;
    reasoning.push(`Active contradiction (${input.contradictionCount}): +0.15`);
  }
  if (input.accessCount && input.accessCount > 5) {
    metadataBoost += Math.min(0.10, input.accessCount * 0.01);
    reasoning.push(`High access count (${input.accessCount}): +${Math.min(0.10, input.accessCount * 0.01).toFixed(2)}`);
  }
  if (input.recency && input.recency < 24) {
    metadataBoost += 0.05;
    reasoning.push('Recent memory (<24h): +0.05');
  }
  
  // Penalties
  let penalty = 0;
  if (input.content) {
    if (CONTENT_PATTERNS.shortContent.test(input.content)) {
      penalty += 0.20;
      reasoning.push('Very short content: -0.20');
    }
    const fillerMatches = input.content.match(CONTENT_PATTERNS.fillerWords);
    if (fillerMatches && fillerMatches.length > 2) {
      penalty += 0.10;
      reasoning.push('High filler word count: -0.10');
    }
    if (CONTENT_PATTERNS.repetitive.test(input.content)) {
      penalty += 0.15;
      reasoning.push('Repetitive content: -0.15');
    }
  }
  
  // Calculate final score
  let score = baseScore + categoryBoost + contentBoost + metadataBoost - penalty;
  score = Math.max(0.0, Math.min(1.0, score));
  
  return {
    score,
    components: {
      baseScore,
      categoryBoost,
      contentBoost,
      metadataBoost,
      penalty,
    },
    reasoning,
  };
}

/**
 * Quick salience check for existing memories
 */
export function estimateSalience(memoryId: string, kg: any): number {
  // This would query the KG for access patterns, contradictions, etc.
  // For now, return a default
  return 0.5;
}

/**
 * Determine if a memory should be protected from compaction
 */
export function shouldProtectFromCompaction(salienceScore: number, isContradicted: boolean): boolean {
  if (salienceScore >= 0.75) return true;
  if (isContradicted) return true;
  return false;
}

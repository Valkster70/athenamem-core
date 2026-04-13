/**
 * AthenaMem Contradiction Detection Engine
 *
 * Every memory retain operation checks new facts against the existing KG.
 * If a new assertion conflicts with an existing one (temporal overlap + different predicate),
 * the memory is flagged and the agent is notified.
 */
import { KnowledgeGraph, Memory } from './kg.js';
export interface Fact {
    subject: string;
    predicate: string;
    object: string;
    confidence: number;
    source?: string;
    timestamp?: number;
}
export interface Contradiction {
    new_fact: Fact;
    existing_fact: Fact;
    existing_entity_id: string;
    severity: 'high' | 'medium' | 'low';
    reason: string;
}
export interface CheckResult {
    has_contradiction: boolean;
    contradictions: Contradiction[];
    new_entities: {
        name: string;
        type: string;
    }[];
    warnings: string[];
}
/**
 * Extract structured facts from raw text using pattern matching.
 * Lightweight extractor — for production, replace with LLM extraction.
 */
export declare function extractFacts(text: string, source?: string, timestamp?: number): Fact[];
export declare class ContradictionDetector {
    private kg;
    constructor(kg: KnowledgeGraph);
    check(facts: Fact[]): CheckResult;
    private inferEntityType;
    private checkTemporalOverlap;
    private calculateSeverity;
    formatReport(result: CheckResult): string;
}
export declare function checkAndFlagContradictions(kg: KnowledgeGraph, memory: Memory, text: string): CheckResult;
//# sourceMappingURL=contradiction.d.ts.map
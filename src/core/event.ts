/**
 * AthenaMem Memory Event Types
 * 
 * Unified event model for all memory ingestion operations.
 * All memory writes go through ingestMemoryEvent() for durability and auditability.
 */

export type CategoryType = 
  | 'preference'
  | 'project'
  | 'decision'
  | 'lesson'
  | 'person'
  | 'system'
  | 'discoveries'
  | 'general';

export type MemorySource = 'tool' | 'diary' | 'boot' | 'import' | 'auto_capture';

export type MemoryEventState = 
  | 'raw' 
  | 'indexed' 
  | 'contradicted' 
  | 'compacted' 
  | 'archived' 
  | 'invalidated';

export interface MemoryEventProvenance {
  triggerTool?: string;
  filePath?: string;
  parentMemoryIds?: string[];
  originalContent?: string;
  extractionMethod?: 'manual' | 'auto' | 'kg_inference';
}

export interface MemoryEvent {
  id: string;
  sessionId: string;
  agentId: string;
  moduleName: string;
  sectionName: string;
  category: CategoryType;
  content: string;
  source: MemorySource;
  createdAt: number;
  confidence: number;
  salience: number;
  state: MemoryEventState;
  provenance: MemoryEventProvenance;
  
  // Optional metadata for downstream processing
  metadata?: Record<string, unknown>;
  
  // For structured data extraction
  extractedFacts?: Array<{
    subject: string;
    predicate: string;
    object: string;
    confidence: number;
  }>;
  
  // Contradiction tracking
  contradictionIds?: string[];
  replacedMemoryIds?: string[];
}

export interface IngestionResult {
  success: boolean;
  memoryId: string;
  drawerId?: string;
  salienceScore: number;
  contradictionsDetected: number;
  factsExtracted: number;
  warnings: string[];
  processingTimeMs: number;
}

export interface SalienceInput {
  category: CategoryType;
  content: string;
  contradictionCount?: number;
  accessCount?: number;
  isProjectMemory?: boolean;
  isPreference?: boolean;
  isDecision?: boolean;
  contentLength?: number;
  hasStructuredData?: boolean;
  recency?: number; // hours since creation
}

export interface ProjectOverviewInput {
  focus?: string;
  maxTokens?: number;
}

export interface FindContextInput {
  query: string;
  scope?: string;
  maxTokens?: number;
  includeTests?: boolean;
  includeSnippets?: boolean;
}

export interface FileContextInput {
  path: string;
  symbol?: string;
  startLine?: number;
  endLine?: number;
  maxTokens?: number;
}

export interface ImpactInput {
  path?: string;
  symbol?: string;
  maxTokens?: number;
}

export interface RelatedTestsInput {
  path?: string;
  symbol?: string;
  maxTokens?: number;
}

export interface StatusInput {
  verbose?: boolean;
}

export type BceToolName =
  | 'bce_get_project_overview'
  | 'bce_find_context'
  | 'bce_get_file_context'
  | 'bce_explain_impact'
  | 'bce_get_related_tests'
  | 'bce_get_status';

/**
 * Types for Context Markets API integration.
 */

export interface AgentMarketDraft {
  formattedQuestion: string; // 1-300 chars
  shortQuestion: string; // 1-200 chars
  marketType: "SUBJECTIVE" | "OBJECTIVE";
  evidenceMode: "social_only" | "web_enabled";
  sources: string[]; // max 25
  resolutionCriteria: string; // 1-6000 chars
  endTime: string; // YYYY-MM-DD HH:MM:SS
  timezone?: string; // IANA timezone, default America/New_York
}

export interface AgentSubmitResponse {
  submissionId: string;
  pollUrl: string;
}

export interface SubmissionPollResponse {
  submissionId: string;
  status: "pending" | "processing" | "complete" | "completed" | "created" | "failed";
  questions?: Array<{
    questionId?: string;
    id?: string;
    formattedQuestion: string;
    shortQuestion: string;
  }>;
  market?: {
    marketId: string;
    txHash: string;
    slug: string;
    url: string;
  };
  // Rejection fields
  refuseToResolve?: boolean;
  rejectionReason?: string;
  qualityExplanation?: string;
  // Auto-create tracking
  autoCreateFailed?: boolean;
  autoCreateError?: string;
}

export interface MarketCreateResponse {
  marketId: string;
  txHash: string;
  slug: string;
  url: string;
}

/** Wallet info for an agent */
export interface AgentWallet {
  agentId: string;
  address: string;
  privateKey: string;
  walletIndex: number;
}

/** Pending market creation tracked in state */
export interface PendingMarketCreation {
  submissionId: string;
  agentId: string;
  question: string;
  submittedAt: number;
  retryCount: number;
  lastPollAt: number;
}

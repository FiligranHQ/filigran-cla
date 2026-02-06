// GitHub Types
export interface GitHubUser {
  id: number;
  login: string;
  email?: string;
  name?: string;
}

export interface PullRequest {
  number: number;
  title: string;
  html_url: string;
  user: GitHubUser;
  head: {
    sha: string;
    ref: string;
  };
  base: {
    ref: string;
    repo: {
      owner: {
        login: string;
      };
      name: string;
      full_name: string;
    };
  };
}

export interface PullRequestWebhookPayload {
  action: string;
  number: number;
  pull_request: PullRequest;
  repository: {
    id: number;
    name: string;
    full_name: string;
    owner: {
      login: string;
    };
  };
  sender: GitHubUser;
  installation?: {
    id: number;
  };
}

// Concord Types
export interface ConcordAgreement {
  uid: string;
  title: string;
  status: string;
  signatureDate?: number;
}

export interface ConcordWebhookPayload {
  event_id: string;
  event_name: ConcordEventName;
  occured_at: string;
  source: 'USER' | 'SCHEDULED';
  content: {
    user?: {
      id: number;
      name: string;
      email: string;
      organization?: {
        id: number;
        name: string;
      };
    };
    agreement: {
      uid: string;
      title: string;
      description?: string;
      signedAgreementUid?: string;
      type: string;
      url?: string;
      file?: string;
      tags?: string[];
      members?: {
        users: Array<{
          id: number;
          name: string;
          email: string;
        }>;
      };
    };
  };
}

export type ConcordEventName =
  | 'AGREEMENT_EXECUTED'
  | 'AGREEMENT_NEW_SIGNATURE'
  | 'AGREEMENT_APPROVED'
  | 'AGREEMENT_EXPIRED'
  | 'AGREEMENT_CUSTOM_FIELDS_ADDED'
  | 'AGREEMENT_CUSTOM_FIELDS_UPDATED'
  | 'AGREEMENT_CUSTOM_FIELDS_DELETED'
  | 'AGREEMENT_LIFECYCLE_UPDATED'
  | 'AGREEMENT_CANCELLED'
  | 'AGREEMENT_BACK_TO_REVIEW'
  | 'AGREEMENT_NEGOTIATION_CREATED'
  | 'AGREEMENT_MOVE_TO_SIGNING'
  | 'AGREEMENT_NEGOTIATION_SHARED'
  | 'AGREEMENT_NEW_VERSION'
  | 'AGREEMENT_NEGOTIATION_JOINED';

// Database Types
export interface CLARecord {
  id?: number;
  github_username: string;
  github_user_id: number;
  github_email?: string;
  concord_agreement_uid: string;
  signed_at?: string;
  created_at: string;
  updated_at: string;
  status: CLAStatus;
}

export type CLAStatus = 'pending' | 'signed' | 'expired' | 'cancelled';

export interface PRRecord {
  id?: number;
  repo_full_name: string;
  pr_number: number;
  github_username: string;
  github_user_id: number;
  comment_id?: number;
  concord_agreement_uid?: string;
  created_at: string;
  updated_at: string;
}

// Service Types
export interface CLACheckResult {
  hasSigned: boolean;
  record?: CLARecord;
}

export interface CreateAgreementResult {
  agreementUid: string;
}

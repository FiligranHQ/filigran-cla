import { config } from '../config';
import { logger } from '../utils/logger';
import { ConcordAgreement, CreateAgreementResult } from '../types';

const API_BASE = config.concord.apiUrl;
const ORG_ID = config.concord.organizationId;

interface ConcordApiError {
  statusCode: number;
  restCode: string;
  message?: string;
}

async function concordFetch<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${API_BASE}${endpoint}`;
  
  const headers: Record<string, string> = {
    'X-API-KEY': config.concord.apiKey,
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  };

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (!response.ok) {
    let errorBody: ConcordApiError | string;
    try {
      errorBody = await response.json() as ConcordApiError;
    } catch {
      errorBody = await response.text();
    }
    
    logger.error('Concord API error', {
      status: response.status,
      endpoint,
      error: errorBody,
    });
    
    throw new Error(`Concord API error: ${response.status} - ${JSON.stringify(errorBody)}`);
  }

  // Handle 204 No Content
  if (response.status === 204) {
    return {} as T;
  }

  return await response.json() as T;
}

/**
 * Create a new agreement from the CLA template and invite the contributor to sign
 */
export async function createAgreementFromTemplate(
  contributorEmail: string,
  contributorName: string,
  githubUsername: string,
  repoName: string,
  prNumber: number
): Promise<CreateAgreementResult> {
  const templateId = config.concord.templateId;
  
  logger.info('Creating agreement from template', {
    templateId,
    contributorEmail,
    githubUsername,
    repoName,
    prNumber,
  });

  // Step 1: Use the automated template to create a new agreement
  // The automated template endpoint creates an agreement from a template
  const createResponse = await concordFetch<{ uid: string; status: string }>(
    `/organizations/${ORG_ID}/automated-templates/${templateId}`,
    {
      method: 'POST',
      body: JSON.stringify({
        title: `Filigran CLA - ${githubUsername}`,
        description: `Contributor License Agreement for GitHub user @${githubUsername} (${repoName}#${prNumber})`,
        // Fill in smartfields if the template has them
        fields: [
          {
            name: 'contributor_name',
            value: contributorName || githubUsername,
          },
          {
            name: 'contributor_email',
            value: contributorEmail,
          },
          {
            name: 'github_username',
            value: githubUsername,
          },
          {
            name: 'date',
            value: new Date().toISOString().split('T')[0],
          },
        ],
      }),
    }
  );

  const agreementUid = createResponse.uid;
  logger.info('Agreement created', { agreementUid });

  // Step 2: Invite the contributor to sign
  await inviteMemberToSign(agreementUid, contributorEmail, contributorName, githubUsername);

  // Step 3: Move the agreement to signing status
  await moveToSigning(agreementUid, contributorEmail);

  // Generate the signing URL
  // Concord provides a direct link to the agreement
  const signingUrl = `https://app.concordnow.com/agreements/${agreementUid}`;

  return {
    agreementUid,
    signingUrl,
  };
}

/**
 * Invite a member to the agreement
 */
async function inviteMemberToSign(
  agreementUid: string,
  email: string,
  name: string,
  githubUsername: string
): Promise<void> {
  logger.info('Inviting member to agreement', { agreementUid, email });

  await concordFetch<{ uid: string; status: string }>(
    `/organizations/${ORG_ID}/agreements/${agreementUid}/members`,
    {
      method: 'POST',
      body: JSON.stringify({
        invitations: {
          [email]: {
            permission: 'NO_EDIT',
          },
        },
        message: {
          subject: 'Filigran Contributor License Agreement',
          content: `Hello ${name || githubUsername},

Thank you for your contribution to Filigran's open source projects!

Before we can merge your pull request, we need you to sign the Contributor License Agreement (CLA). This is a one-time process that covers all future contributions.

Please click below to review and sign the CLA.

Best regards,
The Filigran Team`,
        },
        sendWithDocument: true,
      }),
    }
  );

  logger.info('Member invited successfully', { agreementUid, email });
}

/**
 * Move the agreement to signing phase and request signature
 */
async function moveToSigning(agreementUid: string, signerEmail: string): Promise<void> {
  logger.info('Moving agreement to signing', { agreementUid });

  // Configure signature slots
  await concordFetch(
    `/organizations/${ORG_ID}/agreements/${agreementUid}/signature/slots`,
    {
      method: 'PUT',
      body: JSON.stringify({
        items: [
          {
            label: 'Contributor',
            email: signerEmail,
            required: true,
          },
        ],
      }),
    }
  );

  // Request signature - this sends the document to DocuSign/embedded signing
  await concordFetch(
    `/organizations/${ORG_ID}/agreements/${agreementUid}/signature/request`,
    {
      method: 'POST',
      body: JSON.stringify({
        provider: 'DOCUSIGN',
        message: {
          subject: 'Please sign the Filigran Contributor License Agreement',
          content: 'Please sign this CLA to complete your contribution to Filigran open source projects.',
        },
      }),
    }
  );

  logger.info('Signature requested', { agreementUid });
}

/**
 * Get agreement details
 */
export async function getAgreement(agreementUid: string): Promise<ConcordAgreement> {
  const response = await concordFetch<{
    uid: string;
    metadata: { title: string; status: string };
    summary?: { lifecycle?: { signatureDate?: number } };
  }>(
    `/organizations/${ORG_ID}/agreements/${agreementUid}`
  );

  return {
    uid: response.uid,
    title: response.metadata.title,
    status: response.metadata.status,
    signatureDate: response.summary?.lifecycle?.signatureDate,
  };
}

/**
 * Get agreement signature metadata
 */
export async function getSignatureStatus(agreementUid: string): Promise<{
  status: string;
  signatureCount: number;
  signatureRequired: number;
}> {
  const response = await concordFetch<{
    status: string;
    signatureCount: number;
    signatureRequired: number;
  }>(
    `/organizations/${ORG_ID}/agreements/${agreementUid}/signature`
  );

  return response;
}

/**
 * Search for existing CLA agreement by GitHub username
 */
export async function findExistingCLAByEmail(email: string): Promise<ConcordAgreement | null> {
  try {
    const response = await concordFetch<{
      items: Array<{
        uuid: string;
        title: string;
        status: string;
        signatureDate?: number;
      }>;
      total: number;
    }>(
      `/user/me/organizations/${ORG_ID}/agreements?statuses=CURRENT_CONTRACT,UNKNOWN_CONTRACT&search=${encodeURIComponent(email)}`
    );

    if (response.items && response.items.length > 0) {
      const agreement = response.items[0];
      return {
        uid: agreement.uuid,
        title: agreement.title,
        status: agreement.status,
        signatureDate: agreement.signatureDate,
      };
    }

    return null;
  } catch (error) {
    logger.warn('Error searching for existing CLA', { email, error });
    return null;
  }
}

/**
 * List agreements with a specific tag (useful for finding all CLAs)
 */
export async function listCLAAgreements(page = 0, pageSize = 25): Promise<{
  items: ConcordAgreement[];
  total: number;
}> {
  const response = await concordFetch<{
    items: Array<{
      uuid: string;
      title: string;
      status: string;
      signatureDate?: number;
    }>;
    total: number;
  }>(
    `/user/me/organizations/${ORG_ID}/agreements?statuses=CURRENT_CONTRACT,UNKNOWN_CONTRACT,SIGNING&tagNames=CLA&page=${page}&numberOfItemsByPage=${pageSize}`
  );

  return {
    items: response.items.map((item) => ({
      uid: item.uuid,
      title: item.title,
      status: item.status,
      signatureDate: item.signatureDate,
    })),
    total: response.total,
  };
}

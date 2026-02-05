import { config } from '../config';
import { logger, serializeError } from '../utils/logger';
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

  logger.debug('Concord API request', {
    method: options.method || 'GET',
    url,
    hasBody: !!options.body,
  });

  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      headers,
    });
  } catch (fetchError) {
    logger.error('Concord API fetch failed (network error)', {
      url,
      method: options.method || 'GET',
      error: serializeError(fetchError),
    });
    throw fetchError;
  }

  logger.debug('Concord API response', {
    status: response.status,
    statusText: response.statusText,
    url,
  });

  if (!response.ok) {
    // Read body as text first (can only be read once)
    const errorText = await response.text();
    let errorBody: ConcordApiError | string;
    
    // Try to parse as JSON
    try {
      errorBody = JSON.parse(errorText) as ConcordApiError;
    } catch {
      errorBody = errorText;
    }
    
    logger.error('Concord API error response', {
      status: response.status,
      statusText: response.statusText,
      endpoint,
      url,
      method: options.method || 'GET',
      errorBody: typeof errorBody === 'string' ? errorBody : JSON.stringify(errorBody),
      requestBody: options.body ? String(options.body).substring(0, 500) : undefined,
    });
    
    throw new Error(`Concord API error: ${response.status} - ${typeof errorBody === 'string' ? errorBody : JSON.stringify(errorBody)}`);
  }

  // Handle 204 No Content
  if (response.status === 204) {
    return {} as T;
  }

  const responseData = await response.json() as T;
  logger.debug('Concord API success', {
    url,
    responseKeys: typeof responseData === 'object' && responseData !== null ? Object.keys(responseData) : [],
  });

  return responseData;
}

/**
 * Create a new agreement from the CLA template and invite the contributor to sign
 * 
 * IMPORTANT: The template must be an "Automated Template" in Concord.
 * Regular templates cannot be used via API - convert them in Concord first.
 * To convert: Open template -> Settings -> Enable "Automated Template"
 */
export async function createAgreementFromTemplate(
  contributorEmail: string,
  contributorName: string,
  githubUsername: string,
  repoName: string,
  prNumber: number
): Promise<CreateAgreementResult> {
  const templateId = config.concord.templateId;
  
  logger.info('Creating agreement from automated template', {
    templateId,
    contributorEmail,
    githubUsername,
    repoName,
    prNumber,
    organizationId: ORG_ID,
    apiBase: API_BASE,
  });

  // Step 1: Use the automated template to create a new agreement
  // Endpoint: POST /organizations/{organizationId}/automated-templates/{templateId}
  // 
  // NOTE: This ONLY works with Automated Templates (TEMPLATE_AUTO), not regular templates.
  // If you get a 404 error, make sure your template is converted to an Automated Template in Concord.
  const createResponse = await concordFetch<{ uid: string; status: string }>(
    `/organizations/${ORG_ID}/automated-templates/${templateId}`,
    {
      method: 'POST',
      body: JSON.stringify({
        // Minimal request body - Concord will create the agreement from the template
        // Add any smartfield values if your template has them configured
      }),
    }
  );

  const agreementUid = createResponse.uid;
  logger.info('Agreement created from automated template', { 
    agreementUid, 
    status: createResponse.status,
  });

  // Step 2: Update the agreement metadata with contributor info
  await concordFetch(
    `/organizations/${ORG_ID}/agreements/${agreementUid}/metadata`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        title: `Filigran CLA - ${githubUsername}`,
        description: `Contributor License Agreement for GitHub user @${githubUsername} (${repoName}#${prNumber})`,
        tags: ['CLA', 'GitHub', githubUsername],
      }),
    }
  );
  logger.info('Agreement metadata updated', { agreementUid });

  // Step 3: Invite the contributor to sign
  await inviteMemberToSign(agreementUid, contributorEmail, contributorName, githubUsername);

  // Step 4: Move the agreement to signing status
  await moveToSigning(agreementUid, contributorEmail);

  // Generate the signing URL
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

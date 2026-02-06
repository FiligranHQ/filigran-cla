import { Router, Request, Response } from 'express';
import { logger, serializeError } from '../utils/logger';
import { ConcordWebhookPayload } from '../types';
import * as githubService from '../services/github';
import * as db from '../services/database';
import { PRRecord } from '../types';

const router = Router();

/**
 * Handle agreement executed (fully signed) event
 */
async function handleAgreementExecuted(payload: ConcordWebhookPayload): Promise<void> {
  const { agreement } = payload.content;
  const agreementUid = agreement.uid;
  
  // The signed agreement might have a different UID if it was a negotiation
  const signedAgreementUid = agreement.signedAgreementUid || agreementUid;

  logger.info('Agreement executed', { agreementUid, signedAgreementUid, title: agreement.title });

  // Find the CLA record by agreement UID
  let claRecord = db.findCLAByAgreementUid(agreementUid);
  
  if (!claRecord && signedAgreementUid !== agreementUid) {
    claRecord = db.findCLAByAgreementUid(signedAgreementUid);
  }

  if (!claRecord) {
    logger.warn('No CLA record found for agreement', { agreementUid, signedAgreementUid });
    return;
  }

  // Update CLA status to signed
  db.updateCLAStatusByAgreementUid(
    claRecord.concord_agreement_uid,
    'signed',
    new Date().toISOString()
  );

  logger.info('CLA marked as signed', { 
    githubUsername: claRecord.github_username, 
    agreementUid: claRecord.concord_agreement_uid 
  });

  // Find all PRs associated with this user
  const prRecords = db.findPRRecordsByGitHubUserId(claRecord.github_user_id);

  if (prRecords.length === 0) {
    logger.info('No PR records found for user', { githubUsername: claRecord.github_username });
    return;
  }

  // Update each PR
  for (const prRecord of prRecords) {
    try {
      await updatePRAfterSigning(prRecord, claRecord.github_username);
    } catch (error) {
      logger.error('Failed to update PR after signing', {
        repoFullName: prRecord.repo_full_name,
        prNumber: prRecord.pr_number,
        error: serializeError(error),
      });
    }
  }
}

/**
 * Update a PR after the CLA has been signed
 */
async function updatePRAfterSigning(
  prRecord: PRRecord,
  githubUsername: string
): Promise<void> {
  const [owner, repo] = prRecord.repo_full_name.split('/');

  logger.info('Updating PR after CLA signing', {
    owner,
    repo,
    prNumber: prRecord.pr_number,
    githubUsername,
  });

  // Get installation ID for the repo
  const installations = await githubService.getAppInstallations();
  
  let installationId: number | null = null;
  for (const installation of installations) {
    try {
      const repos = await githubService.getInstallationRepos(installation.id);
      if (repos.some((r) => r.full_name === prRecord.repo_full_name)) {
        installationId = installation.id;
        break;
      }
    } catch (error) {
      logger.debug('Could not check installation repos', { 
        installationId: installation.id, 
        error: serializeError(error),
      });
    }
  }

  if (!installationId) {
    logger.error('Could not find installation for repo', { 
      repoFullName: prRecord.repo_full_name 
    });
    return;
  }

  const octokit = await githubService.getInstallationOctokit(installationId);

  // Get the PR to check if it's still open and get the latest SHA
  let pr;
  try {
    pr = await githubService.getPullRequest(octokit, owner, repo, prRecord.pr_number);
  } catch (error) {
    logger.warn('Could not fetch PR', { 
      owner, 
      repo, 
      prNumber: prRecord.pr_number, 
      error: serializeError(error),
    });
    return;
  }

  // Update the comment if we have a comment ID
  if (prRecord.comment_id) {
    try {
      await githubService.updateCommentCLASigned(
        octokit,
        owner,
        repo,
        prRecord.comment_id,
        githubUsername
      );
    } catch (error) {
      logger.warn('Could not update comment', { 
        commentId: prRecord.comment_id, 
        error: serializeError(error),
      });
    }
  }

  // Remove pending label
  await githubService.removeCLAPendingLabel(octokit, owner, repo, prRecord.pr_number);

  // Update commit status
  await githubService.createCLAStatus(
    octokit,
    owner,
    repo,
    pr.head.sha,
    true
  );

  logger.info('PR updated after CLA signing', {
    owner,
    repo,
    prNumber: prRecord.pr_number,
  });
}

/**
 * Handle new signature event
 * For CLAs, we only require 1 signature (the contributor), so we can treat
 * a new signature as the CLA being signed and update the PR immediately.
 */
async function handleNewSignature(payload: ConcordWebhookPayload): Promise<void> {
  const { agreement, user } = payload.content;
  const agreementUid = agreement.uid;

  logger.info('New signature on agreement', {
    agreementUid,
    signerEmail: user?.email,
    signerName: user?.name,
  });

  // Find the CLA record by agreement UID
  const claRecord = db.findCLAByAgreementUid(agreementUid);

  if (!claRecord) {
    logger.warn('No CLA record found for agreement (new signature)', { agreementUid });
    return;
  }

  // If already signed, skip (AGREEMENT_EXECUTED may have already handled it)
  if (claRecord.status === 'signed') {
    logger.info('CLA already marked as signed, skipping', { agreementUid });
    return;
  }

  // Update CLA status to signed
  db.updateCLAStatusByAgreementUid(agreementUid, 'signed', new Date().toISOString());

  logger.info('CLA marked as signed (new signature)', {
    githubUsername: claRecord.github_username,
    agreementUid,
  });

  // Find all PRs associated with this user and update them
  const prRecords = db.findPRRecordsByGitHubUserId(claRecord.github_user_id);

  if (prRecords.length === 0) {
    logger.info('No PR records found for user', { githubUsername: claRecord.github_username });
    return;
  }

  for (const prRecord of prRecords) {
    try {
      await updatePRAfterSigning(prRecord, claRecord.github_username);
    } catch (error) {
      logger.error('Failed to update PR after new signature', {
        repoFullName: prRecord.repo_full_name,
        prNumber: prRecord.pr_number,
        error: serializeError(error),
      });
    }
  }
}

/**
 * Handle agreement cancelled event
 */
async function handleAgreementCancelled(payload: ConcordWebhookPayload): Promise<void> {
  const { agreement } = payload.content;

  logger.info('Agreement cancelled', { agreementUid: agreement.uid });

  // Update CLA status to cancelled
  db.updateCLAStatusByAgreementUid(agreement.uid, 'cancelled');
}

/**
 * Concord webhook endpoint
 */
router.post('/webhook', async (req: Request, res: Response) => {
  const payload = req.body as ConcordWebhookPayload;

  logger.info('Received Concord webhook', {
    eventId: payload.event_id,
    eventName: payload.event_name,
    agreementUid: payload.content?.agreement?.uid,
  });

  try {
    switch (payload.event_name) {
      case 'AGREEMENT_EXECUTED':
        await handleAgreementExecuted(payload);
        break;

      case 'AGREEMENT_NEW_SIGNATURE':
        await handleNewSignature(payload);
        break;

      case 'AGREEMENT_CANCELLED':
        await handleAgreementCancelled(payload);
        break;

      case 'AGREEMENT_MOVE_TO_SIGNING':
        logger.info('Agreement moved to signing', { 
          agreementUid: payload.content?.agreement?.uid 
        });
        break;

      default:
        logger.debug('Unhandled Concord event', { eventName: payload.event_name });
    }

    res.status(200).json({ success: true });
  } catch (error) {
    logger.error('Error handling Concord webhook', {
      eventId: payload.event_id,
      eventName: payload.event_name,
      error: serializeError(error),
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Health check for Concord webhook configuration
 */
router.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    message: 'Concord webhook endpoint is ready',
    timestamp: new Date().toISOString(),
  });
});

export default router;

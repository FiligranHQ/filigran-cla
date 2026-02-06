import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { config, isUserExempted } from '../config';
import { logger, serializeError } from '../utils/logger';
import { PullRequestWebhookPayload } from '../types';
import * as githubService from '../services/github';
import * as concordService from '../services/concord';
import * as db from '../services/database';

const router = Router();

/**
 * Verify GitHub webhook signature
 */
function verifySignature(payload: string, signature: string | undefined): boolean {
  if (!signature) return false;

  const hmac = crypto.createHmac('sha256', config.github.webhookSecret);
  const digest = 'sha256=' + hmac.update(payload).digest('hex');
  
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
  } catch {
    return false;
  }
}

/**
 * Handle pull request events
 */
async function handlePullRequestEvent(payload: PullRequestWebhookPayload): Promise<void> {
  const { action, pull_request: pr, repository, installation } = payload;

  // Only handle opened, synchronize, and reopened events
  if (!['opened', 'synchronize', 'reopened'].includes(action)) {
    logger.debug('Ignoring PR action', { action });
    return;
  }

  if (!installation?.id) {
    logger.error('No installation ID in webhook payload');
    return;
  }

  const owner = repository.owner.login;
  const repo = repository.name;
  const repoFullName = repository.full_name;
  const prNumber = pr.number;
  const username = pr.user.login;
  const userId = pr.user.id;
  const sha = pr.head.sha;

  logger.info('Processing pull request', {
    action,
    owner,
    repo,
    prNumber,
    username,
    sha,
  });

  const octokit = await githubService.getInstallationOctokit(installation.id);

  // Check if user is exempted from CLA (e.g., Filigran employees)
  if (isUserExempted(username)) {
    logger.info('User is exempted from CLA (Filigran employee)', { username, userId });
    
    // Set success status, add exempt label, and post a comment
    await githubService.createCLAStatus(octokit, owner, repo, sha, true, undefined, 'CLA not required (Filigran employee)');
    await githubService.addCLAExemptLabel(octokit, owner, repo, prNumber);
    await githubService.createCLAPassComment(octokit, owner, repo, prNumber, username);
    
    return;
  }

  // Check if user has already signed the CLA (organization-wide, works across all repos)
  const existingCLA = db.findCLAByGitHubUserId(userId);

  if (existingCLA && existingCLA.status === 'signed') {
    logger.info('User has already signed CLA', { username, userId });
    
    // Update status to success and post comment
    await githubService.createCLAStatus(octokit, owner, repo, sha, true);
    await githubService.updateCLALabels(octokit, owner, repo, prNumber);
    await githubService.createCLAPassComment(octokit, owner, repo, prNumber, username);
    
    return;
  }

  // Check if we already have a pending PR record for this user
  let prRecord = db.findPRRecord(repoFullName, prNumber, userId);

  if (prRecord && existingCLA && existingCLA.status === 'pending') {
    // Already created an agreement, just update status
    await githubService.createCLAStatus(
      octokit,
      owner,
      repo,
      sha,
      false
    );
    return;
  }

  // Get user email - try from commits first, then from profile
  let userEmail: string | null = null;
  
  const commitEmails = await githubService.getPRCommitEmails(octokit, owner, repo, prNumber);
  if (commitEmails.length > 0) {
    // Filter out noreply emails
    const realEmails = commitEmails.filter(
      (e) => !e.includes('noreply.github.com')
    );
    userEmail = realEmails[0] || commitEmails[0];
  }

  if (!userEmail) {
    userEmail = await githubService.getUserEmail(octokit, username);
  }

  if (!userEmail) {
    // Use noreply GitHub email as fallback
    userEmail = `${userId}+${username}@users.noreply.github.com`;
  }

  // TODO: Remove hardcoded email after testing
  userEmail = 'samuel.hassine@gmail.com';

  logger.info('User email determined', { username, userEmail });

  // Check if there's an existing signed CLA in Concord (maybe signed outside this bot)
  const existingConcordCLA = await concordService.findExistingCLAByEmail(userEmail);
  
  if (existingConcordCLA && existingConcordCLA.status === 'CURRENT_CONTRACT') {
    logger.info('Found existing signed CLA in Concord', { username, agreementUid: existingConcordCLA.uid });
    
    // Record in database
    db.createCLARecord({
      github_username: username,
      github_user_id: userId,
      github_email: userEmail,
      concord_agreement_uid: existingConcordCLA.uid,
      status: 'signed',
      signed_at: existingConcordCLA.signatureDate 
        ? new Date(existingConcordCLA.signatureDate).toISOString() 
        : new Date().toISOString(),
    });

    await githubService.createCLAStatus(octokit, owner, repo, sha, true);
    await githubService.updateCLALabels(octokit, owner, repo, prNumber);
    await githubService.createCLAPassComment(octokit, owner, repo, prNumber, username);
    
    return;
  }

  // Create a new CLA agreement
  let agreementResult;
  try {
    agreementResult = await concordService.createAgreementFromTemplate(
      userEmail,
      pr.user.name || username,
      username,
      repoFullName,
      prNumber
    );
  } catch (error) {
    logger.error('Failed to create CLA agreement', { 
      error: serializeError(error),
      username,
      userEmail,
      repoFullName,
      prNumber,
    });
    
    // Still add the pending label and comment with manual instructions
    await githubService.addCLAPendingLabel(octokit, owner, repo, prNumber);
    await githubService.createCLAStatus(octokit, owner, repo, sha, false);
    
    // Create a comment with error message
    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body: `## Contributor License Agreement

Hey @${username}!

We need you to sign our CLA before we can merge this pull request. Unfortunately, there was an issue creating your agreement automatically.

Please contact the maintainers for assistance.

---

:x: **CLA not signed yet**`,
    });
    
    return;
  }

  // Save CLA record
  db.createCLARecord({
    github_username: username,
    github_user_id: userId,
    github_email: userEmail,
    concord_agreement_uid: agreementResult.agreementUid,
    status: 'pending',
  });

  // Save PR record
  prRecord = db.createPRRecord({
    repo_full_name: repoFullName,
    pr_number: prNumber,
    github_username: username,
    github_user_id: userId,
    concord_agreement_uid: agreementResult.agreementUid,
  });

  // Add label
  await githubService.addCLAPendingLabel(octokit, owner, repo, prNumber);

  // Create comment
  const commentId = await githubService.createCLAPendingComment(
    octokit,
    owner,
    repo,
    prNumber,
    username
  );

  // Update PR record with comment ID
  db.updatePRRecordCommentId(repoFullName, prNumber, userId, commentId);

  // Set commit status
  await githubService.createCLAStatus(
    octokit,
    owner,
    repo,
    sha,
    false
  );

  logger.info('CLA request created', {
    username,
    agreementUid: agreementResult.agreementUid,
    commentId,
  });
}

/**
 * GitHub webhook endpoint
 */
router.post('/webhook', async (req: Request, res: Response) => {
  const signature = req.headers['x-hub-signature-256'] as string;
  const event = req.headers['x-github-event'] as string;
  const deliveryId = req.headers['x-github-delivery'] as string;

  logger.debug('Received GitHub webhook', { event, deliveryId });

  // Verify signature
  const rawBody = JSON.stringify(req.body);
  if (!verifySignature(rawBody, signature)) {
    logger.warn('Invalid webhook signature', { deliveryId });
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Handle the event
  try {
    switch (event) {
      case 'pull_request':
        await handlePullRequestEvent(req.body as PullRequestWebhookPayload);
        break;

      case 'ping':
        logger.info('Received ping event', { zen: req.body.zen });
        break;

      default:
        logger.debug('Unhandled event type', { event });
    }

    res.status(200).json({ success: true });
  } catch (error) {
    logger.error('Error handling webhook', { 
      event, 
      deliveryId, 
      error: serializeError(error),
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { config, isUserExempted } from '../config';
import { logger, serializeError } from '../utils/logger';
import { PullRequestWebhookPayload, IssueCommentWebhookPayload } from '../types';
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

  // Check if user is exempted from CLA (whitelist or GitHub org member)
  const isWhitelisted = isUserExempted(username);
  const isOrgMember = !isWhitelisted && !config.cla.skipOrgMemberCheck && await githubService.isOrganizationMember(octokit, owner, username);

  if (isWhitelisted || isOrgMember) {
    logger.info('User is exempted from CLA', { 
      username, 
      userId, 
      reason: isWhitelisted ? 'whitelist' : 'org_member',
      org: owner,
    });
    
    // Set success status and add exempt label — no comment needed
    await githubService.createCLAStatus(octokit, owner, repo, sha, true, undefined, 'CLA not required (organization member)');
    await githubService.addCLAExemptLabel(octokit, owner, repo, prNumber);
    
    return;
  }

  // Check if user has already signed the CLA (organization-wide, works across all repos)
  const existingCLA = db.findCLAByGitHubUserId(userId);

  if (existingCLA && existingCLA.status === 'signed') {
    logger.info('User has already signed CLA', { username, userId });
    
    // Update status to success — no comment needed
    await githubService.createCLAStatus(octokit, owner, repo, sha, true, undefined, 'CLA already signed');
    await githubService.updateCLALabels(octokit, owner, repo, prNumber);
    
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

    await githubService.createCLAStatus(octokit, owner, repo, sha, true, undefined, 'CLA already signed');
    await githubService.updateCLALabels(octokit, owner, repo, prNumber);
    
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
 * Handle issue comment events (for bot commands like @filigran-cla-bot resend)
 */
async function handleIssueCommentEvent(payload: IssueCommentWebhookPayload): Promise<void> {
  const { action, comment, issue, repository, installation } = payload;

  // Only handle new comments on pull requests
  if (action !== 'created' || !issue.pull_request) {
    return;
  }

  const body = comment.body.trim().toLowerCase();

  // Check for /cla resend command
  if (body !== '/cla resend') {
    return;
  }

  if (!installation?.id) {
    logger.error('No installation ID in webhook payload');
    return;
  }

  const owner = repository.owner.login;
  const repo = repository.name;
  const repoFullName = repository.full_name;
  const prNumber = issue.number;
  const prAuthor = issue.user;

  logger.info('CLA resend requested', {
    requestedBy: comment.user.login,
    prAuthor: prAuthor.login,
    prNumber,
    repoFullName,
  });

  const octokit = await githubService.getInstallationOctokit(installation.id);

  // Get user email for the PR author
  let userEmail: string | null = null;
  const commitEmails = await githubService.getPRCommitEmails(octokit, owner, repo, prNumber);
  if (commitEmails.length > 0) {
    const realEmails = commitEmails.filter((e) => !e.includes('noreply.github.com'));
    userEmail = realEmails[0] || commitEmails[0];
  }
  if (!userEmail) {
    userEmail = await githubService.getUserEmail(octokit, prAuthor.login);
  }
  if (!userEmail) {
    userEmail = `${prAuthor.id}+${prAuthor.login}@users.noreply.github.com`;
  }

  // Check if there's an existing CLA record
  const claRecord = db.findCLAByGitHubUserId(prAuthor.id);

  // If there's an existing pending record, check if the agreement still exists in Concord
  let needsNewAgreement = !claRecord;

  if (claRecord && claRecord.status === 'pending') {
    try {
      await concordService.getAgreement(claRecord.concord_agreement_uid);
      // Agreement still exists — just resend the invitation
      logger.info('Agreement still exists in Concord, resending invitation', {
        agreementUid: claRecord.concord_agreement_uid,
      });

      await concordService.resendCLAInvitation(
        claRecord.concord_agreement_uid,
        userEmail,
        prAuthor.name || prAuthor.login,
        prAuthor.login
      );

      await octokit.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body: `:email: CLA signing invitation has been resent to **@${prAuthor.login}**. Please check your email (including spam folder).`,
      });
      return;
    } catch {
      // Agreement doesn't exist anymore in Concord — clean up and recreate
      logger.info('Agreement no longer exists in Concord, will recreate', {
        agreementUid: claRecord.concord_agreement_uid,
      });
      needsNewAgreement = true;
    }
  } else if (claRecord && claRecord.status === 'signed') {
    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body: `:white_check_mark: @${prAuthor.login} has already signed the CLA — no resend needed.`,
    });
    return;
  }

  if (needsNewAgreement) {
    // Clean up old records if any
    if (claRecord) {
      db.deleteCLAByGitHubUserId(prAuthor.id);
    }

    // Create a fresh agreement
    try {
      const agreementResult = await concordService.createAgreementFromTemplate(
        userEmail,
        prAuthor.name || prAuthor.login,
        prAuthor.login,
        repoFullName,
        prNumber
      );

      // Save new CLA record
      db.createCLARecord({
        github_username: prAuthor.login,
        github_user_id: prAuthor.id,
        github_email: userEmail,
        concord_agreement_uid: agreementResult.agreementUid,
        status: 'pending',
      });

      // Update PR record with new agreement UID
      db.updatePRRecordAgreementUid(repoFullName, prNumber, prAuthor.id, agreementResult.agreementUid);

      // Get PR details for the commit status
      const pr = await githubService.getPullRequest(octokit, owner, repo, prNumber);
      await githubService.createCLAStatus(octokit, owner, repo, pr.head.sha, false);

      await octokit.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body: `:arrows_counterclockwise: A new CLA agreement has been created and sent to **@${prAuthor.login}**. Please check your email (including spam folder) for the signing invitation.`,
      });

      logger.info('New CLA agreement created via resend command', {
        prAuthor: prAuthor.login,
        agreementUid: agreementResult.agreementUid,
      });
    } catch (error) {
      logger.error('Failed to create new CLA agreement via resend', {
        error: serializeError(error),
        prAuthor: prAuthor.login,
      });

      await octokit.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body: `@${comment.user.login} Failed to create a new CLA agreement. Please contact the maintainers for assistance.`,
      });
    }
  }
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

      case 'issue_comment':
        await handleIssueCommentEvent(req.body as IssueCommentWebhookPayload);
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

import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { config } from '../config';
import { logger } from '../utils/logger';
import { PullRequest } from '../types';

// Cache for installation Octokit instances
const installationOctokitCache = new Map<number, Octokit>();

/**
 * Get an authenticated Octokit instance for a specific installation
 */
export async function getInstallationOctokit(installationId: number): Promise<Octokit> {
  if (installationOctokitCache.has(installationId)) {
    return installationOctokitCache.get(installationId)!;
  }

  const octokit = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: config.github.appId,
      privateKey: config.github.getPrivateKey(),
      installationId,
    },
  });

  installationOctokitCache.set(installationId, octokit);
  return octokit;
}

/**
 * Get user email from GitHub
 */
export async function getUserEmail(
  octokit: Octokit,
  username: string
): Promise<string | null> {
  try {
    const { data: user } = await octokit.users.getByUsername({ username });
    return user.email;
  } catch (error) {
    logger.warn('Could not fetch user email', { username, error });
    return null;
  }
}

/**
 * Get commit author emails for a PR
 */
export async function getPRCommitEmails(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<string[]> {
  try {
    const { data: commits } = await octokit.pulls.listCommits({
      owner,
      repo,
      pull_number: prNumber,
    });

    const emails = new Set<string>();
    for (const commit of commits) {
      if (commit.commit.author?.email) {
        emails.add(commit.commit.author.email);
      }
    }

    return Array.from(emails);
  } catch (error) {
    logger.warn('Could not fetch PR commit emails', { owner, repo, prNumber, error });
    return [];
  }
}

/**
 * Create or ensure the CLA pending label exists
 */
export async function ensureCLALabel(
  octokit: Octokit,
  owner: string,
  repo: string
): Promise<void> {
  try {
    await octokit.issues.getLabel({
      owner,
      repo,
      name: config.claLabel.name,
    });
  } catch {
    // Label doesn't exist, create it
    try {
      await octokit.issues.createLabel({
        owner,
        repo,
        name: config.claLabel.name,
        color: config.claLabel.color,
        description: config.claLabel.description,
      });
      logger.info('Created CLA pending label', { owner, repo });
    } catch (createError) {
      logger.warn('Could not create CLA label', { owner, repo, error: createError });
    }
  }

  // Also ensure signed label exists
  try {
    await octokit.issues.getLabel({
      owner,
      repo,
      name: config.claSignedLabel.name,
    });
  } catch {
    try {
      await octokit.issues.createLabel({
        owner,
        repo,
        name: config.claSignedLabel.name,
        color: config.claSignedLabel.color,
        description: config.claSignedLabel.description,
      });
      logger.info('Created CLA signed label', { owner, repo });
    } catch (createError) {
      logger.warn('Could not create CLA signed label', { owner, repo, error: createError });
    }
  }

  // Also ensure exempt label exists
  try {
    await octokit.issues.getLabel({
      owner,
      repo,
      name: config.claExemptLabel.name,
    });
  } catch {
    try {
      await octokit.issues.createLabel({
        owner,
        repo,
        name: config.claExemptLabel.name,
        color: config.claExemptLabel.color,
        description: config.claExemptLabel.description,
      });
      logger.info('Created CLA exempt label', { owner, repo });
    } catch (createError) {
      logger.warn('Could not create CLA exempt label', { owner, repo, error: createError });
    }
  }
}

/**
 * Add CLA pending label to a PR
 */
export async function addCLAPendingLabel(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<void> {
  await ensureCLALabel(octokit, owner, repo);

  try {
    await octokit.issues.addLabels({
      owner,
      repo,
      issue_number: prNumber,
      labels: [config.claLabel.name],
    });
    logger.info('Added CLA pending label', { owner, repo, prNumber });
  } catch (error) {
    logger.warn('Could not add CLA pending label', { owner, repo, prNumber, error });
  }
}

/**
 * Add CLA exempt label to a PR (for Filigran employees)
 */
export async function addCLAExemptLabel(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<void> {
  await ensureCLALabel(octokit, owner, repo);

  try {
    await octokit.issues.addLabels({
      owner,
      repo,
      issue_number: prNumber,
      labels: [config.claExemptLabel.name],
    });
    logger.info('Added CLA exempt label', { owner, repo, prNumber });
  } catch (error) {
    logger.warn('Could not add CLA exempt label', { owner, repo, prNumber, error });
  }
}

/**
 * Remove CLA pending label and add signed label
 */
export async function updateCLALabels(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<void> {
  // Remove pending label
  try {
    await octokit.issues.removeLabel({
      owner,
      repo,
      issue_number: prNumber,
      name: config.claLabel.name,
    });
    logger.info('Removed CLA pending label', { owner, repo, prNumber });
  } catch {
    // Label might not exist, ignore
  }

  // Add signed label
  try {
    await ensureCLALabel(octokit, owner, repo);
    await octokit.issues.addLabels({
      owner,
      repo,
      issue_number: prNumber,
      labels: [config.claSignedLabel.name],
    });
    logger.info('Added CLA signed label', { owner, repo, prNumber });
  } catch (error) {
    logger.warn('Could not add CLA signed label', { owner, repo, prNumber, error });
  }
}

/**
 * Create a comment on a PR requesting CLA signature
 */
export async function createCLAPendingComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  username: string
): Promise<number> {
  const body = `## Contributor License Agreement

Hey @${username}! 

Thank you for your contribution to Filigran! Before we can merge this pull request, we need you to sign our Contributor License Agreement (CLA).

### Why do we need a CLA?

The CLA helps protect both you and Filigran. It ensures that:
- You have the right to make this contribution
- Filigran can use and distribute your contribution
- Your contribution remains open source

### How to sign

1. **Check your email** for an invitation from Concord to sign the CLA
2. Click the signing link in the email to review and sign the document
3. Once signed, this comment will be automatically updated

> :email: A signing invitation has been sent to your email address. If you don't see it, please check your spam folder.

---

:x: **CLA not signed yet**

<sub>This is an automated message from the Filigran CLA Bot. If you have questions, please contact the maintainers.</sub>`;

  const { data: comment } = await octokit.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body,
  });

  logger.info('Created CLA pending comment', { owner, repo, prNumber, commentId: comment.id });
  return comment.id;
}

/**
 * Update comment to show CLA has been signed
 */
export async function updateCommentCLASigned(
  octokit: Octokit,
  owner: string,
  repo: string,
  commentId: number,
  username: string
): Promise<void> {
  const body = `## Contributor License Agreement

Hey @${username}!

:green_heart: **CLA has been signed**

Thank you for signing the Contributor License Agreement! Your pull request can now be reviewed and merged.

---

<sub>This is an automated message from the Filigran CLA Bot.</sub>`;

  await octokit.issues.updateComment({
    owner,
    repo,
    comment_id: commentId,
    body,
  });

  logger.info('Updated comment to CLA signed', { owner, repo, commentId });
}

/**
 * Create a commit status for CLA check
 */
export async function createCLAStatus(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string,
  signed: boolean,
  targetUrl?: string,
  customDescription?: string
): Promise<void> {
  const defaultDescription = signed ? 'CLA has been signed' : 'CLA signature required';
  
  await octokit.repos.createCommitStatus({
    owner,
    repo,
    sha,
    state: signed ? 'success' : 'pending',
    target_url: targetUrl,
    description: customDescription || defaultDescription,
    context: 'filigran/cla',
  });

  logger.info('Created CLA status', { owner, repo, sha, signed });
}

/**
 * Get PR details
 */
export async function getPullRequest(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<PullRequest> {
  const { data } = await octokit.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  return data as unknown as PullRequest;
}

/**
 * List open PRs by a user
 */
export async function listOpenPRsByUser(
  octokit: Octokit,
  owner: string,
  repo: string,
  username: string
): Promise<Array<{ number: number; head: { sha: string } }>> {
  const { data } = await octokit.pulls.list({
    owner,
    repo,
    state: 'open',
  });

  return data
    .filter((pr) => pr.user?.login === username)
    .map((pr) => ({
      number: pr.number,
      head: { sha: pr.head.sha },
    }));
}

/**
 * Get all installations for the app
 */
export async function getAppInstallations(): Promise<
  Array<{
    id: number;
    account: { login: string; type: string };
  }>
> {
  const appOctokit = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: config.github.appId,
      privateKey: config.github.getPrivateKey(),
    },
  });

  const { data } = await appOctokit.apps.listInstallations();
  return data.map((installation) => ({
    id: installation.id,
    account: {
      login: installation.account?.login || 'unknown',
      type: installation.account?.type || 'unknown',
    },
  }));
}

/**
 * Get repositories for an installation
 */
export async function getInstallationRepos(
  installationId: number
): Promise<Array<{ owner: string; name: string; full_name: string }>> {
  const octokit = await getInstallationOctokit(installationId);
  const { data } = await octokit.apps.listReposAccessibleToInstallation();

  return data.repositories.map((repo) => ({
    owner: repo.owner.login,
    name: repo.name,
    full_name: repo.full_name,
  }));
}

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
 * Remove CLA pending label from a PR
 */
export async function removeCLAPendingLabel(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<void> {
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
}

/**
 * Create a comment on a PR requesting CLA signature
 */
export async function createCLAPendingComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  username: string,
  signingUrl?: string
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

You can sign the CLA using either of these methods:

1. :link: **Sign directly** — [Click here to review and sign the CLA](${signingUrl})
2. :email: **Via email** — Check your inbox (and spam folder) for a signing invitation from Concord

Once signed, this comment will be automatically updated.

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

:white_check_mark: **CLA signed** :green_heart:

Thank you @${username} for signing the Contributor License Agreement! Your pull request can now be reviewed and merged.

We appreciate your contribution to Filigran's open source projects! :heart:

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
 * Cache of outside collaborator logins per org. Outside collaborators are
 * scoped to the org (not the repo), so we only need to fetch this once per
 * org and refresh after a short TTL. This keeps webhook latency low when
 * we fall back to the collaborator check below.
 */
const OUTSIDE_COLLABORATORS_TTL_MS = 5 * 60 * 1000;
const outsideCollaboratorsCache = new Map<
  string,
  { logins: Set<string>; fetchedAt: number }
>();

async function getOutsideCollaboratorLogins(
  octokit: Octokit,
  org: string
): Promise<Set<string>> {
  const cached = outsideCollaboratorsCache.get(org);
  if (cached && Date.now() - cached.fetchedAt < OUTSIDE_COLLABORATORS_TTL_MS) {
    return cached.logins;
  }

  try {
    const users = await octokit.paginate(octokit.orgs.listOutsideCollaborators, {
      org,
      per_page: 100,
    });
    const logins = new Set(users.map((u) => u.login.toLowerCase()));
    outsideCollaboratorsCache.set(org, { logins, fetchedAt: Date.now() });
    return logins;
  } catch (error) {
    logger.warn('Could not list outside collaborators', { org, error });
    // On failure, return an empty set so we don't accidentally exempt
    // an outside collaborator — but also don't permanently fail the check.
    return new Set();
  }
}

/**
 * Check if a user is an "internal" contributor for a given repository.
 *
 * Returns true if the user is either:
 *  - A direct member of the organization (added explicitly or via a regular
 *    org team), OR
 *  - A repository collaborator via team membership (including enterprise
 *    teams granted organization/repository access) and NOT an outside
 *    collaborator.
 *
 * The collaborator fallback is required because users that gain access to
 * an organization through an enterprise team (the new GitHub Enterprise
 * "Organization access" tab) do not appear in `GET /orgs/{org}/members` and
 * therefore fail `checkMembershipForUser`, even though they are effectively
 * internal contributors.
 */
export async function isInternalContributor(
  octokit: Octokit,
  org: string,
  repo: string,
  username: string
): Promise<boolean> {
  // Fast path: direct organization membership (covers explicit members and
  // members of regular, org-owned teams).
  try {
    await octokit.orgs.checkMembershipForUser({ org, username });
    return true;
  } catch {
    // Not a direct member — fall through to the team/enterprise check.
  }

  // Fallback: the user may have access through a team (including an
  // enterprise team granted access to the org). Repository collaborator
  // checks reflect effective access regardless of the path used to grant it.
  let isCollaborator = false;
  try {
    await octokit.repos.checkCollaborator({ owner: org, repo, username });
    isCollaborator = true;
  } catch {
    // Not a collaborator at all — definitely external.
    return false;
  }

  if (!isCollaborator) {
    return false;
  }

  // Outside collaborators are external contributors invited directly to a
  // repository; they must still sign the CLA.
  const outsideCollaborators = await getOutsideCollaboratorLogins(octokit, org);
  if (outsideCollaborators.has(username.toLowerCase())) {
    return false;
  }

  return true;
}

/**
 * @deprecated Use {@link isInternalContributor} instead. This thin wrapper
 * preserves the old name for callers that only need a yes/no answer at the
 * organization level, but it now also recognises users that reach the org
 * through an enterprise team (via repository collaborator status).
 */
export async function isOrganizationMember(
  octokit: Octokit,
  org: string,
  repo: string,
  username: string
): Promise<boolean> {
  return isInternalContributor(octokit, org, repo, username);
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

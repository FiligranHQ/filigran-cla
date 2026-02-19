/**
 * Ad-hoc migration script to remove PR references from existing CLA
 * agreement descriptions in ConcordNow.
 *
 * Before:  "Contributor License Agreement for GitHub user @foo (org/repo#123)"
 * After:   "Contributor License Agreement for GitHub user @foo"
 *
 * Usage: npx tsx scripts/fix-cla-descriptions.ts [--dry-run]
 */

import 'dotenv/config';

const API_BASE = process.env.CONCORD_API_URL!;
const API_KEY = process.env.CONCORD_API_KEY!;
const ORG_ID = process.env.CONCORD_ORGANIZATION_ID!;

if (!API_BASE || !API_KEY || !ORG_ID) {
  console.error('Missing required env vars: CONCORD_API_URL, CONCORD_API_KEY, CONCORD_ORGANIZATION_ID');
  process.exit(1);
}

const DRY_RUN = process.argv.includes('--dry-run');

interface AgreementListItem {
  uuid: string;
  title: string;
  status: string;
}

interface AgreementDetail {
  uid: string;
  metadata: {
    title: string;
    description?: string;
    status: string;
  };
}

async function concordFetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const url = `${API_BASE}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'X-API-KEY': API_KEY,
      'Content-Type': 'application/json',
      ...((options.headers as Record<string, string>) || {}),
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Concord API error ${response.status}: ${errorText}`);
  }

  if (response.status === 204) return {} as T;
  return (await response.json()) as T;
}

const PR_REF_PATTERN = /\s*\([^)]*#\d+\)\s*$/;

const STATUS_GROUPS = [
  'CURRENT_CONTRACT,UNKNOWN_CONTRACT,SIGNING',
  'DRAFT',
  'NEGOTIATION',
  'PENDING',
  'APPROVED',
  'EXECUTED',
  'TERMINATED',
  'EXPIRED',
  'CANCELLED',
];

async function listAllCLAAgreements(): Promise<AgreementListItem[]> {
  const seen = new Set<string>();
  const allItems: AgreementListItem[] = [];

  for (const statuses of STATUS_GROUPS) {
    let page = 0;
    const pageSize = 50;

    try {
      while (true) {
        const response = await concordFetch<{ items: AgreementListItem[]; total: number }>(
          `/user/me/organizations/${ORG_ID}/agreements?statuses=${statuses}&page=${page}&numberOfItemsByPage=${pageSize}`
        );

        for (const item of response.items) {
          if (!seen.has(item.uuid)) {
            seen.add(item.uuid);
            allItems.push(item);
          }
        }

        console.log(`  [${statuses}] page ${page} — ${response.items.length} items (total: ${response.total})`);
        if ((page + 1) * pageSize >= response.total || response.items.length === 0) break;
        page++;
      }
    } catch {
      console.log(`  [${statuses}] — not a valid status, skipping`);
    }
  }

  return allItems;
}

async function getAgreementDetail(uid: string): Promise<AgreementDetail> {
  return concordFetch<AgreementDetail>(`/organizations/${ORG_ID}/agreements/${uid}`);
}

async function updateAgreementMetadata(uid: string, metadata: { description: string }): Promise<void> {
  await concordFetch(`/organizations/${ORG_ID}/agreements/${uid}/metadata`, {
    method: 'PATCH',
    body: JSON.stringify(metadata),
  });
}

async function main() {
  console.log(`\n=== Fix CLA Descriptions${DRY_RUN ? ' (DRY RUN)' : ''} ===\n`);
  console.log(`API: ${API_BASE}`);
  console.log(`Org: ${ORG_ID}\n`);

  console.log('Fetching all CLA agreements...');
  const agreements = await listAllCLAAgreements();
  console.log(`Found ${agreements.length} CLA agreements.\n`);

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const agreement of agreements) {
    try {
      const detail = await getAgreementDetail(agreement.uuid);
      const description = detail.metadata.description || '';

      if (!PR_REF_PATTERN.test(description)) {
        skipped++;
        continue;
      }

      const newDescription = description.replace(PR_REF_PATTERN, '');

      console.log(`[${agreement.uuid}] "${detail.metadata.title}"`);
      console.log(`  Before: ${description}`);
      console.log(`  After:  ${newDescription}`);

      if (!DRY_RUN) {
        await updateAgreementMetadata(agreement.uuid, { description: newDescription });
        console.log(`  ✓ Updated`);
      } else {
        console.log(`  (dry run — no changes made)`);
      }

      updated++;
    } catch (error) {
      errors++;
      console.error(`[${agreement.uuid}] Error: ${error}`);
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Total:   ${agreements.length}`);
  console.log(`Updated: ${updated}`);
  console.log(`Skipped: ${skipped} (no PR reference found)`);
  console.log(`Errors:  ${errors}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

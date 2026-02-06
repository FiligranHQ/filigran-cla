import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

// Load environment variables
dotenv.config();

/**
 * Parse exempted users from environment variable
 * Supports comma-separated list: "user1,user2,user3"
 */
function parseExemptedUsers(): string[] {
  const envUsers = process.env.CLA_EXEMPTED_USERS || '';
  
  // Default Filigran employees - add your team members here
  const defaultExemptedUsers: string[] = [
    // Add Filigran employee GitHub usernames here
    // 'SamuelHassine',
    // 'employee2',
  ];

  const envUserList = envUsers
    .split(',')
    .map((u) => u.trim().toLowerCase())
    .filter((u) => u.length > 0);

  // Combine env users with default users (case-insensitive)
  const allUsers = new Set([
    ...defaultExemptedUsers.map((u) => u.toLowerCase()),
    ...envUserList,
  ]);

  return Array.from(allUsers);
}

/**
 * Check if a GitHub username is exempted from CLA
 */
export function isUserExempted(username: string): boolean {
  return config.cla.exemptedUsers.includes(username.toLowerCase());
}

function getPrivateKey(): string {
  // First try base64 encoded key
  if (process.env.GITHUB_PRIVATE_KEY_BASE64) {
    return Buffer.from(process.env.GITHUB_PRIVATE_KEY_BASE64, 'base64').toString('utf-8');
  }

  // Then try file path
  const keyPath = process.env.GITHUB_PRIVATE_KEY_PATH;
  if (keyPath && fs.existsSync(keyPath)) {
    return fs.readFileSync(keyPath, 'utf-8');
  }

  throw new Error('GitHub private key not found. Set GITHUB_PRIVATE_KEY_BASE64 or GITHUB_PRIVATE_KEY_PATH');
}

export const config = {
  // Server
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  publicUrl: process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || '3000'}`,

  // GitHub App
  github: {
    appId: process.env.GITHUB_APP_ID || '',
    getPrivateKey,
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET || '',
  },

  // Concord
  concord: {
    apiKey: process.env.CONCORD_API_KEY || '',
    apiUrl: process.env.CONCORD_API_URL || 'https://api.concordnow.com/api/rest/1',
    organizationId: process.env.CONCORD_ORGANIZATION_ID || '',
    templateId: process.env.CONCORD_TEMPLATE_ID || '',
  },

  // Database
  database: {
    path: process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'cla.db'),
  },

  // CLA Configuration
  cla: {
    // GitHub usernames exempted from CLA (e.g., Filigran employees)
    // Can be set via env var as comma-separated list or in code
    exemptedUsers: parseExemptedUsers(),
    skipOrgMemberCheck: process.env.CLA_SKIP_ORG_MEMBER_CHECK === 'true',
  },

  // CLA Labels
  claLabel: {
    name: 'cla:pending',
    color: 'fbca04',
    description: 'CLA signature required',
  },

  claSignedLabel: {
    name: 'cla:signed',
    color: '0e8a16',
    description: 'CLA has been signed',
  },

  claExemptLabel: {
    name: 'cla:exempt',
    color: '5319e7',
    description: 'CLA not required (Filigran employee)',
  },
};

export function validateConfig(): void {
  const required = [
    ['GITHUB_APP_ID', config.github.appId],
    ['GITHUB_WEBHOOK_SECRET', config.github.webhookSecret],
    ['CONCORD_API_KEY', config.concord.apiKey],
    ['CONCORD_ORGANIZATION_ID', config.concord.organizationId],
    ['CONCORD_TEMPLATE_ID', config.concord.templateId],
  ];

  const missing = required.filter(([, value]) => !value).map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

# Filigran CLA Bot

A GitHub App bot that manages Contributor License Agreements (CLAs) for Filigran open source repositories using Concord and DocuSign.

## Features

- **Organization-wide CLA**: Sign once, contribute to all Filigran repositories
- **Exempted users**: Configure Filigran employees to bypass CLA checks
- Automatically checks if PR contributors have signed the Filigran CLA
- Creates CLA agreements in Concord from a template
- Sends agreements for electronic signature via DocuSign
- Adds labels and comments to PRs requiring CLA signature
- Automatically updates PRs when the CLA is signed
- Maintains a local database of CLA signatures for quick lookups

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   GitHub PR     │────▶│  Filigran CLA   │────▶│    Concord      │
│   Webhook       │     │     Bot         │     │   (DocuSign)    │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                               │                        │
                               ▼                        │
                        ┌─────────────────┐            │
                        │    SQLite DB    │            │
                        │  (CLA Records)  │◀───────────┘
                        └─────────────────┘      Webhook
```

## Prerequisites

- Node.js 18+
- A GitHub App with the following permissions:
  - Repository permissions:
    - Commit statuses: Read & Write
    - Issues: Read & Write
    - Pull requests: Read & Write
    - Metadata: Read-only
  - Subscribe to events:
    - Pull request
- A Concord account with:
  - API key
  - Organization ID
  - CLA template document

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/FiligranHQ/filigran-cla.git
cd filigran-cla
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

Copy the example environment file and configure it:

```bash
cp .env.example .env
```

Edit `.env` with your configuration:

```env
# Server
PORT=3000
NODE_ENV=production
PUBLIC_URL=https://your-domain.com

# GitHub App
GITHUB_APP_ID=your_app_id
GITHUB_PRIVATE_KEY_PATH=./private-key.pem
GITHUB_WEBHOOK_SECRET=your_webhook_secret

# Concord
CONCORD_API_KEY=your_api_key
CONCORD_API_URL=https://api.concordnow.com/api/rest/1
CONCORD_ORGANIZATION_ID=your_org_id
CONCORD_TEMPLATE_ID=your_template_id

# Database
DATABASE_PATH=./data/cla.db

# CLA Exempted Users (comma-separated GitHub usernames)
# These users (e.g., Filigran employees) won't need to sign the CLA
CLA_EXEMPTED_USERS=SamuelHassine,employee2,employee3
```

### 4. Set up your GitHub App

1. Go to [GitHub Developer Settings](https://github.com/settings/apps)
2. Create a new GitHub App with:
   - **Webhook URL**: `https://your-domain.com/github/webhook`
   - **Webhook secret**: Generate a secure secret
   - Required permissions (see Prerequisites)
3. Download the private key and save it as `private-key.pem`
4. Install the app on your organization/repositories

### 5. Set up Concord webhook

1. Log in to your Concord account
2. Go to Settings > Integrations > Webhooks
3. Create a new webhook with:
   - **URL**: `https://your-domain.com/concord/webhook`
   - **Events**: 
     - AGREEMENT_EXECUTED
     - AGREEMENT_NEW_SIGNATURE
     - AGREEMENT_CANCELLED

### 6. Build and run

```bash
# Build
npm run build

# Start
npm start

# Or for development
npm run dev
```

## Deployment

### Docker

```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY dist ./dist

# Create data directory for SQLite
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV DATABASE_PATH=/app/data/cla.db

EXPOSE 3000

CMD ["node", "dist/index.js"]
```

Build and run:

```bash
docker build -t filigran-cla .
docker run -d \
  -p 3000:3000 \
  -v ./data:/app/data \
  -v ./private-key.pem:/app/private-key.pem:ro \
  --env-file .env \
  filigran-cla
```

### Using Docker Compose

```yaml
version: '3.8'

services:
  cla-bot:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data
      - ./private-key.pem:/app/private-key.pem:ro
    env_file:
      - .env
    restart: unless-stopped
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Service information |
| `/health` | GET | Health check |
| `/github/webhook` | POST | GitHub webhook endpoint |
| `/concord/webhook` | POST | Concord webhook endpoint |
| `/concord/health` | GET | Concord webhook health check |

## How It Works

### Organization-Wide CLA

The CLA signature is **organization-wide**, meaning:
- Contributors only need to sign the CLA **once**
- The signature covers **all repositories** in your GitHub organization
- When they open PRs in any Filigran repo, they're automatically recognized as having signed

### Exempted Users (Filigran Employees)

Configure employees who don't need to sign the CLA:

```env
CLA_EXEMPTED_USERS=SamuelHassine,JulienRiwormo,employee3
```

Exempted users:
- Automatically pass CLA checks on all PRs
- Get the `cla:exempt` label instead of `cla:pending`
- Are identified by their GitHub username (case-insensitive)

You can also add exempted users directly in `src/config.ts`:

```typescript
const defaultExemptedUsers: string[] = [
  'SamuelHassine',
  'JulienRiwormo',
  // Add more Filigran employees here
];
```

### When a PR is opened

1. GitHub sends a webhook to `/github/webhook`
2. Bot checks if the contributor is an **exempted user** (Filigran employee)
   - If exempted: Sets commit status to success, adds "cla:exempt" label
3. Bot checks if the contributor has already signed the CLA (database lookup)
   - This check is **organization-wide** (not per-repository)
4. If signed: Sets commit status to success, adds "cla:signed" label
5. If not signed:
   - Creates a new agreement in Concord from the template
   - Invites the contributor to sign via DocuSign
   - Adds "cla:pending" label to the PR
   - Creates a comment with signing instructions
   - Sets commit status to pending

### When the CLA is signed

1. Concord sends a webhook to `/concord/webhook` with `AGREEMENT_EXECUTED` event
2. Bot updates the CLA record in the database
3. For **all open PRs by the contributor across all repositories**:
   - Updates the comment to show CLA is signed
   - Removes "cla:pending" label, adds "cla:signed" label
   - Sets commit status to success

### Labels

| Label | Color | Description |
|-------|-------|-------------|
| `cla:pending` | Yellow | CLA signature required |
| `cla:signed` | Green | CLA has been signed |
| `cla:exempt` | Purple | CLA not required (Filigran employee) |

## CLA Template Setup in Concord

Your CLA template should be an "Automated Template" in Concord with the following smartfields (optional):

- `contributor_name` - The contributor's name
- `contributor_email` - The contributor's email
- `github_username` - The contributor's GitHub username
- `date` - The signature date

## Troubleshooting

### Webhook not receiving events

1. Check that your PUBLIC_URL is accessible from the internet
2. Verify the webhook secret matches in both GitHub and your `.env`
3. Check the GitHub App webhook delivery logs

### CLA agreement creation fails

1. Verify your CONCORD_API_KEY is valid
2. Check that the template ID exists and is an Automated Template
3. Review the bot logs for detailed error messages

### Database issues

1. Ensure the data directory is writable
2. Check that DATABASE_PATH is set correctly
3. The bot creates the database automatically on first run

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build
npm run build

# Lint
npm run lint
```

## License

Apache-2.0

## Contributing

Contributions are welcome! Please read the [Contributing Guide](CONTRIBUTING.md) first.

---

Made with love by [Filigran](https://filigran.io)

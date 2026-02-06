# Filigran CLA Bot

A GitHub App bot that manages Contributor License Agreements (CLAs) for open source repositories using [Concord](https://www.concord.app/) for electronic signatures.

## Features

- **Organization-wide CLA**: Sign once, contribute to all repositories in the organization
- **Automatic exemption**: GitHub organization members are automatically exempt from CLA signing
- **Manual whitelist**: Additional users can be exempted via configuration
- **Concord integration**: Agreements are created from an automated template and sent for e-signing
- **Commit status checks**: Uses GitHub commit statuses (`filigran/cla`) to block or allow merges
- **Resend command**: Comment `/cla resend` on a PR to resend or recreate the CLA invitation
- **Webhook-driven**: Automatically updates PRs when the CLA is signed in Concord
- **SQLite database**: Local database for fast CLA lookups across repositories

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   GitHub PR     │────▶│  Filigran CLA   │────▶│    Concord      │
│   Webhook       │     │     Bot         │     │   (e-signing)   │
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
    - **Commit statuses**: Read & Write
    - **Issues**: Read & Write (for PR comments)
    - **Pull requests**: Read & Write
    - **Metadata**: Read-only
  - Organization permissions:
    - **Members**: Read (for automatic org member exemption)
  - Subscribe to events:
    - **Pull request**
    - **Issue comment** (for `/cla resend` command)
- A Concord account with:
  - API key
  - Organization ID
  - CLA document set up as an **Automated Template**

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
cp .env.sample .env
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

# CLA Configuration
# Additional GitHub usernames exempted from CLA (comma-separated)
# Note: GitHub org members are automatically exempted
CLA_EXEMPTED_USERS=
# Set to true to disable automatic org member exemption (useful for testing)
CLA_SKIP_ORG_MEMBER_CHECK=false
```

### 4. Set up your GitHub App

1. Go to [GitHub Developer Settings](https://github.com/settings/apps)
2. Create a new GitHub App with:
   - **Webhook URL**: `https://your-domain.com/github/webhook`
   - **Webhook secret**: Generate a secure secret
   - Required permissions (see Prerequisites)
3. Download the private key and save it as `private-key.pem`
4. Install the app on your organization/repositories

### 5. Set up Concord

#### Automated Template

1. Create your CLA document in Concord
2. Go to the template **Settings** and enable **"Automated Template"**
3. Optionally add smartfields:
   - `contributor_name` — The contributor's name
   - `contributor_email` — The contributor's email
   - `github_username` — The contributor's GitHub username
   - `date` — The signature date
4. Configure signature request to be sent automatically

#### Webhook

1. Log in to your Concord account
2. Go to Settings > Integrations > Webhooks
3. Create a new webhook with:
   - **URL**: `https://your-domain.com/concord/webhook`
   - **Events**:
     - `AGREEMENT_EXECUTED`
     - `AGREEMENT_NEW_SIGNATURE`
     - `AGREEMENT_CANCELLED`

### 6. Build and run

```bash
# Build
npm run build

# Start
npm start

# Or for development
npm run dev
```

## How It Works

### When a PR is opened

1. GitHub sends a webhook to `/github/webhook`
2. Bot checks if the contributor is **exempt** (org member or whitelisted)
   - If exempt: Sets commit status to success ("CLA not required"), returns
3. Bot checks if the contributor has **already signed** the CLA (database lookup)
   - If signed: Sets commit status to success ("CLA already signed"), returns
4. If not signed:
   - Creates a new agreement in Concord from the automated template
   - Concord sends the signing invitation email to the contributor
   - Adds `cla:pending` label to the PR
   - Posts a comment with instructions to check email
   - Sets commit status to pending

On subsequent pushes (`synchronize`) or reopens, only the commit status is updated — no duplicate comments or labels are created.

### When the CLA is signed

1. Concord sends a webhook to `/concord/webhook` with `AGREEMENT_NEW_SIGNATURE` or `AGREEMENT_EXECUTED`
2. Bot marks the CLA as signed in the database
3. For **all open PRs by the contributor across all repositories**:
   - Updates the comment to show the CLA is signed
   - Removes the `cla:pending` label
   - Sets commit status to success

### Organization-Wide CLA

The CLA signature is **organization-wide**, meaning:
- Contributors only need to sign the CLA **once**
- The signature covers **all repositories** in the organization
- Subsequent PRs are automatically recognized

### Exemption (Organization Members)

The bot automatically exempts members of the GitHub organization that owns the repository. This means:
- No manual configuration needed for employees
- Membership is checked dynamically via the GitHub API
- Can be disabled with `CLA_SKIP_ORG_MEMBER_CHECK=true` for testing

Additional users can be exempted via the `CLA_EXEMPTED_USERS` environment variable (comma-separated, case-insensitive).

### Resend Command

If a contributor didn't receive the signing email or the agreement needs to be recreated, anyone can comment on the PR:

```
/cla resend
```

The bot will:
- If the agreement still exists in Concord: resend the invitation email
- If the agreement was deleted in Concord: clean up old records and create a fresh agreement
- If the CLA is already signed: reply that no resend is needed

### Blocking Merges

To make the CLA check block merges, add `filigran/cla` as a **required status check** in your branch protection rules or organization rulesets:

1. Go to **Settings > Rules > Rulesets** (organization-wide) or **Settings > Branches** (per-repo)
2. Add a **"Require status checks"** rule
3. Add `filigran/cla` as a required check

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Service information |
| `/health` | GET | Health check |
| `/github/webhook` | POST | GitHub webhook endpoint |
| `/concord/webhook` | POST | Concord webhook endpoint |
| `/concord/health` | GET | Concord webhook health check |

## Deployment

### systemd

```bash
sudo tee /etc/systemd/system/filigran-cla.service > /dev/null << 'EOF'
[Unit]
Description=Filigran CLA Bot
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/filigran-cla
ExecStart=/usr/bin/node --experimental-sqlite dist/index.js
Restart=always
RestartSec=5
EnvironmentFile=/opt/filigran-cla/.env
StandardOutput=journal
StandardError=journal
SyslogIdentifier=filigran-cla

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable filigran-cla
sudo systemctl start filigran-cla
```

### Docker

```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY dist ./dist

RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV DATABASE_PATH=/app/data/cla.db

EXPOSE 3000

CMD ["node", "--experimental-sqlite", "dist/index.js"]
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

### Docker Compose

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

## Troubleshooting

### Webhook not receiving events

1. Check that your `PUBLIC_URL` is accessible from the internet
2. Verify the webhook secret matches in both GitHub and your `.env`
3. Check the GitHub App webhook delivery logs

### CLA agreement creation fails

1. Verify your `CONCORD_API_KEY` is valid
2. Check that the template ID exists and is an **Automated Template** in Concord
3. Review the bot logs for detailed error messages

### Contributor not receiving signing email

1. Ask the contributor to check their spam folder
2. Use the `/cla resend` command on the PR
3. Verify the contributor's email is correct in the bot logs

### Database issues

1. Ensure the data directory is writable
2. Check that `DATABASE_PATH` is set correctly
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

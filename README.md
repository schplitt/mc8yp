# mc8yp - Cumulocity IoT MCP Server

![Version](https://img.shields.io/npm/v/mc8yp)
![License](https://img.shields.io/npm/l/mc8yp)
![Node Version](https://img.shields.io/node/v/mc8yp)

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that provides AI agents with comprehensive access to Cumulocity IoT platform data. This enables AI-powered device management, data analysis, and operational insights through standardized tooling.

**Two Deployment Modes:**

- **CLI Mode**: Run locally with `pnpm dlx mc8yp` for development and testing with AI agents like Claude Desktop. Uses your system's secure keyring to store credentials.
- **Microservice Mode**: Deploy as a Cumulocity microservice for production use. The MCP endpoint (`/mcp`) integrates with Cumulocity's agents manager, using the service user's permissions automatically.

## Installation

### CLI Mode (Local Development & Testing)

The CLI mode allows you to run the MCP server locally and connect it to your AI agent (e.g., Claude Desktop). It uses STDIO transport and stores Cumulocity credentials securely in your system's native keyring.

```sh
# Run directly with pnpm (recommended)
pnpm dlx mc8yp

# Or install globally
npm install -g mc8yp
mc8yp

# Or with pnpm
pnpm add -g mc8yp
mc8yp
```

**Credential Storage:**
Credentials are stored using your operating system's secure credential manager:

- **macOS**: Keychain
- **Windows**: Credential Vault
- **Linux**: Secret Service API (libsecret)

### Microservice Mode (Production Deployment)

The microservice mode is designed **exclusively for deployment on Cumulocity IoT**. The server exposes an HTTP endpoint at `/mcp` that integrates with Cumulocity's agents manager, automatically using the service user's credentials and permissions.

**Deployment Steps:**

1. Download the latest release package from [GitHub Releases](https://github.com/schplitt/mc8yp/releases)
2. Upload the `.zip` file to Cumulocity via **Application Management**
3. Subscribe to the application in your tenant
4. The MCP server will be available at: `https://<tenant>.cumulocity.com/service/mc8yp-server/mcp`

The microservice uses Cumulocity's built-in service user authentication - no additional credential configuration needed.

## Usage

### CLI Mode: Managing Credentials

Before using the CLI, you need to store your Cumulocity credentials securely:

```sh
# Add credentials (prompts for tenant URL, username, password)
pnpm dlx mc8yp creds add

# List stored credentials
pnpm dlx mc8yp creds list

# Remove credentials
pnpm dlx mc8yp creds remove
```

The CLI stores credentials in your system's native credential manager and automatically uses them when you connect the MCP server to your AI agent. The `list-credentials` tool is also available within MCP sessions when running in CLI mode.

### Connecting to Local Agents

For local development with Claude Desktop or similar MCP clients, add to your MCP configuration:

```json
{
  "servers": {
    "mc8yp": {
      "type": "stdio",
      "command": "pnpm",
      "args": ["dlx", "mc8yp"]
    }
  }
}
```

The server will automatically use credentials stored in your system keyring.

## Development

### Prerequisites

- Node.js ≥22.0.0
- pnpm
- Access to a Cumulocity IoT tenant

### Setup

```sh
# Install dependencies
pnpm install

# Lint code
pnpm lint

# Type check
pnpm typecheck

# Build
pnpm build
```

### Run Locally

Add the mc8yp server to your local MCP client configuration (e.g., Claude Desktop) with the following command:

```json
{
  "servers": {
    "local_mc8yp": {
      "type": "stdio",
      "command": "pnpm",
      "args": [
        "dlx",
        "jiti",
        "/path/to/your/project/src/cli/index.ts"
      ]
    }
  }
}
```

This allows you to test and develop the MCP server locally using your preferred MCP client.

## Available Tools & Prompts

### 🛠️ Tools (20 Total)

> **Note**: In CLI mode, an additional `list-credentials` tool is available to view stored credentials from your system keyring. This tool is not available in microservice deployments.

**Inventory Management** (4 tools)

- `query-inventory` - Query devices, groups, and assets using OData filters
- `get-object` - Get detailed device/group/asset information by ID
- `list-children` - List child objects in device hierarchy
- `get-supported-series` - Discover measurement types a device supports

**Measurements** (2 tools)

- `get-measurements` - Retrieve time-series measurement data
- `get-measurement-stats` - Get min/max/avg statistics for measurements

**Events** (2 tools)

- `get-events` - Query device events with filters
- `get-event-types` - Discover available event types for a device

**Alarms** (2 tools)

- `get-alarms` - Query alarms with filtering by severity, status, type
- `get-alarm-counts` - Get alarm counts grouped by severity

**Metadata & Administration** (10 tools)

- `get-current-tenant` - Get current tenant information
- `get-current-user` - Get current user details
- `get-users` - List users on the tenant
- `get-applications` - List available applications
- `get-application` - Get specific application details
- `get-application-versions` - Get all versions of an application
- `get-audit` - Query audit logs
- `get-tenant-stats` - Get tenant usage statistics
- `get-tenant-summary` - Get tenant usage summary
- `get-dashboards` - Get dashboards for a device or group

### 💬 Prompts (17 Total)

Pre-built prompt templates that guide AI agents through common IoT workflows:

**Date & Time** (2 prompts)

- Date/time range calculations
- Time window guidance for queries

**Inventory** (4 prompts)

- Device lookup and hierarchy navigation
- Finding devices by criteria
- OData query syntax help
- Device discovery workflows

**Measurements** (3 prompts)

- Measurement data analysis
- Time range calculations
- Data aggregation guidance

**Events** (2 prompts)

- Event type discovery
- Event history querying

**Alarms** (2 prompts)

- Alarm status interpretation
- Troubleshooting workflows

**Metadata** (1 prompt)

- Tenant context understanding

**Tenant & Administration** (3 prompts)

- Tenant configuration and settings
- Audit log querying
- Application management

## License

MIT

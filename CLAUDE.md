# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

- `npm start` - Starts the server (runs `node app.js`)
- `node app.js` - Direct server startup, runs on PORT env var or 3000

## Architecture Overview

This is a Node.js Express API backend for SharkBook/SharkBoot, a multi-tenant SaaS platform with OpenAI assistant integration, authentication, and file management.

### Core Structure

**Entry Point**: `app.js` - Express server with Facebook OAuth, CORS, and route mounting

**Database**: `db.js` - MySQL connection pool using mysql2/promise

**Authentication System**:
- JWT-based auth with 7-day expiration (`helpers/jwt.js`)
- Facebook OAuth integration via Passport
- Auth middleware (`middlewares/authGuard.js`) protects routes
- Multi-provider support (EMAIL, FACEBOOK, WHATSAPP) in user_providers table

**Multi-Tenant Architecture**:
- `clients` table represents organizations/workspaces
- `users` belong to clients (client_id foreign key)
- All data scoped by client_id for tenant isolation
- User roles: different permissions within clients

**Route Organization**:
- `/auth/*` - Registration, login, OAuth callbacks (`routes/auth.js`)
- `/client/*` - Client profile, stats, usage data (`routes/client.js`) 
- `/assistants/*` - OpenAI assistant management (`routes/OpenAI.js` and `routes/files.js`)
- `/whatsapp/*` - WhatsApp integration (`routes/whatsapp.js`)

**Key Helpers**:
- `helpers/openai.js` - OpenAI API integration
- `helpers/vectorStore.js` - Vector storage for AI assistants
- `helpers/jwt.js` - JWT token signing/verification

### Database Schema Patterns

- Uses UUIDs for primary keys (generated in app code via `uuid` package)
- Multi-tenant: most tables have `client_id` for data isolation
- User providers pattern: supports multiple auth methods per user
- Usage tracking: `usage_daily` table for API consumption metrics

### External Integrations

- **OpenAI**: Assistant creation, file uploads, vector stores
- **Facebook OAuth**: User authentication and account linking
- **Cloudinary**: File storage and management
- **WhatsApp**: Messaging integration (via routes/whatsapp.js)

### Environment Dependencies

Requires these environment variables:
- Database: `DB_HOST`, `DB_USER`, `DB_PASS`, `DB_NAME`
- JWT: `JWT_SECRET`
- Facebook: `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`
- OpenAI: API keys for assistant functionality
# Secrets

This directory holds references to secrets used across Pando infrastructure. Actual secret values are NEVER committed.

## Gateway .env.local

Lives at: `pando/packages/gateway/.env.local` (gitignored in pando repo)

Template: `env-templates/gateway.env.example`

Contains:
- `PANDO_NODE_URL` — HTTP URL to local Pando node (default: http://localhost:4000)
- `OPENAI_API_KEY` — OpenAI API key for AI search fallback
- `OPENAI_MODEL` — Model to use (default: gpt-4o-mini)
- `GEMINI_API_KEY` — Gemini API key for AI search fallback
- `GEMINI_MODEL` — Model to use (default: gemini-2.0-flash-lite)

## Node API Keys

Lives at: `~/.pando/api-keys.json` (on each machine running a node)

Managed via the gateway UI or manually. Contains contributed API keys with provider, model, budget, and spend tracking.

## Node Identity

Lives at: `~/.pando/identity.json` (on each machine running a node)

Ed25519 keypair. This IS your wallet. Lose this file = lose your Lux. Back it up.

## Session File

Lives at: `~/.pando/session.json` (on each machine running a node)

Contains the decrypted identity for auto-login. Created after the first successful password entry so subsequent launches skip the password prompt. Deleted when the user runs `/logout` in the TUI.

## Identities Directory

Lives at: `~/.pando/identities/` (on each machine running a node)

Stores multiple encrypted identity files. Each file is a separate identity (keypair + display name). The TUI lets the user pick which identity to load at startup via arrow-key navigation.

## Node Passwords

Lives at: `secrets/node-passwords.md` (gitignored, in this repo)

Contains identity passwords for admin-operated nodes. Never committed — exists only on local machines for operational reference.

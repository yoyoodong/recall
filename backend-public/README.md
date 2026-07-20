# Recall Public Backend

This backend is the cloud replacement for the local `127.0.0.1` helper.

## User Flow

1. Extension opens `/api/auth/start`.
2. Backend redirects the user to Feishu OAuth.
3. Feishu redirects back to `/api/auth/callback`.
4. Backend exchanges `code` for a user token.
5. Backend creates or reuses a Feishu Base for that user.
6. Backend redirects back to the extension options page with a Recall session token.
7. Extension sends captures to `/api/captures`.

## Required Environment Variables

```bash
PUBLIC_BASE_URL=https://your-netlify-site.netlify.app
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
SESSION_SECRET=replace-with-random-secret
FEISHU_REDIRECT_URI=https://your-netlify-site.netlify.app/api/auth/callback
FEISHU_OAUTH_SCOPE=contact:user.id:readonly offline_access bitable:app bitable:app:readonly calendar:calendar calendar:calendar:readonly
FEISHU_AUTO_PROVISION=true
```

The exact Feishu OAuth URLs and scopes should be finalized from the Feishu Open Platform app configuration before production deployment.

## Current Local Configuration

The local `.env` file is ignored by git and contains the current Feishu App credentials for development. Do not copy those credentials into the Chrome extension.

Before a real OAuth test, replace these placeholder values with the deployed backend URL:

```bash
PUBLIC_BASE_URL=https://<your-backend-domain>
FEISHU_REDIRECT_URI=https://<your-backend-domain>/api/auth/callback
```

Then add the same redirect URI in Feishu Open Platform:

```text
https://<your-backend-domain>/api/auth/callback
```

## Netlify Deploy

This repo now includes a real Netlify Functions entry at:

```text
netlify/functions/api.js
```

Netlify settings:

```text
Build command: empty
Publish directory: public
Functions directory: netlify/functions
```

The first deploy can be tested with:

```text
https://<your-netlify-site>/health
```

## Local Commands

```bash
npm run check:public
npm run server:public
```

For a no-Feishu smoke test, temporarily set:

```bash
PUBLIC_AUTH_MODE=dev
```

For real Feishu OAuth, use:

```bash
PUBLIC_AUTH_MODE=oauth
```

## Production Notes

- Netlify Functions use Netlify Blobs for first-version session/workspace storage.
- Feishu refresh/access tokens are encrypted at rest with `SESSION_SECRET`.
- Restrict CORS to the published Chrome extension ID.
- Add rate limits.
- Add a privacy policy URL before Chrome Web Store submission.
- Add Feishu scope review notes and reviewer test account instructions.
- Confirm Feishu Base provisioning payload against the approved app scopes in the first real OAuth test.

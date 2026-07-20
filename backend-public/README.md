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
PUBLIC_BASE_URL=https://recall-api.example.com
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_OAUTH_AUTHORIZE_URL=https://open.feishu.cn/open-apis/authen/v1/authorize
FEISHU_OAUTH_TOKEN_URL=https://open.feishu.cn/open-apis/authen/v1/access_token
FEISHU_REDIRECT_URI=https://recall-api.example.com/api/auth/callback
SESSION_SECRET=replace-with-random-secret
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

- Replace the in-memory stores with a real database.
- Encrypt Feishu refresh/access tokens at rest.
- Restrict CORS to the published Chrome extension ID.
- Add rate limits.
- Add a privacy policy URL before Chrome Web Store submission.
- Add Feishu scope review notes and reviewer test account instructions.
- Implement the Feishu Base provisioning and record-write adapter after confirming the app scopes.

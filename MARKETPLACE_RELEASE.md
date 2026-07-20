# Recall Chrome Web Store Release Plan

## Current State

The current Recall build is a personal/local build:

- Chrome extension captures the current page, screenshot, title, URL, tags, and core content.
- A local helper at `http://127.0.0.1:8787` writes data into one Feishu Base.
- The local helper depends on the user's local `lark-cli` login and local `.env`.

This build should not be submitted to the Chrome Web Store as-is because other users cannot use the local helper or the owner's private Feishu Base.

## Public Release Target

The public version should work like this:

1. User installs Recall from Chrome Web Store.
2. User clicks "Connect Feishu".
3. User completes Feishu OAuth authorization.
4. Backend creates or reuses that user's own Feishu Base.
5. Extension stores only the user's session token and public backend URL.
6. User clicks the extension icon to save a page.
7. Backend writes to that user's Base.

## Required Product Changes

- Replace `127.0.0.1` API with a deployed HTTPS backend.
- Remove hardcoded personal Base links and IDs from the extension.
- Add Feishu OAuth login.
- Store per-user Feishu access/refresh tokens on the backend.
- Create a per-user Base or copy a Base template after authorization.
- Add a first-run setup screen: connect Feishu, show connected Base, reset connection.
- Keep the simple one-click capture interaction after setup.
- Keep screenshot upload and the "发财 +1" animation.
- Keep the simplified table schema:
  - 标题
  - 网页截图
  - 核心内容
  - 链接
  - 标签
  - 状态
  - 提醒时间
  - 保存时间
  - 来源
  - 重要度

## Required Chrome Web Store Assets

- Extension ZIP built from a public-safe extension folder.
- 128x128 icon and store icon assets.
- At least one screenshot for the listing.
- Short description.
- Detailed description.
- Privacy policy URL.
- Test instructions for the reviewer.
- Data-use disclosure:
  - Page title
  - Page URL
  - Visible page screenshot
  - Selected/visible page text used to generate core content
  - Feishu account authorization token handled by backend

## Required Accounts and Secrets

These cannot be created safely inside source code:

- Chrome Web Store developer account.
- Feishu Open Platform app for Recall.
- OAuth redirect URL on the deployed backend.
- HTTPS backend domain.
- Backend environment variables:
  - `FEISHU_APP_ID`
  - `FEISHU_APP_SECRET`
  - token encryption secret
  - production database URL

## Current Progress

- `extension-public/` contains the public Chrome extension flow:
  - first click opens "Connect Feishu" when not connected
  - after connection, clicking the extension icon saves the page
  - screenshot capture and the "发财 +1" animation are preserved
- `backend-public/` contains the OAuth backend skeleton:
  - `/api/auth/start`
  - `/api/auth/callback`
  - `/api/me`
  - `/api/captures`
- Local backend health check passed on `http://127.0.0.1:8788/health`.
- Feishu App credentials are stored only in ignored local backend env.

## Next Configuration Step

Choose the public backend URL first. For beta, a free HTTPS platform URL is enough:

- Vercel
- Netlify
- Render
- Cloudflare Workers

After deployment, set both places to the same callback URL:

```text
https://<backend-domain>/api/auth/callback
```

Places to update:

- Feishu Open Platform app redirect URL
- `backend-public/.env` / deployed backend env:
  - `PUBLIC_BASE_URL`
  - `FEISHU_REDIRECT_URI`
- `extension-public/options.js` default `apiBaseUrl`

## Recommended Release Phases

### Phase 1: Public Architecture

- Add a cloud backend folder.
- Add Feishu OAuth endpoints.
- Add user/token storage.
- Add Base creation or template-copy logic.
- Add a public-safe extension config flow.

### Phase 2: Beta Distribution

- Build a Chrome Web Store draft item.
- Set visibility to private/unlisted for testing.
- Test with 2-3 Feishu accounts.
- Verify each account gets its own Base.

### Phase 3: Public Submission

- Add listing copy, screenshots, privacy policy, and reviewer instructions.
- Upload ZIP in Chrome Developer Dashboard.
- Submit for review with deferred publishing enabled.

## Do Not Do

- Do not publish the current local build as public.
- Do not embed Feishu app secret in the Chrome extension.
- Do not write all users into the owner's private Base.
- Do not ask users to run a local Node helper for the marketplace version.

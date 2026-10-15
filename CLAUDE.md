# CatalogDesk V2

## UI feedback
- Every message about the outcome of an action (saved, deleted, imported, synchronized, failed) uses `useNotify()` from `src/components/notifications/notifications.ts`. Never add new inline success/error paragraphs to pages.
- Pick the tone by meaning: `success` done, `info` neutral, `warning` saved but not finished (e.g. offline), `error` failed. Short title plus a one-sentence `message` naming the affected item; pass a `key` when repeated actions on the same topic should replace each other.
- Exceptions that stay inline: validation errors inside forms/dialogs and persistent states (loading, progress, pending-sync bar).
- Details: README section "User Feedback (Notifications)".

## Usage history
- Every IPC handler that changes data, touches the shop or affects access calls `audit(user, { category, action, summary, targetType, targetId, targetLabel, shopUrl, details })` in `electron/main.cjs`, for success and for rejected attempts (`outcome: 'failure'`).
- `summary` is a readable German sentence naming the record (e.g. „Begriff „Hosen“ in Kategorien angelegt“); before/after values go into `details.changes` as `{ field, before, after }` with readable values.
- Never record passwords, API keys or session tokens. New categories must be added to `auditCategories` (database) and the History page.

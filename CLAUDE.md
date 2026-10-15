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

## Shop writes
- Writes to WooCommerce always go through an outbox table and a sync module (`taxonomy-sync.cjs`, `product-sync.cjs`) run by `runShopSync()` in Main: queue locally first, send immediately when online, keep queued offline.
- Before overwriting shop data that others can change, read the current shop state and treat fields changed there since the local base as conflicts; send only changed fields and verify the shop's answer.

## Plugin knowledge
- Never hard-code knowledge about a specific WordPress plugin in the core (`taxonomies.cjs`, `products.cjs`, `database.cjs`, UI). Put it into a module in `electron/modules/` and register it in `modules/index.cjs`.
- The core must keep working without the module (generic discovery, neutral labels); modules only add meaning. Licensing hooks in at `isLicensed()` only; whether a module is used is decided by `activeModuleIds()` in the database (detected, licensed, switched on). Module effects must be applied when reading or recomputed on toggle, never baked into imported data.

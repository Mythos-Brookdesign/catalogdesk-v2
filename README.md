# CatalogDesk V2

A separate product-first Electron application. V1 remains untouched and its local database and credentials are not migrated automatically.

## Architecture

- `electron/main.cjs`: trusted desktop boundary, custom `catalog:` protocol, and sender-validated IPC.
- `electron/preload.cjs`: narrow renderer API; no Node integration in the UI.
- `electron/database-worker.cjs`: serial SQLite work away from the renderer/main event loop.
- `electron/database.cjs`: V2 schema for shops, products/variants, native taxonomy relations, and product attributes.
- `electron/auth.cjs`: first-admin bootstrap, scrypt password hashing, rate-limited login, and in-memory sessions.
- `src/features/auth`: first-run admin setup and login gate; the product workspace is not rendered before authentication.
- `src/features/products`: product workspace UI and feature types, separate from CSV parsing.
- `src/domain`: shared product invariants and future use cases.

The V2 schema models WooCommerce products and variants explicitly. Germanized and plugin-specific data remain in the original JSON payload until an adapter declares those fields. No V1 data or credentials are copied into V2.

On the first start, create the initial admin with first name, last name, email, username, and a password of at least 8 characters. Later starts require that local username and password.

## User Management

Admins can list, create, edit and delete local accounts under Settings > Users, including optional password resets. Employees have explicitly assigned access to sidebar sections. The Users permission grants read-only access to the user list; only admins can change accounts or assign roles. Admins always have full access. At least one active admin must remain: SQLite transactions reject deletion or demotion of the last admin. Editing or deleting a user revokes their existing sessions; editing your own profile requires a new login. Passwords remain scrypt-hashed and are never returned in the user list.

Menu permissions are enforced in Main for implemented data endpoints, not just the sidebar. Future endpoints must apply the matching permission before accessing data. The local login does not isolate the database from other processes running as the same operating-system user.

## WooCommerce Connection

Shop Connection provides the connection form with an HTTPS shop URL, Consumer Key and Consumer Secret. Admins and employees explicitly granted Shop Connection access can configure it. General Settings does not expose the shop connection. API keys are encrypted using Electron safeStorage and stored separately from SQLite at `userData/credentials/shop-connection.enc`; stored keys are never returned to the renderer or placed in localStorage. Linux requires a secure keyring backend (no basic_text fallback).

The read-only connection test sends one GET request to `wc/v3/products` with a 15-second timeout and 64-KB response bound, and refuses redirects. Testing does not save changes automatically: use Save Connection explicitly. Blank key fields preserve existing keys only for the same normalized shop URL; a different URL requires both new keys. Removing the connection requires confirmation and leaves catalog data unchanged. Shop import and synchronization are not part of this step.

## Taxonomies

Taxonomies imports every product taxonomy the shop exposes, without a fixed list, so plugin and custom taxonomies are included:

1. The WooCommerce REST index (`wp-json/wc/v3?context=help`): every term collection (WooCommerce terms controller and plugin subclasses such as Germanized) accepts `hide_empty` and names its taxonomy in the schema title. Hierarchy is detected from a `parent` schema field. Terms are read with the WooCommerce keys.
2. WordPress taxonomies registered for products with `show_in_rest` (`wp/v2/taxonomies?type=product`) that have no WooCommerce controller. These requests are sent without credentials, since WordPress rejects WooCommerce keys; their labels also replace generic names.
3. Global attributes (`pa_*`) with their terms.

If the index is blocked (e.g. by a security plugin), the core taxonomies (categories, tags, brands if present, shipping classes) are used. Taxonomies registered without any REST exposure cannot be read through the API.

Requests are read-only GETs with 100 terms per page, a 15-second timeout (30 s for the index), size bounds and no redirects; the import requires the Taxonomies permission and API keys stay in Main. Core taxonomies must import completely; a plugin taxonomy that refuses access is marked unreadable and its stored terms are kept. Results replace the shop's local taxonomy data in a single SQLite transaction (schema v7: `taxonomies` with kind `core`/`custom`/`attribute` and the REST route, plus `parent_id`, `product_count` and `menu_order` on `taxonomy_terms`; the full REST object stays in the term payload). Terms that no longer exist in the shop are removed together with their product relations. A taxonomy import alone does not count as a catalog import on the dashboard. The screen groups taxonomies into WooCommerce, plugins & custom, and attributes, and shows terms with search, paging, and hierarchies as a tree.

### Editing terms (online first, offline capable)

Terms of taxonomies with a WooCommerce route (`wc/v3/...`, including plugin and attribute taxonomies) can be created, edited (name, slug, parent, description) and deleted; `wp/v2`-only taxonomies are read-only because writes there need a WordPress login. Every edit is first stored in the SQLite outbox `taxonomy_changes` (schema v8, one row per term) and then sent to the shop immediately (POST/PUT, DELETE with `force=true`). Without a connection the edit stays queued and is shown in the list right away (states New/Changed/Being deleted); locally created terms use negative IDs until the shop assigns real ones, so children can be created under them offline.

Queued changes are synchronized in creation order every 30 seconds, when the network returns, before each taxonomy import, or via *Sync now*. Parents are created before their children and local IDs are mapped to shop IDs. Connection loss stops the run and keeps everything queued; rejections by the shop (e.g. duplicate names or slugs) are stored with the shop's message and can be discarded or retried. Missing write permission (read-only API keys) stops the run. Edits made while a request is running are kept as follow-up changes (revision check). Deleting a term moves its children one level up, as WordPress does, and removes local product relations. Writes always win over concurrent edits in the shop (last write wins). Name and slug conflicts are checked locally before queueing.

## Appearance

General Settings provides Light and Dark modes. Selection applies immediately to the whole app and is persisted as a shared local workspace setting in SQLite (schema v4). The login screen and native window background load the saved mode before displaying the workspace. Theme updates require the Settings permission; reading only the theme is permitted before login. A failed save restores the previous mode.

## Usage History (Audit Log)

History lists who did what and when: logins (including failed attempts with the entered username) and logouts, the first admin setup, user changes, theme changes, shop connection save/test/remove, taxonomy imports, term create/edit/delete/discard, and every synchronization run (manual, before an import, or automatic in the background as "System"). Rejected actions are recorded as failures with their reason.

Entries are written in Main (`audit()` in `electron/main.cjs`), where the acting user is known from the session, and stored in the SQLite table `audit_log` (schema v9). Each entry holds the time, a snapshot of the user's name and username (readable after the user is deleted), area, action code, a readable summary, the affected record (type, ID, label), shop URL, outcome and details such as before/after values. Passwords and API keys are never recorded, only that they were changed. Triggers make the table append-only; the app offers no way to edit or delete entries. As with the rest of the local database, this does not protect against other processes of the same operating-system user editing the file. There is no automatic cleanup yet.

The History screen (permission "Historie"; admins always) groups entries by day, filters by search text, area, user (including System), outcome and date range, shows details with before/after tables, and updates live while the first page is open.

New features must record every change and every shop access through `audit()`.

## User Feedback (Notifications)

All feedback about the outcome of an action uses the shared notifications in `src/components/notifications`: `const notify = useNotify()` and then `notify.success | info | warning | error(title, { message, key })`.

- Title: short outcome (e.g. "Im Shop gespeichert", "Import fehlgeschlagen"); message: one sentence with the affected item or the reason.
- Tones: `success` for completed actions, `info` for neutral results (e.g. discarded), `warning` for saved-but-not-done-yet (e.g. offline), `error` for failures. Success/info/warning close automatically (4.5/6/8 s, paused on hover/focus); errors stay until closed.
- `key` replaces an earlier notification on the same topic instead of stacking them.
- Notifications appear bottom right so they never cover page actions.
- Not notifications: validation errors inside forms and dialogs (shown inline next to the input), and persistent states such as loading, progress or the pending-sync bar.

## Development

```sh
npm install
npm run dev
```

The dev command starts Vite on `127.0.0.1:5179` and launches the sandboxed Electron shell. Build with `npm run build`; package with `npm run dist`.

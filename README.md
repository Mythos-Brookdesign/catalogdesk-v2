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

## Appearance

General Settings provides Light and Dark modes. Selection applies immediately to the whole app and is persisted as a shared local workspace setting in SQLite (schema v4). The login screen and native window background load the saved mode before displaying the workspace. Theme updates require the Settings permission; reading only the theme is permitted before login. A failed save restores the previous mode.

## Development

```sh
npm install
npm run dev
```

The dev command starts Vite on `127.0.0.1:5179` and launches the sandboxed Electron shell. Build with `npm run build`; package with `npm run dist`.

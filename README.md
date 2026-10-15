# CatalogDesk V2

A separate product-first Electron application. V1 remains untouched and its local database and credentials are not migrated automatically.

## Architecture

- `electron/main.cjs`: trusted desktop boundary, custom `catalog:` protocol, and sender-validated IPC.
- `electron/preload.cjs`: narrow renderer API; no Node integration in the UI.
- `electron/database-worker.cjs`: serial SQLite work away from the renderer/main event loop.
- `electron/database.cjs`: V2 schema for shops, products/variants, native taxonomy relations, and product attributes.
- `src/features/products`: product workspace UI and feature types, separate from CSV parsing.
- `src/domain`: shared product invariants and future use cases.

The V2 schema models WooCommerce products and variants explicitly. Germanized and plugin-specific data remain in the original JSON payload until an adapter declares those fields. No V1 data or credentials are copied into V2.

## Development

```sh
npm install
npm run dev
```

The dev command starts Vite on `127.0.0.1:5179` and launches the sandboxed Electron shell. Build with `npm run build`; package with `npm run dist`.

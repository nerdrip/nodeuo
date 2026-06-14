// Iso math moved to apps/client/src/shared/iso.js so the admin editor
// can import the same module (the admin web server exposes the shared/
// directory at /shared/* — see apps/server/src/admin/admin-server.js).
// This file stays as a re-export shim so existing client imports keep
// working without a project-wide path change.
export * from '../shared/iso.js';

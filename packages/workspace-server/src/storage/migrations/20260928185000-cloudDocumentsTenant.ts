import type { Migration } from "../Migration.js";

export const cloudDocumentsTenantMigration: Migration = {
  id: "20260928185000-cloud-documents-tenant",
  sql: `
    UPDATE integration SET tenant = '/home/node/documents' WHERE tenant = '/home/node';
    UPDATE subject SET tenant = '/home/node/documents' WHERE tenant = '/home/node';
    UPDATE connection SET tenant = '/home/node/documents' WHERE tenant = '/home/node';
    UPDATE oauth_client SET tenant = '/home/node/documents' WHERE tenant = '/home/node';
    UPDATE oauth_session SET tenant = '/home/node/documents' WHERE tenant = '/home/node';
    UPDATE tool SET tenant = '/home/node/documents' WHERE tenant = '/home/node';
    UPDATE definition SET tenant = '/home/node/documents' WHERE tenant = '/home/node';
    UPDATE tool_policy SET tenant = '/home/node/documents' WHERE tenant = '/home/node';
    UPDATE artifact SET tenant = '/home/node/documents' WHERE tenant = '/home/node';
    UPDATE plugin_storage SET tenant = '/home/node/documents' WHERE tenant = '/home/node';
  `,
};

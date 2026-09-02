export const CRM_DATABASE_SQL = [
  `CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, phone_raw TEXT, phone_normalized TEXT,
    customer_status TEXT NOT NULL DEFAULT 'PROSPECT', province TEXT, canton TEXT, district TEXT,
    default_delivery_address TEXT, location_url TEXT, location_reference TEXT,
    latitude REAL, longitude REAL, preferred_payment_method TEXT, version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS customers_phone_normalized_unique ON customers (phone_normalized)",
  "CREATE INDEX IF NOT EXISTS customers_updated_idx ON customers (updated_at, id)",
  `CREATE TABLE IF NOT EXISTS customer_external_identities (
    id TEXT PRIMARY KEY NOT NULL, customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
    provider TEXT NOT NULL, external_account TEXT NOT NULL DEFAULT '', external_id TEXT NOT NULL,
    phone_normalized TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS customer_external_identity_unique ON customer_external_identities (provider, external_account, external_id)",
  "CREATE INDEX IF NOT EXISTS customer_external_identities_customer_idx ON customer_external_identities (customer_id, created_at)",
  "CREATE INDEX IF NOT EXISTS customer_external_identities_phone_idx ON customer_external_identities (phone_normalized)",
  `CREATE TABLE IF NOT EXISTS chatwoot_contact_links (
    id TEXT PRIMARY KEY NOT NULL, chatwoot_account_id INTEGER NOT NULL, chatwoot_contact_id INTEGER NOT NULL,
    customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT, source TEXT NOT NULL DEFAULT 'CRM',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS chatwoot_contact_link_unique ON chatwoot_contact_links (chatwoot_account_id, chatwoot_contact_id)",
  "CREATE INDEX IF NOT EXISTS chatwoot_contact_links_customer_idx ON chatwoot_contact_links (customer_id, created_at)",
  `CREATE TABLE IF NOT EXISTS chatwoot_conversation_order_links (
    id TEXT PRIMARY KEY NOT NULL, chatwoot_account_id INTEGER NOT NULL, chatwoot_conversation_id INTEGER NOT NULL,
    order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT, link_role TEXT NOT NULL DEFAULT 'RELATED',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS chatwoot_conversation_order_link_unique ON chatwoot_conversation_order_links (chatwoot_account_id, chatwoot_conversation_id, order_id, link_role)",
  "CREATE INDEX IF NOT EXISTS chatwoot_conversation_order_links_order_idx ON chatwoot_conversation_order_links (order_id, created_at)",
  "CREATE INDEX IF NOT EXISTS chatwoot_conversation_order_links_conversation_idx ON chatwoot_conversation_order_links (chatwoot_account_id, chatwoot_conversation_id)",
  `CREATE TABLE IF NOT EXISTS crm_operations (
    operation_id TEXT PRIMARY KEY NOT NULL, operation_type TEXT NOT NULL, request_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING', response_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TEXT
  )`,
] as const;

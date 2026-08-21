const stockStateSql = (prefix: "OLD" | "NEW") => `CASE
  WHEN ${prefix}.quantity_available<=0 THEN 'OUT_OF_STOCK'
  WHEN ${prefix}.minimum_stock_enabled=1 AND ${prefix}.quantity_available<=${prefix}.minimum_stock THEN 'LOW_STOCK'
  ELSE 'NORMAL'
END`;

export const NOTIFICATION_DATABASE_SQL = [
  `CREATE TABLE IF NOT EXISTS notification_events (
    id TEXT PRIMARY KEY NOT NULL,
    event_type TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    source_operation_id TEXT,
    dedupe_key TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    processing_state TEXT NOT NULL DEFAULT 'PENDING' CHECK (processing_state IN ('PENDING','MATERIALIZED','SKIPPED','FAILED')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error_code TEXT,
    occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    processed_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS notification_events_dedupe_unique ON notification_events (dedupe_key)",
  "CREATE INDEX IF NOT EXISTS notification_events_pending_idx ON notification_events (processing_state,occurred_at,id)",
  "CREATE INDEX IF NOT EXISTS notification_events_entity_idx ON notification_events (entity_type,entity_id,occurred_at)",
  `CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY NOT NULL,
    event_id TEXT NOT NULL REFERENCES notification_events(id) ON DELETE RESTRICT,
    event_type TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'INFO' CHECK (severity IN ('INFO','WARNING','CRITICAL')),
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    target_url TEXT,
    delivery_state TEXT NOT NULL DEFAULT 'IN_APP_ONLY' CHECK (delivery_state IN ('IN_APP_ONLY','PUSH_PENDING','PUSH_SENT','PUSH_PARTIAL','PUSH_FAILED')),
    dedupe_key TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    read_at TEXT,
    dismissed_at TEXT
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS notifications_event_unique ON notifications (event_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_unique ON notifications (dedupe_key)",
  "CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications (dismissed_at,read_at,created_at,id)",
  "CREATE INDEX IF NOT EXISTS notifications_entity_idx ON notifications (entity_type,entity_id,created_at)",
  `CREATE TABLE IF NOT EXISTS notification_preferences (
    id INTEGER PRIMARY KEY NOT NULL CHECK (id=1),
    principal_id TEXT,
    push_enabled INTEGER NOT NULL DEFAULT 0,
    low_stock_enabled INTEGER NOT NULL DEFAULT 1,
    out_of_stock_enabled INTEGER NOT NULL DEFAULT 1,
    orders_enabled INTEGER NOT NULL DEFAULT 1,
    special_orders_enabled INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (push_enabled IN (0,1) AND low_stock_enabled IN (0,1) AND out_of_stock_enabled IN (0,1) AND orders_enabled IN (0,1) AND special_orders_enabled IN (0,1))
  )`,
  `INSERT OR IGNORE INTO notification_preferences (
    id,principal_id,push_enabled,low_stock_enabled,out_of_stock_enabled,orders_enabled,special_orders_enabled
  ) VALUES (1,NULL,0,1,1,1,1)`,
  `CREATE TABLE IF NOT EXISTS push_subscriptions (
    id TEXT PRIMARY KEY NOT NULL,
    principal_id TEXT,
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    content_encoding TEXT NOT NULL DEFAULT 'aes128gcm' CHECK (content_encoding='aes128gcm'),
    device_label TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    disabled_at TEXT,
    disabled_reason TEXT
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_endpoint_unique ON push_subscriptions (endpoint)",
  "CREATE INDEX IF NOT EXISTS push_subscriptions_active_idx ON push_subscriptions (disabled_at,last_seen_at,id)",
  `CREATE TABLE IF NOT EXISTS notification_deliveries (
    id TEXT PRIMARY KEY NOT NULL,
    notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
    subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE RESTRICT,
    channel TEXT NOT NULL DEFAULT 'PUSH' CHECK (channel='PUSH'),
    state TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','SENT','FAILED','DISABLED')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    response_status INTEGER,
    error_code TEXT,
    last_attempt_at TEXT,
    delivered_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS notification_deliveries_target_unique ON notification_deliveries (notification_id,subscription_id,channel)",
  "CREATE INDEX IF NOT EXISTS notification_deliveries_state_idx ON notification_deliveries (state,created_at,id)",
  `CREATE TABLE IF NOT EXISTS notification_resource_states (
    id TEXT PRIMARY KEY NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    state_key TEXT NOT NULL,
    state_value TEXT NOT NULL,
    cycle INTEGER NOT NULL DEFAULT 0 CHECK (cycle>=0),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS notification_resource_states_unique ON notification_resource_states (entity_type,entity_id,state_key)",
  "CREATE INDEX IF NOT EXISTS notification_resource_states_value_idx ON notification_resource_states (entity_type,state_key,state_value,updated_at)",
  `INSERT OR IGNORE INTO notification_resource_states (
    id,entity_type,entity_id,state_key,state_value,cycle,updated_at
  ) SELECT
    'nstate-product-stock-'||id,'product',CAST(id AS TEXT),'stock',
    CASE
      WHEN quantity_available<=0 THEN 'OUT_OF_STOCK'
      WHEN minimum_stock_enabled=1 AND quantity_available<=minimum_stock THEN 'LOW_STOCK'
      ELSE 'NORMAL'
    END,
    0,COALESCE(updated_at,CURRENT_TIMESTAMP)
  FROM products`,
] as const;

const oldStockState = stockStateSql("OLD");
const newStockState = stockStateSql("NEW");

export const NOTIFICATION_DATABASE_TRIGGER_SQL = [
  `CREATE TRIGGER IF NOT EXISTS notification_product_insert_state
    AFTER INSERT ON products
    BEGIN
      INSERT OR IGNORE INTO notification_resource_states (
        id,entity_type,entity_id,state_key,state_value,cycle,updated_at
      ) VALUES (
        'nstate-product-stock-'||NEW.id,'product',CAST(NEW.id AS TEXT),'stock',
        ${newStockState},0,COALESCE(NEW.updated_at,CURRENT_TIMESTAMP)
      );
    END`,
  `CREATE TRIGGER IF NOT EXISTS notification_product_stock_transition
    AFTER UPDATE OF quantity_available,minimum_stock,minimum_stock_enabled ON products
    WHEN (${oldStockState})<>(${newStockState})
    BEGIN
      INSERT OR IGNORE INTO notification_resource_states (
        id,entity_type,entity_id,state_key,state_value,cycle,updated_at
      ) VALUES (
        'nstate-product-stock-'||NEW.id,'product',CAST(NEW.id AS TEXT),'stock',
        ${oldStockState},0,COALESCE(OLD.updated_at,CURRENT_TIMESTAMP)
      );

      UPDATE notification_resource_states SET
        state_value=${newStockState},
        cycle=cycle+CASE
          WHEN (${newStockState}) IN ('LOW_STOCK','OUT_OF_STOCK') THEN 1
          ELSE 0
        END,
        updated_at=COALESCE(NEW.updated_at,CURRENT_TIMESTAMP)
      WHERE entity_type='product' AND entity_id=CAST(NEW.id AS TEXT) AND state_key='stock';

      INSERT OR IGNORE INTO notification_events (
        id,event_type,entity_type,entity_id,source_operation_id,dedupe_key,payload_json,
        processing_state,occurred_at,created_at
      )
      SELECT
        'nevt-'||lower(hex(randomblob(16))),'inventory.low_stock','product',CAST(NEW.id AS TEXT),NULL,
        'inventory.low_stock:product:'||NEW.id||':v'||NEW.version,
        json_object('productId',NEW.id,'productName',NEW.name,'quantity',NEW.quantity_available,'minimumStock',NEW.minimum_stock),
        'PENDING',COALESCE(NEW.updated_at,CURRENT_TIMESTAMP),COALESCE(NEW.updated_at,CURRENT_TIMESTAMP)
      WHERE (${oldStockState})<>'LOW_STOCK' AND (${newStockState})='LOW_STOCK';

      INSERT OR IGNORE INTO notification_events (
        id,event_type,entity_type,entity_id,source_operation_id,dedupe_key,payload_json,
        processing_state,occurred_at,created_at
      )
      SELECT
        'nevt-'||lower(hex(randomblob(16))),'inventory.out_of_stock','product',CAST(NEW.id AS TEXT),NULL,
        'inventory.out_of_stock:product:'||NEW.id||':v'||NEW.version,
        json_object('productId',NEW.id,'productName',NEW.name,'quantity',NEW.quantity_available,'minimumStock',NEW.minimum_stock),
        'PENDING',COALESCE(NEW.updated_at,CURRENT_TIMESTAMP),COALESCE(NEW.updated_at,CURRENT_TIMESTAMP)
      WHERE (${oldStockState})<>'OUT_OF_STOCK' AND (${newStockState})='OUT_OF_STOCK';

      INSERT OR IGNORE INTO notification_events (
        id,event_type,entity_type,entity_id,source_operation_id,dedupe_key,payload_json,
        processing_state,occurred_at,created_at
      )
      SELECT
        'nevt-'||lower(hex(randomblob(16))),'inventory.back_in_stock','product',CAST(NEW.id AS TEXT),NULL,
        'inventory.back_in_stock:product:'||NEW.id||':v'||NEW.version,
        json_object('productId',NEW.id,'productName',NEW.name,'quantity',NEW.quantity_available,'minimumStock',NEW.minimum_stock),
        'PENDING',COALESCE(NEW.updated_at,CURRENT_TIMESTAMP),COALESCE(NEW.updated_at,CURRENT_TIMESTAMP)
      WHERE (${oldStockState})='OUT_OF_STOCK' AND (${newStockState})<>'OUT_OF_STOCK';
    END`,
  `CREATE TRIGGER IF NOT EXISTS notification_product_delete_state
    AFTER DELETE ON products
    BEGIN
      DELETE FROM notification_resource_states
      WHERE entity_type='product' AND entity_id=CAST(OLD.id AS TEXT) AND state_key='stock';
    END`,
  `CREATE TRIGGER IF NOT EXISTS notification_special_order_received
    AFTER UPDATE OF special_order_status ON special_order_details
    WHEN OLD.special_order_status<>NEW.special_order_status
      AND NEW.special_order_status='RECEIVED_PENDING_RESOLUTION'
    BEGIN
      INSERT OR IGNORE INTO notification_events (
        id,event_type,entity_type,entity_id,source_operation_id,dedupe_key,payload_json,
        processing_state,occurred_at,created_at
      ) SELECT
        'nevt-'||lower(hex(randomblob(16))),'special_order.received','order',NEW.order_id,NULL,
        'special_order.received:order:'||NEW.order_id||':'||COALESCE(NEW.received_at,NEW.updated_at),
        json_object(
          'orderId',NEW.order_id,
          'orderNumber',(SELECT order_number FROM orders WHERE id=NEW.order_id),
          'receivedAt',NEW.received_at
        ),
        'PENDING',COALESCE(NEW.received_at,NEW.updated_at,CURRENT_TIMESTAMP),COALESCE(NEW.updated_at,CURRENT_TIMESTAMP);
    END`,
] as const;

export const ORDER_DATABASE_SQL = [
  `CREATE TABLE IF NOT EXISTS order_number_allocations (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    order_id TEXT NOT NULL,
    allocated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS order_number_allocations_order_unique ON order_number_allocations (order_id)",
  `CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY NOT NULL,
    order_number TEXT NOT NULL,
    order_type TEXT NOT NULL DEFAULT 'STANDARD' CHECK (order_type IN ('STANDARD','SPECIAL_ORDER')),
    customer_id TEXT,
    customer_name_snapshot TEXT NOT NULL,
    phone_raw TEXT,
    phone_normalized TEXT,
    delivery_address TEXT,
    delivery_instructions TEXT,
    province TEXT,
    canton TEXT,
    district TEXT,
    latitude REAL,
    longitude REAL,
    scheduled_delivery_date TEXT,
    route_id TEXT,
    status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','CONFIRMED','PREPARED','DELIVERED','CANCELLED','REOPENED')),
    currency TEXT NOT NULL DEFAULT 'CRC' CHECK (length(trim(currency))=3),
    subtotal INTEGER NOT NULL DEFAULT 0 CHECK (subtotal>=0),
    discount_total INTEGER NOT NULL DEFAULT 0 CHECK (discount_total>=0),
    delivery_fee INTEGER NOT NULL DEFAULT 0 CHECK (delivery_fee>=0),
    total INTEGER NOT NULL DEFAULT 0 CHECK (total>=0 AND total=subtotal-discount_total+delivery_fee),
    internal_notes TEXT,
    delivery_notes TEXT,
    source TEXT NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL','WHATSAPP','INSTAGRAM_FACEBOOK','WEB','CRM','OTHER')),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version>0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    confirmed_at TEXT,
    prepared_at TEXT,
    delivered_at TEXT,
    cancelled_at TEXT,
    reopened_at TEXT
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS orders_number_unique ON orders (order_number)",
  "CREATE INDEX IF NOT EXISTS orders_delivery_date_idx ON orders (scheduled_delivery_date,id)",
  "CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status,updated_at,id)",
  "CREATE INDEX IF NOT EXISTS orders_phone_idx ON orders (phone_normalized,id)",
  "CREATE INDEX IF NOT EXISTS orders_customer_idx ON orders (customer_id,id)",
  "CREATE INDEX IF NOT EXISTS orders_route_idx ON orders (route_id,id)",
  `CREATE TABLE IF NOT EXISTS order_lines (
    id TEXT PRIMARY KEY NOT NULL,
    order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position>0),
    product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
    quantity INTEGER NOT NULL CHECK (quantity>0),
    product_name_snapshot TEXT NOT NULL,
    presentation_snapshot TEXT,
    barcode_snapshot TEXT,
    unit_price_original INTEGER,
    unit_price_sold INTEGER NOT NULL CHECK (unit_price_sold>=0),
    discount_amount INTEGER NOT NULL DEFAULT 0,
    line_subtotal INTEGER NOT NULL,
    line_total INTEGER NOT NULL,
    historical_cost_snapshot INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    removed_at TEXT,
    removed_reason TEXT,
    CHECK (unit_price_original IS NULL OR unit_price_original>=0),
    CHECK (discount_amount>=0 AND line_subtotal=quantity*unit_price_sold AND discount_amount<=line_subtotal AND line_total=line_subtotal-discount_amount)
  )`,
  "CREATE INDEX IF NOT EXISTS order_lines_order_idx ON order_lines (order_id,position,id)",
  "CREATE INDEX IF NOT EXISTS order_lines_product_idx ON order_lines (product_id,order_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS order_lines_position_unique ON order_lines (order_id,position) WHERE removed_at IS NULL",
  `CREATE TABLE IF NOT EXISTS order_operations (
    operation_id TEXT PRIMARY KEY NOT NULL,
    order_id TEXT NOT NULL,
    operation_type TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed')),
    response_json TEXT,
    guard INTEGER NOT NULL DEFAULT 1 CHECK (guard=1),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS order_operations_order_idx ON order_operations (order_id,created_at)",
  `CREATE TABLE IF NOT EXISTS order_status_events (
    id TEXT PRIMARY KEY NOT NULL,
    order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
    from_status TEXT,
    to_status TEXT NOT NULL,
    reason TEXT,
    operation_id TEXT NOT NULL,
    actor_principal TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (to_status NOT IN ('CANCELLED','REOPENED') OR length(trim(COALESCE(reason,'')))>=3)
  )`,
  "CREATE INDEX IF NOT EXISTS order_status_events_order_idx ON order_status_events (order_id,created_at,id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS order_status_events_operation_unique ON order_status_events (operation_id)",
  `CREATE TABLE IF NOT EXISTS order_events (
    id TEXT PRIMARY KEY NOT NULL,
    order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    operation_id TEXT NOT NULL,
    actor_principal TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  "CREATE INDEX IF NOT EXISTS order_events_order_idx ON order_events (order_id,created_at,id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS order_events_operation_type_unique ON order_events (operation_id,event_type)",
  `CREATE TABLE IF NOT EXISTS order_payments (
    id TEXT PRIMARY KEY NOT NULL,
    order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
    amount INTEGER NOT NULL CHECK (amount>0),
    currency TEXT NOT NULL CHECK (length(trim(currency))=3),
    method TEXT NOT NULL CHECK (method IN ('CASH','SINPE','CARD','OTHER')),
    payment_type TEXT NOT NULL DEFAULT 'PAYMENT' CHECK (payment_type IN ('PAYMENT','REVERSAL','REFUND','VOID')),
    status TEXT NOT NULL DEFAULT 'POSTED' CHECK (status='POSTED'),
    reference TEXT,
    reverses_payment_id TEXT,
    reason TEXT,
    operation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK ((payment_type='PAYMENT' AND reverses_payment_id IS NULL) OR (payment_type<>'PAYMENT' AND reverses_payment_id IS NOT NULL AND length(trim(COALESCE(reason,'')))>=3))
  )`,
  "CREATE INDEX IF NOT EXISTS order_payments_order_idx ON order_payments (order_id,created_at,id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS order_payments_operation_unique ON order_payments (operation_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS order_payments_reversal_unique ON order_payments (reverses_payment_id)",
  `CREATE TABLE IF NOT EXISTS order_external_references (
    id TEXT PRIMARY KEY NOT NULL,
    order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    reference_type TEXT NOT NULL,
    external_id TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  "CREATE INDEX IF NOT EXISTS order_external_references_order_idx ON order_external_references (order_id,provider)",
  "CREATE UNIQUE INDEX IF NOT EXISTS order_external_references_external_unique ON order_external_references (provider,reference_type,external_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS order_external_references_order_unique ON order_external_references (order_id,provider,reference_type)",
  `CREATE TABLE IF NOT EXISTS delivery_routes (
    id TEXT PRIMARY KEY NOT NULL,
    route_date TEXT NOT NULL,
    label TEXT,
    status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    closed_at TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS delivery_routes_date_idx ON delivery_routes (route_date,status,id)",
  `CREATE TABLE IF NOT EXISTS route_orders (
    id TEXT PRIMARY KEY NOT NULL,
    route_id TEXT NOT NULL REFERENCES delivery_routes(id) ON DELETE CASCADE,
    order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
    position INTEGER NOT NULL CHECK (position>0),
    assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    removed_at TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS route_orders_route_idx ON route_orders (route_id,position,id)",
  "CREATE INDEX IF NOT EXISTS route_orders_order_idx ON route_orders (order_id,removed_at)",
  "CREATE UNIQUE INDEX IF NOT EXISTS route_orders_position_unique ON route_orders (route_id,position) WHERE removed_at IS NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS route_orders_active_order_unique ON route_orders (order_id) WHERE removed_at IS NULL",
  `CREATE TABLE IF NOT EXISTS order_returns (
    id TEXT PRIMARY KEY NOT NULL,
    order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
    reason TEXT NOT NULL CHECK (length(trim(reason))>=3),
    status TEXT NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('COMPLETED','REVERSED')),
    operation_id TEXT NOT NULL,
    actor_principal TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  "CREATE INDEX IF NOT EXISTS order_returns_order_idx ON order_returns (order_id,created_at,id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS order_returns_operation_unique ON order_returns (operation_id)",
  `CREATE TABLE IF NOT EXISTS order_return_lines (
    id TEXT PRIMARY KEY NOT NULL,
    return_id TEXT NOT NULL REFERENCES order_returns(id) ON DELETE CASCADE,
    order_line_id TEXT NOT NULL REFERENCES order_lines(id) ON DELETE RESTRICT,
    quantity INTEGER NOT NULL CHECK (quantity>0),
    reenter_inventory INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  "CREATE INDEX IF NOT EXISTS order_return_lines_return_idx ON order_return_lines (return_id,id)",
  "CREATE INDEX IF NOT EXISTS order_return_lines_order_line_idx ON order_return_lines (order_line_id,id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS order_return_lines_unique ON order_return_lines (return_id,order_line_id)",
  `CREATE TABLE IF NOT EXISTS order_fulfillments (
    id TEXT PRIMARY KEY NOT NULL,
    order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'DELIVERED' CHECK (status IN ('PARTIAL','DELIVERED')),
    operation_id TEXT NOT NULL,
    delivered_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS order_fulfillments_order_idx ON order_fulfillments (order_id,delivered_at,id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS order_fulfillments_operation_unique ON order_fulfillments (operation_id)",
  `CREATE TABLE IF NOT EXISTS order_fulfillment_lines (
    id TEXT PRIMARY KEY NOT NULL,
    fulfillment_id TEXT NOT NULL REFERENCES order_fulfillments(id) ON DELETE CASCADE,
    order_line_id TEXT NOT NULL REFERENCES order_lines(id) ON DELETE RESTRICT,
    quantity INTEGER NOT NULL CHECK (quantity>0)
  )`,
  "CREATE INDEX IF NOT EXISTS order_fulfillment_lines_fulfillment_idx ON order_fulfillment_lines (fulfillment_id,id)",
  "CREATE INDEX IF NOT EXISTS order_fulfillment_lines_order_line_idx ON order_fulfillment_lines (order_line_id,id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS order_fulfillment_lines_unique ON order_fulfillment_lines (fulfillment_id,order_line_id)",
  "CREATE INDEX IF NOT EXISTS inventory_movements_order_idx ON inventory_movements (order_id,order_line_id,created_at)",
  "CREATE UNIQUE INDEX IF NOT EXISTS inventory_movements_order_operation_line_unique ON inventory_movements (operation_id,order_line_id,movement_type) WHERE order_line_id IS NOT NULL",
] as const;

export const ORDER_DATABASE_TRIGGER_SQL = [
  `CREATE TRIGGER IF NOT EXISTS orders_status_transition_guard
    BEFORE UPDATE OF status ON orders WHEN OLD.status<>NEW.status
    BEGIN
      SELECT CASE WHEN NOT (
        (OLD.status='DRAFT' AND NEW.status IN ('CONFIRMED','CANCELLED')) OR
        (OLD.status='CONFIRMED' AND NEW.status IN ('PREPARED','CANCELLED')) OR
        (OLD.status='PREPARED' AND NEW.status IN ('DELIVERED','CANCELLED')) OR
        (OLD.status='DELIVERED' AND NEW.status='REOPENED') OR
        (OLD.status='REOPENED' AND NEW.status='CONFIRMED')
      ) THEN RAISE(ABORT,'ORDER_INVALID_TRANSITION') END;
    END`,
  `CREATE TRIGGER IF NOT EXISTS orders_number_immutable
    BEFORE UPDATE OF order_number ON orders WHEN OLD.order_number<>NEW.order_number
    BEGIN SELECT RAISE(ABORT,'ORDER_NUMBER_IMMUTABLE'); END`,
  `CREATE TRIGGER IF NOT EXISTS orders_hard_delete_guard
    BEFORE DELETE ON orders WHEN OLD.status<>'DRAFT'
    BEGIN SELECT RAISE(ABORT,'ORDER_HARD_DELETE_FORBIDDEN'); END`,
  `CREATE TRIGGER IF NOT EXISTS order_lines_hard_delete_guard
    BEFORE DELETE ON order_lines
    WHEN EXISTS (SELECT 1 FROM orders WHERE id=OLD.order_id AND status<>'DRAFT')
    BEGIN SELECT RAISE(ABORT,'ORDER_LINE_HARD_DELETE_FORBIDDEN'); END`,
  `CREATE TRIGGER IF NOT EXISTS order_status_events_no_update
    BEFORE UPDATE ON order_status_events
    BEGIN SELECT RAISE(ABORT,'ORDER_STATUS_EVENT_APPEND_ONLY'); END`,
  `CREATE TRIGGER IF NOT EXISTS order_status_events_no_delete
    BEFORE DELETE ON order_status_events
    WHEN EXISTS (SELECT 1 FROM orders WHERE id=OLD.order_id AND status<>'DRAFT')
    BEGIN SELECT RAISE(ABORT,'ORDER_STATUS_EVENT_APPEND_ONLY'); END`,
  `CREATE TRIGGER IF NOT EXISTS order_events_no_update
    BEFORE UPDATE ON order_events
    BEGIN SELECT RAISE(ABORT,'ORDER_EVENT_APPEND_ONLY'); END`,
  `CREATE TRIGGER IF NOT EXISTS order_events_no_delete
    BEFORE DELETE ON order_events
    WHEN EXISTS (SELECT 1 FROM orders WHERE id=OLD.order_id AND status<>'DRAFT')
    BEGIN SELECT RAISE(ABORT,'ORDER_EVENT_APPEND_ONLY'); END`,
  `CREATE TRIGGER IF NOT EXISTS order_payments_no_update
    BEFORE UPDATE ON order_payments
    BEGIN SELECT RAISE(ABORT,'ORDER_PAYMENT_APPEND_ONLY'); END`,
  `CREATE TRIGGER IF NOT EXISTS order_payments_no_delete
    BEFORE DELETE ON order_payments
    BEGIN SELECT RAISE(ABORT,'ORDER_PAYMENT_APPEND_ONLY'); END`,
  `CREATE TRIGGER IF NOT EXISTS inventory_movements_order_apply
    BEFORE INSERT ON inventory_movements WHEN NEW.order_line_id IS NOT NULL
    BEGIN
      SELECT CASE WHEN NEW.order_id IS NULL OR NEW.movement_type IS NULL
        THEN RAISE(ABORT,'ORDER_MOVEMENT_REFERENCE_REQUIRED') END;
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM order_lines l WHERE l.id=NEW.order_line_id AND l.order_id=NEW.order_id
          AND l.product_id=NEW.product_id
      ) THEN RAISE(ABORT,'ORDER_MOVEMENT_REFERENCE_INVALID') END;
      SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM products WHERE id=NEW.product_id)
        THEN RAISE(ABORT,'ORDER_PRODUCT_NOT_FOUND') END;
      SELECT CASE WHEN NEW.previous_quantity<>(SELECT quantity_available FROM products WHERE id=NEW.product_id)
        THEN RAISE(ABORT,'ORDER_STALE_STOCK') END;
      SELECT CASE WHEN NEW.resulting_quantity<>NEW.previous_quantity+NEW.quantity_change
        THEN RAISE(ABORT,'ORDER_MOVEMENT_TOTAL_INVALID') END;
      SELECT CASE WHEN NEW.resulting_quantity<0
        THEN RAISE(ABORT,'ORDER_INSUFFICIENT_STOCK') END;
      UPDATE products SET
        quantity_available=NEW.resulting_quantity,
        zero_stock_since=CASE WHEN NEW.resulting_quantity=0 THEN COALESCE(zero_stock_since,NEW.created_at) ELSE NULL END,
        restock_purchased_at=CASE WHEN NEW.resulting_quantity>0 AND (minimum_stock_enabled=0 OR NEW.resulting_quantity>minimum_stock) THEN NULL ELSE restock_purchased_at END,
        version=version+1,
        updated_at=NEW.created_at
      WHERE id=NEW.product_id;
    END`,
] as const;

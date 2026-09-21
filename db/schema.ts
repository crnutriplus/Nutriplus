import { sql } from "drizzle-orm";
import { check, index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey(),
  exchangeRateCrc: integer("exchange_rate_crc").notNull().default(520),
  courierRateUsdCents: integer("courier_rate_usd_cents").notNull().default(550),
  extraWeightMilliLb: integer("extra_weight_milli_lb").notNull().default(100),
  deliveryCrc: integer("delivery_crc").notNull().default(1000),
  correosCrc: integer("correos_crc").notNull().default(500),
  gamProfitCrc: integer("gam_profit_crc").notNull().default(5000),
  puertoProfitCrc: integer("puerto_profit_crc").notNull().default(4000),
  roundingCrc: integer("rounding_crc").notNull().default(100),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const products = sqliteTable("products", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  normalizedName: text("normalized_name").notNull(),
  code: text("code"),
  brand: text("brand"),
  presentation: text("presentation"),
  purchasePriceUsdCents: integer("purchase_price_usd_cents"),
  weightMilliLb: integer("weight_milli_lb"),
  quantityAvailable: integer("quantity_available").notNull().default(0),
  minimumStock: integer("minimum_stock").notNull().default(0),
  minimumStockEnabled: integer("minimum_stock_enabled", { mode: "boolean" }).notNull().default(false),
  restockPurchasedAt: text("restock_purchased_at"),
  zeroStockSince: text("zero_stock_since"),
  version: integer("version").notNull().default(1),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("products_normalized_name_unique").on(table.normalizedName),
  uniqueIndex("products_code_unique").on(table.code),
]);

export const nonInventoryQuotes = sqliteTable("non_inventory_quotes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  code: text("code"),
  purchasePriceUsdCents: integer("purchase_price_usd_cents"),
  weightMilliLb: integer("weight_milli_lb"),
  version: integer("version").notNull().default(1),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("non_inventory_quotes_updated_idx").on(table.updatedAt, table.id)]);

export const mutationReceipts = sqliteTable("mutation_receipts", {
  id: text("id").primaryKey(),
  status: text("status").notNull().default("pending"),
  responseJson: text("response_json"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  completedAt: text("completed_at"),
});

export const inventoryDocuments = sqliteTable("inventory_documents", {
  id: text("id").primaryKey(),
  fileFingerprint: text("file_fingerprint").notNull(),
  fileName: text("file_name").notNull(),
  mimeTypesJson: text("mime_types_json").notNull().default("[]"),
  provider: text("provider").notNull().default("other"),
  orderNumber: text("order_number"),
  invoiceNumber: text("invoice_number"),
  shipmentNumber: text("shipment_number"),
  documentDate: text("document_date"),
  pageCount: integer("page_count").notNull().default(1),
  fileCount: integer("file_count").notNull().default(0),
  processingMode: text("processing_mode").notNull().default("manual"),
  analysisStatus: text("analysis_status").notNull().default("not_requested"),
  activeAnalysisId: text("active_analysis_id"),
  fieldEvidenceJson: text("field_evidence_json").notNull().default("{}"),
  status: text("status").notNull().default("draft"),
  warningsJson: text("warnings_json").notNull().default("[]"),
  duplicateOf: text("duplicate_of"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  confirmedAt: text("confirmed_at"),
  confirmedBy: text("confirmed_by"),
}, (table) => [
  uniqueIndex("inventory_documents_fingerprint_unique").on(table.fileFingerprint),
  index("inventory_documents_history_idx").on(table.createdAt, table.id),
  index("inventory_documents_order_idx").on(table.provider, table.orderNumber, table.shipmentNumber),
]);

export const inventoryDocumentLines = sqliteTable("inventory_document_lines", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull(),
  lineKey: text("line_key").notNull(),
  lineIndex: integer("line_index").notNull().default(0),
  pageNumber: integer("page_number"),
  originalDescription: text("original_description").notNull(),
  name: text("name").notNull(),
  brand: text("brand"),
  presentation: text("presentation"),
  size: text("size"),
  flavor: text("flavor"),
  concentration: text("concentration"),
  billedQuantity: integer("billed_quantity"),
  receivedQuantity: integer("received_quantity"),
  unitsPerPackage: integer("units_per_package").notNull().default(1),
  totalToAdd: integer("total_to_add").notNull().default(0),
  barcode: text("barcode"),
  canonicalBarcode: text("canonical_barcode"),
  barcodeType: text("barcode_type"),
  secondaryId: text("secondary_id"),
  secondaryType: text("secondary_type"),
  barcodeMethod: text("barcode_method"),
  barcodeSource: text("barcode_source"),
  barcodeSourceUrl: text("barcode_source_url"),
  barcodeSourceTitle: text("barcode_source_title"),
  barcodeDifferencesJson: text("barcode_differences_json").notNull().default("[]"),
  barcodeLookupStatus: text("barcode_lookup_status").notNull().default("pending"),
  fieldEvidenceJson: text("field_evidence_json").notNull().default("{}"),
  barcodeConfirmed: integer("barcode_confirmed").notNull().default(0),
  selectedForIngress: integer("selected_for_ingress").notNull().default(1),
  reviewSavedAt: text("review_saved_at"),
  confidence: integer("confidence").notNull().default(0),
  status: text("status").notNull().default("requires_confirm_code"),
  matchProductId: integer("match_product_id"),
  matchNonInventoryId: integer("match_non_inventory_id"),
  action: text("action").notNull().default("pending"),
  barcodeLevel: text("barcode_level"),
  warningsJson: text("warnings_json").notNull().default("[]"),
  processedOperationId: text("processed_operation_id"),
  ignoredReason: text("ignored_reason"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("inventory_document_lines_key_unique").on(table.documentId, table.lineKey),
  index("inventory_document_lines_document_idx").on(table.documentId, table.status, table.id),
  index("inventory_document_lines_barcode_idx").on(table.canonicalBarcode),
]);

export const inventoryDocumentFiles = sqliteTable("inventory_document_files", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull(),
  fileIndex: integer("file_index").notNull(),
  storageKey: text("storage_key").notNull(),
  fileName: text("file_name").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  fileSha256: text("file_sha256").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("inventory_document_files_order_unique").on(table.documentId, table.fileIndex),
  uniqueIndex("inventory_document_files_storage_unique").on(table.storageKey),
  index("inventory_document_files_document_idx").on(table.documentId, table.fileIndex),
]);

export const invoiceAiAnalyses = sqliteTable("invoice_ai_analyses", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull(),
  fileFingerprint: text("file_fingerprint").notNull(),
  analysisNumber: integer("analysis_number").notNull(),
  model: text("model").notNull(),
  analysisOrigin: text("analysis_origin").notNull().default("OPENAI_API"),
  apiCalls: integer("api_calls").notNull().default(1),
  status: text("status").notNull().default("processing"),
  responseId: text("response_id"),
  inputTokens: integer("input_tokens").notNull().default(0),
  cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  webSearchCount: integer("web_search_count").notNull().default(0),
  estimatedCostMicrousd: integer("estimated_cost_microusd").notNull().default(0),
  apiCostMicrousd: integer("api_cost_microusd").notNull().default(0),
  extractionJson: text("extraction_json").notNull().default("{}"),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  reanalysis: integer("reanalysis", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  completedAt: text("completed_at"),
}, (table) => [
  uniqueIndex("invoice_ai_analyses_number_unique").on(table.documentId, table.analysisNumber),
  index("invoice_ai_analyses_document_idx").on(table.documentId, table.createdAt),
  index("invoice_ai_analyses_usage_idx").on(table.createdAt, table.estimatedCostMicrousd),
]);

export const supplierProductAliases = sqliteTable("supplier_product_aliases", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  provider: text("provider").notNull(),
  secondaryType: text("secondary_type").notNull(),
  secondaryId: text("secondary_id").notNull(),
  barcode: text("barcode").notNull(),
  canonicalBarcode: text("canonical_barcode").notNull(),
  productId: integer("product_id").notNull(),
  descriptionSignature: text("description_signature").notNull(),
  presentationSignature: text("presentation_signature"),
  unitsPerPackage: integer("units_per_package").notNull().default(1),
  barcodeLevel: text("barcode_level").notNull().default("unit"),
  source: text("source"),
  confirmedAt: text("confirmed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  confirmedBy: text("confirmed_by"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("supplier_product_aliases_identity_unique").on(table.provider, table.secondaryType, table.secondaryId),
  index("supplier_product_aliases_barcode_idx").on(table.canonicalBarcode, table.productId),
]);

export const orderNumberAllocations = sqliteTable("order_number_allocations", {
  sequence: integer("sequence").primaryKey({ autoIncrement: true }),
  orderId: text("order_id").notNull(),
  allocatedAt: text("allocated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("order_number_allocations_order_unique").on(table.orderId)]);

export const orders = sqliteTable("orders", {
  id: text("id").primaryKey(),
  orderNumber: text("order_number").notNull(),
  orderType: text("order_type").notNull().default("STANDARD"),
  customerId: text("customer_id"),
  customerNameSnapshot: text("customer_name_snapshot").notNull(),
  phoneRaw: text("phone_raw"),
  phoneNormalized: text("phone_normalized"),
  deliveryAddress: text("delivery_address"),
  deliveryInstructions: text("delivery_instructions"),
  province: text("province"),
  canton: text("canton"),
  district: text("district"),
  latitude: real("latitude"),
  longitude: real("longitude"),
  scheduledDeliveryDate: text("scheduled_delivery_date"),
  routeId: text("route_id"),
  status: text("status").notNull().default("DRAFT"),
  currency: text("currency").notNull().default("CRC"),
  subtotal: integer("subtotal").notNull().default(0),
  discountTotal: integer("discount_total").notNull().default(0),
  deliveryFee: integer("delivery_fee").notNull().default(0),
  total: integer("total").notNull().default(0),
  expectedPaymentMethod: text("expected_payment_method"),
  internalNotes: text("internal_notes"),
  deliveryNotes: text("delivery_notes"),
  source: text("source").notNull().default("MANUAL"),
  version: integer("version").notNull().default(1),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  confirmedAt: text("confirmed_at"),
  preparedAt: text("prepared_at"),
  deliveredAt: text("delivered_at"),
  cancelledAt: text("cancelled_at"),
  reopenedAt: text("reopened_at"),
}, (table) => [
  uniqueIndex("orders_number_unique").on(table.orderNumber),
  index("orders_delivery_date_idx").on(table.scheduledDeliveryDate, table.id),
  index("orders_status_idx").on(table.status, table.updatedAt, table.id),
  index("orders_phone_idx").on(table.phoneNormalized, table.id),
  index("orders_customer_idx").on(table.customerId, table.id),
  index("orders_route_idx").on(table.routeId, table.id),
  check("orders_type_check", sql`${table.orderType} IN ('STANDARD','SPECIAL_ORDER')`),
  check("orders_status_check", sql`${table.status} IN ('DRAFT','CONFIRMED','PREPARED','DELIVERED','CANCELLED','REOPENED')`),
  check("orders_currency_check", sql`length(trim(${table.currency})) = 3`),
  check("orders_source_check", sql`${table.source} IN ('MANUAL','WHATSAPP','INSTAGRAM_FACEBOOK','WEB','CRM','OTHER')`),
  check("orders_expected_payment_method_check", sql`${table.expectedPaymentMethod} IS NULL OR ${table.expectedPaymentMethod} IN ('CASH','SINPE','CARD','OTHER')`),
  check("orders_money_check", sql`${table.subtotal} >= 0 AND ${table.discountTotal} >= 0 AND ${table.deliveryFee} >= 0 AND ${table.total} >= 0`),
  check("orders_total_check", sql`${table.total} = ${table.subtotal} - ${table.discountTotal} + ${table.deliveryFee}`),
  check("orders_version_check", sql`${table.version} > 0`),
]);

export const orderLines = sqliteTable("order_lines", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  productId: integer("product_id").references(() => products.id, { onDelete: "set null" }),
  quantity: integer("quantity").notNull(),
  productNameSnapshot: text("product_name_snapshot").notNull(),
  presentationSnapshot: text("presentation_snapshot"),
  barcodeSnapshot: text("barcode_snapshot"),
  unitPriceOriginal: integer("unit_price_original"),
  unitPriceSold: integer("unit_price_sold").notNull(),
  discountAmount: integer("discount_amount").notNull().default(0),
  lineSubtotal: integer("line_subtotal").notNull(),
  lineTotal: integer("line_total").notNull(),
  historicalCostSnapshot: integer("historical_cost_snapshot"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  removedAt: text("removed_at"),
  removedReason: text("removed_reason"),
}, (table) => [
  index("order_lines_order_idx").on(table.orderId, table.position, table.id),
  index("order_lines_product_idx").on(table.productId, table.orderId),
  uniqueIndex("order_lines_position_unique").on(table.orderId, table.position).where(sql`${table.removedAt} IS NULL`),
  check("order_lines_quantity_check", sql`${table.quantity} > 0`),
  check("order_lines_position_check", sql`${table.position} > 0`),
  check("order_lines_money_check", sql`${table.unitPriceSold} >= 0 AND ${table.discountAmount} >= 0 AND ${table.lineSubtotal} >= 0 AND ${table.lineTotal} >= 0`),
  check("order_lines_totals_check", sql`${table.lineSubtotal} = ${table.quantity} * ${table.unitPriceSold} AND ${table.discountAmount} <= ${table.lineSubtotal} AND ${table.lineTotal} = ${table.lineSubtotal} - ${table.discountAmount}`),
]);

export const specialOrderDetails = sqliteTable("special_order_details", {
  orderId: text("order_id").primaryKey().references(() => orders.id, { onDelete: "cascade" }),
  specialOrderStatus: text("special_order_status").notNull().default("REQUESTED"),
  requestedAt: text("requested_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  orderedAt: text("ordered_at"),
  estimatedArrivalDate: text("estimated_arrival_date"),
  receivedAt: text("received_at"),
  receiptResolvedAt: text("receipt_resolved_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("special_order_details_status_idx").on(table.specialOrderStatus, table.updatedAt, table.orderId),
  index("special_order_details_estimated_idx").on(table.estimatedArrivalDate, table.orderId),
  check("special_order_details_status_check", sql`${table.specialOrderStatus} IN (
    'REQUESTED','ORDERED_FROM_SUPPLIER','IN_TRANSIT','RECEIVED_PENDING_RESOLUTION',
    'PARTIALLY_RECEIVED','RECEIVED_READY','ADDED_TO_ROUTE','DELIVERED','CANCELLED'
  )`),
]);

export const specialOrderReceipts = sqliteTable("special_order_receipts", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull().references(() => orders.id, { onDelete: "restrict" }),
  resolutionMode: text("resolution_mode").notNull(),
  operationId: text("operation_id").notNull(),
  resolvedAt: text("resolved_at").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("special_order_receipts_order_idx").on(table.orderId, table.resolvedAt, table.id),
  uniqueIndex("special_order_receipts_operation_unique").on(table.operationId),
  check("special_order_receipts_mode_check", sql`${table.resolutionMode} IN ('INVENTORY_NOW','ALREADY_INVENTORY')`),
]);

export const specialOrderReceiptLines = sqliteTable("special_order_receipt_lines", {
  id: text("id").primaryKey(),
  receiptId: text("receipt_id").notNull().references(() => specialOrderReceipts.id, { onDelete: "cascade" }),
  orderLineId: text("order_line_id").notNull().references(() => orderLines.id, { onDelete: "restrict" }),
  productId: integer("product_id").notNull().references(() => products.id, { onDelete: "restrict" }),
  quantityReceived: integer("quantity_received").notNull(),
  inventoryMovementCreated: integer("inventory_movement_created", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("special_order_receipt_lines_receipt_idx").on(table.receiptId, table.id),
  index("special_order_receipt_lines_order_line_idx").on(table.orderLineId, table.createdAt, table.id),
  uniqueIndex("special_order_receipt_lines_unique").on(table.receiptId, table.orderLineId),
  check("special_order_receipt_lines_quantity_check", sql`${table.quantityReceived} > 0`),
  check("special_order_receipt_lines_movement_check", sql`${table.inventoryMovementCreated} IN (0,1)`),
]);

export const orderOperations = sqliteTable("order_operations", {
  operationId: text("operation_id").primaryKey(),
  orderId: text("order_id").notNull(),
  operationType: text("operation_type").notNull(),
  requestHash: text("request_hash").notNull(),
  status: text("status").notNull().default("pending"),
  responseJson: text("response_json"),
  guard: integer("guard").notNull().default(1),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  completedAt: text("completed_at"),
}, (table) => [
  index("order_operations_order_idx").on(table.orderId, table.createdAt),
  check("order_operations_status_check", sql`${table.status} IN ('pending','completed')`),
  check("order_operations_guard_check", sql`${table.guard} = 1`),
]);

export const orderStatusEvents = sqliteTable("order_status_events", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull().references(() => orders.id, { onDelete: "restrict" }),
  fromStatus: text("from_status"),
  toStatus: text("to_status").notNull(),
  reason: text("reason"),
  operationId: text("operation_id").notNull(),
  actorPrincipal: text("actor_principal"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("order_status_events_order_idx").on(table.orderId, table.createdAt, table.id),
  uniqueIndex("order_status_events_operation_unique").on(table.operationId),
  check("order_status_events_reason_check", sql`${table.toStatus} NOT IN ('CANCELLED','REOPENED') OR length(trim(COALESCE(${table.reason},''))) >= 3`),
]);

export const orderEvents = sqliteTable("order_events", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull().references(() => orders.id, { onDelete: "restrict" }),
  eventType: text("event_type").notNull(),
  payloadJson: text("payload_json").notNull().default("{}"),
  operationId: text("operation_id").notNull(),
  actorPrincipal: text("actor_principal"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("order_events_order_idx").on(table.orderId, table.createdAt, table.id),
  uniqueIndex("order_events_operation_type_unique").on(table.operationId, table.eventType),
]);

export const orderPayments = sqliteTable("order_payments", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull().references(() => orders.id, { onDelete: "restrict" }),
  amount: integer("amount").notNull(),
  currency: text("currency").notNull(),
  method: text("method").notNull(),
  paymentType: text("payment_type").notNull().default("PAYMENT"),
  status: text("status").notNull().default("POSTED"),
  reference: text("reference"),
  reversesPaymentId: text("reverses_payment_id"),
  reason: text("reason"),
  operationId: text("operation_id").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("order_payments_order_idx").on(table.orderId, table.createdAt, table.id),
  uniqueIndex("order_payments_operation_unique").on(table.operationId),
  uniqueIndex("order_payments_reversal_unique").on(table.reversesPaymentId),
  check("order_payments_amount_check", sql`${table.amount} > 0`),
  check("order_payments_currency_check", sql`length(trim(${table.currency})) = 3`),
  check("order_payments_method_check", sql`${table.method} IN ('CASH','SINPE','CARD','OTHER')`),
  check("order_payments_type_check", sql`${table.paymentType} IN ('PAYMENT','REVERSAL','REFUND','VOID')`),
  check("order_payments_status_check", sql`${table.status} = 'POSTED'`),
  check("order_payments_reversal_check", sql`(${table.paymentType} = 'PAYMENT' AND ${table.reversesPaymentId} IS NULL) OR (${table.paymentType} <> 'PAYMENT' AND ${table.reversesPaymentId} IS NOT NULL AND length(trim(COALESCE(${table.reason},''))) >= 3)`),
]);

export const orderExternalReferences = sqliteTable("order_external_references", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  referenceType: text("reference_type").notNull(),
  externalId: text("external_id").notNull(),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("order_external_references_order_idx").on(table.orderId, table.provider),
  uniqueIndex("order_external_references_external_unique").on(table.provider, table.referenceType, table.externalId),
  uniqueIndex("order_external_references_order_unique").on(table.orderId, table.provider, table.referenceType),
]);

export const deliveryRoutes = sqliteTable("delivery_routes", {
  id: text("id").primaryKey(),
  routeDate: text("route_date").notNull(),
  label: text("label"),
  status: text("status").notNull().default("OPEN"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  closedAt: text("closed_at"),
}, (table) => [
  index("delivery_routes_date_idx").on(table.routeDate, table.status, table.id),
  check("delivery_routes_status_check", sql`${table.status} IN ('OPEN','CLOSED')`),
]);

export const routeOrders = sqliteTable("route_orders", {
  id: text("id").primaryKey(),
  routeId: text("route_id").notNull().references(() => deliveryRoutes.id, { onDelete: "cascade" }),
  orderId: text("order_id").notNull().references(() => orders.id, { onDelete: "restrict" }),
  position: integer("position").notNull(),
  assignedAt: text("assigned_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  removedAt: text("removed_at"),
}, (table) => [
  index("route_orders_route_idx").on(table.routeId, table.position, table.id),
  index("route_orders_order_idx").on(table.orderId, table.removedAt),
  uniqueIndex("route_orders_position_unique").on(table.routeId, table.position).where(sql`${table.removedAt} IS NULL`),
  uniqueIndex("route_orders_active_order_unique").on(table.orderId).where(sql`${table.removedAt} IS NULL`),
  check("route_orders_position_check", sql`${table.position} > 0`),
]);

export const orderReturns = sqliteTable("order_returns", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull().references(() => orders.id, { onDelete: "restrict" }),
  reason: text("reason").notNull(),
  status: text("status").notNull().default("COMPLETED"),
  operationId: text("operation_id").notNull(),
  actorPrincipal: text("actor_principal"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("order_returns_order_idx").on(table.orderId, table.createdAt, table.id),
  uniqueIndex("order_returns_operation_unique").on(table.operationId),
  check("order_returns_status_check", sql`${table.status} IN ('COMPLETED','REVERSED')`),
  check("order_returns_reason_check", sql`length(trim(${table.reason})) >= 3`),
]);

export const orderReturnLines = sqliteTable("order_return_lines", {
  id: text("id").primaryKey(),
  returnId: text("return_id").notNull().references(() => orderReturns.id, { onDelete: "cascade" }),
  orderLineId: text("order_line_id").notNull().references(() => orderLines.id, { onDelete: "restrict" }),
  quantity: integer("quantity").notNull(),
  reenterInventory: integer("reenter_inventory", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("order_return_lines_return_idx").on(table.returnId, table.id),
  index("order_return_lines_order_line_idx").on(table.orderLineId, table.id),
  uniqueIndex("order_return_lines_unique").on(table.returnId, table.orderLineId),
  check("order_return_lines_quantity_check", sql`${table.quantity} > 0`),
]);

export const orderFulfillments = sqliteTable("order_fulfillments", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull().references(() => orders.id, { onDelete: "restrict" }),
  status: text("status").notNull().default("DELIVERED"),
  operationId: text("operation_id").notNull(),
  deliveredAt: text("delivered_at").notNull(),
}, (table) => [
  index("order_fulfillments_order_idx").on(table.orderId, table.deliveredAt, table.id),
  uniqueIndex("order_fulfillments_operation_unique").on(table.operationId),
  check("order_fulfillments_status_check", sql`${table.status} IN ('PARTIAL','DELIVERED')`),
]);

export const orderFulfillmentLines = sqliteTable("order_fulfillment_lines", {
  id: text("id").primaryKey(),
  fulfillmentId: text("fulfillment_id").notNull().references(() => orderFulfillments.id, { onDelete: "cascade" }),
  orderLineId: text("order_line_id").notNull().references(() => orderLines.id, { onDelete: "restrict" }),
  quantity: integer("quantity").notNull(),
}, (table) => [
  index("order_fulfillment_lines_fulfillment_idx").on(table.fulfillmentId, table.id),
  index("order_fulfillment_lines_order_line_idx").on(table.orderLineId, table.id),
  uniqueIndex("order_fulfillment_lines_unique").on(table.fulfillmentId, table.orderLineId),
  check("order_fulfillment_lines_quantity_check", sql`${table.quantity} > 0`),
]);

export const financeSales = sqliteTable("finance_sales", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull().references(() => orders.id, { onDelete: "restrict" }),
  orderNumber: text("order_number").notNull(),
  customerNameSnapshot: text("customer_name_snapshot").notNull(),
  deliveredAt: text("delivered_at").notNull(),
  routeId: text("route_id"),
  currency: text("currency").notNull().default("CRC"),
  productGrossTotal: integer("product_gross_total").notNull(),
  discountTotal: integer("discount_total").notNull().default(0),
  productNetTotal: integer("product_net_total").notNull(),
  deliveryIncome: integer("delivery_income").notNull().default(0),
  totalIncome: integer("total_income").notNull(),
  historicalCogsTotal: integer("historical_cogs_total"),
  costStatus: text("cost_status").notNull().default("MISSING"),
  sourceOperationId: text("source_operation_id").notNull(),
  status: text("status").notNull().default("RECOGNIZED"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  reversedAt: text("reversed_at"),
}, (table) => [
  uniqueIndex("finance_sales_source_operation_unique").on(table.sourceOperationId),
  uniqueIndex("finance_sales_active_order_unique").on(table.orderId).where(sql`${table.status} = 'RECOGNIZED'`),
  index("finance_sales_delivered_idx").on(table.deliveredAt, table.id),
  index("finance_sales_route_idx").on(table.routeId, table.deliveredAt, table.id),
  check("finance_sales_status_check", sql`${table.status} IN ('RECOGNIZED','REVERSED')`),
  check("finance_sales_cost_status_check", sql`${table.costStatus} IN ('COMPLETE','MISSING')`),
  check("finance_sales_money_check", sql`${table.productGrossTotal} >= 0 AND ${table.discountTotal} >= 0 AND ${table.productNetTotal} >= 0 AND ${table.deliveryIncome} >= 0 AND ${table.totalIncome} >= 0 AND (${table.historicalCogsTotal} IS NULL OR ${table.historicalCogsTotal} >= 0)`),
]);

export const financeSaleLines = sqliteTable("finance_sale_lines", {
  id: text("id").primaryKey(),
  saleId: text("sale_id").notNull().references(() => financeSales.id, { onDelete: "restrict" }),
  orderLineId: text("order_line_id").notNull().references(() => orderLines.id, { onDelete: "restrict" }),
  productId: integer("product_id"),
  productNameSnapshot: text("product_name_snapshot").notNull(),
  quantity: integer("quantity").notNull(),
  unitPriceReal: integer("unit_price_real").notNull(),
  grossIncome: integer("gross_income").notNull(),
  allocatedDiscount: integer("allocated_discount").notNull().default(0),
  netIncome: integer("net_income").notNull(),
  historicalUnitCost: integer("historical_unit_cost"),
  historicalCogs: integer("historical_cogs"),
  grossProfit: integer("gross_profit"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("finance_sale_lines_sale_order_line_unique").on(table.saleId, table.orderLineId),
  index("finance_sale_lines_product_idx").on(table.productId, table.saleId),
  check("finance_sale_lines_quantity_check", sql`${table.quantity} > 0`),
  check("finance_sale_lines_money_check", sql`${table.unitPriceReal} >= 0 AND ${table.grossIncome} >= 0 AND ${table.allocatedDiscount} >= 0 AND ${table.netIncome} >= 0 AND (${table.historicalUnitCost} IS NULL OR ${table.historicalUnitCost} >= 0) AND (${table.historicalCogs} IS NULL OR ${table.historicalCogs} >= 0)`),
]);

export const financeSaleEvents = sqliteTable("finance_sale_events", {
  id: text("id").primaryKey(),
  saleId: text("sale_id").notNull().references(() => financeSales.id, { onDelete: "restrict" }),
  eventType: text("event_type").notNull(),
  sourceOperationId: text("source_operation_id").notNull(),
  reason: text("reason"),
  previousJson: text("previous_json").notNull().default("{}"),
  nextJson: text("next_json").notNull().default("{}"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("finance_sale_events_operation_unique").on(table.sourceOperationId, table.eventType),
  index("finance_sale_events_sale_idx").on(table.saleId, table.createdAt, table.id),
  check("finance_sale_events_type_check", sql`${table.eventType} IN ('RECOGNITION','REVERSAL')`),
]);

export const financeExpenses = sqliteTable("finance_expenses", {
  id: text("id").primaryKey(),
  expenseDate: text("expense_date").notNull(),
  category: text("category").notNull(),
  description: text("description").notNull(),
  amountCrc: integer("amount_crc").notNull(),
  originalAmountMinor: integer("original_amount_minor").notNull(),
  currency: text("currency").notNull().default("CRC"),
  exchangeRateCrc: integer("exchange_rate_crc").notNull().default(1),
  paymentMethod: text("payment_method").notNull(),
  provider: text("provider"),
  notes: text("notes"),
  routeId: text("route_id"),
  orderId: text("order_id").references(() => orders.id, { onDelete: "restrict" }),
  sourceType: text("source_type").notNull().default("MANUAL"),
  sourceId: text("source_id"),
  idempotencyKey: text("idempotency_key").notNull(),
  entryType: text("entry_type").notNull().default("EXPENSE"),
  reversesExpenseId: text("reverses_expense_id"),
  businessScope: text("business_scope").notNull().default("BUSINESS"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("finance_expenses_idempotency_unique").on(table.idempotencyKey),
  uniqueIndex("finance_expenses_reversal_unique").on(table.reversesExpenseId),
  uniqueIndex("finance_expenses_source_unique").on(table.sourceType, table.sourceId).where(sql`${table.entryType} = 'EXPENSE' AND ${table.sourceId} IS NOT NULL`),
  index("finance_expenses_date_idx").on(table.expenseDate, table.id),
  index("finance_expenses_route_idx").on(table.routeId, table.expenseDate, table.id),
  index("finance_expenses_order_idx").on(table.orderId, table.expenseDate, table.id),
  check("finance_expenses_amount_check", sql`${table.amountCrc} > 0 AND ${table.originalAmountMinor} > 0 AND ${table.exchangeRateCrc} > 0`),
  check("finance_expenses_currency_check", sql`length(trim(${table.currency})) = 3`),
  check("finance_expenses_method_check", sql`${table.paymentMethod} IN ('CASH','SINPE','CARD','OTHER')`),
  check("finance_expenses_entry_check", sql`${table.entryType} IN ('EXPENSE','REVERSAL')`),
  check("finance_expenses_scope_check", sql`${table.businessScope} IN ('BUSINESS','PERSONAL')`),
  check("finance_expenses_reversal_check", sql`(${table.entryType} = 'EXPENSE' AND ${table.reversesExpenseId} IS NULL) OR (${table.entryType} = 'REVERSAL' AND ${table.reversesExpenseId} IS NOT NULL)`),
]);

export const financeRecurringTemplates = sqliteTable("finance_recurring_templates", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  category: text("category").notNull(),
  amountCrc: integer("amount_crc").notNull(),
  currency: text("currency").notNull().default("CRC"),
  exchangeRateCrc: integer("exchange_rate_crc").notNull().default(1),
  paymentMethod: text("payment_method").notNull(),
  frequency: text("frequency").notNull(),
  nextDueDate: text("next_due_date").notNull(),
  provider: text("provider"),
  notes: text("notes"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("finance_recurring_due_idx").on(table.active, table.nextDueDate, table.id),
  check("finance_recurring_amount_check", sql`${table.amountCrc} > 0 AND ${table.exchangeRateCrc} > 0`),
  check("finance_recurring_method_check", sql`${table.paymentMethod} IN ('CASH','SINPE','CARD','OTHER')`),
  check("finance_recurring_frequency_check", sql`${table.frequency} IN ('WEEKLY','MONTHLY','QUARTERLY','YEARLY')`),
]);

export const financeBudgets = sqliteTable("finance_budgets", {
  id: text("id").primaryKey(),
  category: text("category").notNull(),
  yearMonth: text("year_month").notNull(),
  amountCrc: integer("amount_crc").notNull(),
  operationId: text("operation_id").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("finance_budgets_category_month_unique").on(table.category, table.yearMonth),
  uniqueIndex("finance_budgets_operation_unique").on(table.operationId),
  check("finance_budgets_amount_check", sql`${table.amountCrc} > 0`),
]);

export const inventoryOperations = sqliteTable("inventory_operations", {
  id: text("id").primaryKey(),
  documentId: text("document_id"),
  operationType: text("operation_type").notNull().default("ingress"),
  status: text("status").notNull().default("pending"),
  reversalOf: text("reversal_of"),
  reason: text("reason"),
  confirmedBy: text("confirmed_by"),
  lineCount: integer("line_count").notNull().default(0),
  totalUnits: integer("total_units").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  confirmedAt: text("confirmed_at"),
  verificationStatus: text("verification_status").notNull().default("pending"),
}, (table) => [
  index("inventory_operations_history_idx").on(table.confirmedAt, table.id),
  index("inventory_operations_document_idx").on(table.documentId, table.status),
]);

export const inventoryMovements = sqliteTable("inventory_movements", {
  id: text("id").primaryKey(),
  operationId: text("operation_id").notNull(),
  originalMovementId: text("original_movement_id"),
  documentLineId: text("document_line_id"),
  orderId: text("order_id"),
  orderLineId: text("order_line_id"),
  movementType: text("movement_type"),
  productId: integer("product_id").notNull(),
  productName: text("product_name").notNull(),
  barcode: text("barcode"),
  canonicalBarcode: text("canonical_barcode"),
  secondaryId: text("secondary_id"),
  secondaryType: text("secondary_type"),
  previousQuantity: integer("previous_quantity").notNull(),
  quantityChange: integer("quantity_change").notNull(),
  conversion: integer("conversion").notNull().default(1),
  resultingQuantity: integer("resulting_quantity").notNull(),
  barcodeMethod: text("barcode_method"),
  barcodeSource: text("barcode_source"),
  confirmedBy: text("confirmed_by"),
  reason: text("reason"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("inventory_movements_operation_line_unique").on(table.operationId, table.documentLineId),
  index("inventory_movements_product_idx").on(table.productId, table.createdAt),
  index("inventory_movements_operation_idx").on(table.operationId, table.id),
  index("inventory_movements_order_idx").on(table.orderId, table.orderLineId, table.createdAt),
  uniqueIndex("inventory_movements_order_operation_line_unique").on(table.operationId, table.orderLineId, table.movementType).where(sql`${table.orderLineId} IS NOT NULL`),
]);

export const notificationEvents = sqliteTable("notification_events", {
  id: text("id").primaryKey(),
  eventType: text("event_type").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id"),
  sourceOperationId: text("source_operation_id"),
  dedupeKey: text("dedupe_key").notNull(),
  payloadJson: text("payload_json").notNull().default("{}"),
  processingState: text("processing_state").notNull().default("PENDING"),
  attemptCount: integer("attempt_count").notNull().default(0),
  lastErrorCode: text("last_error_code"),
  occurredAt: text("occurred_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  processedAt: text("processed_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("notification_events_dedupe_unique").on(table.dedupeKey),
  index("notification_events_pending_idx").on(table.processingState, table.occurredAt, table.id),
  index("notification_events_entity_idx").on(table.entityType, table.entityId, table.occurredAt),
  check("notification_events_state_check", sql`${table.processingState} IN ('PENDING','MATERIALIZED','SKIPPED','FAILED')`),
]);

export const notifications = sqliteTable("notifications", {
  id: text("id").primaryKey(),
  eventId: text("event_id").notNull().references(() => notificationEvents.id, { onDelete: "restrict" }),
  eventType: text("event_type").notNull(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  severity: text("severity").notNull().default("INFO"),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id"),
  targetUrl: text("target_url"),
  deliveryState: text("delivery_state").notNull().default("IN_APP_ONLY"),
  dedupeKey: text("dedupe_key").notNull(),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  readAt: text("read_at"),
  dismissedAt: text("dismissed_at"),
}, (table) => [
  uniqueIndex("notifications_event_unique").on(table.eventId),
  uniqueIndex("notifications_dedupe_unique").on(table.dedupeKey),
  index("notifications_unread_idx").on(table.dismissedAt, table.readAt, table.createdAt, table.id),
  index("notifications_entity_idx").on(table.entityType, table.entityId, table.createdAt),
  check("notifications_severity_check", sql`${table.severity} IN ('INFO','WARNING','CRITICAL')`),
  check("notifications_delivery_state_check", sql`${table.deliveryState} IN ('IN_APP_ONLY','PUSH_PENDING','PUSH_SENT','PUSH_PARTIAL','PUSH_FAILED')`),
]);

export const notificationPreferences = sqliteTable("notification_preferences", {
  id: integer("id").primaryKey(),
  principalId: text("principal_id"),
  pushEnabled: integer("push_enabled", { mode: "boolean" }).notNull().default(false),
  lowStockEnabled: integer("low_stock_enabled", { mode: "boolean" }).notNull().default(true),
  outOfStockEnabled: integer("out_of_stock_enabled", { mode: "boolean" }).notNull().default(true),
  ordersEnabled: integer("orders_enabled", { mode: "boolean" }).notNull().default(true),
  specialOrdersEnabled: integer("special_orders_enabled", { mode: "boolean" }).notNull().default(true),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  check("notification_preferences_singleton_check", sql`${table.id} = 1`),
  check("notification_preferences_boolean_check", sql`${table.pushEnabled} IN (0,1) AND ${table.lowStockEnabled} IN (0,1) AND ${table.outOfStockEnabled} IN (0,1) AND ${table.ordersEnabled} IN (0,1) AND ${table.specialOrdersEnabled} IN (0,1)`),
]);

export const pushSubscriptions = sqliteTable("push_subscriptions", {
  id: text("id").primaryKey(),
  principalId: text("principal_id"),
  endpoint: text("endpoint").notNull(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  contentEncoding: text("content_encoding").notNull().default("aes128gcm"),
  deviceLabel: text("device_label"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  lastSeenAt: text("last_seen_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  disabledAt: text("disabled_at"),
  disabledReason: text("disabled_reason"),
}, (table) => [
  uniqueIndex("push_subscriptions_endpoint_unique").on(table.endpoint),
  index("push_subscriptions_active_idx").on(table.disabledAt, table.lastSeenAt, table.id),
  check("push_subscriptions_encoding_check", sql`${table.contentEncoding} = 'aes128gcm'`),
]);

export const notificationDeliveries = sqliteTable("notification_deliveries", {
  id: text("id").primaryKey(),
  notificationId: text("notification_id").notNull().references(() => notifications.id, { onDelete: "cascade" }),
  subscriptionId: text("subscription_id").notNull().references(() => pushSubscriptions.id, { onDelete: "restrict" }),
  channel: text("channel").notNull().default("PUSH"),
  state: text("state").notNull().default("PENDING"),
  attemptCount: integer("attempt_count").notNull().default(0),
  responseStatus: integer("response_status"),
  errorCode: text("error_code"),
  lastAttemptAt: text("last_attempt_at"),
  deliveredAt: text("delivered_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("notification_deliveries_target_unique").on(table.notificationId, table.subscriptionId, table.channel),
  index("notification_deliveries_state_idx").on(table.state, table.createdAt, table.id),
  check("notification_deliveries_channel_check", sql`${table.channel} = 'PUSH'`),
  check("notification_deliveries_state_check", sql`${table.state} IN ('PENDING','SENT','FAILED','DISABLED')`),
]);

export const notificationResourceStates = sqliteTable("notification_resource_states", {
  id: text("id").primaryKey(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  stateKey: text("state_key").notNull(),
  stateValue: text("state_value").notNull(),
  cycle: integer("cycle").notNull().default(0),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("notification_resource_states_unique").on(table.entityType, table.entityId, table.stateKey),
  index("notification_resource_states_value_idx").on(table.entityType, table.stateKey, table.stateValue, table.updatedAt),
  check("notification_resource_states_cycle_check", sql`${table.cycle} >= 0`),
]);

export const importJobs = sqliteTable("import_jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  fileName: text("file_name").notNull(),
  sheetName: text("sheet_name"),
  strategy: text("strategy").notNull().default("update"),
  status: text("status").notNull().default("queued"),
  totalRows: integer("total_rows").notNull().default(0),
  processedRows: integer("processed_rows").notNull().default(0),
  importedCount: integer("imported_count").notNull().default(0),
  updatedCount: integer("updated_count").notNull().default(0),
  skippedCount: integer("skipped_count").notNull().default(0),
  conflictCount: integer("conflict_count").notNull().default(0),
  errorCount: integer("error_count").notNull().default(0),
  incompleteCount: integer("incomplete_count").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  completedAt: text("completed_at"),
  restoredAt: text("restored_at"),
});

export const importJobRows = sqliteTable("import_job_rows", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  importId: integer("import_id").notNull(),
  rowNumber: integer("row_number").notNull(),
  name: text("name").notNull(),
  normalizedName: text("normalized_name").notNull(),
  code: text("code"),
  purchasePriceUsdCents: integer("purchase_price_usd_cents"),
  weightMilliLb: integer("weight_milli_lb"),
  quantityAvailable: integer("quantity_available"),
  minimumStock: integer("minimum_stock"),
  minimumStockEnabled: integer("minimum_stock_enabled", { mode: "boolean" }),
  hasCode: integer("has_code", { mode: "boolean" }).notNull().default(false),
  hasPurchasePrice: integer("has_purchase_price", { mode: "boolean" }).notNull().default(false),
  hasWeight: integer("has_weight", { mode: "boolean" }).notNull().default(false),
  hasQuantity: integer("has_quantity", { mode: "boolean" }).notNull().default(false),
  hasMinimumStock: integer("has_minimum_stock", { mode: "boolean" }).notNull().default(false),
  processed: integer("processed", { mode: "boolean" }).notNull().default(false),
  claimToken: text("claim_token"),
  claimedAt: text("claimed_at"),
  outcome: text("outcome"),
  message: text("message"),
}, (table) => [
  index("import_job_rows_pending_idx").on(table.importId, table.processed, table.id),
  index("import_job_rows_claim_idx").on(table.importId, table.processed, table.claimedAt, table.id),
]);

export const importBackups = sqliteTable("import_backups", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  importId: integer("import_id").notNull(),
  productCount: integer("product_count").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const importBackupProducts = sqliteTable("import_backup_products", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  backupId: integer("backup_id").notNull(),
  originalId: integer("original_id").notNull(),
  name: text("name").notNull(),
  normalizedName: text("normalized_name").notNull(),
  code: text("code"),
  purchasePriceUsdCents: integer("purchase_price_usd_cents"),
  weightMilliLb: integer("weight_milli_lb"),
  quantityAvailable: integer("quantity_available").notNull().default(0),
  minimumStock: integer("minimum_stock").notNull().default(0),
  minimumStockEnabled: integer("minimum_stock_enabled", { mode: "boolean" }).notNull().default(false),
  restockPurchasedAt: text("restock_purchased_at"),
  zeroStockSince: text("zero_stock_since"),
  version: integer("version").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [index("import_backup_products_backup_idx").on(table.backupId, table.originalId)]);

export const productDeletionJobs = sqliteTable("product_deletion_jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  status: text("status").notNull().default("queued"),
  totalProducts: integer("total_products").notNull().default(0),
  processedProducts: integer("processed_products").notNull().default(0),
  deletedProducts: integer("deleted_products").notNull().default(0),
  preservedProducts: integer("preserved_products").notNull().default(0),
  backupImportId: integer("backup_import_id"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  completedAt: text("completed_at"),
});

export const productDeletionRows = sqliteTable("product_deletion_rows", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  deletionId: integer("deletion_id").notNull(),
  productId: integer("product_id").notNull(),
  processed: integer("processed", { mode: "boolean" }).notNull().default(false),
  claimToken: text("claim_token"),
  claimedAt: text("claimed_at"),
  outcome: text("outcome"),
}, (table) => [
  index("product_deletion_rows_pending_idx").on(table.deletionId, table.processed, table.id),
  index("product_deletion_rows_claim_idx").on(table.deletionId, table.processed, table.claimedAt, table.id),
]);

// CRM Phase 2: canonical customer records remain separate from immutable order snapshots.
export const customers = sqliteTable("customers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  phoneRaw: text("phone_raw"),
  phoneNormalized: text("phone_normalized"),
  customerStatus: text("customer_status").notNull().default("PROSPECT"),
  province: text("province"), canton: text("canton"), district: text("district"),
  defaultDeliveryAddress: text("default_delivery_address"), locationUrl: text("location_url"),
  locationReference: text("location_reference"), latitude: real("latitude"), longitude: real("longitude"),
  preferredPaymentMethod: text("preferred_payment_method"), version: integer("version").notNull().default(1),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("customers_phone_normalized_unique").on(table.phoneNormalized), index("customers_updated_idx").on(table.updatedAt, table.id)]);

export const customerExternalIdentities = sqliteTable("customer_external_identities", {
  id: text("id").primaryKey(), customerId: text("customer_id").notNull().references(() => customers.id, { onDelete: "restrict" }),
  provider: text("provider").notNull(), externalAccount: text("external_account").notNull().default(""), externalId: text("external_id").notNull(), phoneNormalized: text("phone_normalized"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`), updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("customer_external_identity_unique").on(table.provider, table.externalAccount, table.externalId), index("customer_external_identities_customer_idx").on(table.customerId, table.createdAt), index("customer_external_identities_phone_idx").on(table.phoneNormalized)]);

export const chatwootContactLinks = sqliteTable("chatwoot_contact_links", {
  id: text("id").primaryKey(), chatwootAccountId: integer("chatwoot_account_id").notNull(), chatwootContactId: integer("chatwoot_contact_id").notNull(),
  customerId: text("customer_id").notNull().references(() => customers.id, { onDelete: "restrict" }), source: text("source").notNull().default("CRM"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`), updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("chatwoot_contact_link_unique").on(table.chatwootAccountId, table.chatwootContactId), index("chatwoot_contact_links_customer_idx").on(table.customerId, table.createdAt)]);

export const chatwootConversationOrderLinks = sqliteTable("chatwoot_conversation_order_links", {
  id: text("id").primaryKey(), chatwootAccountId: integer("chatwoot_account_id").notNull(), chatwootConversationId: integer("chatwoot_conversation_id").notNull(),
  orderId: text("order_id").notNull().references(() => orders.id, { onDelete: "restrict" }), linkRole: text("link_role").notNull().default("RELATED"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`), updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("chatwoot_conversation_order_link_unique").on(table.chatwootAccountId, table.chatwootConversationId, table.orderId, table.linkRole), index("chatwoot_conversation_order_links_order_idx").on(table.orderId, table.createdAt), index("chatwoot_conversation_order_links_conversation_idx").on(table.chatwootAccountId, table.chatwootConversationId)]);

export const chatwootWebhookJobs = sqliteTable("chatwoot_webhook_jobs", {
  id: text("id").primaryKey(),
  deliveryId: text("delivery_id").notNull(),
  eventType: text("event_type").notNull(),
  chatwootAccountId: integer("chatwoot_account_id").notNull(),
  chatwootContactId: integer("chatwoot_contact_id"),
  chatwootConversationId: integer("chatwoot_conversation_id"),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  nextAttemptAt: text("next_attempt_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  leaseToken: text("lease_token"),
  leaseExpiresAt: text("lease_expires_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  completedAt: text("completed_at"),
}, (table) => [
  uniqueIndex("chatwoot_webhook_jobs_delivery_unique").on(table.deliveryId),
  index("chatwoot_webhook_jobs_due_idx").on(table.status, table.nextAttemptAt, table.createdAt),
  index("chatwoot_webhook_jobs_lease_idx").on(table.status, table.leaseExpiresAt),
]);

export const crmOperations = sqliteTable("crm_operations", {
  operationId: text("operation_id").primaryKey(), operationType: text("operation_type").notNull(), requestHash: text("request_hash").notNull(), status: text("status").notNull().default("PENDING"), responseJson: text("response_json"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`), completedAt: text("completed_at"),
});


// Meta Conversions API: durable server-side delivery outbox.
export const metaCapiJobs = sqliteTable("meta_capi_jobs", {
  id: text("id").primaryKey(),
  dedupeKey: text("dedupe_key").notNull(),
  eventId: text("event_id").notNull(),
  eventName: text("event_name").notNull(),
  eventTime: text("event_time").notNull(),
  orderId: text("order_id"),
  orderNumber: text("order_number"),
  valueCrc: integer("value_crc"),
  chatwootAccountId: integer("chatwoot_account_id").notNull(),
  chatwootConversationId: integer("chatwoot_conversation_id").notNull(),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  nextAttemptAt: text("next_attempt_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  leaseToken: text("lease_token"),
  leaseExpiresAt: text("lease_expires_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  completedAt: text("completed_at"),
}, (table) => [
  uniqueIndex("meta_capi_jobs_dedupe_unique").on(table.dedupeKey),
  uniqueIndex("meta_capi_jobs_event_id_unique").on(table.eventId),
  index("meta_capi_jobs_due_idx").on(table.status, table.nextAttemptAt, table.createdAt),
  index("meta_capi_jobs_lease_idx").on(table.status, table.leaseExpiresAt),
  index("meta_capi_jobs_order_idx").on(table.orderId, table.eventName),
  check("meta_capi_jobs_event_name_check", sql`${table.eventName} IN ('LeadSubmitted','Purchase')`),
  check("meta_capi_jobs_status_check", sql`${table.status} IN ('pending','processing','completed','failed')`),
  check("meta_capi_jobs_attempts_check", sql`${table.attempts} >= 0`),
]);

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

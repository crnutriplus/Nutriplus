import { DatabaseSync } from "node:sqlite";

function normalizedBindings(values) {
  return values.map((value) => typeof value === "boolean" ? Number(value) : value === undefined ? null : value);
}

class LocalD1Statement {
  constructor(owner, sql, bindings = []) {
    this.owner = owner;
    this.sql = sql;
    this.bindings = bindings;
  }

  bind(...values) {
    return new LocalD1Statement(this.owner, this.sql, normalizedBindings(values));
  }

  statement() {
    return this.owner.sqlite.prepare(this.sql);
  }

  async first() {
    return this.statement().get(...this.bindings) ?? null;
  }

  async all() {
    return { success: true, results: this.statement().all(...this.bindings), meta: { changes: 0 } };
  }

  execute() {
    const statement = this.statement();
    if (statement.columns().length > 0) {
      const results = statement.all(...this.bindings);
      const changes = Number(this.owner.sqlite.prepare("SELECT changes() AS changes").get().changes || 0);
      return { success: true, results, meta: { changes } };
    }
    const result = statement.run(...this.bindings);
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes || 0), last_row_id: Number(result.lastInsertRowid || 0) },
    };
  }

  async run() {
    return this.execute();
  }
}

export class LocalD1Database {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec("PRAGMA foreign_keys=ON");
  }

  prepare(sql) {
    return new LocalD1Statement(this, sql);
  }

  async batch(statements) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.execute());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.sqlite.close();
  }
}

function copyBytes(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  throw new TypeError("The local R2 mock only accepts byte-backed values.");
}

export class LocalR2Bucket {
  constructor() {
    this.objects = new Map();
  }

  async put(key, value, options = {}) {
    const bytes = copyBytes(value);
    this.objects.set(String(key), {
      bytes,
      httpMetadata: options.httpMetadata || {},
      customMetadata: options.customMetadata || {},
    });
    return { key: String(key), size: bytes.byteLength };
  }

  async get(key, options = {}) {
    const stored = this.objects.get(String(key));
    if (!stored) return null;
    const range = options.range;
    const start = range && Number.isInteger(range.offset) ? Math.max(0, range.offset) : 0;
    const end = range && Number.isInteger(range.length) ? Math.min(stored.bytes.byteLength, start + range.length) : stored.bytes.byteLength;
    const bytes = stored.bytes.slice(start, end);
    return {
      key: String(key),
      size: stored.bytes.byteLength,
      body: bytes,
      httpMetadata: stored.httpMetadata,
      customMetadata: stored.customMetadata,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  }

  async head(key) {
    const stored = this.objects.get(String(key));
    if (!stored) return null;
    return {
      key: String(key),
      size: stored.bytes.byteLength,
      httpMetadata: stored.httpMetadata,
      customMetadata: stored.customMetadata,
    };
  }

  async delete(key) {
    this.objects.delete(String(key));
  }
}

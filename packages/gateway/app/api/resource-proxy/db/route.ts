/**
 * Resource Proxy — Database Operations
 *
 * Phase 53.2: Apps built by Pando agents access MongoDB through this proxy.
 * The proxy holds NO permanent credentials. It validates project keys against
 * the node's ResourceRegistry, gets decrypted MongoDB URIs per-request (with
 * short caching), executes the query, meters usage, and returns results.
 *
 * POST /api/resource-proxy/db — query, insert, update, delete
 * GET  /api/resource-proxy/db — simple find via query params
 *
 * Auth: X-Project-Key header (project-scoped API key)
 */

import { NextRequest, NextResponse } from "next/server";
import { MongoClient, ObjectId, type Db, type Document, type Filter, type UpdateFilter } from "mongodb";
import { getNodeUrl, getApiToken } from "@/lib/node-connection";

// ── CORS (required: S3-hosted apps call this cross-origin) ───────────────────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Project-Key",
  "Access-Control-Max-Age": "86400",
};

/** Wrap NextResponse.json with CORS headers. */
function jsonWithCors(body: unknown, init?: { status?: number }): NextResponse {
  return NextResponse.json(body, { ...init, headers: CORS_HEADERS });
}

/** Preflight handler. */
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

// ── Types ─────────────────────────────────────────────────────────────────────

type DbOperation =
  | "find"
  | "findOne"
  | "insertOne"
  | "insertMany"
  | "updateOne"
  | "updateMany"
  | "deleteOne"
  | "deleteMany"
  | "count";

interface ProxyRequest {
  collection: string;
  operation: DbOperation;
  filter?: Record<string, unknown>;
  document?: Record<string, unknown>;
  documents?: Record<string, unknown>[];
  update?: Record<string, unknown>;
  options?: Record<string, unknown>;
  sort?: Record<string, number>;
  limit?: number;
  skip?: number;
  projection?: Record<string, number>;
}

interface CachedCredential {
  mongoUri: string;
  projectId: string;
  resourceId: string;
  expiresAt: number;
}

// ── Credential Cache (5-minute TTL) ───────────────────────────────────────────

const credentialCache = new Map<string, CachedCredential>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCachedCredential(projectKey: string): CachedCredential | null {
  const cached = credentialCache.get(projectKey);
  if (!cached) return null;
  if (Date.now() > cached.expiresAt) {
    credentialCache.delete(projectKey);
    return null;
  }
  return cached;
}

function setCachedCredential(projectKey: string, cred: Omit<CachedCredential, "expiresAt">): void {
  credentialCache.set(projectKey, { ...cred, expiresAt: Date.now() + CACHE_TTL });
}

// ── MongoDB Connection Pool ───────────────────────────────────────────────────

/** Reuse connections by URI (pool per unique MongoDB instance). */
const connectionPool = new Map<string, { client: MongoClient; lastUsed: number }>();
const CONNECTION_TTL = 10 * 60 * 1000; // 10 minutes idle before closing

/** Cleanup idle connections every 2 minutes. */
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function startConnectionCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [uri, entry] of connectionPool) {
      if (now - entry.lastUsed > CONNECTION_TTL) {
        entry.client.close().catch(() => {});
        connectionPool.delete(uri);
      }
    }
  }, 2 * 60 * 1000);
  // Do not block process exit in environments where this matters
  if (cleanupTimer && typeof cleanupTimer === "object" && "unref" in cleanupTimer) {
    (cleanupTimer as NodeJS.Timeout).unref();
  }
}

async function getMongoDb(uri: string): Promise<Db> {
  startConnectionCleanup();

  let entry = connectionPool.get(uri);
  if (entry) {
    entry.lastUsed = Date.now();
    // Extract database name from URI
    const dbName = extractDbName(uri);
    return entry.client.db(dbName);
  }

  const client = new MongoClient(uri, {
    maxPoolSize: 5,
    minPoolSize: 1,
    maxIdleTimeMS: CONNECTION_TTL,
    connectTimeoutMS: 10_000,
    serverSelectionTimeoutMS: 10_000,
  });

  await client.connect();
  connectionPool.set(uri, { client, lastUsed: Date.now() });

  const dbName = extractDbName(uri);
  return client.db(dbName);
}

function extractDbName(uri: string): string {
  try {
    const url = new URL(uri);
    const path = url.pathname;
    // pathname is "/<dbname>" or "/<dbname>?options"
    const name = path.replace(/^\//, "").split("?")[0];
    return name || "pando";
  } catch {
    return "pando";
  }
}

// ── Rate Limiting (per project key) ───────────────────────────────────────────

const rateLimitWindows = new Map<string, number[]>();
const RATE_LIMIT_MAX = 100; // ops per minute
const RATE_LIMIT_WINDOW = 60_000; // 1 minute

function checkRateLimit(projectKey: string): boolean {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW;
  let timestamps = rateLimitWindows.get(projectKey);
  if (!timestamps) {
    timestamps = [];
    rateLimitWindows.set(projectKey, timestamps);
  }
  // Prune expired entries
  while (timestamps.length > 0 && timestamps[0] <= cutoff) {
    timestamps.shift();
  }
  if (timestamps.length >= RATE_LIMIT_MAX) {
    return false;
  }
  timestamps.push(now);
  return true;
}

// ── Size limits ───────────────────────────────────────────────────────────────

const MAX_RESPONSE_SIZE = 1 * 1024 * 1024; // 1MB
const MAX_DOCUMENT_SIZE = 100 * 1024; // 100KB per document

// ── Allowed operations ────────────────────────────────────────────────────────

const ALLOWED_OPERATIONS: Set<string> = new Set([
  "find",
  "findOne",
  "insertOne",
  "insertMany",
  "updateOne",
  "updateMany",
  "deleteOne",
  "deleteMany",
  "count",
]);

// ── Node communication helpers ────────────────────────────────────────────────

function nodeHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = getApiToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

async function validateProjectKey(
  projectKey: string,
): Promise<{ valid: boolean; projectId?: string; mongoUri?: string; resourceId?: string; error?: string }> {
  // Check cache first
  const cached = getCachedCredential(projectKey);
  if (cached) {
    return { valid: true, projectId: cached.projectId, mongoUri: cached.mongoUri, resourceId: cached.resourceId };
  }

  // Call node to validate
  try {
    const res = await fetch(`${getNodeUrl()}/v1/resource-proxy/validate`, {
      method: "POST",
      headers: nodeHeaders(),
      body: JSON.stringify({ projectKey }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: "Validation failed" }));
      return { valid: false, error: data.error || "Invalid project key" };
    }

    const data = await res.json();
    if (!data.valid) {
      return { valid: false, error: data.error || "Invalid project key" };
    }

    // Cache the credential
    if (data.mongoUri) {
      setCachedCredential(projectKey, {
        mongoUri: data.mongoUri,
        projectId: data.projectId,
        resourceId: data.resourceId,
      });
    }

    return data;
  } catch (err: any) {
    return { valid: false, error: `Node unreachable: ${err.message || "Unknown error"}` };
  }
}

async function meterUsage(projectId: string, resourceId: string, operation: string, count: number, bytes: number): Promise<void> {
  try {
    await fetch(`${getNodeUrl()}/v1/resource-proxy/meter`, {
      method: "POST",
      headers: nodeHeaders(),
      body: JSON.stringify({ projectId, resourceId, operation, count, bytes }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // Metering failure should not block the response — log silently
    console.error(`[resource-proxy] Failed to meter usage for project ${projectId}`);
  }
}

// ── Validation helpers ────────────────────────────────────────────────────────

/** Validate collection name: alphanumeric, underscores, dots, hyphens. No system collections. */
function isValidCollection(name: string): boolean {
  if (!name || typeof name !== "string") return false;
  if (name.startsWith("system.")) return false;
  if (name.startsWith("__")) return false;
  if (name.length > 128) return false;
  return /^[a-zA-Z0-9_.\-]+$/.test(name);
}

/** Check document size (rough JSON byte count). */
function estimateSize(obj: unknown): number {
  try {
    return JSON.stringify(obj).length;
  } catch {
    return Infinity;
  }
}

// ── ObjectId conversion ──────────────────────────────────────────────────────
// MongoDB returns _id as a hex string via JSON, but queries need ObjectId.
// Convert any _id string that looks like a 24-char hex to ObjectId recursively.
function convertObjectIds(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === '_id' && typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value)) {
      result[key] = new ObjectId(value);
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = convertObjectIds(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ── Collection namespace isolation (Phase 68.1) ─────────────────────────────
// Every project gets its own collection namespace. Client sends "messages",
// MongoDB sees "{projectId}_messages". This prevents data leakage across projects.
// The prefix is applied transparently — clients never see it.

function scopeCollection(collection: string, projectId: string): string {
  if (!projectId) return collection; // Safety fallback — should never happen
  // Short prefix: first 8 chars of projectId (enough to be unique)
  return `${projectId.slice(0, 8)}_${collection}`;
}

// ── Execute database operation ────────────────────────────────────────────────

async function executeOperation(db: Db, body: ProxyRequest, projectId?: string): Promise<{ result: unknown; count: number; bytes: number }> {
  const collectionName = projectId ? scopeCollection(body.collection, projectId) : body.collection;
  const collection = db.collection(collectionName);
  const filter = convertObjectIds(body.filter || {}) as Filter<Document>;
  const limit = Math.min(body.limit || 100, 1000); // Max 1000 docs per query
  const skip = body.skip || 0;

  let result: unknown;
  let count = 0;
  let bytes = 0;

  switch (body.operation) {
    case "find": {
      let cursor = collection.find(filter);
      if (body.sort) cursor = cursor.sort(body.sort as any);
      if (body.projection) cursor = cursor.project(body.projection);
      cursor = cursor.skip(skip).limit(limit);
      const docs = await cursor.toArray();
      count = docs.length;
      result = docs;
      bytes = estimateSize(docs);
      break;
    }

    case "findOne": {
      const doc = await collection.findOne(filter, {
        projection: body.projection as any,
      });
      result = doc;
      count = doc ? 1 : 0;
      bytes = estimateSize(doc);
      break;
    }

    case "insertOne": {
      if (!body.document) throw new Error("Missing 'document' field for insertOne");
      const docSize = estimateSize(body.document);
      if (docSize > MAX_DOCUMENT_SIZE) {
        throw new Error(`Document too large: ${docSize} bytes (max ${MAX_DOCUMENT_SIZE})`);
      }
      const insertResult = await collection.insertOne(body.document as Document);
      result = { insertedId: insertResult.insertedId, acknowledged: insertResult.acknowledged };
      count = 1;
      bytes = docSize;
      break;
    }

    case "insertMany": {
      if (!body.documents || !Array.isArray(body.documents)) {
        throw new Error("Missing 'documents' array for insertMany");
      }
      if (body.documents.length > 100) {
        throw new Error("Too many documents (max 100 per insertMany)");
      }
      let totalSize = 0;
      for (const doc of body.documents) {
        const s = estimateSize(doc);
        if (s > MAX_DOCUMENT_SIZE) {
          throw new Error(`Document too large: ${s} bytes (max ${MAX_DOCUMENT_SIZE})`);
        }
        totalSize += s;
      }
      const insertManyResult = await collection.insertMany(body.documents as Document[]);
      result = {
        insertedCount: insertManyResult.insertedCount,
        insertedIds: insertManyResult.insertedIds,
        acknowledged: insertManyResult.acknowledged,
      };
      count = insertManyResult.insertedCount;
      bytes = totalSize;
      break;
    }

    case "updateOne": {
      if (!body.update) throw new Error("Missing 'update' field for updateOne");
      const updateResult = await collection.updateOne(filter, body.update as UpdateFilter<Document>);
      result = {
        matchedCount: updateResult.matchedCount,
        modifiedCount: updateResult.modifiedCount,
        acknowledged: updateResult.acknowledged,
      };
      count = updateResult.modifiedCount;
      bytes = estimateSize(body.update);
      break;
    }

    case "updateMany": {
      if (!body.update) throw new Error("Missing 'update' field for updateMany");
      const updateManyResult = await collection.updateMany(filter, body.update as UpdateFilter<Document>);
      result = {
        matchedCount: updateManyResult.matchedCount,
        modifiedCount: updateManyResult.modifiedCount,
        acknowledged: updateManyResult.acknowledged,
      };
      count = updateManyResult.modifiedCount;
      bytes = estimateSize(body.update);
      break;
    }

    case "deleteOne": {
      const deleteResult = await collection.deleteOne(filter);
      result = { deletedCount: deleteResult.deletedCount, acknowledged: deleteResult.acknowledged };
      count = deleteResult.deletedCount;
      bytes = 0;
      break;
    }

    case "deleteMany": {
      const deleteManyResult = await collection.deleteMany(filter);
      result = { deletedCount: deleteManyResult.deletedCount, acknowledged: deleteManyResult.acknowledged };
      count = deleteManyResult.deletedCount;
      bytes = 0;
      break;
    }

    case "count": {
      const docCount = await collection.countDocuments(filter);
      result = { count: docCount };
      count = 1;
      bytes = 0;
      break;
    }

    default:
      throw new Error(`Unsupported operation: ${body.operation}`);
  }

  // Check response size
  const responseSize = estimateSize(result);
  if (responseSize > MAX_RESPONSE_SIZE) {
    throw new Error(`Response too large: ${responseSize} bytes (max ${MAX_RESPONSE_SIZE}). Use limit/projection to reduce.`);
  }

  return { result, count, bytes };
}

// ── POST handler ──────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    // 1. Extract and validate project key
    const projectKey = request.headers.get("X-Project-Key");
    if (!projectKey) {
      return jsonWithCors(
        { error: "Missing X-Project-Key header", code: "UNAUTHORIZED" },
        { status: 401 },
      );
    }

    // 2. Rate limit check
    if (!checkRateLimit(projectKey)) {
      return jsonWithCors(
        { error: "Rate limit exceeded (100 operations per minute)", code: "RATE_LIMITED" },
        { status: 429 },
      );
    }

    // 3. Parse request body
    let body: ProxyRequest;
    try {
      body = await request.json();
    } catch {
      return jsonWithCors(
        { error: "Invalid JSON body", code: "BAD_REQUEST" },
        { status: 400 },
      );
    }

    // 4. Validate required fields
    if (!body.collection || !body.operation) {
      return jsonWithCors(
        { error: "Missing required fields: collection, operation", code: "BAD_REQUEST" },
        { status: 400 },
      );
    }

    if (!isValidCollection(body.collection)) {
      return jsonWithCors(
        { error: "Invalid collection name", code: "BAD_REQUEST" },
        { status: 400 },
      );
    }

    if (!ALLOWED_OPERATIONS.has(body.operation)) {
      return jsonWithCors(
        { error: `Unsupported operation: ${body.operation}. Allowed: ${[...ALLOWED_OPERATIONS].join(", ")}`, code: "BAD_REQUEST" },
        { status: 400 },
      );
    }

    // 5. Validate project key and get MongoDB URI
    const validation = await validateProjectKey(projectKey);
    if (!validation.valid) {
      return jsonWithCors(
        { error: validation.error || "Invalid project key", code: "UNAUTHORIZED" },
        { status: 401 },
      );
    }

    if (!validation.mongoUri) {
      return jsonWithCors(
        { error: "No database resource assigned to this project", code: "NO_RESOURCE" },
        { status: 503 },
      );
    }

    // 6. Connect and execute
    let db: Db;
    try {
      db = await getMongoDb(validation.mongoUri);
    } catch (err: any) {
      return jsonWithCors(
        { error: "Database connection failed", code: "DB_ERROR", details: err.message },
        { status: 502 },
      );
    }

    let execResult: { result: unknown; count: number; bytes: number };
    try {
      execResult = await executeOperation(db, body, validation.projectId);
    } catch (err: any) {
      return jsonWithCors(
        { error: err.message || "Operation failed", code: "OP_ERROR" },
        { status: 400 },
      );
    }

    // 7. Meter usage (fire-and-forget)
    meterUsage(
      validation.projectId!,
      validation.resourceId!,
      body.operation,
      execResult.count,
      execResult.bytes,
    );

    // 8. Return results
    return jsonWithCors({
      success: true,
      operation: body.operation,
      collection: body.collection,
      data: execResult.result,
    });
  } catch (err: any) {
    console.error("[resource-proxy] POST error:", err);
    return jsonWithCors(
      { error: "Internal proxy error", code: "INTERNAL_ERROR", details: err.message },
      { status: 500 },
    );
  }
}

// ── GET handler (simple find via query params) ────────────────────────────────

export async function GET(request: NextRequest) {
  try {
    // 1. Extract project key
    const projectKey = request.headers.get("X-Project-Key");
    if (!projectKey) {
      return jsonWithCors(
        { error: "Missing X-Project-Key header", code: "UNAUTHORIZED" },
        { status: 401 },
      );
    }

    // 2. Rate limit
    if (!checkRateLimit(projectKey)) {
      return jsonWithCors(
        { error: "Rate limit exceeded (100 operations per minute)", code: "RATE_LIMITED" },
        { status: 429 },
      );
    }

    // 3. Parse query params
    const { searchParams } = new URL(request.url);
    const collection = searchParams.get("collection");
    const filterRaw = searchParams.get("filter");
    const limitRaw = searchParams.get("limit");
    const skipRaw = searchParams.get("skip");
    const sortRaw = searchParams.get("sort");
    const projectionRaw = searchParams.get("projection");

    if (!collection) {
      return jsonWithCors(
        { error: "Missing 'collection' query param", code: "BAD_REQUEST" },
        { status: 400 },
      );
    }

    if (!isValidCollection(collection)) {
      return jsonWithCors(
        { error: "Invalid collection name", code: "BAD_REQUEST" },
        { status: 400 },
      );
    }

    // 4. Validate project key
    const validation = await validateProjectKey(projectKey);
    if (!validation.valid) {
      return jsonWithCors(
        { error: validation.error || "Invalid project key", code: "UNAUTHORIZED" },
        { status: 401 },
      );
    }

    if (!validation.mongoUri) {
      return jsonWithCors(
        { error: "No database resource assigned to this project", code: "NO_RESOURCE" },
        { status: 503 },
      );
    }

    // 5. Connect
    let db: Db;
    try {
      db = await getMongoDb(validation.mongoUri);
    } catch (err: any) {
      return jsonWithCors(
        { error: "Database connection failed", code: "DB_ERROR", details: err.message },
        { status: 502 },
      );
    }

    // 6. Build find query from params
    let filter: Record<string, unknown> = {};
    if (filterRaw) {
      try {
        filter = convertObjectIds(JSON.parse(filterRaw));
      } catch {
        return jsonWithCors(
          { error: "Invalid 'filter' JSON", code: "BAD_REQUEST" },
          { status: 400 },
        );
      }
    }

    let sort: Record<string, number> | undefined;
    if (sortRaw) {
      try {
        sort = JSON.parse(sortRaw);
      } catch {
        return jsonWithCors(
          { error: "Invalid 'sort' JSON", code: "BAD_REQUEST" },
          { status: 400 },
        );
      }
    }

    let projection: Record<string, number> | undefined;
    if (projectionRaw) {
      try {
        projection = JSON.parse(projectionRaw);
      } catch {
        return jsonWithCors(
          { error: "Invalid 'projection' JSON", code: "BAD_REQUEST" },
          { status: 400 },
        );
      }
    }

    const proxyReq: ProxyRequest = {
      collection,
      operation: "find",
      filter,
      limit: limitRaw ? Math.min(parseInt(limitRaw, 10), 1000) : 100,
      skip: skipRaw ? parseInt(skipRaw, 10) : 0,
      sort,
      projection,
    };

    // 7. Execute
    let execResult: { result: unknown; count: number; bytes: number };
    try {
      execResult = await executeOperation(db, proxyReq, validation.projectId);
    } catch (err: any) {
      return jsonWithCors(
        { error: err.message || "Query failed", code: "OP_ERROR" },
        { status: 400 },
      );
    }

    // 8. Meter
    meterUsage(
      validation.projectId!,
      validation.resourceId!,
      "find",
      execResult.count,
      execResult.bytes,
    );

    // 9. Return
    return jsonWithCors({
      success: true,
      operation: "find",
      collection,
      data: execResult.result,
    });
  } catch (err: any) {
    console.error("[resource-proxy] GET error:", err);
    return jsonWithCors(
      { error: "Internal proxy error", code: "INTERNAL_ERROR", details: err.message },
      { status: 500 },
    );
  }
}

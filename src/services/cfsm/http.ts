import { z } from "zod";
import { fetchWithTimeout } from "@/utils/abort";
import {
  clearJwtToken,
  clearTurnstileCredentials,
  getApiBases,
  getJwtToken,
  getPrimaryApiBase,
  getTurnstileToken,
  getTurnstileVerified,
  setTurnstileVerified,
} from "@/services/cfsm/config";

// 普通 GET 没有传输超时，half-open socket 会无限挂住调用方，这里统一兜底。
export const DEFAULT_API_TIMEOUT_MS = 12_000;

export class ApiRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly path: string,
    /** 后端错误体里的业务 code，通常与 status 一致。 */
    public readonly code: number = status,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

/** 数据库需要升级（409）时后端返回 `{ message: "databaseUpgradeRequired" }`。 */
export class DatabaseUpgradeRequiredError extends ApiRequestError {
  constructor(path: string) {
    super("databaseUpgradeRequired", 409, path, 409);
    this.name = "DatabaseUpgradeRequiredError";
  }
}

const ErrorBodySchema = z
  .object({
    error: z.string().optional(),
    message: z.string().optional(),
    code: z.union([z.number(), z.string()]).optional(),
  })
  .passthrough();

export interface RequestOptions {
  signal?: AbortSignal;
  timeout?: number;
  /** 指定后端；多站部署时用于把详情/历史请求打到拥有该服务器的站点。 */
  base?: string;
}

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };

  const token = getJwtToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  // 已验证凭证优先；只有还没拿到凭证时才带一次性 token。
  const verified = getTurnstileVerified();
  if (verified) {
    headers["X-Turnstile-Verified"] = verified;
  } else {
    const turnstileToken = getTurnstileToken();
    if (turnstileToken) headers["X-Turnstile-Token"] = turnstileToken;
  }

  return headers;
}

async function readErrorBody(resp: Response) {
  try {
    const parsed = ErrorBodySchema.safeParse(await resp.json());
    if (!parsed.success) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

function captureTurnstileVerified(payload: unknown): void {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
  const value = (payload as Record<string, unknown>).turnstile_verified;
  if (typeof value === "string" && value) setTurnstileVerified(value);
}

/**
 * 单个后端的 GET。成功响应直接是业务对象（没有 `{status,data}` 包装），
 * 失败响应是 `{ error, code }`。
 */
export async function cfsmGet<S extends z.ZodTypeAny>(
  path: string,
  schema: S,
  options?: RequestOptions,
): Promise<z.output<S>> {
  const base = options?.base ?? getPrimaryApiBase();
  const url = `${base}${path}`;
  const resp = await fetchWithTimeout(
    url,
    { credentials: "include", headers: buildHeaders() },
    options?.timeout ?? DEFAULT_API_TIMEOUT_MS,
    options?.signal,
  );

  if (!resp.ok) {
    const body = await readErrorBody(resp);
    if (resp.status === 401) {
      // 令牌过期后清掉，让后续请求以访客身份继续；不做跳转 —— 主题不接管登录。
      clearJwtToken();
    }
    if (resp.status === 403) {
      clearTurnstileCredentials();
    }
    if (resp.status === 409 || body?.message === "databaseUpgradeRequired") {
      throw new DatabaseUpgradeRequiredError(path);
    }
    const code = Number(body?.code);
    throw new ApiRequestError(
      body?.error || body?.message || `Request ${path} failed: ${resp.status}`,
      resp.status,
      path,
      Number.isFinite(code) && code > 0 ? code : resp.status,
    );
  }

  const json = (await resp.json()) as unknown;
  captureTurnstileVerified(json);

  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `Schema mismatch on ${path}: ${parsed.error.issues[0]?.message ?? "unknown"}`,
    );
  }
  return parsed.data;
}

/**
 * 单个后端的 POST。目前唯一的写入口是第三方主题保存自身配置（`POST /api/theme_options`，
 * 仅登录站长可用）—— 与 GET 共用鉴权头（Bearer JWT + Turnstile），额外带 JSON body。
 * 401 清 JWT、403 清 Turnstile 凭证的处理与 cfsmGet 一致，调用方据 status 提示。
 */
export async function cfsmPost<S extends z.ZodTypeAny>(
  path: string,
  body: unknown,
  schema: S,
  options?: RequestOptions,
): Promise<z.output<S>> {
  const base = options?.base ?? getPrimaryApiBase();
  const url = `${base}${path}`;
  const resp = await fetchWithTimeout(
    url,
    {
      method: "POST",
      credentials: "include",
      headers: { ...buildHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    options?.timeout ?? DEFAULT_API_TIMEOUT_MS,
    options?.signal,
  );

  if (!resp.ok) {
    const errorBody = await readErrorBody(resp);
    if (resp.status === 401) {
      // 令牌过期：清掉，让调用方提示重新登录（写操作没有匿名降级一说）。
      clearJwtToken();
    }
    if (resp.status === 403) {
      // Turnstile 凭证失效：清掉，全局 TurnstileGate 会在下次拉 config 时重新弹验证。
      clearTurnstileCredentials();
    }
    if (resp.status === 409 || errorBody?.message === "databaseUpgradeRequired") {
      throw new DatabaseUpgradeRequiredError(path);
    }
    const code = Number(errorBody?.code);
    throw new ApiRequestError(
      errorBody?.error || errorBody?.message || `Request ${path} failed: ${resp.status}`,
      resp.status,
      path,
      Number.isFinite(code) && code > 0 ? code : resp.status,
    );
  }

  const json = (await resp.json()) as unknown;
  captureTurnstileVerified(json);

  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `Schema mismatch on ${path}: ${parsed.error.issues[0]?.message ?? "unknown"}`,
    );
  }
  return parsed.data;
}

export interface MultiBaseResult<T> {
  base: string;
  data?: T;
  error?: unknown;
}

/**
 * 向所有后端并发发起同一个 GET。单站失败不影响其它站，调用方自行决定如何合并
 * 与如何提示（多站部署下部分站点离线属于常态）。
 */
export async function cfsmGetAll<S extends z.ZodTypeAny>(
  path: string,
  schema: S,
  options?: Omit<RequestOptions, "base">,
): Promise<MultiBaseResult<z.output<S>>[]> {
  const bases = getApiBases();
  const settled = await Promise.allSettled(
    bases.map((base) => cfsmGet(path, schema, { ...options, base })),
  );

  return settled.map((result, index) => {
    const base = bases[index]!;
    return result.status === "fulfilled"
      ? { base, data: result.value }
      : { base, error: result.reason };
  });
}

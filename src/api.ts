export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...options,
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
      signal: options.signal ?? AbortSignal.timeout(15000),
    });
  } catch {
    throw new ApiError(
      "Нет связи с сервером. Проверьте, что приложение запущено, и повторите попытку.",
      0,
    );
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(
      data?.message ?? data?.error ?? `Ошибка сервера (${response.status})`,
      response.status,
    );
  }
  if (data === null)
    throw new ApiError("Сервер вернул некорректный ответ.", response.status);
  return data as T;
}

export type AuthSession = { username: string; csrfToken: string };
export type AuthStatus = {
  needsSetup: boolean;
  authenticated: boolean;
  username?: string;
  csrfToken?: string;
};

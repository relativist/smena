/** Normalize a deployment base path to either "/" or a slash-wrapped prefix. */
export function normalizeBasePath(value) {
  const segments = (value ?? "/").split("/").filter(Boolean);
  return segments.length ? `/${segments.join("/")}/` : "/";
}

function configuredBasePath() {
  // Native Node navigation tests do not provide Vite's import.meta.env object.
  return normalizeBasePath(import.meta.env?.BASE_URL);
}

export function appBasePath() {
  return configuredBasePath();
}

export function withBasePath(path, basePath = appBasePath()) {
  const base = normalizeBasePath(basePath);
  const suffix = path.replace(/^\/+/, "");
  return base === "/" ? `/${suffix}` : `${base}${suffix}`;
}

export function stripBasePath(pathname, basePath = appBasePath()) {
  const base = normalizeBasePath(basePath);
  if (base === "/") return pathname;
  const prefix = base.slice(0, -1);
  if (pathname === prefix || pathname === base) return "/";
  return pathname.startsWith(base) ? `/${pathname.slice(base.length)}` : pathname;
}

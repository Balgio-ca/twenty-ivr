function ts(): string {
  return new Date().toISOString();
}

export function log(scope: string, message: string, extra?: unknown): void {
  if (extra !== undefined) {
    console.log(`[${ts()}] [${scope}] ${message}`, extra);
  } else {
    console.log(`[${ts()}] [${scope}] ${message}`);
  }
}

export function warn(scope: string, message: string, extra?: unknown): void {
  if (extra !== undefined) {
    console.warn(`[${ts()}] [${scope}] ${message}`, extra);
  } else {
    console.warn(`[${ts()}] [${scope}] ${message}`);
  }
}

export function error(scope: string, message: string, extra?: unknown): void {
  if (extra !== undefined) {
    console.error(`[${ts()}] [${scope}] ${message}`, extra);
  } else {
    console.error(`[${ts()}] [${scope}] ${message}`);
  }
}

export function isVerboseLogging(): boolean {
  const value = process.env.VERBOSE_LOGGING?.trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes';
}

export function logVerbose(message: string, details?: Record<string, unknown>): void {
  if (!isVerboseLogging()) {
    return;
  }
  if (details) {
    console.log(message, JSON.stringify(details));
  } else {
    console.log(message);
  }
}

export function logError(message: string): void {
  console.error(message);
}

export function getCurrentTime() {
  const now = new Date();
  return {
    iso: now.toISOString(),
    local: now.toString(),
    epochMs: now.getTime(),
  };
}

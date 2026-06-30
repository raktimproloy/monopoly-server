/** Runtime flags shared across persistence layers (avoids circular imports). */
export const runtimeFlags = {
  /** When true PostgreSQL is unreachable — logs/final archive are skipped. */
  useMemoryFallback: false,
};

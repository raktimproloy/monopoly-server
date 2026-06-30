/** Redis key namespace — keep all keys prefixed for multi-tenant safety. */
export const RedisKeys = {
  /** Full active room payload: { state, version, templateId } */
  roomState: (roomId: string) => `monopoly:room:${roomId}:state`,
  /** Monotonic version counter (optimistic locking) */
  roomVersion: (roomId: string) => `monopoly:room:${roomId}:version`,
  /** Set of active room IDs (for sweeps / monitoring) */
  activeRooms: () => 'monopoly:rooms:active',
  /** Pub/Sub channel for cross-node state fan-out */
  roomChannel: (roomId: string) => `monopoly:channel:room:${roomId}`,
} as const;

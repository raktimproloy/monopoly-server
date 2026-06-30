# Optimized Multiplayer Backend Architecture

## Directory layout

```
server/src/
├── redis/
│   ├── client.ts          # ioredis singleton + in-memory fallback
│   └── keys.ts            # Key/channel naming conventions
├── state/
│   ├── delta.ts           # jsondiffpatch create/apply + DeltaPayload builder
│   └── GameStateStore.ts  # Redis-backed active room state (CAS via Lua)
├── managers/
│   └── RoomManager.ts     # Authoritative mutations + EventEmitter pipeline
├── broadcast/
│   └── RoomBroadcaster.ts # state_delta fan-out + Redis Pub/Sub
├── persistence/
│   └── PostgresPersistence.ts  # Batched audit logs + final archive on close
├── config/
│   └── runtime.ts         # Feature flags (memory fallback when DB down)
├── controllers/
│   └── game.controller.ts # Socket handlers: Zod validate → service → commit
└── services/
    └── room.service.ts    # Room lifecycle; PG only for cold recovery + archive
```

## Data flow

```
Client action (Socket.IO)
  → game.controller (Zod validation)
  → action/game services (pure mutation)
  → room.service.updateRoomState()
  → RoomManager.commitUpdate()  → Redis (GameStateStore)
  → emit('stateUpdated')
  → RoomBroadcaster.broadcast()
       ├─ io.to(roomId).emit('state_delta', delta)
       ├─ io.to(roomId).emit('state_updated')  [only when full: true]
       └─ Redis PUBLISH room:{id}:events  [multi-node fan-out]
```

## Storage policy

| Data | Store | When |
|------|-------|------|
| Active `GameState` | Redis (`game:room:{id}`) | Every move |
| Audit logs | PostgreSQL (batched ~2s) | Async flush |
| Final game snapshot | PostgreSQL `game_rooms` | Room close / game finished |
| User profiles, leaderboards | PostgreSQL | Persistent only |

## Environment

```env
REDIS_URL=redis://localhost:6379   # optional; falls back to in-memory
DATABASE_URL=postgresql://...
```

## Horizontal scaling

1. Run multiple Node processes behind a load balancer (sticky sessions optional with Socket.IO adapter).
2. Each node calls `roomBroadcaster.subscribeRoom(roomId)` when the first socket joins.
3. State mutations publish to `room:{roomId}:events`; other nodes relay to their local sockets.
4. Authoritative writes still go through Redis CAS — only one commit wins per version.

## Client contract

- **Primary:** `state_delta` — apply via `mergeServerPayload()` in `client/utils/stateDelta.ts`.
- **Fallback:** `state_updated` — full snapshot on reconnect or when delta > ~40% of payload.
- **Prediction:** `rollDice()` sets `isPredictingRoll`; reconciled when authoritative delta arrives.

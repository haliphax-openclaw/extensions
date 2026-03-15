// Room message types are defined in room-manager.ts as the RoomMessage interface.
// No TypeBox protocol schemas are needed since room messages are delivered
// via the pull-based room_recv tool (as tool return values), not as
// server-push WebSocket events.
//
// If a future version adds server-push delivery, add TypeBox schemas here
// and register them in the gateway protocol schema.
export {};

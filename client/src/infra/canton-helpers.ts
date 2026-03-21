import type { Event, CreatedEvent } from "./canton-client.js";

export function getCreatedEvent(event: Event): CreatedEvent | undefined {
  if ("CreatedEvent" in event) return event.CreatedEvent;
  return undefined;
}

export function findCreated(events: Event[] | undefined, templateFragment: string): CreatedEvent {
  const event = events?.find((e) => getCreatedEvent(e)?.templateId.includes(templateFragment));
  const created = event ? getCreatedEvent(event) : undefined;
  if (!created) throw new Error(`CreatedEvent matching "${templateFragment}" not found`);
  return created;
}

export function firstCreated(events: Event[] | undefined): CreatedEvent {
  const first = events?.[0];
  if (!first) throw new Error("No events in transaction");
  const created = getCreatedEvent(first);
  if (!created) throw new Error("First event is not a CreatedEvent");
  return created;
}

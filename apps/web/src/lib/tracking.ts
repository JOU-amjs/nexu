import * as amplitude from "@amplitude/unified";
import { Identify } from "@amplitude/unified";

export function track(
  event: string,
  properties?: Record<string, unknown>,
): void {
  amplitude.track(event, properties);
}

export function identify(properties: Record<string, unknown>): void {
  const id = new Identify();
  for (const [key, value] of Object.entries(properties)) {
    id.set(key, value as string);
  }
  amplitude.identify(id);
}

export function setUserId(userId: string): void {
  amplitude.setUserId(userId);
}

/**
 * Global notification system for Nova agent.
 * Channels and services push notifications here.
 * The HTTP API serves them to the platform.
 */

export interface Notification {
  type: 'info' | 'action' | 'error';
  message: string;
  timestamp: string;
}

const pending: Notification[] = [];

export function pushNotification(type: Notification['type'], message: string): void {
  pending.push({ type, message, timestamp: new Date().toISOString() });
}

export function getAndClearNotifications(): Notification[] {
  return pending.splice(0);
}

export function getNotifications(): Notification[] {
  return [...pending];
}

import fs from 'node:fs';
import path from 'node:path';
import * as operational from '../systems/operational-diagnostics.js';

const DEFAULT_THRESHOLDS = Object.freeze({
  eventLoopLagMs: 100, tickMs: 50, memoryMB: 2048, protocolErrors: 10, parserErrors: 5,
});
const DEFAULT_NOTIFICATIONS = Object.freeze({ enabled: false, webhookUrl: '', cooldownMs: 300_000 });

function readState(file, fallback) {
  try { return { ...fallback, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; }
  catch { return { ...fallback }; }
}

function writeState(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, file);
}

function validWebhook(value) {
  if (!value) return true;
  try {
    const url = new URL(String(value));
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  } catch { return false; }
}

export function registerAlertRoutes(routes, { saveDir }) {
  const thresholdFile = path.join(saveDir, 'admin-alert-thresholds.json');
  const notificationFile = path.join(saveDir, 'admin-alert-notifications.json');
  let thresholds = readState(thresholdFile, DEFAULT_THRESHOLDS);
  let notifications = readState(notificationFile, DEFAULT_NOTIFICATIONS);
  const delivery = { lastAttemptAt: 0, lastSuccessAt: 0, lastError: '', sent: 0, suppressed: 0 };
  const lastAlertByKey = new Map();

  const notify = (active) => {
    if (!notifications.enabled || !notifications.webhookUrl || !globalThis.fetch) return;
    const now = Date.now();
    const due = active.filter((alert) => now - (lastAlertByKey.get(alert.key) ?? 0) >= notifications.cooldownMs);
    if (!due.length) { if (active.length) delivery.suppressed += active.length; return; }
    for (const alert of due) lastAlertByKey.set(alert.key, now);
    delivery.lastAttemptAt = now;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000); timeout.unref?.();
    void fetch(notifications.webhookUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ schema: 1, source: 'nodeuo-admin', generatedAt: new Date(now).toISOString(), alerts: due }),
    }).then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      delivery.lastSuccessAt = Date.now(); delivery.lastError = ''; delivery.sent += due.length;
    }).catch((error) => { delivery.lastError = String(error?.message ?? error).slice(0, 300); })
      .finally(() => clearTimeout(timeout));
  };

  routes.push({ method: 'GET', path: '/api/operations/alerts', run: () => {
    const runtime = operational.runtimeSnapshot();
    const protocol = operational.protocolSnapshot();
    const memoryMB = process.memoryUsage().rss / 1048576;
    const active = [
      runtime.eventLoop.currentLagMs > thresholds.eventLoopLagMs && { key: 'event-loop', value: runtime.eventLoop.currentLagMs, threshold: thresholds.eventLoopLagMs, href: '#operations' },
      (runtime.ticks[0]?.maxMs ?? 0) > thresholds.tickMs && { key: 'tick', value: runtime.ticks[0]?.maxMs ?? 0, threshold: thresholds.tickMs, href: '#operations' },
      memoryMB > thresholds.memoryMB && { key: 'memory', value: Number(memoryMB.toFixed(1)), threshold: thresholds.memoryMB, href: '#operations' },
      protocol.protocolErrors > thresholds.protocolErrors && { key: 'protocol', value: protocol.protocolErrors, threshold: thresholds.protocolErrors, href: '#operations' },
      protocol.handlerErrors > thresholds.parserErrors && { key: 'handler-errors', value: protocol.handlerErrors, threshold: thresholds.parserErrors, href: '#operations' },
    ].filter(Boolean);
    notify(active);
    return { thresholds, notifications, delivery: { ...delivery }, active, ok: active.length === 0 };
  } });

  routes.push({ method: 'PUT', path: '/api/operations/alerts', run: ({ body }) => {
    for (const key of Object.keys(DEFAULT_THRESHOLDS)) {
      if (body?.[key] != null && (!Number.isFinite(Number(body[key])) || Number(body[key]) < 0)) {
        return { error: `${key} must be a non-negative number` };
      }
    }
    const notification = body?.notifications;
    if (notification != null && (typeof notification !== 'object' || Array.isArray(notification))) return { error: 'notifications must be an object' };
    if (notification?.webhookUrl != null && (String(notification.webhookUrl).length > 2048 || !validWebhook(notification.webhookUrl))) {
      return { error: 'webhookUrl must use HTTPS (HTTP is allowed only for loopback)' };
    }
    if (notification?.cooldownMs != null && (!Number.isFinite(Number(notification.cooldownMs))
        || Number(notification.cooldownMs) < 10_000 || Number(notification.cooldownMs) > 86_400_000)) {
      return { error: 'cooldownMs must be between 10000 and 86400000' };
    }
    thresholds = { ...thresholds, ...Object.fromEntries(Object.entries(body ?? {})
      .filter(([key]) => key in DEFAULT_THRESHOLDS).map(([key, value]) => [key, Number(value)])) };
    if (notification) notifications = {
      enabled: notification.enabled == null ? notifications.enabled : Boolean(notification.enabled),
      webhookUrl: notification.webhookUrl == null ? notifications.webhookUrl : String(notification.webhookUrl),
      cooldownMs: notification.cooldownMs == null ? notifications.cooldownMs : Math.trunc(Number(notification.cooldownMs)),
    };
    writeState(thresholdFile, thresholds); writeState(notificationFile, notifications);
    return { ok: true, thresholds, notifications };
  } });
}

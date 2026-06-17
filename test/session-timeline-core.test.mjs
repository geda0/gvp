import test from 'node:test'
import assert from 'node:assert/strict'
import { orderSessionEvents } from '../aws/src/common/session-timeline-core.js'

test('orderSessionEvents filters to one session and orders ascending by ts then createdAt', () => {
  const rows = [
    { sessionId: 's1', event: 'page_view', ts: 300, createdAt: '2026-06-17T00:00:09.000Z' },
    { sessionId: 's2', event: 'other', ts: 100, createdAt: '2026-06-17T00:00:01.000Z' },
    { sessionId: 's1', event: 'hero_click', ts: 100, createdAt: '2026-06-17T00:00:09.000Z' },
    { sessionId: 's1', event: 'chat_open', ts: 200, createdAt: '2026-06-17T00:00:09.000Z' }
  ]
  const timeline = orderSessionEvents(rows, 's1')
  assert.deepEqual(timeline.map((e) => e.event), ['hero_click', 'chat_open', 'page_view'], 'in interaction order via ts')
  assert.ok(timeline.every((e) => e.sessionId === 's1'), 'only the requested session')
})

test('orderSessionEvents falls back to createdAt when ts is missing (batch with one server stamp)', () => {
  const rows = [
    { sessionId: 's1', event: 'b', createdAt: '2026-06-17T00:00:02.000Z' },
    { sessionId: 's1', event: 'a', createdAt: '2026-06-17T00:00:01.000Z' },
    { sessionId: 's1', event: 'c', createdAt: '2026-06-17T00:00:03.000Z' }
  ]
  assert.deepEqual(orderSessionEvents(rows, 's1').map((e) => e.event), ['a', 'b', 'c'])
})

test('orderSessionEvents returns [] for empty input or no matching session', () => {
  assert.deepEqual(orderSessionEvents([], 's1'), [])
  assert.deepEqual(orderSessionEvents([{ sessionId: 'x', event: 'y' }], 's1'), [])
  assert.deepEqual(orderSessionEvents(null, 's1'), [])
})

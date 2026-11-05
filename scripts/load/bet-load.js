// scripts/load/bet-load.js — k6 load test (docs/19 §20): 200 concurrent dice betters.
// Run: k6 run scripts/load/bet-load.js
// Prereq: seeded stack + a funded test user. Set TEST_TOKEN (a user access token).
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  scenarios: {
    bets: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 100 },
        { duration: '60s', target: 200 },
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'], // <1% errors (docs/19 §20)
    // Both thresholds must live in ONE array — a second `http_req_duration` key
    // silently replaced the first, so the p95<500ms check was never enforced.
    http_req_duration: ['p(95)<500', 'p(99)<1000'],
  },
};

const API = __ENV.API || 'http://localhost:4000/api/v1';
const TOKEN = __ENV.TEST_TOKEN || '';

export default function () {
  const payload = JSON.stringify({
    amount: 10,
    choices: { over: true, target: 50 },
    clientSeed: `k6-${__VU}-${__ITER}`,
    requestId: crypto.randomUUID(),
  });

  const res = http.post(`${API}/games/dice/bet`, payload, {
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
      'x-request-id': crypto.randomUUID(),
    },
    timeout: '5s',
  });

  check(res, {
    'status is 200 or 429 (rate-limit under load is acceptable)': (r) =>
      r.status === 200 || r.status === 429,
    'no 5xx': (r) => r.status < 500,
  });

  sleep(0.05); // spread requests (20 rps per VU max)
}

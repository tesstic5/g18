// e2e/support-flow.mjs — D-079 full support chat flow:
// user picks topic → creates conversation → sends message via socket (room
// join + ack) → admin inbox lists it → admin replies → user receives reply
// via socket → notification row exists. Also verifies admin thread endpoint.
import { io } from 'socket.io-client';
const B = process.env.API || 'http://localhost:4000';
let pass = 0,
  fail = 0;
const P = (n, ok, d = '') => {
  console.log(`${ok ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`);
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fp = { userAgent: 'e2e-sf', screenRes: '1x1', timezone: 'UTC', language: 'en' };
const phone = `+9235${String(10000000 + Math.floor(Math.random() * 89999999))}`;
const signup = await fetch(`${B}/api/v1/auth/signup`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ phone, password: 'TestPass123!', fingerprint: fp }),
});
const sj = await signup.json();
const token = sj.data.accessToken;
const userCookie = (signup.headers.getSetCookie ? signup.headers.getSetCookie() : [])
  .map((c) => c.split(';')[0])
  .join('; ');
const userCsrf =
  (signup.headers.getSetCookie ? signup.headers.getSetCookie() : [])
    .find((c) => c.startsWith('csrf_token='))
    ?.split('=')[1]
    .split(';')[0] ?? '';
P('player signed up', !!token);

// 1. topic-based conversation creation (first message reason)
const convo = await fetch(`${B}/api/v1/support/conversations`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ subject: 'Deposit issue' }),
});
const convId = (await convo.json()).data.id;
P('conversation created with topic', convo.status === 200 && !!convId);

// 2. user socket: join + send
const sock = io(B, { auth: { token }, transports: ['websocket'], reconnection: false });
const events = [];
sock.on('chat:message', (p) => events.push(p));
await sleep(600);
const joinRes = await new Promise((resolve) =>
  sock.emit('chat:join', { conversationId: convId }, resolve)
);
P('chat:join accepted', joinRes?.ok === true, JSON.stringify(joinRes));
const sendRes = await new Promise((resolve) =>
  sock.emit(
    'chat:send',
    { conversationId: convId, message: 'My deposit is stuck, please help!' },
    resolve
  )
);
P(
  'chat:send accepted + stored',
  sendRes?.ok === true && !!sendRes?.message?.id,
  sendRes?.error ?? ''
);
await sleep(800);
P(
  'sender receives own message via room echo',
  events.some((e) => e.message?.body === 'My deposit is stuck, please help!')
);
sock.close();

// 3. message persisted (REST)
const msgs = await fetch(`${B}/api/v1/support/conversations/${convId}/messages`, {
  headers: { Authorization: `Bearer ${token}` },
});
const msgsData = (await msgs.json()).data;
P(
  'message persisted in DB',
  msgsData.some(
    (m) => m.body === 'My deposit is stuck, please help!' && m.senderType === 'USER'
  )
);

// 4. admin inbox sees conversation
const adminLogin = await fetch(`${B}/api/v1/panel/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'superadmin', password: 'change-this-immediately' }),
});
const adminCookie = (
  adminLogin.headers.getSetCookie ? adminLogin.headers.getSetCookie() : []
)
  .map((c) => c.split(';')[0])
  .join('; ');
const adminCsrf =
  (adminLogin.headers.getSetCookie ? adminLogin.headers.getSetCookie() : [])
    .find((c) => c.startsWith('csrf_token='))
    ?.split('=')[1]
    .split(';')[0] ?? '';
const inbox = await fetch(`${B}/api/v1/panel/support/conversations`, {
  headers: { Cookie: adminCookie },
});
const inboxData = (await inbox.json()).data;
P(
  'admin inbox lists the conversation',
  inboxData.some((c) => c.id === convId && c.subject === 'Deposit issue')
);

// 5. admin reads the thread via the NEW admin endpoint
const thread = await fetch(
  `${B}/api/v1/panel/support/conversations/${convId}/messages`,
  { headers: { Cookie: adminCookie } }
);
const threadData = (await thread.json()).data;
P(
  'admin reads thread (admin endpoint)',
  thread.status === 200 && threadData.some((m) => m.body.includes('stuck'))
);

// 6. assign to me
const assign = await fetch(`${B}/api/v1/panel/support/conversations/${convId}`, {
  method: 'PATCH',
  headers: {
    Cookie: adminCookie,
    'X-CSRF-Token': adminCsrf,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ status: 'ASSIGNED' }),
});
P('admin assigns conversation', assign.status === 200);

// 7. user joins the room FIRST (like the open widget), THEN admin replies
const sock2 = io(B, {
  auth: { token },
  transports: ['websocket'],
  reconnection: false,
});
const gotReply = new Promise((resolve) => {
  sock2.on('chat:message', (p) => {
    if (p.message?.senderType === 'ADMIN' && p.message.body.includes('checking now'))
      resolve(true);
  });
  setTimeout(() => resolve(false), 5000);
});
await sleep(500);
sock2.emit('chat:join', { conversationId: convId });
await sleep(600);

const reply = await fetch(`${B}/api/v1/panel/support/conversations/${convId}/reply`, {
  method: 'POST',
  headers: {
    Cookie: adminCookie,
    'X-CSRF-Token': adminCsrf,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ message: 'We see your deposit — checking now.' }),
});
const replyData = await reply.json();
P('admin reply sent', reply.status === 200 && replyData.data?.senderType === 'ADMIN');

const userGetsReply = await gotReply;
P('user receives admin reply via socket', userGetsReply === true);
sock2.close();

// 8. player notification row (notifyUser on reply)
const notifs = await fetch(`${B}/api/v1/notifications`, {
  headers: { Authorization: `Bearer ${token}` },
});
const notifData = (await notifs.json()).data;
P(
  'player got a notification for the reply',
  notifData.some((n) => n.type === 'support')
);

console.log(`\nSUPPORT FLOW: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

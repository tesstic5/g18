import 'dotenv/config';
console.log('DATABASE_URL:', process.env.DATABASE_URL);
console.log('REDIS_URL:', process.env.REDIS_URL);
const { buildServer } = await import('./server');
try {
  const app = await buildServer();
  const res = await app.inject({ method: 'GET', url: '/health' });
  console.log('health:', res.statusCode, res.body);
  await app.close();
} catch (e) {
  console.error('ERROR:', (e as Error).message);
  console.error((e as Error).stack?.split('\n').slice(0, 8).join('\n'));
}

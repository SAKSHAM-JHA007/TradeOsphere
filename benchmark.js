const jwt = require('jsonwebtoken');
const http = require('http');

const JWT_SECRET = 'fallback-secret-key-do-not-use-in-production';
const token = jwt.sign({ id: 1, email: 'test@test.com' }, JWT_SECRET);

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/api/stock/quote/AAPL',
  method: 'GET',
  headers: {
    'Cookie': `jwt=${token}`
  }
};

async function runBenchmark() {
  const start = Date.now();
  let count = 0;
  const numRequests = 20;

  for (let i = 0; i < numRequests; i++) {
    await new Promise((resolve, reject) => {
      const req = http.request(options, (res) => {
        res.on('data', () => {});
        res.on('end', () => {
          count++;
          resolve();
        });
      });
      req.on('error', (e) => reject(e));
      req.end();
    });
  }

  const end = Date.now();
  console.log(`Finished ${count} requests in ${end - start} ms`);
}

runBenchmark();

const request = require('supertest');

process.env.JWT_SECRET = 'test_secret';

const { app, server, db } = require('./server');

jest.mock('node-cron', () => ({
  schedule: jest.fn()
}));

// We need to mock JWT and skip the requireAuth middleware.
jest.mock('jsonwebtoken', () => ({
  verify: jest.fn((token, secret, callback) => callback(null, { id: 1 })),
  sign: jest.fn(() => 'mock_token')
}));

describe('POST /api/trade validation', () => {
    let testAgent;

    beforeAll(() => {
        testAgent = request.agent(app);
        // add a dummy cookie
        testAgent.set('Cookie', ['jwt=mock_token']);
    });

    afterAll((done) => {
        db.close();
        server.close(done);
    });

    test('should fail if ticker is missing', async () => {
        const res = await testAgent.post('/api/trade')
            .send({ type: 'BUY', quantity: 10 });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Invalid trade parameters');
    });

    test('should fail if type is missing', async () => {
        const res = await testAgent.post('/api/trade')
            .send({ ticker: 'AAPL', quantity: 10 });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Invalid trade parameters');
    });

    test('should fail if quantity is missing', async () => {
        const res = await testAgent.post('/api/trade')
            .send({ ticker: 'AAPL', type: 'BUY' });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Invalid trade parameters');
    });

    test('should fail if quantity is less than or equal to 0', async () => {
        const res = await testAgent.post('/api/trade')
            .send({ ticker: 'AAPL', type: 'BUY', quantity: 0 });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Invalid trade parameters');

        const res2 = await testAgent.post('/api/trade')
            .send({ ticker: 'AAPL', type: 'BUY', quantity: -5 });
        expect(res2.status).toBe(400);
        expect(res2.body.error).toBe('Invalid trade parameters');
    });

    test('should fail if quantity is not a number', async () => {
        const res = await testAgent.post('/api/trade')
            .send({ ticker: 'AAPL', type: 'BUY', quantity: 'abc' });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Invalid trade parameters');
    });
});

const request = require('supertest');
const jwt = require('jsonwebtoken');

// Mock node-cron to prevent background tasks from running
jest.mock('node-cron', () => ({
    schedule: jest.fn()
}));

const { app, server, db } = require('../server.js');

describe('Trade API Error Handling', () => {
    afterAll((done) => {
        server.close(() => {
            db.close(done);
        });
    });

    it('should return 500 when external API call fails during trade execution', async () => {
        // Setup authenticated user
        const token = jwt.sign({ id: 1, name: 'Test User', email: 'test@example.com' }, process.env.JWT_SECRET || 'test_secret', { expiresIn: '1h' });

        // Ensure server knows the JWT_SECRET
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret';

        // Mock global.fetch to simulate an external API failure
        const originalFetch = global.fetch;
        global.fetch = jest.fn(() => Promise.reject(new Error('API is down')));

        try {
            const response = await request(app)
                .post('/api/trade')
                .set('Cookie', [`jwt=${token}`])
                .send({
                    ticker: 'AAPL',
                    type: 'BUY',
                    quantity: 10
                });

            expect(response.status).toBe(500);
            expect(response.body).toEqual({ error: 'Error executing trade' });
        } finally {
            // Restore original fetch
            global.fetch = originalFetch;
        }
    });
});

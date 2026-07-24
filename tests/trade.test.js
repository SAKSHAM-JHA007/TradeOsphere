jest.mock('node-cron', () => ({ schedule: jest.fn() }));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { app, db } = require('../server'); // Do not import server here, let supertest handle app binding

const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-key-do-not-use-in-production';
let token;
let testUserId;

beforeAll((done) => {
    db.serialize(() => {
        db.run("DELETE FROM transactions");
        db.run("DELETE FROM portfolio");
        db.run("DELETE FROM users");

        const hash = bcrypt.hashSync('password123', 10);
        db.run(`INSERT INTO users (name, email, password_hash, balance) VALUES (?, ?, ?, ?)`,
            ['Test User', 'test@example.com', hash, 100000.0], function(err) {
            if (err) return done(err);
            testUserId = this.lastID;
            token = jwt.sign({ id: testUserId, email: 'test@example.com', name: 'Test User' }, JWT_SECRET, { expiresIn: '1h' });

            // Insert some initial portfolio for SELL tests
            db.run(`INSERT INTO portfolio (user_id, ticker, quantity, average_price) VALUES (?, ?, ?, ?)`,
                [testUserId, 'AAPL', 10, 150.0], (err) => {
                if (err) return done(err);
                done();
            });
        });
    });
});

afterAll((done) => {
    db.serialize(() => {
        db.run("DELETE FROM transactions", () => {
            db.run("DELETE FROM portfolio", () => {
                db.run("DELETE FROM users", () => {
                    db.close(done);
                });
            });
        });
    });
});

describe('Trade API Integrations', () => {
    beforeEach(() => {
        global.fetch = jest.fn();
    });

    afterEach(() => {
        jest.resetAllMocks();
    });

    it('should return 400 for invalid parameters', async () => {
        const res = await request(app)
            .post('/api/trade')
            .set('Cookie', [`jwt=${token}`])
            .send({ ticker: '', type: 'BUY', quantity: 10 });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Invalid trade parameters');

        const res2 = await request(app)
            .post('/api/trade')
            .set('Cookie', [`jwt=${token}`])
            .send({ ticker: 'AAPL', type: 'BUY', quantity: -5 });

        expect(res2.status).toBe(400);
        expect(res2.body.error).toBe('Invalid trade parameters');
    });

    it('should return 400 if finnhub returns no price data', async () => {
        global.fetch.mockResolvedValueOnce({
            json: jest.fn().mockResolvedValueOnce({ c: 0 }) // mock Finnhub returning invalid price
        });

        const res = await request(app)
            .post('/api/trade')
            .set('Cookie', [`jwt=${token}`])
            .send({ ticker: 'INVALID', type: 'BUY', quantity: 10 });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Invalid ticker symbol or no price data');
    });

    it('should return 400 for BUY if insufficient virtual balance', async () => {
        global.fetch.mockResolvedValueOnce({
            json: jest.fn().mockResolvedValueOnce({ c: 20000.0 }) // mock Finnhub returning high price
        });

        const res = await request(app)
            .post('/api/trade')
            .set('Cookie', [`jwt=${token}`])
            .send({ ticker: 'BRK.A', type: 'BUY', quantity: 10 }); // 200,000 > 100,000 balance

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Insufficient virtual balance');
    });

    it('should return 400 for SELL if insufficient stock quantity in portfolio', async () => {
        global.fetch.mockResolvedValueOnce({
            json: jest.fn().mockResolvedValueOnce({ c: 150.0 }) // mock Finnhub returning valid price
        });

        const res = await request(app)
            .post('/api/trade')
            .set('Cookie', [`jwt=${token}`])
            .send({ ticker: 'AAPL', type: 'SELL', quantity: 20 }); // trying to sell 20, but only have 10

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Insufficient quantity to sell');
    });
    it('should successfully execute a BUY order and update db', async () => {
        global.fetch.mockResolvedValueOnce({
            json: jest.fn().mockResolvedValueOnce({ c: 150.0 }) // mock Finnhub returning valid price
        });

        const res = await request(app)
            .post('/api/trade')
            .set('Cookie', [`jwt=${token}`])
            .send({ ticker: 'MSFT', type: 'BUY', quantity: 10 });

        expect(res.status).toBe(200);
        expect(res.body.message).toBe('Trade executed successfully');
        expect(res.body.price).toBe(150.0);
        expect(res.body.totalValue).toBe(1500.0);

        // Wait a small amount of time for async DB updates to finish
        await new Promise(resolve => setTimeout(resolve, 100));

        // Verify balance was deducted
        const user = await new Promise((res, rej) => db.get('SELECT balance FROM users WHERE id = ?', [testUserId], (err, row) => err ? rej(err) : res(row)));
        expect(user.balance).toBe(100000.0 - 1500.0);

        // Verify portfolio
        const portfolio = await new Promise((res, rej) => db.get('SELECT quantity, average_price FROM portfolio WHERE user_id = ? AND ticker = ?', [testUserId, 'MSFT'], (err, row) => err ? rej(err) : res(row)));
        expect(portfolio.quantity).toBe(10);
        expect(portfolio.average_price).toBe(150.0);

        // Verify transaction
        const tx = await new Promise((res, rej) => db.get('SELECT type, quantity, price FROM transactions WHERE user_id = ? AND ticker = ? ORDER BY id DESC', [testUserId, 'MSFT'], (err, row) => err ? rej(err) : res(row)));
        expect(tx.type).toBe('BUY');
        expect(tx.quantity).toBe(10);
        expect(tx.price).toBe(150.0);
    });

    it('should successfully execute a SELL order and update db', async () => {
        global.fetch.mockResolvedValueOnce({
            json: jest.fn().mockResolvedValueOnce({ c: 200.0 }) // mock Finnhub returning valid price
        });

        // We already have 10 AAPL in portfolio from beforeAll
        const res = await request(app)
            .post('/api/trade')
            .set('Cookie', [`jwt=${token}`])
            .send({ ticker: 'AAPL', type: 'SELL', quantity: 5 });

        expect(res.status).toBe(200);
        expect(res.body.message).toBe('Trade executed successfully');
        expect(res.body.price).toBe(200.0);
        expect(res.body.totalValue).toBe(1000.0);

        // Wait a small amount of time for async DB updates to finish
        await new Promise(resolve => setTimeout(resolve, 100));

        // Verify balance was added
        const user = await new Promise((res, rej) => db.get('SELECT balance FROM users WHERE id = ?', [testUserId], (err, row) => err ? rej(err) : res(row)));
        expect(user.balance).toBe(100000.0 - 1500.0 + 1000.0); // Took out 1500 for MSFT in last test, added 1000 for AAPL

        // Verify portfolio
        const portfolio = await new Promise((res, rej) => db.get('SELECT quantity FROM portfolio WHERE user_id = ? AND ticker = ?', [testUserId, 'AAPL'], (err, row) => err ? rej(err) : res(row)));
        expect(portfolio.quantity).toBe(5); // 10 - 5

        // Verify transaction
        const tx = await new Promise((res, rej) => db.get('SELECT type, quantity, price FROM transactions WHERE user_id = ? AND ticker = ? ORDER BY id DESC', [testUserId, 'AAPL'], (err, row) => err ? rej(err) : res(row)));
        expect(tx.type).toBe('SELL');
        expect(tx.quantity).toBe(5);
        expect(tx.price).toBe(200.0);
    });

});

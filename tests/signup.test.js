const request = require('supertest');
const bcrypt = require('bcrypt');

// Set environment variables before requiring server.js
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'testsecret';

jest.mock('node-cron', () => ({
    schedule: jest.fn()
}));

jest.mock('bcrypt');

const { app, server, db } = require('../server.js');

describe('POST /api/signup', () => {
    beforeAll((done) => {
        db.serialize(() => {
            db.run(`CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT,
                email TEXT UNIQUE,
                password_hash TEXT,
                balance REAL DEFAULT 1000000.0
            )`, done);
        });
    });

    afterAll((done) => {
        db.close(done);
    });

    beforeEach((done) => {
        db.run('DELETE FROM users', done);
    });

    it('should return 400 if fields are missing', async () => {
        const res = await request(app).post('/api/signup').send({
            name: 'John Doe',
            // Missing email and password
        });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'All fields are required' });
    });

    it('should signup a user successfully and return 200', async () => {
        bcrypt.hash.mockImplementation((password, saltRounds, cb) => {
            cb(null, 'hashed_password');
        });

        const res = await request(app).post('/api/signup').send({
            name: 'John Doe',
            email: 'john@example.com',
            password: 'password123'
        });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ message: 'Signup successful' });

        // Ensure the JWT cookie is set
        const cookies = res.headers['set-cookie'];
        expect(cookies).toBeDefined();
        expect(cookies[0]).toMatch(/jwt=.+/);

        // Ensure user is in the database
        return new Promise((resolve, reject) => {
            db.get(`SELECT * FROM users WHERE email = ?`, ['john@example.com'], (err, row) => {
                if (err) return reject(err);
                expect(row).toBeDefined();
                expect(row.name).toBe('John Doe');
                expect(row.password_hash).toBe('hashed_password');
                resolve();
            });
        });
    });

    it('should return 400 if email is already in use', async () => {
        // Seed the database with a user
        await new Promise((resolve, reject) => {
            db.run(`INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)`,
                ['Jane Doe', 'jane@example.com', 'hashed_pass'],
                function(err) {
                    if (err) return reject(err);
                    resolve();
                }
            );
        });

        const res = await request(app).post('/api/signup').send({
            name: 'Another Jane',
            email: 'jane@example.com',
            password: 'new_password'
        });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Email already in use' });
    });

    it('should return 500 if there is a database error during SELECT', async () => {
        const originalGet = db.get;
        db.get = jest.fn((query, params, cb) => cb(new Error('Mock DB Error')));

        const res = await request(app).post('/api/signup').send({
            name: 'John Doe',
            email: 'john@example.com',
            password: 'password123'
        });

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Database error' });

        db.get = originalGet; // Restore
    });

    it('should return 500 if there is a hashing error', async () => {
        bcrypt.hash.mockImplementation((password, saltRounds, cb) => {
            cb(new Error('Mock Hashing Error'));
        });

        const res = await request(app).post('/api/signup').send({
            name: 'John Doe',
            email: 'john@example.com',
            password: 'password123'
        });

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Hashing error' });
    });

    it('should return 500 if there is a database error during INSERT', async () => {
        bcrypt.hash.mockImplementation((password, saltRounds, cb) => {
            cb(null, 'hashed_password');
        });

        const originalRun = db.run;
        db.run = jest.fn((query, params, cb) => {
            if (query.includes('INSERT INTO users')) {
                return cb(new Error('Mock Insert Error'));
            }
            return originalRun.call(db, query, params, cb);
        });

        const res = await request(app).post('/api/signup').send({
            name: 'John Doe',
            email: 'john@example.com',
            password: 'password123'
        });

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Database error' });

        db.run = originalRun; // Restore
    });
});

const request = require('supertest');
const { app, server, db } = require('../server');

beforeAll((done) => {
    // Wait for the db to be initialized
    // The server.js initializes the DB synchronously on require, but table creation happens async.
    // However, the test will use memory DB. Let's make sure it's ready.
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
    // Close server and db after tests
    server.close();
    db.close(done);
});

describe('POST /api/signup', () => {
    beforeEach((done) => {
        // Clean the database before each test
        db.run('DELETE FROM users', done);
    });

    it('should successfully sign up a user with valid data', async () => {
        const res = await request(app)
            .post('/api/signup')
            .send({
                name: 'Test User',
                email: 'test@example.com',
                password: 'password123'
            });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ message: 'Signup successful' });

        // Check if the jwt cookie was set
        const cookies = res.headers['set-cookie'];
        expect(cookies).toBeDefined();
        expect(cookies[0]).toMatch(/jwt=/);
    });

    it('should return 400 if required fields are missing', async () => {
        const res = await request(app)
            .post('/api/signup')
            .send({
                name: 'Test User',
                email: 'test@example.com'
                // password is missing
            });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'All fields are required' });
    });

    it('should return 400 if the email is already in use', async () => {
        // Insert a user first
        await request(app)
            .post('/api/signup')
            .send({
                name: 'First User',
                email: 'test@example.com',
                password: 'password123'
            });

        // Try signing up with the same email
        const res = await request(app)
            .post('/api/signup')
            .send({
                name: 'Second User',
                email: 'test@example.com',
                password: 'password456'
            });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Email already in use' });
    });
});

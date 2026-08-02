const request = require('supertest');
const bcrypt = require('bcrypt');

jest.mock('node-cron', () => ({ schedule: jest.fn() }));
jest.mock('yahoo-finance2', () => ({
    default: jest.fn().mockImplementation(() => ({}))
}));

// We need to set the environment variable before importing the app
process.env.JWT_SECRET = 'test_secret';
process.env.NODE_ENV = 'test';

const { app, db, server } = require('../server');

beforeAll((done) => {
    db.serialize(() => {
        db.run('DELETE FROM users', done);
    });
});

afterAll((done) => {
    server.close();
    db.close(done);
});

describe('POST /api/signin - Invalid Credentials', () => {
    const testUser = {
        name: 'Test User',
        email: 'test@example.com',
        password: 'password123'
    };

    beforeAll((done) => {
        // create a user with a hashed password
        bcrypt.hash(testUser.password, 10, (err, hash) => {
            if (err) return done(err);
            db.run(
                'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)',
                [testUser.name, testUser.email, hash],
                done
            );
        });
    });

    it('should return 400 for a non-existent email', async () => {
        const response = await request(app)
            .post('/api/signin')
            .send({
                email: 'nonexistent@example.com',
                password: 'password123'
            });

        expect(response.status).toBe(400);
        expect(response.body).toEqual({ error: 'Invalid email or password' });
    });

    it('should return 400 for an existing email but incorrect password', async () => {
        const response = await request(app)
            .post('/api/signin')
            .send({
                email: testUser.email,
                password: 'wrongpassword'
            });

        expect(response.status).toBe(400);
        expect(response.body).toEqual({ error: 'Invalid email or password' });
    });

    it('should return 400 when missing email', async () => {
        const response = await request(app)
            .post('/api/signin')
            .send({
                password: testUser.password
            });

        expect(response.status).toBe(400);
        expect(response.body).toEqual({ error: 'Email and password are required' });
    });

    it('should return 400 when missing password', async () => {
        const response = await request(app)
            .post('/api/signin')
            .send({
                email: testUser.email
            });

        expect(response.status).toBe(400);
        expect(response.body).toEqual({ error: 'Email and password are required' });
    });
});

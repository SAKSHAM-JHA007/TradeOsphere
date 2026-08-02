jest.mock('node-cron', () => ({ schedule: jest.fn() }));
const jwt = require('jsonwebtoken');

describe('requireAuth middleware', () => {
    let req, res, next, requireAuth, server, db, JWT_SECRET;

    beforeAll(() => {
        const appModule = require('../server');
        requireAuth = appModule.requireAuth;
        server = appModule.server;
        db = appModule.db;
        JWT_SECRET = appModule.JWT_SECRET;
    });

    beforeEach(() => {
        req = {
            cookies: {}
        };
        res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn()
        };
        next = jest.fn();
    });

    afterAll(() => {
        server.close();
    });

    it('should return 401 if no token is provided', () => {
        requireAuth(req, res, next);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
        expect(next).not.toHaveBeenCalled();
    });

    it('should return 401 if token is invalid', () => {
        req.cookies.jwt = 'invalid.token.here';

        requireAuth(req, res, next);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
        expect(next).not.toHaveBeenCalled();
    });

    it('should call next and set req.user if token is valid', () => {
        const payload = { id: 1, name: 'Test User' };
        const validToken = jwt.sign(payload, JWT_SECRET);
        req.cookies.jwt = validToken;

        requireAuth(req, res, next);

        expect(req.user).toBeDefined();
        expect(req.user.id).toBe(payload.id);
        expect(req.user.name).toBe(payload.name);
        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
        expect(res.json).not.toHaveBeenCalled();
    });
});

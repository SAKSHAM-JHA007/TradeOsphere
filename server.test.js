const jwt = require('jsonwebtoken');
const { requireAuth } = require('./server');

jest.mock('jsonwebtoken');

describe('requireAuth middleware', () => {
    let req;
    let res;
    let next;

    beforeEach(() => {
        req = {
            cookies: {}
        };
        res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn()
        };
        next = jest.fn();

        // Reset process.env.JWT_SECRET if it was modified
        process.env.JWT_SECRET = 'fallback-secret-key-do-not-use-in-production';

        jest.clearAllMocks();
    });

    it('should return 401 if no token is provided', () => {
        requireAuth(req, res, next);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
        expect(next).not.toHaveBeenCalled();
    });

    it('should return 401 if token is invalid', () => {
        req.cookies.jwt = 'invalid-token';

        // Mock jwt.verify to call the callback with an error
        jwt.verify.mockImplementation((token, secret, callback) => {
            callback(new Error('Invalid token'), null);
        });

        requireAuth(req, res, next);

        expect(jwt.verify).toHaveBeenCalledWith('invalid-token', process.env.JWT_SECRET, expect.any(Function));
        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
        expect(next).not.toHaveBeenCalled();
    });

    it('should decode token, assign user to req, and call next if token is valid', () => {
        req.cookies.jwt = 'valid-token';
        const decodedUser = { id: 1, name: 'Test User', email: 'test@example.com' };

        // Mock jwt.verify to call the callback with decoded data
        jwt.verify.mockImplementation((token, secret, callback) => {
            callback(null, decodedUser);
        });

        requireAuth(req, res, next);

        expect(jwt.verify).toHaveBeenCalledWith('valid-token', process.env.JWT_SECRET, expect.any(Function));
        expect(req.user).toEqual(decodedUser);
        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
        expect(res.json).not.toHaveBeenCalled();
    });
});

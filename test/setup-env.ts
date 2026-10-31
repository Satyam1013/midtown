import 'reflect-metadata';

// Always a dedicated database, never the one in .env.
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI =
  process.env.TEST_MONGODB_URI ?? 'mongodb://localhost:27019/midtown_test?directConnection=true';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-test-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-test-refresh-secret';
process.env.OWNER_NAME = 'Test Owner';
process.env.OWNER_PHONE = '9000000000';
process.env.OWNER_PASSWORD = 'test-owner-password';
process.env.OTP_PROVIDER = 'console';
process.env.FRONTEND_MANAGER_URL = 'http://localhost:3000';
process.env.FRONTEND_GUEST_URL = 'http://localhost:3000';

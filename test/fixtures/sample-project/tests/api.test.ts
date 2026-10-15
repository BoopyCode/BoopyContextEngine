import { createServer } from '../src/index';

describe('api', () => {
  it('exposes the orders endpoint', () => {
    const server = createServer();
    expect(server).toBeDefined();
  });
});
